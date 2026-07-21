import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/main/db/database";
import { parseTc } from "../src/shared/timecode";

describe("db end-to-end smoke", () => {
  it("uses shared drop-frame math for search hits at minute boundaries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-df-"));
    const db = openDatabase(path.join(dir, "drop-frame.db"));
    const fps = 29.97;
    const file = db.upsertFile({
      path: "/footage/df.mov",
      filename: "df.mov",
      durationS: 700,
      fps,
      dropFrame: true,
      startTc: "00:00:00;00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "df-boundaries",
    });
    const atFrame = (frame: number): number => frame / fps;
    const beforeMinute = parseTc("00:00:59;29", fps, true);
    const minuteOne = beforeMinute + 1;
    const beforeMinuteTen = parseTc("00:09:59;29", fps, true);
    const minuteTen = beforeMinuteTen + 1;

    db.replaceTranscript(file.id, [
      { startS: atFrame(beforeMinute - 1), endS: atFrame(beforeMinute), text: "twopreboundary", avgConf: 1, words: [] },
      { startS: atFrame(beforeMinute), endS: atFrame(minuteOne), text: "preboundary", avgConf: 1, words: [] },
      { startS: atFrame(minuteOne), endS: atFrame(minuteOne + 1), text: "postboundary", avgConf: 1, words: [] },
      { startS: atFrame(beforeMinuteTen), endS: atFrame(minuteTen), text: "preexempt", avgConf: 1, words: [] },
      { startS: atFrame(minuteTen), endS: atFrame(minuteTen + 1), text: "postexempt", avgConf: 1, words: [] },
    ]);
    expect(db.searchTranscripts(["twopreboundary"])[0]?.startTc).toBe("00:00:59;28");
    expect(db.searchTranscripts(["preboundary"])[0]?.startTc).toBe("00:00:59;29");
    expect(db.searchTranscripts(["postboundary"])[0]?.startTc).toBe("00:01:00;02");
    expect(db.searchTranscripts(["preexempt"])[0]?.startTc).toBe("00:09:59;29");
    expect(db.searchTranscripts(["postexempt"])[0]?.startTc).toBe("00:10:00;00");

    db.close();
  });

  it("reopens only matching errored jobs and is idempotent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-reopen-errors-"));
    const db = openDatabase(path.join(dir, "reopen-errors.db"));
    const input = {
      path: "/footage/retry.wav",
      filename: "retry.wav",
      durationS: 10,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "retry-file",
    };
    const file = db.upsertFile(input);
    const otherFile = db.upsertFile({
      ...input,
      path: "/footage/other.wav",
      filename: "other.wav",
      fileHash: "other-file",
    });

    db.enqueueJob(file.id, "transcribe");
    const firstError = db.claimNextJob()!;
    db.retryJob(firstError.id, "first attempt failed");
    expect(db.claimNextJob()?.id).toBe(firstError.id);
    db.failJob(firstError.id, "terminal transcribe failure");

    db.enqueueJob(file.id, "transcribe");
    const secondError = db.claimNextJob()!;
    db.failJob(secondError.id, "second terminal transcribe failure");

    db.enqueueJob(file.id, "embed");
    const otherStageError = db.claimNextJob()!;
    db.failJob(otherStageError.id, "embed failure");

    db.enqueueJob(otherFile.id, "transcribe");
    const otherFileError = db.claimNextJob()!;
    db.failJob(otherFileError.id, "other file failure");

    db.enqueueJob(file.id, "scenes");
    const doneJob = db.claimNextJob()!;
    db.completeJob(doneJob.id);

    db.enqueueJob(file.id, "proxy");
    const waitingJob = db.claimNextJob()!;
    db.waitJob(waitingJob.id, "waiting for dependency");

    db.enqueueJob(file.id, "audio");
    const runningJob = db.claimNextJob()!;
    db.enqueueJob(file.id, "probe");
    const queuedJob = db.listJobs().find((job) => job.stage === "probe")!;

    const unchangedIds = new Set([
      queuedJob.id,
      runningJob.id,
      waitingJob.id,
      doneJob.id,
      otherStageError.id,
      otherFileError.id,
    ]);
    const unchangedBefore = db.listJobs().filter((job) => unchangedIds.has(job.id));

    expect(db.reopenErroredJobs(file.id, ["transcribe"])).toBe(2);
    expect(db.listJobs().find((job) => job.id === firstError.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
    });
    expect(db.listJobs().find((job) => job.id === secondError.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
    });
    expect(db.listJobs().filter((job) => unchangedIds.has(job.id))).toEqual(unchangedBefore);

    const afterFirstReopen = db.listJobs();
    expect(db.reopenErroredJobs(file.id, ["transcribe"])).toBe(0);
    expect(db.listJobs()).toEqual(afterFirstReopen);

    db.close();
  });

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

    // FTS + source-TC offset: 34 wall-clock seconds into a 23.976 NDF clip
    // starting 01:00:00:00 is round(34 * 23.976) = 815 frames = 33s 23f.
    const spoken = db.searchTranscripts(["bears", "salmon"]);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken[0].startTc).toBe("01:00:33:23");

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

    // Embeddings retain absolute cosine and reject off-topic neighbours.
    const unembedded = db.listUnembeddedSegments(file.id);
    expect(unembedded).toHaveLength(2);
    const vecA = new Float32Array(768).fill(0);
    vecA[0] = 1;
    const vecB = new Float32Array(768).fill(0);
    vecB[1] = 1;
    db.upsertEmbedding("segment", unembedded[0].refId, vecA);
    db.upsertEmbedding("segment", unembedded[1].refId, vecB);
    expect(db.listUnembeddedSegments(file.id)).toHaveLength(0);
    const query = new Float32Array(768).fill(0);
    query[0] = 0.8;
    query[1] = 0.6;
    const nearest = db.semanticSearch("segment", query, 2);
    expect(nearest[0].refId).toBe(unembedded[0].refId);
    expect(nearest[0].score).toBeCloseTo(0.8, 5);
    expect(nearest[1].score).toBeCloseTo(0.6, 5);
    const junk = new Float32Array(768).fill(0);
    junk[2] = 1;
    expect(db.semanticSearch("segment", junk, 2)).toEqual([]);

    // Project metadata and embedding-model invalidation primitives.
    expect(db.getMeta("embedding_model")).toBeNull();
    db.setMeta("embedding_model", "google/gemini-embedding-001");
    expect(db.getMeta("embedding_model")).toBe("google/gemini-embedding-001");
    db.deleteAllEmbeddings();
    expect(db.listUnembeddedSegments(file.id)).toHaveLength(2);

    db.close();
  });
});
