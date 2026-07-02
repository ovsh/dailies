/**
 * Orchestrates the local media-processing pipeline: watches folders, walks
 * files through probe -> {audio, proxy, scenes} -> transcribe / visual_index
 * -> embed, persisting every result via DailiesDB and notifying the
 * renderer. Also ingests documents (producer notes, scripts) alongside
 * media, and groups Avid OP-Atom MXF essence atoms into single clips.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

import type { DailiesDB } from "../db/types";
import type {
  FileInput,
  GeminiIndexer,
  Job,
  MediaRole,
  ProjectFolder,
  TextEmbedder,
} from "../../shared/types";
import { findFfprobeBinary, findWhisperBinary, findWhisperModel } from "./binaries";
import { DOC_EXTENSIONS, extractDocument } from "./docs";
import { analyzeMxf, OpAtomGrouper, type MxfAtomInfo, type OpAtomClip } from "./opatom";
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
  start(): void;
  stop(): Promise<void>;
}

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);
const DOC_EXTENSIONS_SET = new Set(DOC_EXTENSIONS);
const MAX_CONCURRENCY = 2;
const MAX_TRANSCRIBE_CONCURRENCY = 1;
const MAX_KEYFRAMES_PER_FILE = 40;
const IDLE_POLL_MS = 1500;
const UPDATE_DEBOUNCE_MS = 300;
const EMBED_BATCH_SIZE = 64;

function mediaDirFor(dataDir: string, fileId: number): string {
  return join(dataDir, "media", String(fileId));
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".dailies") continue;
      found.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  const { db, dataDir, whisperModel, gemini, embedder, onUpdate } = opts;

  let running = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  let inFlightCount = 0;
  let transcribeInFlight = 0;
  /** Transcribe jobs claimed from the DB but held back because one is already running. */
  const pendingTranscribeJobs: Job[] = [];

  // Watched project folders, used to resolve a discovered file's/document's
  // role and episodeId by longest-prefix match. Default role "raw",
  // default episodeId null.
  const watchedFolders: ProjectFolder[] = [];

  function scheduleUpdate(): void {
    if (updateDebounceTimer) return;
    updateDebounceTimer = setTimeout(() => {
      updateDebounceTimer = null;
      onUpdate();
    }, UPDATE_DEBOUNCE_MS);
  }

  /** Longest-prefix-matching watched folder for `path`, if any. */
  function folderForPath(path: string): ProjectFolder | null {
    let best: ProjectFolder | null = null;
    for (const folder of watchedFolders) {
      if (!path.startsWith(folder.path)) continue;
      if (!best || folder.path.length > best.path.length) {
        best = folder;
      }
    }
    return best;
  }

  function roleForPath(path: string): MediaRole {
    return folderForPath(path)?.role ?? "raw";
  }

  function episodeIdForPath(path: string): number | null {
    return folderForPath(path)?.episodeId ?? null;
  }

  async function embedDocChunks(): Promise<void> {
    const e = embedder();
    if (!e) return;
    try {
      const pending = db.listUnembeddedDocChunks(EMBED_BATCH_SIZE);
      if (pending.length === 0) return;
      const vectors = await e.embed(pending.map((c) => c.text));
      pending.forEach((chunk, i) => {
        const vector = vectors[i];
        if (vector) db.upsertEmbedding("doc", chunk.refId, vector);
      });
    } catch (err) {
      console.error("[pipeline] doc embedding failed:", err);
    }
  }

  async function onDocFound(path: string): Promise<void> {
    try {
      if (db.getDocumentByPath(path)) return;

      const doc = await extractDocument(path, episodeIdForPath(path));
      if (!doc) return;

      db.upsertDocument(doc);
      await embedDocChunks();
      onUpdate();
    } catch (err) {
      console.error(`[pipeline] failed to ingest document ${path}:`, err);
    }
  }

  /**
   * Direct entry for the Import button. Unlike onDocFound (the watcher/scan
   * path), this always (re-)ingests: upsertDocument replaces any existing
   * record at the same path.
   */
  async function ingestDocument(path: string, episodeId: number | null): Promise<boolean> {
    try {
      const doc = await extractDocument(path, episodeId);
      if (!doc) return false;

      db.upsertDocument(doc);
      await embedDocChunks();
      onUpdate();
      return true;
    } catch (err) {
      console.error(`[pipeline] failed to ingest document ${path}:`, err);
      return false;
    }
  }

  const grouper = new OpAtomGrouper({
    onClip: (clip) => {
      void onOpAtomClip(clip);
    },
  });

  async function onOpAtomClip(clip: OpAtomClip): Promise<void> {
    const videoAtoms = clip.atoms.filter((a) => a.essence === "video");
    const audioAtoms = clip.atoms.filter((a) => a.essence === "audio");
    const primaryAtom = videoAtoms[0] ?? audioAtoms[0];
    if (!primaryAtom) return;

    // Ordered [videoAtoms..., audioAtoms...] with the primary path always
    // first, so the audio stage can iterate in a predictable order and the
    // proxy/scenes stages can tell a video atom exists via memberPaths[0].
    const memberPaths = [...videoAtoms, ...audioAtoms].map((a) => a.path);

    const existing = db.getFileByClipKey(clip.clipKey);
    const fileHash = await computePartialHashSafe(primaryAtom.path);
    if (
      existing &&
      existing.memberPaths &&
      existing.memberPaths.length === memberPaths.length &&
      existing.fileHash === fileHash
    ) {
      return;
    }

    const input: FileInput = {
      path: primaryAtom.path,
      filename: clip.clipName ?? basenameOf(primaryAtom.path),
      durationS: Math.max(...clip.atoms.map((a) => a.durationS)),
      fps: primaryAtom.fps,
      dropFrame: primaryAtom.dropFrame,
      startTc: primaryAtom.startTc,
      codec: primaryAtom.codec,
      audioChannels: audioAtoms.length > 0 ? 1 : 0,
      fileHash,
      role: roleForPath(primaryAtom.path),
      episodeId: episodeIdForPath(primaryAtom.path),
      clipName: clip.clipName,
      mediaKind: "opatom",
      memberPaths,
      clipKey: clip.clipKey,
    };

    const file = db.upsertFile(input);
    db.enqueueJob(file.id, "probe");
    scheduleUpdate();
  }

  /** Thin wrapper around probeFile's hashing so we don't duplicate it here. */
  async function computePartialHashSafe(path: string): Promise<string> {
    try {
      const probed = await probeFile(path);
      return probed.fileHash;
    } catch {
      return "";
    }
  }

  function basenameOf(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? path;
  }

  async function onFileFound(path: string): Promise<void> {
    const ext = extname(path).toLowerCase();

    if (ext === ".mxf") {
      const ffprobeBin = findFfprobeBinary();
      const atomInfo: MxfAtomInfo | null = await analyzeMxf(ffprobeBin, path);
      if (atomInfo) {
        grouper.addAtom(atomInfo);
        return;
      }
      // Not OP-Atom (e.g. carries both audio and video) — fall through to
      // standard ingest below.
    }

    const existing = db.getFileByPath(path);

    // db.upsertFile() is the only way to obtain a fileId, and it requires a
    // full FileInput, so a lightweight probe is unavoidable here just to
    // identify the file and compare hashes. The heavier per-stage work
    // (audio/proxy/scenes/transcribe/visual_index) is still fully deferred
    // to the worker loop via enqueueJob — this call never dispatches those.
    const probed = await probeFile(path);
    probed.role = roleForPath(path);
    probed.episodeId = episodeIdForPath(path);

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
    onDocFound: (path) => {
      void onDocFound(path);
    },
  });

  function watchFolder(folder: ProjectFolder): void {
    watchedFolders.push(folder);
    watcher.watchFolder(folder.path);
  }

  function unwatchFolder(path: string): void {
    const idx = watchedFolders.findIndex((f) => f.path === path);
    if (idx >= 0) watchedFolders.splice(idx, 1);
    watcher.unwatchFolder(path);
  }

  async function scanFolder(folder: ProjectFolder): Promise<void> {
    // A missing folder (unmounted drive, deleted path) must never take the
    // app down — skip quietly; the watcher recovers when it reappears.
    let files: string[];
    try {
      files = await walkFiles(folder.path);
    } catch (err) {
      console.warn(`scanFolder: cannot read ${folder.path}:`, err);
      return;
    }
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      try {
        if (VIDEO_EXTENSIONS.has(ext)) {
          await onFileFound(file);
        } else if (DOC_EXTENSIONS_SET.has(ext)) {
          await onDocFound(file);
        }
      } catch (err) {
        console.warn(`scanFolder: failed on ${file}:`, err);
      }
    }
  }

  async function handleProbe(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    // The file row (including its hash) was already written by onFileFound;
    // this stage just transitions status and fans out the next stages.
    // OP-Atom clips are already in their final shape (merged from atoms at
    // discovery time) — never re-probe them into standard shape.
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

    if (file.mediaKind === "opatom") {
      const candidates = file.memberPaths ?? [file.path];
      let extracted = false;
      for (const candidate of candidates) {
        try {
          await extractAudio(candidate, audioPath);
          extracted = true;
          break;
        } catch {
          continue;
        }
      }
      if (!extracted) {
        throw new Error(`No member path of opatom clip ${file.id} yielded audio`);
      }
    } else {
      await extractAudio(file.path, audioPath);
    }

    db.enqueueJob(file.id, "transcribe");

    db.completeJob(job.id);
  }

  /**
   * True when the file has a video essence to work from: always true for
   * standard media; for opatom clips, true iff the primary path (always
   * memberPaths[0], since memberPaths is ordered [videoAtoms..., audioAtoms...])
   * is itself a video atom.
   */
  async function hasVideoAtom(file: { mediaKind: string; path: string }): Promise<boolean> {
    if (file.mediaKind !== "opatom") return true;
    const ffprobeBin = findFfprobeBinary();
    const info = await analyzeMxf(ffprobeBin, file.path);
    return info?.essence === "video";
  }

  async function handleProxy(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (!(await hasVideoAtom(file))) {
      // Audio-only opatom clip — nothing to make a proxy from.
      db.completeJob(job.id);
      return;
    }

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });

    const proxyPath = await makeProxy(file.path, mediaDir);
    db.setFileProxy(file.id, proxyPath);

    db.completeJob(job.id);
  }

  async function handleScenes(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (!(await hasVideoAtom(file))) {
      // Audio-only opatom clip — no video to scene-detect.
      db.completeJob(job.id);
      return;
    }

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

    db.enqueueJob(file.id, "embed");

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

    db.enqueueJob(file.id, "embed");

    db.completeJob(job.id);
  }

  async function handleEmbed(job: Job): Promise<void> {
    const e = embedder();
    if (!e) {
      db.failJob(job.id, "Gemini API key not set");
      return;
    }

    const segments = db.listUnembeddedSegments(job.fileId);
    for (let i = 0; i < segments.length; i += EMBED_BATCH_SIZE) {
      const batch = segments.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await e.embed(batch.map((s) => s.text));
      batch.forEach((seg, idx) => {
        const vector = vectors[idx];
        if (vector) db.upsertEmbedding("segment", seg.refId, vector);
      });
    }

    const annotations = db.listUnembeddedAnnotations(job.fileId);
    for (let i = 0; i < annotations.length; i += EMBED_BATCH_SIZE) {
      const batch = annotations.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await e.embed(batch.map((a) => a.text));
      batch.forEach((ann, idx) => {
        const vector = vectors[idx];
        if (vector) db.upsertEmbedding("scene", ann.refId, vector);
      });
    }

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
        case "embed":
          await handleEmbed(job);
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
    ingestDocument,
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
