import type { FileStatus, Job, JobStage } from "../../shared/types";

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
