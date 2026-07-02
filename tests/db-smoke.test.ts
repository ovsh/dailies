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

    db.close();
  });
});
