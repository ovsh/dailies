import { cpus, loadavg } from "node:os";

import { OpenRouterApiError } from "../agents/openrouter-client";
import type { DailiesDB } from "../db/types";
import type { Job } from "../../shared/types";
import { isSystemicSpawnError } from "./exec";
import { STAGE_POLICY } from "./status";

// Leave two cores for the UI and the OS, and never trust a huge core count to
// mean huge I/O headroom.
function defaultConcurrency(): number {
  return Math.min(8, Math.max(4, cpus().length - 2));
}
// macOS Whisper uses Metal efficiently at two jobs. The packaged Windows
// runtime is CPU-only, so run one large model at a time to keep the app responsive.
const MAX_TRANSCRIBE_CONCURRENCY = process.platform === "win32" ? 1 : 2;
// Back-off floor — below this the pipeline stops making useful progress.
const MIN_CONCURRENCY = 2;
const LOAD_SAMPLE_MS = 15_000;
const LOAD_HIGH = 0.9;
const LOAD_LOW = 0.6;
// Hysteresis: one spike (or one quiet moment) never moves the cap.
const LOAD_SAMPLE_STREAK = 2;
const STEP_DOWN = 2;
const STEP_UP = 1;
const IDLE_POLL_MS = 1500;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_MS = 250;
// Out-of-descriptors spawn failures are process-wide and clear on their own
// once whatever held the descriptors lets go — worth far more patience than
// an ordinary transient error, and fast retries would only burn attempts
// while the table is still full.
const MAX_SYSTEMIC_RETRIES = 8;
const SYSTEMIC_RETRY_BASE_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
// Embed jobs parked because the box was offline: nothing else wakes them, so
// re-open them on a slow timer. If the link is still down the handler parks
// them again, which costs one failed request a minute.
const OFFLINE_RECHECK_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const EVENT_LOOP_PROBE_MS = 100;

export interface PipelineBudgetTotals {
  readonly inFlightCount: number;
  readonly transcribeInFlight: number;
  readonly concurrency: number;
  readonly baseConcurrency: number;
}

export interface PipelineBudgetLimits {
  concurrency?: number;
  transcribeConcurrency?: number;
}

export class PipelineBudget {
  private inFlightCount = 0;
  private transcribeInFlight = 0;
  private readonly baseConcurrency: number;
  private readonly maxTranscribeConcurrency: number;
  /** Gates NEW starts only — a lowered cap never interrupts running work. */
  private concurrency: number;
  private highLoadSamples = 0;
  private lowLoadSamples = 0;
  private samplers = 0;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(limits: PipelineBudgetLimits = {}) {
    this.baseConcurrency = limits.concurrency ?? defaultConcurrency();
    this.maxTranscribeConcurrency = limits.transcribeConcurrency ?? MAX_TRANSCRIBE_CONCURRENCY;
    this.concurrency = this.baseConcurrency;
  }

  get limit(): number {
    return this.concurrency;
  }

  /** True while the dedicated transcribe cap is fully occupied. */
  get transcribeAtCapacity(): boolean {
    return this.transcribeInFlight >= this.maxTranscribeConcurrency;
  }

