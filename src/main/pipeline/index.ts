/**
 * Orchestrates the local media-processing pipeline: watches folders, walks
 * files through probe -> {audio, proxy, scenes} -> transcribe / visual_index,
 * persisting every result via DailiesDB and notifying the renderer.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

import type { DailiesDB } from "../db/types";
import type { GeminiIndexer, Job } from "../../shared/types";
import { findWhisperBinary, findWhisperModel } from "./binaries";
import { extractAudio, extractKeyframe, makeProxy } from "./proxy";
import { probeFile } from "./probe";
import { detectScenes } from "./scenes";
import { transcribeAudio } from "./transcribe";
import { createWatcher, type Watcher } from "./watcher";

export interface PipelineOptions {
  db: DailiesDB;
  /** app-support dir; derived media is stored under `${dataDir}/media/<fileId>/`. */
  dataDir: string;
  whisperModel: string;
  /** late-bound; null when no API key is configured. */
  gemini: () => GeminiIndexer | null;
  /** fires after any job/file state change so the renderer can refresh. */
  onUpdate: () => void;
}

export interface Pipeline {
  watchFolder(path: string): void;
  unwatchFolder(path: string): void;
  scanFolder(path: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);
const MAX_CONCURRENCY = 2;
const MAX_TRANSCRIBE_CONCURRENCY = 1;
const MAX_KEYFRAMES_PER_FILE = 40;
const IDLE_POLL_MS = 1500;
const UPDATE_DEBOUNCE_MS = 300;

function mediaDirFor(dataDir: string, fileId: number): string {
  return join(dataDir, "media", String(fileId));
}

async function walkVideoFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".dailies") continue;
      found.push(...(await walkVideoFiles(full)));
    } else if (entry.isFile()) {
      if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  }
  return found;
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  const { db, dataDir, whisperModel, gemini, onUpdate } = opts;

  let running = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  let inFlightCount = 0;
  let transcribeInFlight = 0;
  /** Transcribe jobs claimed from the DB but held back because one is already running. */
  const pendingTranscribeJobs: Job[] = [];

  function scheduleUpdate(): void {
    if (updateDebounceTimer) return;
    updateDebounceTimer = setTimeout(() => {
      updateDebounceTimer = null;
      onUpdate();
    }, UPDATE_DEBOUNCE_MS);
  }

  async function onFileFound(path: string): Promise<void> {
    const existing = db.getFileByPath(path);

    // db.upsertFile() is the only way to obtain a fileId, and it requires a
    // full FileInput, so a lightweight probe is unavoidable here just to
    // identify the file and compare hashes. The heavier per-stage work
    // (audio/proxy/scenes/transcribe/visual_index) is still fully deferred
    // to the worker loop via enqueueJob — this call never dispatches those.
    const probed = await probeFile(path);

    if (existing && existing.fileHash === probed.fileHash) {
      // Unchanged since we last saw it; nothing to do.
      return;
    }

    const file = db.upsertFile(probed);
    db.enqueueJob(file.id, "probe");
    scheduleUpdate();
  }

  const watcher: Watcher = createWatcher({
    onFileFound: (path) => {
      void onFileFound(path);
    },
  });

  function watchFolder(path: string): void {
    watcher.watchFolder(path);
  }

  function unwatchFolder(path: string): void {
    watcher.unwatchFolder(path);
  }

  async function scanFolder(path: string): Promise<void> {
    const files = await walkVideoFiles(path);
    for (const file of files) {
      await onFileFound(file);
    }
  }

  async function handleProbe(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    // The file row (including its hash) was already written by onFileFound;
    // this stage just transitions status and fans out the next stages.
    db.setFileStatus(file.id, "processing");

    db.enqueueJob(file.id, "audio");
    db.enqueueJob(file.id, "proxy");
    db.enqueueJob(file.id, "scenes");

    db.completeJob(job.id);
  }

  async function handleAudio(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });
    const audioPath = join(mediaDir, "audio.wav");

    await extractAudio(file.path, audioPath);
    db.enqueueJob(file.id, "transcribe");

    db.completeJob(job.id);
  }

  async function handleProxy(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });

    const proxyPath = await makeProxy(file.path, mediaDir);
    db.setFileProxy(file.id, proxyPath);

    db.completeJob(job.id);
  }

  async function handleScenes(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });

    const detected = await detectScenes(file.path, file.durationS);

    const scenesWithKeyframes: Array<{
      startS: number;
      endS: number;
      startTc: string;
      endTc: string;
      keyframePath?: string | null;
    }> = [];

    let keyframeCount = 0;
    for (const scene of detected) {
      let keyframePath: string | null = null;
      if (keyframeCount < MAX_KEYFRAMES_PER_FILE) {
        const midpointS = scene.startS + (scene.endS - scene.startS) / 2;
        const outPath = join(mediaDir, `keyframe-${keyframeCount}.jpg`);
        try {
          await extractKeyframe(file.path, midpointS, outPath);
          keyframePath = outPath;
          keyframeCount += 1;
        } catch {
          keyframePath = null;
        }
      }

      scenesWithKeyframes.push({
        startS: scene.startS,
        endS: scene.endS,
        // Relative-to-file-start timecode at the source fps; does not account
        // for a non-zero source start_tc offset.
        startTc: secondsToTc(scene.startS, file.fps),
        endTc: secondsToTc(scene.endS, file.fps),
        keyframePath,
      });
    }

    db.replaceScenes(file.id, scenesWithKeyframes);
    db.enqueueJob(file.id, "visual_index");

    db.completeJob(job.id);
  }

  async function handleTranscribe(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const whisperBin = findWhisperBinary();
    if (!whisperBin) {
      db.failJob(job.id, "Whisper not installed — see Settings");
      return;
    }

    const modelPath = findWhisperModel(whisperModel, dataDir);
    if (!modelPath) {
      db.failJob(job.id, "Whisper not installed — see Settings");
      return;
    }

    const mediaDir = mediaDirFor(dataDir, file.id);
    const audioPath = join(mediaDir, "audio.wav");

    const segments = await transcribeAudio(audioPath, whisperBin, modelPath);
    db.replaceTranscript(file.id, segments);
    db.markTranscribed(file.id);
    maybeMarkReady(file.id);

    db.completeJob(job.id);
  }

  function maybeMarkReady(fileId: number): void {
    const file = db.getFile(fileId);
    if (!file) return;
    if (file.hasTranscript) {
      db.setFileStatus(fileId, "ready");
    }
  }

  async function handleVisualIndex(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const indexer = gemini();
    if (!indexer) {
      db.failJob(job.id, "Gemini API key not set");
      return;
    }

    const scenes = db.listScenes(file.id);
    for (const scene of scenes) {
      try {
        const annotation = await indexer.annotateScene({
          proxyPath: file.proxyPath,
          keyframePaths: scene.keyframePath ? [scene.keyframePath] : [],
          startS: scene.startS,
          endS: scene.endS,
        });
        db.upsertAnnotation(scene.id, annotation);
        scheduleUpdate();
      } catch {
        // Continue indexing remaining scenes even if one fails.
        continue;
      }
    }

    db.markVisuallyIndexed(file.id);
    db.completeJob(job.id);
  }

  async function runJob(job: Job): Promise<void> {
    try {
      switch (job.stage) {
        case "probe":
          await handleProbe(job);
          break;
        case "audio":
          await handleAudio(job);
          break;
        case "proxy":
          await handleProxy(job);
          break;
        case "scenes":
          await handleScenes(job);
          break;
        case "transcribe":
          await handleTranscribe(job);
          break;
        case "visual_index":
          await handleVisualIndex(job);
          break;
      }
    } catch (err) {
      db.failJob(job.id, err instanceof Error ? err.message : String(err));
    } finally {
      inFlightCount -= 1;
      if (job.stage === "transcribe") {
        transcribeInFlight -= 1;
      }
      scheduleUpdate();
      kick();
    }
  }

  function launch(job: Job): void {
    inFlightCount += 1;
    if (job.stage === "transcribe") {
      transcribeInFlight += 1;
    }
    scheduleUpdate();
    void runJob(job);
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
    kick();
  }

  async function stop(): Promise<void> {
    running = false;
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    if (updateDebounceTimer) {
      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = null;
    }
    await watcher.close();
  }

  return {
    watchFolder,
    unwatchFolder,
    scanFolder,
    start,
    stop,
  };
}

/** Formats seconds since file start as an HH:MM:SS:FF timecode string. */
function secondsToTc(totalSeconds: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalFrames = Math.max(Math.round(totalSeconds * safeFps), 0);
  const framesPerSecond = Math.max(Math.round(safeFps), 1);

  const frames = totalFrames % framesPerSecond;
  const totalWholeSeconds = Math.floor(totalFrames / framesPerSecond);
  const seconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}
