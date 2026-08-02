import type {
  FileStatus,
  Job,
  JobStage,
  PipelineActiveFile,
  PipelineCounts,
  PipelineFailure,
  PipelineFileState,
  PipelinePhase,
  PipelineProgress,
  PipelineSnapshot,
  SearchCoverage,
} from "../../shared/types";
import type { PipelineFileFacts } from "../db/types";

export interface FileLifecycleFacts {
  hasVideo: boolean | null;
  hasTranscript: boolean;
  proxyPath: string | null;
  videoUnplayable: boolean;
  discoveryFailed: boolean;
  probed: boolean;
  latestJobs: Map<JobStage, Job>;
}

export const STAGE_POLICY: Record<JobStage, {
  blocksReadiness: boolean;
  failureImpact: "file-error" | "degrade-video" | "job-only";
}> = {
  probe: { blocksReadiness: true, failureImpact: "file-error" },
  audio: { blocksReadiness: true, failureImpact: "file-error" },
  proxy: { blocksReadiness: true, failureImpact: "degrade-video" },
  scenes: { blocksReadiness: false, failureImpact: "job-only" },
  transcribe: { blocksReadiness: true, failureImpact: "file-error" },
  embed: { blocksReadiness: false, failureImpact: "job-only" },
  "media-tag": { blocksReadiness: false, failureImpact: "job-only" },
};

// The readiness stages, in order. "media-tag" is deliberately absent: it is a
// metadata backfill, not part of what makes a clip ready, so it must not move
// any status, percentage, or ETA.
const JOB_STAGES: JobStage[] = [
  "probe",
  "audio",
  "proxy",
  "scenes",
  "transcribe",
  "embed",
];

const RATE_WINDOW_MS = 15 * 60 * 1000;

export function latestJobsByStage(jobs: Iterable<Job>): Map<JobStage, Job> {
  const latestJobs = new Map<JobStage, Job>();
  for (const job of jobs) {
    const current = latestJobs.get(job.stage);
    if (!current || job.id > current.id) latestJobs.set(job.stage, job);
  }
  return latestJobs;
}

function hasRequiredArtifact(
  stage: JobStage,
  facts: FileLifecycleFacts,
): boolean {
  switch (stage) {
    case "probe":
      return facts.probed;
    case "audio":
    case "transcribe":
      return facts.hasTranscript;
    case "proxy":
      return facts.proxyPath !== null || facts.videoUnplayable;
    case "scenes":
    case "embed":
    case "media-tag":
      return true;
  }
}

export function computeFileStatus(facts: FileLifecycleFacts): FileStatus {
  if (facts.discoveryFailed) return "error";

  for (const stage of JOB_STAGES) {
    if (STAGE_POLICY[stage].failureImpact !== "file-error") continue;
    const latestJob = facts.latestJobs.get(stage);
    if (latestJob?.status === "error" && !hasRequiredArtifact(stage, facts)) {
      return "error";
    }
  }

  const videoReady = facts.hasVideo === false ||
    facts.proxyPath !== null ||
    facts.videoUnplayable;
  if (facts.hasTranscript && videoReady) return "ready";
  if (facts.probed) return "processing";
  return "pending";
}

function isPipelineStageExpected(stage: JobStage, facts: PipelineFileFacts): boolean {
  if (facts.latestJobsByStage.has(stage)) return true;
  if (!STAGE_POLICY[stage].blocksReadiness) return false;

  switch (stage) {
    case "probe":
      return facts.file.hasVideo === null;
    case "audio":
    case "transcribe":
      return facts.file.audioChannels > 0 && !facts.file.hasTranscript;
    case "proxy":
      return facts.file.hasVideo === true &&
        !facts.file.videoUnplayable &&
        facts.file.proxyPath === null;
    case "scenes":
    case "embed":
    case "media-tag":
      return false;
  }
}

function isPipelineStageComplete(stage: JobStage, facts: PipelineFileFacts): boolean {
  const latestJob = facts.latestJobsByStage.get(stage);
  if (latestJob?.status === "done") return true;
  if (!STAGE_POLICY[stage].blocksReadiness) return false;

  switch (stage) {
    case "probe":
      return facts.file.hasVideo !== null;
    case "audio":
    case "transcribe":
      return facts.file.hasTranscript;
    case "proxy":
      return facts.file.hasVideo === false ||
        facts.file.videoUnplayable ||
        facts.file.proxyPath !== null;
    case "scenes":
    case "embed":
    case "media-tag":
      return false;
  }
}

