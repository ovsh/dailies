import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/main/db/database";

describe("db end-to-end smoke", () => {
  it("indexes, searches, and queues against a real SQLite file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-"));
    const db = openDatabase(path.join(dir, "smoke.db"));

    const file = db.upsertFile({
      path: "/footage/A001_bear_river.mov",
      filename: "A001_bear_river.mov",
      durationS: 120,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "abc123",
    });
    expect(file.id).toBeGreaterThan(0);

    db.replaceScenes(file.id, [
      { startS: 0, endS: 30, startTc: "01:00:00:00", endTc: "01:00:30:00", keyframePath: null },
      { startS: 30, endS: 120, startTc: "01:00:30:00", endTc: "01:02:00:00", keyframePath: null },
    ]);

    db.replaceTranscript(file.id, [
      {
        startS: 34,
        endS: 41,
        text: "The bears come down to the river when the salmon start running.",
        speaker: "Marsh",
        avgConf: 0.93,
        words: [
          { word: "The", startS: 34, endS: 34.2 },
          { word: "bears", startS: 34.2, endS: 34.6 },
        ],
      },
      {
        startS: 60,
        endS: 66,
        text: "Weather is turning so we fly the drone early tomorrow.",
        speaker: "Marsh",
        avgConf: 0.9,
        words: [],
      },
    ]);

    const scenes = db.listScenes(file.id);
    expect(scenes).toHaveLength(2);
    db.upsertAnnotation(scenes[0].id, {
      description: "A brown bear stands mid-river as salmon leap around it.",
      objects: ["bear", "river", "salmon"],
      shotType: "WS",
      timeOfDay: "day",
      peopleCount: 0,
      actions: ["fishing"],
      model: "gemini-2.5-flash",
    });

    // FTS + source-TC offset: 34 wall-clock seconds into a 23.976 NDF clip
    // starting 01:00:00:00 is round(34 * 23.976) = 815 frames = 33s 23f.
    const spoken = db.searchTranscripts(["bears", "salmon"]);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken[0].startTc).toBe("01:00:33:23");

    const seen = db.searchVisuals(["bear"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].description).toContain("brown bear");

    // episodes + folders + scoped search
    const ep = db.createEpisode("201");
    expect(db.createEpisode("201").id).toBe(ep.id); // idempotent by code
    const folder = db.addFolder("/footage/ep201", "raw", ep.id);
    expect(db.listFolders()[0]?.episodeId).toBe(ep.id);
    db.setFolderScanned(folder.id, "2026-07-02T00:00:00.000Z");
    expect(db.listFolders()[0]?.lastScannedAt).toContain("2026");

    db.upsertFile({
      path: "/footage/A001_bear_river.mov",
      filename: "A001_bear_river.mov",
      durationS: 120,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "abc123",
      episodeId: ep.id,
    });
    expect(db.listFiles(ep.id)).toHaveLength(1);
    const scoped = db.searchTranscripts(["bears"], 40, ep.id);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped[0].episodeId).toBe(ep.id);
    expect(db.searchTranscripts(["bears"], 40, ep.id + 999)).toHaveLength(0);

    // job queue lifecycle
    db.enqueueJob(file.id, "transcribe");
    const job = db.claimNextJob();
    expect(job?.stage).toBe("transcribe");
    expect(job?.status).toBe("running");
    db.completeJob(job!.id);
    expect(db.claimNextJob()).toBeNull();

    // chat persistence
    const chat = db.createChat("bears");
    db.addChatMessage(chat.id, "user", "where are the bears?");
    db.addChatMessage(chat.id, "assistant", "found them", [
      {
        fileId: file.id,
        filename: file.filename,
        kind: "visual",
        inTc: "01:00:34:00",
        outTc: "01:00:41:00",
        inS: 34,
        outS: 41,
        confidence: "high",
      },
    ]);
    const msgs = db.getChatMessages(chat.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].hits?.[0].kind).toBe("visual");

    // roles + hit hydration
    expect(spoken[0].role).toBe("raw");
    const hydrated = db.getTranscriptHit(spoken[0].segmentId);
    expect(hydrated?.startTc).toBe(spoken[0].startTc);

    // OP-Atom clip lookup by UMID
    const atom = db.upsertFile({
      path: "/avid/MXF/1/BEARV01.mxf",
      filename: "A001C012 BEAR RIVER WS",
      durationS: 60,
      fps: 25,
      dropFrame: false,
      startTc: "05:00:00:00",
      codec: "dnxhd",
      audioChannels: 0,
      fileHash: "atomhash",
      role: "raw",
      clipName: "A001C012 BEAR RIVER WS",
      mediaKind: "opatom",
      memberPaths: ["/avid/MXF/1/BEARV01.mxf", "/avid/MXF/1/BEARA01.mxf"],
      clipKey: "umid-123",
    });
    expect(db.getFileByClipKey("umid-123")?.id).toBe(atom.id);
    expect(db.getFile(atom.id)?.memberPaths).toHaveLength(2);

    // documents + chunk FTS
    const doc = db.upsertDocument({
      path: "/notes/producer-notes.txt",
      filename: "producer-notes.txt",
      kind: "txt",
      content: "We need more bear content in episode two.",
      chunks: ["We need more bear content in episode two.", "Also check the salmon aerials."],
    });
    expect(doc.chunkCount).toBe(2);
    const noteHits = db.searchDocuments(["bear"]);
    expect(noteHits).toHaveLength(1);
    expect(noteHits[0].filename).toBe("producer-notes.txt");

    // embeddings: store two orthogonal-ish vectors, nearest neighbour wins
    const unembedded = db.listUnembeddedSegments(file.id);
    expect(unembedded).toHaveLength(2);
    const vecA = new Float32Array(768).fill(0);
    vecA[0] = 1;
    const vecB = new Float32Array(768).fill(0);
    vecB[1] = 1;
    db.upsertEmbedding("segment", unembedded[0].refId, vecA);
    db.upsertEmbedding("segment", unembedded[1].refId, vecB);
    expect(db.listUnembeddedSegments(file.id)).toHaveLength(0);
    const nearest = db.semanticSearch("segment", vecA, 2);
    expect(nearest[0].refId).toBe(unembedded[0].refId);
    expect(nearest[0].score).toBeGreaterThan(nearest[1].score);

    db.close();
  });
});
