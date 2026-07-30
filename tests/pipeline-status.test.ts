import { describe, expect, it } from "vitest";

import {
  computeFileStatus,
  computePipelineFileState,
  computePipelineSnapshot,
  latestJobsByStage,
  STAGE_POLICY,
  type FileLifecycleFacts,
} from "../src/main/pipeline/status";
import type { Job, JobStage, JobStatus, MediaFile } from "../src/shared/types";
import type { PipelineFileFacts } from "../src/main/db/types";

function makeJob(
  id: number,
  stage: JobStage,
  status: JobStatus,
): Job {
  return {
    id,
    fileId: 1,
    filename: "clip.mov",
    stage,
    status,
    attempts: status === "error" ? 1 : 0,
    error: status === "error" ? `${stage} failed` : null,
    updatedAt: new Date(id).toISOString(),
  };
}

function facts(overrides: Partial<FileLifecycleFacts> = {}): FileLifecycleFacts {
  return {
    hasVideo: false,
    hasTranscript: false,
    proxyPath: null,
    videoUnplayable: false,
    discoveryFailed: false,
    probed: false,
    latestJobs: new Map(),
    ...overrides,
  };
}

const pipelineFile: MediaFile = {
  id: 1,
  path: "/footage/clip.mov",
  filename: "clip.mov",
  durationS: 10,
  fps: 24,
  dropFrame: false,
  startTc: "01:00:00:00",
  codec: "prores",
  audioChannels: 2,
  fileHash: "clip",
  status: "ready",
  addedAt: new Date(0).toISOString(),
  hasTranscript: true,
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
    path: "/footage/clip.mov",
    filename: "clip.mov",
    clipName: null,
    role: "raw",
    folderId: null,
    memberPaths: null,
  }],
};

function pipelineFacts(
  overrides: {
    file?: Partial<MediaFile>;
    latestJobsByStage?: Map<JobStage, Job>;
    discoveryError?: string | null;
  } = {},
): PipelineFileFacts {
  return {
    file: { ...pipelineFile, ...overrides.file },
    latestJobsByStage: overrides.latestJobsByStage ?? new Map(),
    discoveryError: overrides.discoveryError ?? null,
  };
}

describe("computeFileStatus", () => {
  it.each([
    {
      name: "discovery failure outranks complete artifacts",
      input: facts({
        discoveryFailed: true,
        hasTranscript: true,
        proxyPath: "/cache/proxy.mp4",
        probed: true,
      }),
      expected: "error",
    },
    {
      name: "errored probe without probe artifacts",
      input: facts({
        latestJobs: new Map([["probe", makeJob(1, "probe", "error")]]),
      }),
      expected: "error",
    },
    {
      name: "errored audio without a downstream transcript artifact",
      input: facts({
        probed: true,
        latestJobs: new Map([["audio", makeJob(1, "audio", "error")]]),
      }),
      expected: "error",
    },
    {
      name: "errored transcription without a transcript artifact",
      input: facts({
        probed: true,
        latestJobs: new Map([["transcribe", makeJob(1, "transcribe", "error")]]),
      }),
      expected: "error",
    },
    {
      name: "transcript artifact outranks old audio and transcription errors",
      input: facts({
        hasTranscript: true,
        probed: true,
        latestJobs: new Map([
          ["audio", makeJob(1, "audio", "error")],
          ["transcribe", makeJob(2, "transcribe", "error")],
        ]),
      }),
      expected: "ready",
    },
    {
      name: "probe artifacts outrank an old probe error",
      input: facts({
        hasTranscript: true,
        probed: true,
        latestJobs: new Map([["probe", makeJob(1, "probe", "error")]]),
      }),
      expected: "ready",
    },
    {
      name: "silent clip is ready without audio or transcription jobs",
      input: facts({ hasTranscript: true, probed: true }),
      expected: "ready",
    },
    {
      name: "video is ready with transcript and proxy",
      input: facts({
        hasVideo: true,
        hasTranscript: true,
        proxyPath: "/cache/proxy.mp4",
        probed: true,
      }),
      expected: "ready",
    },
    {
      name: "unplayable video is ready with a transcript",
      input: facts({
        hasVideo: true,
        hasTranscript: true,
        videoUnplayable: true,
        probed: true,
      }),
      expected: "ready",
    },
    {
      name: "video remains processing while its proxy is absent",
      input: facts({ hasVideo: true, hasTranscript: true, probed: true }),
      expected: "processing",
    },
    {
      name: "probed media without a transcript is processing",
      input: facts({ probed: true }),
      expected: "processing",
    },
    {
      name: "media with no jobs or probe artifacts is pending",
      input: facts(),
      expected: "pending",
    },
    {
      name: "legacy unknown video stays processing until it is backfilled",
      input: facts({ hasVideo: null, hasTranscript: true, probed: true }),
      expected: "processing",
    },
    {
      name: "legacy unknown video with a proxy is ready",
      input: facts({
        hasVideo: null,
        hasTranscript: true,
        proxyPath: "/cache/proxy.mp4",
        probed: true,
      }),
      expected: "ready",
    },
    {
      name: "scenes and embed errors stay job-only",
      input: facts({
        hasTranscript: true,
        probed: true,
        latestJobs: new Map([
          ["scenes", makeJob(1, "scenes", "error")],
          ["embed", makeJob(2, "embed", "error")],
        ]),
      }),
      expected: "ready",
    },
  ])("$name", ({ input, expected }) => {
    expect(computeFileStatus(input)).toBe(expected);
  });

  it("uses the highest job id for each stage", () => {
    const latestJobs = latestJobsByStage([
      makeJob(9, "transcribe", "done"),
      makeJob(3, "transcribe", "error"),
      makeJob(7, "audio", "error"),
      makeJob(11, "audio", "done"),
    ]);

    expect(latestJobs.get("transcribe")?.id).toBe(9);
    expect(latestJobs.get("audio")?.id).toBe(11);
    expect(computeFileStatus(facts({ probed: true, latestJobs }))).toBe("processing");
  });

  it("defines the reviewed policy for every stage", () => {
    expect(STAGE_POLICY).toEqual({
      probe: { blocksReadiness: true, failureImpact: "file-error" },
      audio: { blocksReadiness: true, failureImpact: "file-error" },
      proxy: { blocksReadiness: true, failureImpact: "degrade-video" },
      scenes: { blocksReadiness: false, failureImpact: "job-only" },
      transcribe: { blocksReadiness: true, failureImpact: "file-error" },
      embed: { blocksReadiness: false, failureImpact: "job-only" },
    });
  });
});