export function computePipelineFileState(facts: PipelineFileFacts): PipelineFileState {
  if (facts.file.discoveryFailed || facts.discoveryError !== null || facts.file.status === "error") {
    return "failed";
  }

  for (const stage of JOB_STAGES) {
    if (!isPipelineStageExpected(stage, facts)) continue;
    const latestJob = facts.latestJobsByStage.get(stage);
    if (
      latestJob?.status === "error" &&
      (
        STAGE_POLICY[stage].failureImpact === "degrade-video" ||
        !isPipelineStageComplete(stage, facts)
      )
    ) {
      return "failed";
    }
  }

  for (const stage of JOB_STAGES) {
    if (!isPipelineStageExpected(stage, facts)) continue;
    if (facts.latestJobsByStage.get(stage)?.status === "running") return "processing";
  }

  for (const stage of JOB_STAGES) {
    if (!isPipelineStageExpected(stage, facts)) continue;
    const latestJob = facts.latestJobsByStage.get(stage);
    if (latestJob?.status === "queued" || latestJob?.status === "waiting") return "queued";
    if (!isPipelineStageComplete(stage, facts)) return "queued";
  }

  return facts.file.status === "ready" ? "done" : "queued";
}

function latestTerminalTimestamp(facts: PipelineFileFacts): number | null {
  let latest: number | null = null;
  for (const stage of JOB_STAGES) {
    const job = facts.latestJobsByStage.get(stage);
    if (!job) continue;
    if (job.status !== "done" && job.status !== "error") continue;
    const timestamp = Date.parse(job.updatedAt);
    if (Number.isNaN(timestamp)) continue;
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

function makeActiveFile(facts: PipelineFileFacts): PipelineActiveFile | null {
  for (const stage of JOB_STAGES) {
    if (facts.latestJobsByStage.get(stage)?.status === "running") {
      return { fileId: facts.file.id, filename: facts.file.filename, stage };
    }
  }
  return null;
}

// Readiness stages only: a queued media-tag backfill is not work that keeps a
// clip out of the library, so it must not show the clip as still indexing.
function hasPendingWork(facts: PipelineFileFacts): boolean {
  for (const stage of JOB_STAGES) {
    const job = facts.latestJobsByStage.get(stage);
    if (!job) continue;
    if (job.status === "queued" || job.status === "running" || job.status === "waiting") {
      return true;
    }
  }
  return false;
}

function makeFailure(facts: PipelineFileFacts): PipelineFailure {
  if (facts.discoveryError !== null || facts.file.discoveryFailed) {
    return {
      fileId: facts.file.id,
      filename: facts.file.filename,
      stage: "discovery",
      reason: facts.discoveryError ?? "File discovery failed",
      attempts: 0,
      updatedAt: facts.file.addedAt,
    };
  }

  for (const stage of JOB_STAGES) {
    const job = facts.latestJobsByStage.get(stage);
    if (job?.status === "error") {
      return {
        fileId: facts.file.id,
        filename: facts.file.filename,
        stage,
        reason: job.error ?? `${stage} failed`,
        attempts: job.attempts,
        updatedAt: job.updatedAt,
      };
    }
  }

  return {
    fileId: facts.file.id,
    filename: facts.file.filename,
    stage: "discovery",
    reason: "File failed without a recorded reason",
    attempts: 0,
    updatedAt: facts.file.addedAt,
  };
}

function makeCoverage(
  facts: PipelineFileFacts[],
  states: Map<number, PipelineFileState>,
  producerNoteCount: number,
): SearchCoverage {
  const searchableFiles = facts.filter((item) => item.file.hasTranscript).length;
  const failedFiles = facts.filter((item) => states.get(item.file.id) === "failed").length;
  const pendingFiles = facts.filter((item) =>
    !item.file.hasTranscript && states.get(item.file.id) !== "failed"
  ).length;
  return {
    totalFiles: facts.length,
    searchableFiles,
    pendingFiles,
    failedFiles,
    producerNoteCount,
  };
}

function recentDoneTimestamp(
  job: Job | undefined,
  now: Date,
): number | null {
  if (job?.status !== "done") return null;
  const timestamp = Date.parse(job.updatedAt);
  if (Number.isNaN(timestamp)) return null;
  return now.getTime() - timestamp <= RATE_WINDOW_MS ? timestamp : null;
}

/** Same rate math as the snapshot ETA, but scoped to one milestone's completions. */
function etaFromTimestamps(timestamps: number[], remaining: number): number | null {
  if (timestamps.length < 2 || remaining === 0) return null;
  timestamps.sort((a, b) => a - b);
  const elapsedMs = timestamps[timestamps.length - 1]! - timestamps[0]!;
  if (elapsedMs <= 0) return null;
  const perMinute = (timestamps.length - 1) / (elapsedMs / 60_000);
  return Math.ceil((remaining / perMinute) * 60);
}

export function computePipelineProgress(
  facts: PipelineFileFacts[],
  now = new Date(),
): PipelineProgress {
  let searchableFiles = 0;
  let searchRemaining = 0;
  let playbackDone = 0;
  let playbackRemaining = 0;
  let cantFindCount = 0;
  let cantPlayCount = 0;
  let failedCount = 0;
  let searchWorkStarted = false;
  const searchDone: number[] = [];
  const playbackDoneAt: number[] = [];

  for (const item of facts) {
    const failed = computePipelineFileState(item) === "failed";
    const failureStage = failed ? makeFailure(item).stage : null;
    const blocksFinding = failureStage === "discovery" ||
      failureStage === "probe" ||
      failureStage === "audio" ||
      failureStage === "transcribe";
    const blocksPlayback = failureStage === "proxy";
    if (blocksFinding) {
      failedCount += 1;
      cantFindCount += 1;
    } else if (blocksPlayback) {
      failedCount += 1;
      cantPlayCount += 1;
    }

    if (item.file.hasTranscript) {
      searchableFiles += 1;
      searchWorkStarted = true;
      const t = recentDoneTimestamp(item.latestJobsByStage.get("transcribe"), now);
      if (t !== null) searchDone.push(t);
    } else if (!blocksFinding) {
      searchRemaining += 1;
      if (isPipelineStageExpected("transcribe", item)) searchWorkStarted = true;
    }

    if (isPipelineStageComplete("proxy", item) && !item.file.videoUnplayable) {
      playbackDone += 1;
      const t = recentDoneTimestamp(item.latestJobsByStage.get("proxy"), now);
      if (t !== null) playbackDoneAt.push(t);
    } else if (!blocksPlayback && isPipelineStageExpected("proxy", item)) {
      playbackRemaining += 1;
    }
  }

  const searchableEtaSeconds = etaFromTimestamps(searchDone, searchRemaining);
  const playbackEtaSeconds = etaFromTimestamps(playbackDoneAt, playbackRemaining);

  const phase: PipelinePhase = facts.length === 0 || (searchRemaining > 0 && !searchWorkStarted)
    ? "starting"
    : searchRemaining > 0
      ? "working"
      : playbackRemaining > 0
        ? "ready"
        : "done";

  return {
    phase,
    totalFiles: facts.length,
    searchableFiles,
    searchRemaining,
    searchableEtaSeconds,
    playbackDone,
    playbackRemaining,
    playbackEtaSeconds,
    cantFindCount,
    cantPlayCount,
    failedCount,
    updatedAt: now.toISOString(),
  };
}

export function computePipelineSnapshot(
  facts: PipelineFileFacts[],
  producerNoteCount = 0,
  now = new Date(),
): PipelineSnapshot {
  const counts: PipelineCounts = { queued: 0, processing: 0, done: 0, failed: 0 };
  const states = new Map<number, PipelineFileState>();
  const activeFiles: PipelineActiveFile[] = [];
  const pendingFileIds: number[] = [];
  const failures: PipelineFailure[] = [];
  const terminalTimestamps: number[] = [];

  for (const item of facts) {
    const state = computePipelineFileState(item);
    states.set(item.file.id, state);
    counts[state] += 1;
    const activeFile = makeActiveFile(item);
    if (activeFile) activeFiles.push(activeFile);
    if (hasPendingWork(item)) pendingFileIds.push(item.file.id);
    if (state === "failed") failures.push(makeFailure(item));
    if (state === "done" || state === "failed") {
      const timestamp = latestTerminalTimestamp(item);
      if (timestamp !== null && now.getTime() - timestamp <= RATE_WINDOW_MS) {
        terminalTimestamps.push(timestamp);
      }
    }
  }

  terminalTimestamps.sort((a, b) => a - b);
  const firstTerminal = terminalTimestamps[0];
  const lastTerminal = terminalTimestamps[terminalTimestamps.length - 1];
  const elapsedMs = firstTerminal === undefined || lastTerminal === undefined
    ? 0
    : lastTerminal - firstTerminal;
  const filesPerMinute = terminalTimestamps.length >= 2 && elapsedMs > 0
    ? (terminalTimestamps.length - 1) / (elapsedMs / 60_000)
    : null;
  const remainingFiles = counts.queued + counts.processing;
  const etaSeconds = filesPerMinute === null || remainingFiles === 0
    ? null
    : Math.ceil((remainingFiles / filesPerMinute) * 60);

  return {
    counts,
    percentProcessed: facts.length === 0 ? 0 : (counts.done + counts.failed) / facts.length,
    filesPerMinute,
    etaSeconds,
    activeFiles,
    pendingFileIds,
    failures,
    coverage: makeCoverage(facts, states, producerNoteCount),
    updatedAt: now.toISOString(),
  };
}
