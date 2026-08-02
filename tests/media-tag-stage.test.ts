import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockReadMxfProjectName, mockProbeFile } = vi.hoisted(() => ({
  mockReadMxfProjectName: vi.fn(),
  mockProbeFile: vi.fn(),
}));

vi.mock("../src/main/pipeline/opatom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/pipeline/opatom")>()),
  readMxfProjectName: mockReadMxfProjectName,
}));

vi.mock("../src/main/pipeline/probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/pipeline/probe")>()),
  probeFile: mockProbeFile,
}));

import { openDatabase } from "../src/main/db/database";
import { applyEpisodeProposal } from "../src/main/episode-detection";
import { createStages } from "../src/main/pipeline/stages";
import type { DailiesDB } from "../src/main/db/types";
import type { FileInput } from "../src/shared/types";

function makeDb(name: string): { db: DailiesDB; dataDir: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), `dailies-media-tag-stage-${name}-`));
  return { db: openDatabase(path.join(dataDir, "dailies.db")), dataDir };
}

function makeStages(db: DailiesDB, dataDir: string) {
  return createStages({
    db,
    dataDir,
    whisperModel: "unused",
    embedder: () => null,
  });
}

function addOpAtom(db: DailiesDB) {
  return db.upsertFile({
    path: "/pool/V01.mxf",
    filename: "A01.mxf",
    durationS: 10,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "dnxhd",
    audioChannels: 1,
    fileHash: "hash:atom",
    clipKey: "umid-a01",
    mediaKind: "opatom",
    memberPaths: ["/pool/V01.mxf", "/pool/A01.mxf"],
    hasVideo: true,
  });
}

afterEach(() => {
  mockReadMxfProjectName.mockReset();
  mockProbeFile.mockReset();
});

describe("media-tag stage", () => {
  it.each([
    "ffprobe timed out after 20000ms",
    "ffprobe failed (exit 1)",
  ])("does not record a failed header read as an untagged success: %s", async (message) => {
    const { db, dataDir } = makeDb("read-failure");
    const file = addOpAtom(db);
    db.enqueueJob(file.id, "media-tag");
    const job = db.claimNextJob();
    expect(job?.stage).toBe("media-tag");
    mockReadMxfProjectName.mockRejectedValueOnce(new Error(message));

    await expect(makeStages(db, dataDir).run(job!, new AbortController().signal))
      .rejects.toThrow(message);

    expect(db.getFile(file.id)?.sourceProject).toBeNull();
    expect(db.listJobsForFile(file.id)[0]?.status).toBe("running");
    expect(db.listFilesMissingSourceProject().map((candidate) => candidate.id)).toContain(file.id);
  });

  it("reconciles a standard MXF into its media-tag episode after probe", async () => {
    const { db, dataDir } = makeDb("standard-probe");
    const file = db.upsertFile({
      path: "/pool/standard.mxf",
      filename: "standard.mxf",
      durationS: 0,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "unknown",
      audioChannels: 0,
      fileHash: "hash:standard",
      mediaKind: "standard",
      hasVideo: undefined,
    });
    const [episode] = applyEpisodeProposal(db, [{
      sourceProject: "RWAR_EDIT_02",
      code: "02",
    }]);
    expect(db.getEpisodeMemberIds(episode.id)).toEqual([]);

    const probed: FileInput = {
      path: file.path,
      filename: file.filename,
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "mpeg2video",
      audioChannels: 0,
      fileHash: file.fileHash,
      hasVideo: true,
      sourceProject: "RWAR_EDIT_02",
    };
    mockProbeFile.mockResolvedValueOnce(probed);
    db.enqueueJob(file.id, "probe");
    const job = db.claimNextJob();
    expect(job?.stage).toBe("probe");

    await makeStages(db, dataDir).run(job!, new AbortController().signal);

    expect(db.getFile(file.id)?.sourceProject).toBe("RWAR_EDIT_02");
    expect(db.getEpisodeMemberIds(episode.id)).toEqual([file.id]);
  });
});
