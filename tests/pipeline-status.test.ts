import { describe, expect, it } from "vitest";

import {
  computeFileStatus,
  latestJobsByStage,
  STAGE_POLICY,
  type FileLifecycleFacts,
} from "../src/main/pipeline/status";
import type { Job, JobStage, JobStatus } from "../src/shared/types";

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
