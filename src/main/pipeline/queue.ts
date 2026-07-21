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

export interface QueueOptions {
  db: DailiesDB;
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
  stop(): Promise<void>;
}

export function createQueue(opts: QueueOptions): JobQueue {
  const {
    db,
    runStage,
    reconcile,
    ensureWork,
    reconcileAndEnsureAllFiles,
    scheduleUpdate,
    delay,
  } = opts;

  let running = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;

  let inFlightCount = 0;
  let transcribeInFlight = 0;
  /** Transcribe jobs claimed from the DB but held back because one is already running. */
  const pendingTranscribeJobs: Job[] = [];
  const inFlightJobs = new Map<Promise<void>, AbortController>();

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
    const reopened = db.reopenErroredJobs(fileId);
    if (reopened === 0) return;

    if (file.videoUnplayable) db.setVideoUnplayable(fileId, false);
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
    try {
      await runStage(job, signal);
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      const transient = job.stage === "embed"
        ? isTransientEmbedError(err)
        : isTransientError(err);
      if (transient && job.attempts < MAX_TRANSIENT_RETRIES) {
        await delay(RETRY_BASE_MS * 2 ** job.attempts);
        db.retryJob(job.id, message);
      } else {
        db.failJob(job.id, message);
        if (STAGE_POLICY[job.stage].failureImpact === "degrade-video") {
          db.setVideoUnplayable(job.fileId, true);
        }
      }
    } finally {
      inFlightCount -= 1;
      if (job.stage === "transcribe") {
        transcribeInFlight -= 1;
      }
      if (!signal.aborted) {
        reconcile(job.fileId);
        scheduleUpdate();
      }
      kick();
    }
  }

  function launch(job: Job): void {
    inFlightCount += 1;
    if (job.stage === "transcribe") {
      transcribeInFlight += 1;
    }
    scheduleUpdate();
    const controller = new AbortController();
    const task = runJob(job, controller.signal);
    inFlightJobs.set(task, controller);
    void task.then(
      () => inFlightJobs.delete(task),
      () => inFlightJobs.delete(task),
    );
  }

  function tryLaunchPendingTranscribe(): boolean {
    if (transcribeInFlight >= MAX_TRANSCRIBE_CONCURRENCY) return false;
    const next = pendingTranscribeJobs.shift();
    if (!next) return false;
    launch(next);
    return true;
  }

  function kick(): void {
    if (!running) return;

    // Drain any transcribe jobs we held back earlier, respecting the cap.
    while (inFlightCount < MAX_CONCURRENCY && tryLaunchPendingTranscribe()) {
      /* keep draining */
    }

    while (inFlightCount < MAX_CONCURRENCY && pendingTranscribeJobs.length === 0) {
      const job = db.claimNextJob();
      if (!job) break;

      if (job.stage === "transcribe" && transcribeInFlight >= MAX_TRANSCRIBE_CONCURRENCY) {
        // Hold this single job in memory (already marked 'running' in the DB)
        // and stop claiming further jobs this tick so we don't drain the
        // entire queue into memory while transcribe is saturated.
        pendingTranscribeJobs.push(job);
        break;
      }

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

  async function stop(): Promise<void> {
    running = false;
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }

    for (const job of pendingTranscribeJobs.splice(0)) {
      db.releaseClaimedJob(job.id);
    }

    const active = [...inFlightJobs.keys()];
    if (active.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const drained = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!drained) {
      for (const task of active) {
        inFlightJobs.get(task)?.abort(new Error("Pipeline stopped before the job finished"));
      }
    }
  }

  return {
    retryFile,
    refreshPrerequisites,
    start,
    stop,
  };
}