describe("pipeline file state and snapshot", () => {
  it.each([
    {
      name: "classifies a durable discovery reason as failed",
      input: pipelineFacts({ discoveryError: "Permission denied" }),
      expected: "failed",
    },
    {
      name: "classifies a terminal embed failure as failed",
      input: pipelineFacts({
        latestJobsByStage: new Map([["embed", makeJob(1, "embed", "error")]]),
      }),
      expected: "failed",
    },
    {
      name: "classifies a launched stage as processing",
      input: pipelineFacts({
        latestJobsByStage: new Map([["embed", makeJob(1, "embed", "running")]]),
      }),
      expected: "processing",
    },
    {
      name: "classifies a paused prerequisite as queued",
      input: pipelineFacts({
        latestJobsByStage: new Map([["transcribe", makeJob(1, "transcribe", "waiting")]]),
      }),
      expected: "queued",
    },
    {
      name: "keeps searchable footage queued while embedding remains",
      input: pipelineFacts({
        latestJobsByStage: new Map([["embed", makeJob(1, "embed", "queued")]]),
      }),
      expected: "queued",
    },
    {
      name: "classifies completed searchable footage as done",
      input: pipelineFacts(),
      expected: "done",
    },
  ])("$name", ({ input, expected }) => {
    expect(computePipelineFileState(input)).toBe(expected);
  });

  it("derives coverage, rate, and ETA from terminal file facts", () => {
    const first = pipelineFacts({
      file: { id: 1, filename: "first.mov" },
      latestJobsByStage: new Map([["embed", {
        ...makeJob(1, "embed", "done"),
        updatedAt: new Date(0).toISOString(),
      }]]),
    });
    const second = pipelineFacts({
      file: { id: 2, filename: "second.mov" },
      latestJobsByStage: new Map([["embed", {
        ...makeJob(2, "embed", "done"),
        updatedAt: new Date(60_000).toISOString(),
      }]]),
    });
    const queued = pipelineFacts({
      file: {
        id: 3,
        filename: "queued.mov",
        status: "pending",
        hasTranscript: false,
        hasVideo: null,
      },
    });

    const snapshot = computePipelineSnapshot([first, second, queued], 3, new Date(120_000));

    expect(snapshot.counts).toEqual({ queued: 1, processing: 0, done: 2, failed: 0 });
    expect(snapshot.coverage).toEqual({
      totalFiles: 3,
      searchableFiles: 2,
      pendingFiles: 1,
      failedFiles: 0,
      producerNoteCount: 3,
    });
    expect(snapshot.percentProcessed).toBeCloseTo(2 / 3);
    expect(snapshot.filesPerMinute).toBe(1);
    expect(snapshot.etaSeconds).toBe(60);
  });

  it("leaves rate and ETA absent until terminal timestamps establish a rate", () => {
    const snapshot = computePipelineSnapshot([
      pipelineFacts({
        latestJobsByStage: new Map([["embed", makeJob(1, "embed", "done")]]),
      }),
      pipelineFacts({
        file: { id: 2, status: "pending", hasTranscript: false, hasVideo: null },
      }),
    ]);

    expect(snapshot.filesPerMinute).toBeNull();
    expect(snapshot.etaSeconds).toBeNull();
  });

  it("reports running work even when another stage classifies the file as failed", () => {
    const failedWithRunningWork = pipelineFacts({
      latestJobsByStage: new Map([
        ["embed", makeJob(1, "embed", "error")],
        ["scenes", makeJob(2, "scenes", "running")],
      ]),
    });

    const snapshot = computePipelineSnapshot([failedWithRunningWork]);

    expect(snapshot.counts.failed).toBe(1);
    expect(snapshot.activeFiles).toEqual([{
      fileId: 1,
      filename: "clip.mov",
      stage: "scenes",
    }]);
  });

  it("reports file ids with queued, running, or waiting work", () => {
    const queued = pipelineFacts({
      latestJobsByStage: new Map([["embed", makeJob(1, "embed", "queued")]]),
    });
    const done = pipelineFacts({
      file: { id: 2, filename: "done.mov" },
      latestJobsByStage: new Map([["embed", makeJob(2, "embed", "done")]]),
    });

    expect(computePipelineSnapshot([queued, done]).pendingFileIds).toEqual([1]);
  });
});
