import { OpenRouterApiError } from "../agents/openrouter-client";
import type { DailiesDB } from "../db/types";
import type { Job } from "../../shared/types";
import { STAGE_POLICY } from "./status";

const MAX_CONCURRENCY = 2;
const MAX_TRANSCRIBE_CONCURRENCY = 1;
const IDLE_POLL_MS = 1500;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const EVENT_LOOP_PROBE_MS = 100;

export interface PipelineBudgetTotals {
  readonly inFlightCount: number;
  readonly transcribeInFlight: number;
}

export class PipelineBudget {
  private inFlightCount = 0;
  private transcribeInFlight = 0;

  acquire(stage: Job["stage"]): boolean {
    if (this.inFlightCount >= MAX_CONCURRENCY) return false;
    if (
      stage === "transcribe" &&
      this.transcribeInFlight >= MAX_TRANSCRIBE_CONCURRENCY
    ) {
      return false;
    }
    this.inFlightCount += 1;
    if (stage === "transcribe") this.transcribeInFlight += 1;
    return true;
  }

  release(stage: Job["stage"]): void {
    if (this.inFlightCount <= 0) {
      throw new Error("Pipeline budget released without an acquired stage");
    }
    if (stage === "transcribe") {
      if (this.transcribeInFlight <= 0) {
        throw new Error("Pipeline transcription budget released without an acquired stage");
      }
      this.transcribeInFlight -= 1;
    }
    this.inFlightCount -= 1;
  }

  get totals(): PipelineBudgetTotals {
    return {
      inFlightCount: this.inFlightCount,
      transcribeInFlight: this.transcribeInFlight,
    };
  }
}

interface QueueActivity {
  queuedClaims: number;
  launchedJobs: number;
  inFlightCount: number;
  transcribeInFlight: number;
}

export type StopMode = "drain" | "abort";

type StageOutcome = "fulfilled" | "retry-scheduled" | "failed" | "aborted";

type QueueDiagnostic =
  | {
      event: "claim" | "launch";
      jobId: number;
      fileId: number;
      stage: Job["stage"];
    }
  | {
      event: "permit-wait";
      jobId: number;
      fileId: number;
      stage: Job["stage"];
      durationMs: number;
      outcome: "started" | "acquired";
    }
  | {
      event: "stage-completion";
      jobId: number;
      fileId: number;
      stage: Job["stage"];
      durationMs: number;
      outcome: StageOutcome;
    }
  | {
      event: "event-loop-delay";
      jobId: number;
      fileId: number;
      stage: Job["stage"];
      durationMs: number;
      outcome: "observed";
    }
  | {
      event: "stop-wait";
      durationMs: number;
      outcome: "idle" | "drained" | "timed-out" | "aborted";
    };

export interface QueueOptions {
  db: DailiesDB;
  budget: PipelineBudget;
  runStage: (job: Job, signal: AbortSignal) => Promise<void>;
  reconcile: (fileId: number) => void;
  ensureWork: (fileId: number) => void;
  reconcileAndEnsureAllFiles: () => void;
  scheduleUpdate: () => void;
  delay: (ms: number) => Promise<void>;
}

export interface JobQueue {
  retryFile(fileId: number): Promise<void>;
  refreshPrerequisites(kind: "whisper" | "openrouter" | "all"): Promise<void>;
  start(): void;
  stop(mode?: StopMode): Promise<void>;
}

