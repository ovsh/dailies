import { describe, expect, it } from "vitest";

import { computePipelineProgress } from "../src/main/pipeline/status";
import type { PipelineFileFacts } from "../src/main/db/types";
import type { Job, JobStage, JobStatus, MediaFile } from "../src/shared/types";

const NOW = new Date("2026-07-31T18:00:00.000Z");

const baseFile: MediaFile = {
  id: 1,
  path: "/footage/clip-1.mov",
  filename: "clip-1.mov",
  durationS: 10,
  fps: 24,
  dropFrame: false,
  startTc: "01:00:00:00",
  codec: "prores",
  audioChannels: 2,
  fileHash: "clip-1",
  status: "pending",
  addedAt: new Date(0).toISOString(),
  hasTranscript: false,
  hasVideo: false,
  proxyPath: null,
  role: "raw",
  clipName: null,
  mediaKind: "standard",
  memberPaths: null,
  clipKey: null,
  videoUnplayable: false,
  discoveryFailed: false,
  locations: [{
    id: 1,
    fileId: 1,
    path: "/footage/clip-1.mov",
    filename: "clip-1.mov",
    clipName: null,
    role: "raw",
    folderId: null,
    memberPaths: null,
  }],
};

function makeJob(
  id: number,
  fileId: number,
  stage: JobStage,
  status: JobStatus,
  updatedAt = NOW.toISOString(),
): Job {
  return {
    id,
    fileId,
    filename: `clip-${fileId}.mov`,
    stage,
    status,
    attempts: status === "error" ? 1 : 0,
    error: status === "error" ? `${stage} failed` : null,
    updatedAt,
  };
}

function pipelineFacts(
  id: number,
  overrides: {
    file?: Partial<MediaFile>;
    jobs?: Job[];
    discoveryError?: string | null;
  } = {},
): PipelineFileFacts {
  const filename = overrides.file?.filename ?? `clip-${id}.mov`;
  const path = `/footage/${filename}`;
  const jobs = overrides.jobs ?? [];
  return {
    file: {
      ...baseFile,
      id,
      path,
      filename,
      fileHash: `clip-${id}`,
      locations: [{
        ...baseFile.locations[0]!,
        id,
        fileId: id,
        path,
        filename,
      }],
      ...overrides.file,
    },
    latestJobsByStage: new Map(jobs.map((job) => [job.stage, job])),
    discoveryError: overrides.discoveryError ?? null,
  };
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("computePipelineProgress phases", () => {
  it("starts before any files are found", () => {
    expect(computePipelineProgress([], NOW).phase).toBe("starting");
  });

  it("stays in starting while newly found files are still being read", () => {
    const probing = pipelineFacts(1, {
      file: { audioChannels: 0, hasVideo: null },
      jobs: [makeJob(1, 1, "probe", "queued")],
    });

    const progress = computePipelineProgress([probing], NOW);

    expect(progress.phase).toBe("starting");
    expect(progress.searchRemaining).toBe(1);
  });

  it("works while transcripts are pending", () => {
    const pending = pipelineFacts(1, {
      jobs: [makeJob(1, 1, "transcribe", "queued")],
    });

    expect(computePipelineProgress([pending], NOW).phase).toBe("working");
  });

  it("is ready when transcripts are done and proxies are pending", () => {
    const proxyPending = pipelineFacts(1, {
      file: { hasTranscript: true, hasVideo: true, status: "processing" },
      jobs: [
        makeJob(1, 1, "transcribe", "done"),
        makeJob(2, 1, "proxy", "queued"),
      ],
    });

    expect(computePipelineProgress([proxyPending], NOW).phase).toBe("ready");
  });

  it("finishes when both milestones are done", () => {
    const complete = pipelineFacts(1, {
      file: {
        hasTranscript: true,
        hasVideo: true,
        proxyPath: "/cache/clip-1.mp4",
        status: "ready",
      },
      jobs: [
        makeJob(1, 1, "transcribe", "done"),
        makeJob(2, 1, "proxy", "done"),
      ],
    });

    expect(computePipelineProgress([complete], NOW).phase).toBe("done");
  });
});

describe("computePipelineProgress failures", () => {
  it("separates playback failures from failures that block search", () => {
    const proxyFailure = pipelineFacts(1, {
      file: {
        hasTranscript: true,
        hasVideo: true,
        videoUnplayable: true,
        status: "ready",
      },
      jobs: [makeJob(1, 1, "proxy", "error")],
    });
    const transcriptFailure = pipelineFacts(2, {
      jobs: [makeJob(2, 2, "transcribe", "error")],
    });

    const progress = computePipelineProgress([proxyFailure, transcriptFailure], NOW);

    expect(progress.failedCount).toBe(2);
    expect(progress.cantPlayCount).toBe(1);
    expect(progress.cantFindCount).toBe(1);
    expect(computePipelineProgress([proxyFailure], NOW).playbackDone).toBe(0);
  });

  it("does not present job-only failures as lost user capabilities", () => {
    const sceneFailure = pipelineFacts(1, {
      file: {
        hasTranscript: true,
        hasVideo: true,
        proxyPath: "/cache/clip-1.mp4",
        status: "ready",
      },
      jobs: [makeJob(1, 1, "scenes", "error")],
    });
    const embedFailure = pipelineFacts(2, {
      file: { hasTranscript: true, status: "ready" },
      jobs: [makeJob(2, 2, "embed", "error")],
    });

    const progress = computePipelineProgress([sceneFailure, embedFailure], NOW);

    expect(progress.failedCount).toBe(0);
    expect(progress.cantPlayCount).toBe(0);
    expect(progress.cantFindCount).toBe(0);
  });
});

describe("computePipelineProgress ETA", () => {
  function finished(id: number, completedMinutesAgo: number): PipelineFileFacts {
    return pipelineFacts(id, {
      file: {
        hasTranscript: true,
        hasVideo: true,
        proxyPath: `/cache/clip-${id}.mp4`,
        status: "ready",
      },
      jobs: [
        makeJob(id * 10, id, "transcribe", "done", minutesAgo(completedMinutesAgo)),
        makeJob(id * 10 + 1, id, "proxy", "done", minutesAgo(completedMinutesAgo)),
      ],
    });
  }

  const pending = pipelineFacts(3, {
    file: { hasVideo: true, status: "processing" },
    jobs: [
      makeJob(30, 3, "transcribe", "queued"),
      makeJob(31, 3, "proxy", "queued"),
    ],
  });

  it("does not estimate from fewer than two recent completions", () => {
    const progress = computePipelineProgress([finished(1, 5), pending], NOW);

    expect(progress.searchableEtaSeconds).toBeNull();
    expect(progress.playbackEtaSeconds).toBeNull();
  });

  it("estimates both milestones from two recent completions", () => {
    const progress = computePipelineProgress([
      finished(1, 10),
      finished(2, 5),
      pending,
    ], NOW);

    expect(progress.searchableEtaSeconds).toBe(300);
    expect(progress.playbackEtaSeconds).toBe(300);
  });
});
