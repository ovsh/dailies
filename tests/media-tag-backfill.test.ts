import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/main/db/database";
import { createQueue, PipelineBudget } from "../src/main/pipeline/queue";
import type { DailiesDB } from "../src/main/db/types";
import type { Job, JobStage } from "../src/shared/types";

function makeDb(name: string): DailiesDB {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-media-tag-backfill-"));
  return openDatabase(path.join(dir, `${name}.db`));
}

function addAtomClip(db: DailiesDB, name: string, sourceProject: string | null) {
  return db.upsertFile({
    path: `/pool/${name}`,
    filename: name,
    durationS: 10,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "dnxhd",
    audioChannels: 2,
    fileHash: `hash:${name}`,
    clipName: name,
    clipKey: `umid-${name}`,
    mediaKind: "opatom",
    memberPaths: [`/pool/${name}/V01.mxf`, `/pool/${name}/A01.mxf`],
    sourceProject,
  });
}

function stubQueue(db: DailiesDB) {
  const ensureWork = vi.fn();
  const reconcile = vi.fn();
  const reconcileAndEnsureAllFiles = vi.fn();
  const runStage = vi.fn(async (_job: Job) => {});
  const queue = createQueue({
    db,
    budget: new PipelineBudget({ concurrency: 2, transcribeConcurrency: 1 }),
    runStage,
    reconcile,
    ensureWork,
    reconcileAndEnsureAllFiles,
    scheduleUpdate: () => {},
    delay: async () => {},
  });
  return { queue, ensureWork, reconcile, reconcileAndEnsureAllFiles, runStage };
}

function stagesInQueue(db: DailiesDB): JobStage[] {
  return db.listJobs().map((job) => job.stage);
}

describe("media-tag backfill", () => {
  it("queues one tag read per untagged MXF clip and nothing else", () => {
    const db = makeDb("scope");
    const first = addAtomClip(db, "a01", null);
    const second = addAtomClip(db, "a02", null);
    addAtomClip(db, "a03", "RWAR_EDIT_02");
    const standardMxf = db.upsertFile({
      path: "/pool/standard.mxf",
      filename: "standard.mxf",
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "mpeg2video",
      audioChannels: 2,
      fileHash: "hash:standard-mxf",
      mediaKind: "standard",
    });
    // Non-MXF standard media is outside this metadata backfill.
    db.upsertFile({
      path: "/pool/standard.mov",
      filename: "standard.mov",
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "hash:standard",
    });

    const { queue, ensureWork, reconcile, reconcileAndEnsureAllFiles } = stubQueue(db);
    expect(queue.backfillSourceProjects()).toBe(3);

    expect(db.listJobs().map((job) => ({ stage: job.stage, fileId: job.fileId })))
      .toEqual(expect.arrayContaining([
        { stage: "media-tag", fileId: first.id },
        { stage: "media-tag", fileId: second.id },
        { stage: "media-tag", fileId: standardMxf.id },
      ]));
    expect(db.listJobs()).toHaveLength(3);
    // No audio, proxy, scenes, transcribe, or embed work may come out of this.
    expect(new Set(stagesInQueue(db))).toEqual(new Set(["media-tag"]));
    expect(ensureWork).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(reconcileAndEnsureAllFiles).not.toHaveBeenCalled();
  });

  it("does not re-probe a clip whose tag read already finished with no tag", () => {
    const db = makeDb("done");
    const file = addAtomClip(db, "a01", null);
    const { queue } = stubQueue(db);

    expect(queue.backfillSourceProjects()).toBe(1);
    const job = db.claimNextJob();
    expect(job?.stage).toBe("media-tag");
    db.completeJob(job!.id);

    // The finished job is the record of "already looked".
    expect(db.listFilesMissingSourceProject()).toEqual([]);
    expect(queue.backfillSourceProjects()).toBe(0);
    expect(db.getFile(file.id)?.sourceProject).toBeNull();

    // A clip that never got a job is still picked up.
    const later = addAtomClip(db, "a02", null);
    expect(db.listFilesMissingSourceProject().map((f) => f.id)).toEqual([later.id]);
    expect(queue.backfillSourceProjects()).toBe(1);
    expect(db.listJobs().filter((j) => j.fileId === later.id).map((j) => j.stage)).toEqual([
      "media-tag",
    ]);
  });
});
