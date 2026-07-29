import type {
  FileStatus,
  Job,
  JobStage,
  PipelineActiveFile,
  PipelineCounts,
  PipelineFailure,
  PipelineFileState,
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
};

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
    if (latestJob?.status === "error" && !isPipelineStageComplete(stage, facts)) {
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
  for (const job of facts.latestJobsByStage.values()) {
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

function hasPendingWork(facts: PipelineFileFacts): boolean {
  for (const job of facts.latestJobsByStage.values()) {
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
