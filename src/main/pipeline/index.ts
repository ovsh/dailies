/**
 * Orchestrates the local media-processing pipeline: watches folders, walks
 * files through probe -> {audio, proxy, scenes} -> transcribe -> embed,
 * persisting every result via DailiesDB and notifying the
 * renderer. Also ingests documents (producer notes, scripts) alongside
 * media, and groups Avid OP-Atom MXF essence atoms into single clips.
 */
import type { DailiesDB } from "../db/types";
import type {
  ProjectFolder,
  TextEmbedder,
} from "../../shared/types";
import { createDiscovery } from "./discovery";
import { createQueue } from "./queue";
import { createStages } from "./stages";

export interface PipelineOptions {
  db: DailiesDB;
  /** app-support dir; derived media is stored under `${dataDir}/media/<fileId>/`. */
  dataDir: string;
  whisperModel: string;
  /** late-bound; null when no API key is configured. */
  embedder: () => TextEmbedder | null;
  /** fires after any job/file state change so the renderer can refresh. */
  onUpdate: () => void;
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
  stop(): Promise<void>;
}

const UPDATE_DEBOUNCE_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  let updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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
    delay,
  });

  const queue = createQueue({
    db: opts.db,
    runStage: stages.run,
    reconcile: stages.reconcile,
    ensureWork: stages.ensureWork,
    reconcileAndEnsureAllFiles: stages.reconcileAndEnsureAllFiles,
    scheduleUpdate,
    delay,
  });

  async function stop(): Promise<void> {
    const jobsStopped = queue.stop();
    if (updateDebounceTimer) {
      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = null;
    }
    await discovery.close();
    await jobsStopped;
    if (updateDebounceTimer) {
      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = null;
    }
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