export function createQueue(opts: QueueOptions): JobQueue {
  const {
    db,
    budget,
    runStage,
    reconcile,
    ensureWork,
    reconcileAndEnsureAllFiles,
    scheduleUpdate,
    delay,
  } = opts;

  let running = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;

  const activity: QueueActivity = {
    queuedClaims: 0,
    launchedJobs: 0,
    inFlightCount: 0,
    transcribeInFlight: 0,
  };
  let waitingForPermit: { jobId: number; startedAt: number } | null = null;
  const inFlightJobs = new Map<Promise<void>, AbortController>();

  function logActivity(diagnostic: QueueDiagnostic): void {
    console.warn("[pipeline] queue", JSON.stringify({ ...diagnostic, ...activity }));
  }

  function startEventLoopDelayProbe(): () => number {
    const expectedAt = Date.now() + EVENT_LOOP_PROBE_MS;
    let observedDelayMs: number | null = null;
    const timer = setTimeout(() => {
      observedDelayMs = Math.max(0, Date.now() - expectedAt);
    }, EVENT_LOOP_PROBE_MS);
    return () => {
      clearTimeout(timer);
      return observedDelayMs ?? Math.max(0, Date.now() - expectedAt);
    };
  }

  async function refreshPrerequisites(kind: "whisper" | "openrouter" | "all"): Promise<void> {
    if (kind === "whisper" || kind === "all") {
      db.requeueWaitingJobs(["transcribe"]);
    }
    if (kind === "openrouter") {
      db.reopenErroredJobs(undefined, ["embed"]);
    }
    if (kind === "openrouter" || kind === "all") {
      db.requeueWaitingJobs(["embed"]);
    }
    reconcileAndEnsureAllFiles();
    scheduleUpdate();
    kick();
  }

  async function retryFile(fileId: number): Promise<void> {
    const file = db.getFile(fileId);
    if (!file) throw new Error(`Unknown file ${fileId}`);
    db.reopenErroredJobs(fileId);

    if (file.videoUnplayable) db.setVideoUnplayable(fileId, false);
    db.setDiscoveryFailure(fileId, null);
    reconcile(fileId);
    ensureWork(fileId);
    scheduleUpdate();
    kick();
  }

  function isTransientError(err: unknown): boolean {
    const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return /\b429\b|\b5\d\d\b|rate.?limit|temporar|timeout|timed out|network|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket/i.test(
      message,
    );
  }

  function isTransientEmbedError(err: unknown): boolean {
    if (err instanceof OpenRouterApiError) {
      return err.status === 408 ||
        err.status === 429 ||
        (err.status >= 500 && err.status < 600);
    }
    return isTransientError(err);
  }

  async function runJob(job: Job, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const stopEventLoopDelayProbe = startEventLoopDelayProbe();
    let outcome: StageOutcome = "fulfilled";
    try {
      await runStage(job, signal);
    } catch (err) {
      if (signal.aborted) {
        outcome = "aborted";
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const transient = job.stage === "embed"
        ? isTransientEmbedError(err)
        : isTransientError(err);
      if (transient && job.attempts < MAX_TRANSIENT_RETRIES) {
        await delay(RETRY_BASE_MS * 2 ** job.attempts);
        if (signal.aborted) {
          outcome = "aborted";
          return;
        }
        db.retryJob(job.id, message);
        outcome = "retry-scheduled";
      } else {
        db.failJob(job.id, message);
        if (STAGE_POLICY[job.stage].failureImpact === "degrade-video") {
          db.setVideoUnplayable(job.fileId, true);
        }
        outcome = "failed";
      }
    } finally {
      activity.inFlightCount -= 1;
      if (job.stage === "transcribe") {
        activity.transcribeInFlight -= 1;
      }
      budget.release(job.stage);
      logActivity({
        event: "stage-completion",
        jobId: job.id,
        fileId: job.fileId,
        stage: job.stage,
        durationMs: Date.now() - startedAt,
        outcome,
      });
      logActivity({
        event: "event-loop-delay",
        jobId: job.id,
        fileId: job.fileId,
        stage: job.stage,
        durationMs: stopEventLoopDelayProbe(),
        outcome: "observed",
      });
      if (!signal.aborted) {
        reconcile(job.fileId);
        scheduleUpdate();
      }
      kick();
    }
  }

  function launch(job: Job): void {
    activity.queuedClaims -= 1;
    activity.launchedJobs += 1;
    activity.inFlightCount += 1;
    if (job.stage === "transcribe") {
      activity.transcribeInFlight += 1;
    }
    logActivity({
      event: "launch",
      jobId: job.id,
      fileId: job.fileId,
      stage: job.stage,
    });
    scheduleUpdate();
    const controller = new AbortController();
    const task = runJob(job, controller.signal);
    inFlightJobs.set(task, controller);
    void task.then(
      () => inFlightJobs.delete(task),
      () => inFlightJobs.delete(task),
    );
  }

  function kick(): void {
    if (!running) return;

    while (activity.inFlightCount < MAX_CONCURRENCY) {
      const job = db.claimNextJob();
      if (!job) break;
      activity.queuedClaims += 1;
      const alreadyWaiting = waitingForPermit?.jobId === job.id;
      if (!alreadyWaiting) {
        logActivity({
          event: "claim",
          jobId: job.id,
          fileId: job.fileId,
          stage: job.stage,
        });
      }

      if (!budget.acquire(job.stage)) {
        db.releaseClaimedJob(job.id);
        activity.queuedClaims -= 1;
        if (!alreadyWaiting) {
          logActivity({
            event: "permit-wait",
            jobId: job.id,
            fileId: job.fileId,
            stage: job.stage,
            durationMs: 0,
            outcome: "started",
          });
        }
        waitingForPermit = alreadyWaiting
          ? waitingForPermit
          : { jobId: job.id, startedAt: Date.now() };
        break;
      }

      if (alreadyWaiting && waitingForPermit) {
        logActivity({
          event: "permit-wait",
          jobId: job.id,
          fileId: job.fileId,
          stage: job.stage,
          durationMs: Date.now() - waitingForPermit.startedAt,
          outcome: "acquired",
        });
      }
      waitingForPermit = null;
      launch(job);
    }

    scheduleNextPoll();
  }

  function scheduleNextPoll(): void {
    if (!running) return;
    if (loopTimer) return;
    loopTimer = setTimeout(() => {
      loopTimer = null;
      kick();
    }, IDLE_POLL_MS);
  }

  function start(): void {
    if (running) return;
    running = true;
    db.resetRunningJobs();
    // Prerequisites may have arrived while this project was closed (model
    // downloaded with another/no project open, key added, app restarted) —
    // requeue waiting jobs now; handlers re-park them if still unmet.
    void refreshPrerequisites("all");
  }

  function stop(mode: StopMode = "drain"): Promise<void> {
    const startedAt = Date.now();
    running = false;
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    waitingForPermit = null;

    const active = [...inFlightJobs.keys()];
    if (mode === "abort") {
      for (const controller of inFlightJobs.values()) {
        controller.abort(new Error("Pipeline aborted before the job finished"));
      }
      logActivity({
        event: "stop-wait",
        durationMs: Date.now() - startedAt,
        outcome: active.length === 0 ? "idle" : "aborted",
      });
      return Promise.resolve();
    }

    if (active.length === 0) {
      logActivity({
        event: "stop-wait",
        durationMs: Date.now() - startedAt,
        outcome: "idle",
      });
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        logActivity({
          event: "stop-wait",
          durationMs: Date.now() - startedAt,
          outcome: "timed-out",
        });
        reject(new Error(`Pipeline drain timed out after ${SHUTDOWN_TIMEOUT_MS}ms`));
      }, SHUTDOWN_TIMEOUT_MS);
      void Promise.allSettled(active).then(() => {
        clearTimeout(timeout);
        if (timedOut) return;
        logActivity({
          event: "stop-wait",
          durationMs: Date.now() - startedAt,
          outcome: "drained",
        });
        resolve();
      });
    });
  }

  return {
    retryFile,
    refreshPrerequisites,
    start,
    stop,
  };
}
