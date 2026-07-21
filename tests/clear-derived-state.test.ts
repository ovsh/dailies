import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";

function fileInput(filePath: string, hash: string) {
  return {
    path: filePath,
    filename: path.basename(filePath),
    durationS: 10,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: hash,
    hasVideo: true,
  };
}

describe("clearDerivedState", () => {
  it("clears one file's derived facts without writing status", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-clear-derived-"));
    const dbPath = path.join(dir, "clear-derived.db");
    const db = openDatabase(dbPath);
    const cleared = db.upsertFile(fileInput("/media/cleared.mov", "cleared-hash"));
    const preserved = db.upsertFile(fileInput("/media/preserved.mov", "preserved-hash"));

    for (const file of [cleared, preserved]) {
      const token = file.id === cleared.id ? "clearedtoken" : "preservedtoken";
      db.setFileProxy(file.id, `/cache/${file.id}/proxy.mp4`);
      db.replaceTranscript(file.id, [{
        startS: 1,
        endS: 2,
        text: `${token} transcript`,
        avgConf: 1,
        words: [],
      }]);
      db.markTranscribed(file.id);
      db.replaceScenes(file.id, [{
        startS: 0,
        endS: 10,
        startTc: "01:00:00:00",
        endTc: "01:00:10:00",
        keyframePath: `/cache/${file.id}/keyframe-0.jpg`,
      }]);
      const segmentId = db.listSegments(file.id)[0]!.id;
      const vector = new Float32Array(768);
      vector[file.id === cleared.id ? 0 : 1] = 1;
      db.upsertEmbedding("segment", segmentId, vector);
      db.enqueueJob(file.id, "embed");
    }

    const raw = new Database(dbPath);
    raw.prepare("UPDATE files SET status = 'ready'").run();
    raw.close();

    db.clearDerivedState(cleared.id);

    expect(db.getFile(cleared.id)).toMatchObject({
      status: "ready",
      hasTranscript: false,
      proxyPath: null,
    });
    expect(db.listSegments(cleared.id)).toEqual([]);
    expect(db.listScenes(cleared.id)).toEqual([]);
    expect(db.searchTranscripts(["clearedtoken"])).toEqual([]);
    const clearedVector = new Float32Array(768);
    clearedVector[0] = 1;
    expect(db.semanticSearch("segment", clearedVector)).toEqual([]);
    expect(db.listJobs().map((job) => job.fileId)).toEqual([preserved.id]);

    expect(db.getFile(preserved.id)).toMatchObject({
      status: "ready",
      hasTranscript: true,
      proxyPath: `/cache/${preserved.id}/proxy.mp4`,
    });
    expect(db.listSegments(preserved.id)).toHaveLength(1);
    expect(db.listScenes(preserved.id)).toHaveLength(1);
    expect(db.searchTranscripts(["preservedtoken"])).toHaveLength(1);
    const preservedVector = new Float32Array(768);
    preservedVector[1] = 1;
    expect(db.semanticSearch("segment", preservedVector)).toHaveLength(1);
    db.close();
  });
});
