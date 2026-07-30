/**
 * Orchestrates the local media-processing pipeline: watches folders, walks
 * files through probe -> {audio, proxy, scenes} -> transcribe -> embed,
 * persisting every result via DailiesDB and notifying the
 * renderer. Also ingests documents (producer notes, scripts) alongside
 * media, and groups Avid OP-Atom MXF essence atoms into single clips.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { DailiesDB } from "../db/types";
import type {
  ProjectFolder,
  TextEmbedder,
} from "../../shared/types";
import { createDiscovery } from "./discovery";
import { createQueue, PipelineBudget, type StopMode } from "./queue";
import { createStages } from "./stages";

export { PipelineBudget, type StopMode } from "./queue";

export interface PipelineOptions {
  db: DailiesDB;
  /** app-support dir; derived media is stored under `${dataDir}/media/<fileId>/`. */
  dataDir: string;
  whisperModel: string;
  /** late-bound; null when no API key is configured. */
  embedder: () => TextEmbedder | null;
  /** fires after any job/file state change so the renderer can refresh. */
  onUpdate: () => void;
  budget?: PipelineBudget;
}

export interface Pipeline {
  watchFolder(folder: ProjectFolder): void;
  unwatchFolder(path: string): void;
  scanFolder(folder: ProjectFolder): Promise<void>;
  /**
   * Direct entry for the Import button: extracts the file at `path` and
   * upserts it as a document, attempting inline embedding immediately
   * (same as the watched-doc flow). Returns false when extraction fails
   * or the extension is unsupported. Re-ingesting an existing path is
   * allowed — upsertDocument replaces the prior record.
   */
  ingestDocument(path: string, episodeId: number | null): Promise<boolean>;
  /** Retry every terminal job failure for one known file. */
  retryFile(fileId: number): Promise<void>;
  /** Requeue prerequisite-blocked and otherwise missing derived stages. */
  refreshPrerequisites(kind: "whisper" | "openrouter" | "all"): Promise<void>;
  start(): void;
  stop(mode?: StopMode): Promise<void>;
}

const UPDATE_DEBOUNCE_MS = 300;

type StopResult =
  | { kind: "fulfilled" }
  | { kind: "rejected"; error: unknown };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleStop(task: Promise<void>): Promise<StopResult> {
  return task.then(
    () => ({ kind: "fulfilled" }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  let updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const budget = opts.budget ?? new PipelineBudget();
  opts.db.consolidateDuplicateFiles();

  function scheduleUpdate(): void {
    if (updateDebounceTimer) return;
    updateDebounceTimer = setTimeout(() => {
      updateDebounceTimer = null;
      opts.onUpdate();
    }, UPDATE_DEBOUNCE_MS);
  }

  const stages = createStages({
    db: opts.db,
    dataDir: opts.dataDir,
    whisperModel: opts.whisperModel,
    embedder: opts.embedder,
  });

  const discovery = createDiscovery({
    db: opts.db,
    embedDocChunks: stages.embedDocChunks,
    onUpdate: opts.onUpdate,
    scheduleUpdate,
    reconcile: stages.reconcile,
    ensureWork: stages.ensureWork,
    onFileDeleted: (fileId) => {
      rmSync(join(opts.dataDir, "media", String(fileId)), { recursive: true, force: true });
    },
    delay,
  });

  const queue = createQueue({
    db: opts.db,
    budget,
    runStage: stages.run,
    reconcile: stages.reconcile,
    ensureWork: stages.ensureWork,
    reconcileAndEnsureAllFiles: stages.reconcileAndEnsureAllFiles,
    scheduleUpdate,
    delay,
  });

  async function stop(mode: StopMode = "drain"): Promise<void> {
    const jobsStopped = queue.stop(mode);
    if (updateDebounceTimer) {
      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = null;
    }
    const [discoveryResult, jobsResult] = await Promise.all([
      settleStop(discovery.close(mode)),
      settleStop(jobsStopped),
    ]);
    if (updateDebounceTimer) {
      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = null;
    }
    if (jobsResult.kind === "rejected") throw jobsResult.error;
    if (discoveryResult.kind === "rejected") throw discoveryResult.error;
  }

  return {
    watchFolder: discovery.watchFolder,
    unwatchFolder: discovery.unwatchFolder,
    scanFolder: discovery.scanFolder,
    ingestDocument: discovery.ingestDocument,
    retryFile: queue.retryFile,
    refreshPrerequisites: queue.refreshPrerequisites,
    start: queue.start,
    stop,
  };
}
