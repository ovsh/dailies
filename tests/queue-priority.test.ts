import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";
import type { JobStage } from "../src/shared/types";

function makeDb(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-claim-priority-"));
  return openDatabase(path.join(dir, `${name}.db`));
}

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
  };
}

describe("search-first claim priority", () => {
  it("claims transcript-producing stages before playback stages, FIFO within a stage", () => {
    const db = makeDb("stage-order");
    const first = db.upsertFile(fileInput("/media/first.mov", "a"));
    const second = db.upsertFile(fileInput("/media/second.mov", "b"));

    // Enqueue in the order discovery would: heavy playback work first, so a
    // FIFO queue would claim proxies ahead of everything else.
    db.enqueueJob(first.id, "proxy");
    db.enqueueJob(first.id, "scenes");
    db.enqueueJob(second.id, "proxy");
    db.enqueueJob(second.id, "embed");
    db.enqueueJob(second.id, "audio");
    db.enqueueJob(first.id, "audio");
    db.enqueueJob(first.id, "transcribe");
    db.enqueueJob(second.id, "probe");

    const claimed: Array<{ stage: JobStage; fileId: number }> = [];
    for (;;) {
      const job = db.claimNextJob();
      if (!job) break;
      claimed.push({ stage: job.stage, fileId: job.fileId });
    }

    expect(claimed).toEqual([
      { stage: "probe", fileId: second.id },
      { stage: "audio", fileId: second.id },
      { stage: "audio", fileId: first.id },
      { stage: "transcribe", fileId: first.id },
      { stage: "embed", fileId: second.id },
      { stage: "proxy", fileId: first.id },
      { stage: "proxy", fileId: second.id },
      { stage: "scenes", fileId: first.id },
    ]);
  });

  it("skips past the transcribe backlog when asked to exclude the stage", () => {
    const db = makeDb("exclude-stage");
    const file = db.upsertFile(fileInput("/media/only.mov", "c"));

    db.enqueueJob(file.id, "proxy");
    db.enqueueJob(file.id, "transcribe");

    const skipped = db.claimNextJob("transcribe");
    expect(skipped?.stage).toBe("proxy");

    // With the cap no longer full, the transcribe job is next as usual.
    const next = db.claimNextJob();
    expect(next?.stage).toBe("transcribe");

    expect(db.claimNextJob()).toBeNull();
  });

  it("returns null when the only queued work is excluded", () => {
    const db = makeDb("exclude-only");
    const file = db.upsertFile(fileInput("/media/solo.mov", "d"));
    db.enqueueJob(file.id, "transcribe");

    expect(db.claimNextJob("transcribe")).toBeNull();
    expect(db.claimNextJob()?.stage).toBe("transcribe");
  });
});