  acquire(stage: Job["stage"]): boolean {
    if (this.inFlightCount >= this.concurrency) return false;
    if (
      stage === "transcribe" &&
      this.transcribeInFlight >= this.maxTranscribeConcurrency
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

  /**
   * Load sampling runs only while at least one pipeline is started — every
   * queue that starts must release, or the interval outlives the pipeline.
   */
  retainLoadSampler(): void {
    this.samplers += 1;
    if (this.sampleTimer) return;
    this.sampleTimer = setInterval(() => this.sampleLoad(), LOAD_SAMPLE_MS);
    this.sampleTimer.unref();
  }

  releaseLoadSampler(): void {
    if (this.samplers <= 0) return;
    this.samplers -= 1;
    if (this.samplers > 0 || !this.sampleTimer) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.highLoadSamples = 0;
    this.lowLoadSamples = 0;
  }

  /**
   * EBADF/EMFILE/ENFILE from a child spawn is resource pressure exactly like a
   * hot CPU: fewer concurrent stages is the only thing that helps. Recovery
   * goes through the same gradual load-driven step up.
   */
  noteSpawnPressure(): void {
    this.lowLoadSamples = 0;
    this.stepConcurrency(-STEP_DOWN, "spawn-error");
  }

  private sampleLoad(): void {
    const cores = cpus().length || 1;
    const load = loadavg()[0] / cores;
    if (load > LOAD_HIGH) {
      this.lowLoadSamples = 0;
      this.highLoadSamples += 1;
      if (this.highLoadSamples < LOAD_SAMPLE_STREAK) return;
      this.highLoadSamples = 0;
      this.stepConcurrency(-STEP_DOWN, `load ${load.toFixed(2)}`);
      return;
    }
    if (load < LOAD_LOW) {
      this.highLoadSamples = 0;
      this.lowLoadSamples += 1;
      if (this.lowLoadSamples < LOAD_SAMPLE_STREAK) return;
      this.lowLoadSamples = 0;
      this.stepConcurrency(STEP_UP, `load ${load.toFixed(2)}`);
      return;
    }
    this.highLoadSamples = 0;
    this.lowLoadSamples = 0;
  }

  private stepConcurrency(delta: number, reason: string): void {
    const next = Math.min(
      this.baseConcurrency,
      Math.max(MIN_CONCURRENCY, this.concurrency + delta),
    );
    if (next === this.concurrency) return;
    const previous = this.concurrency;
    this.concurrency = next;
    console.info("[pipeline] concurrency", JSON.stringify({
      reason,
      from: previous,
      to: next,
      base: this.baseConcurrency,
    }));
  }

  get totals(): PipelineBudgetTotals {
    return {
      inFlightCount: this.inFlightCount,
      transcribeInFlight: this.transcribeInFlight,
      concurrency: this.concurrency,
      baseConcurrency: this.baseConcurrency,
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

type StageOutcome = "fulfilled" | "retry-scheduled" | "parked" | "failed" | "aborted";

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
  /** Queues an Avid project-tag read for every clip that has never had one. */
  backfillSourceProjects(): number;
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
  let lastOfflineRecheck = 0;
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

  /**
   * Enqueues the metadata backfill only. It calls neither reconcile nor
   * ensureWork, so no audio, proxy, scenes, transcribe, or embed job can come
   * out of it; enqueueJob itself skips clips that already have one in flight.
   * Returns how many clips were queued.
   */
  function backfillSourceProjects(): number {
    const pending = db.listFilesMissingSourceProject();
    for (const file of pending) db.enqueueJob(file.id, "media-tag");
    if (pending.length > 0) {
      scheduleUpdate();
      kick();
    }
    return pending.length;
  }

  function isTransientError(err: unknown): boolean {
    const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return /\b429\b|\b5\d\d\b|rate.?limit|temporar|timeout|timed out|network|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket|\bebadf\b|\bemfile\b/i.test(
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

  /**
   * The machine could not reach the network at all — DNS, connect, or a dropped
   * socket — as opposed to OpenRouter answering with an error. Node reports the
   * whole class as a bare "fetch failed" with the real cause nested inside it.
   */
  function isOfflineError(err: unknown): boolean {
    if (err instanceof OpenRouterApiError) return false;
    let text = "";
    let cause: unknown = err;
    for (let depth = 0; depth < 4 && cause; depth += 1) {
      text += cause instanceof Error ? ` ${cause.name} ${cause.message}` : ` ${String(cause)}`;
      cause = (cause as { cause?: unknown }).cause;
    }
    return /fetch failed|enotfound|eai_again|econnrefused|econnreset|enetdown|enetunreach|ehostunreach|socket hang up/i
      .test(text);
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
      const systemic =
        isSystemicSpawnError(err) || /\bebadf\b|\bemfile\b|\benfile\b/i.test(message);
      if (systemic) budget.noteSpawnPressure();
      const transient = systemic || (job.stage === "embed"
        ? isTransientEmbedError(err)
        : isTransientError(err));
      const retryLimit = systemic ? MAX_SYSTEMIC_RETRIES : MAX_TRANSIENT_RETRIES;
      if (transient && job.attempts < retryLimit) {
        const baseMs = systemic ? SYSTEMIC_RETRY_BASE_MS : RETRY_BASE_MS;
        await delay(Math.min(baseMs * 2 ** job.attempts, MAX_RETRY_DELAY_MS));
        if (signal.aborted) {
          outcome = "aborted";
          return;
        }
        db.retryJob(job.id, message);
        outcome = "retry-scheduled";
      } else if (job.stage === "embed" && isOfflineError(err)) {
        // Neither the file's fault nor OpenRouter's — the box is offline. Park
        // it like a missing API key, so a dropped link overnight does not need
        // the user to hunt down 3700 files and press Retry.
        db.waitJob(job.id, "Waiting for a network connection to reach OpenRouter");
        outcome = "parked";
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
    if (Date.now() - lastOfflineRecheck >= OFFLINE_RECHECK_MS) {
      lastOfflineRecheck = Date.now();
      if (db.requeueWaitingJobs(["embed"]) > 0) scheduleUpdate();
    }

    while (activity.inFlightCount < budget.limit) {
      // While both whisper slots are busy, claim past the transcribe backlog
      // so the remaining slots keep doing proxy/scenes work.
      const job = db.claimNextJob(
        budget.transcribeAtCapacity ? "transcribe" : undefined,
      );
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
    budget.retainLoadSampler();
    db.resetRunningJobs();
    const requeued = db.requeueSystemicFailures();
    if (requeued > 0) {
      console.warn(`[pipeline] requeued ${requeued} jobs that failed for process-level reasons`);
    }
    // Prerequisites may have arrived while this project was closed (model
    // downloaded with another/no project open, key added, app restarted) —
    // requeue waiting jobs now; handlers re-park them if still unmet.
    void refreshPrerequisites("all");
  }

  function stop(mode: StopMode = "drain"): Promise<void> {
    const startedAt = Date.now();
    if (running) budget.releaseLoadSampler();
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
    backfillSourceProjects,
    start,
    stop,
  };
}
