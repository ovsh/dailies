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
import { formatElapsedOffset, tcAddSeconds } from "../../shared/timecode";
import { findFfprobeBinary, findWhisperBinary, findWhisperModel } from "./binaries";
import { DOC_EXTENSIONS, extractDocument } from "./docs";
import { analyzeMxf, OpAtomGrouper, type MxfAtomInfo, type OpAtomClip } from "./opatom";
import { extractAudio, extractKeyframe, makeProxy } from "./proxy";
import { probeFile } from "./probe";
import { detectScenes } from "./scenes";
import {
  audioExtractTimeoutMs,
  KEYFRAME_TIMEOUT_MS,
  proxyTimeoutMs,
  transcribeTimeoutMs,
} from "./timeouts";
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
  /** Requeue prerequisite-blocked and otherwise missing derived stages. */
  refreshPrerequisites(kind: "whisper" | "gemini" | "all"): Promise<void>;
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
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_MS = 250;

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
    const existing = db.getFileByClipKey(clip.clipKey);
    const atomByPath = new Map(clip.atoms.map((atom) => [atom.path, atom]));
    for (const path of existing?.memberPaths ?? []) {
      if (atomByPath.has(path)) continue;
      const restored = await analyzeMxf(findFfprobeBinary(), path);
      if (restored?.clipKey === clip.clipKey) atomByPath.set(path, restored);
    }

    const atoms = [...atomByPath.values()];
    const byPath = (a: MxfAtomInfo, b: MxfAtomInfo) => a.path.localeCompare(b.path);
    const videoAtoms = atoms.filter((a) => a.essence === "video").sort(byPath);
    const audioAtoms = atoms.filter((a) => a.essence === "audio").sort(byPath);
    const primaryAtom = videoAtoms[0] ?? audioAtoms[0];
    if (!primaryAtom) return;

    // Ordered [videoAtoms..., audioAtoms...] with the primary path always
    // first, so the audio stage can iterate in a predictable order and the
    // proxy/scenes stages can tell a video atom exists via memberPaths[0].
    const memberPaths = [...videoAtoms, ...audioAtoms].map((a) => a.path);

    const memberHashes = await Promise.all(
      memberPaths.map(async (path) => `${path}:${await computePartialHashSafe(path)}`),
    );
    const fileHash = memberHashes.join("|");
    if (
      existing &&
      existing.memberPaths &&
      existing.memberPaths.length === memberPaths.length &&
      existing.memberPaths.every((path, index) => path === memberPaths[index]) &&
      existing.fileHash === fileHash
    ) {
      await repairFile(existing);
      return;
    }

    const input: FileInput = {
      path: primaryAtom.path,
      filename: clip.clipName ?? basenameOf(primaryAtom.path),
      durationS: Math.max(...atoms.map((a) => a.durationS)),
      fps: videoAtoms[0]?.fps ?? audioAtoms.find((atom) => atom.fps > 0)?.fps ?? 0,
      dropFrame: (videoAtoms[0] ?? audioAtoms[0])?.dropFrame ?? false,
      startTc: (videoAtoms[0] ?? audioAtoms[0])?.startTc ?? "00:00:00:00",
      codec: primaryAtom.codec,
      audioChannels: audioAtoms.length > 0 ? 1 : 0,
      fileHash,
      role: roleForPath(primaryAtom.path),
      episodeId: episodeIdForPath(primaryAtom.path),
      clipName: atoms.find((atom) => atom.clipName)?.clipName ?? clip.clipName,
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
    let probed: FileInput;
    try {
      probed = await probeFile(path);
    } catch (err) {
      // Unreadable media (corrupt file, unsupported MXF variant) must remain
      // VISIBLE as an error rather than silently disappearing — otherwise the
      // clip count doesn't match what the editor put in the folder and it
      // looks like the app "lost" a file. Record a stub in error state.
      if (!existing) {
        const stub = db.upsertFile({
          path,
          filename: basenameOf(path),
          durationS: 0,
          fps: 0,
          dropFrame: false,
          startTc: "00:00:00:00",
          codec: "unknown",
          audioChannels: 0,
          fileHash: `unreadable:${path}`,
          role: roleForPath(path),
          episodeId: episodeIdForPath(path),
        });
        db.setFileStatus(stub.id, "error");
        scheduleUpdate();
      }
      console.warn(`onFileFound: unreadable media ${path}:`, err);
      return;
    }
    probed.role = roleForPath(path);
    probed.episodeId = episodeIdForPath(path);

    if (existing && existing.fileHash === probed.fileHash) {
      // File identity is unchanged, but derived processing may be incomplete.
      await repairFile(existing);
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

    if (file.audioChannels > 0) {
      db.enqueueJob(file.id, "audio");
    } else {
      // A silent clip has a complete, explicitly empty transcript stage.
      db.replaceTranscript(file.id, []);
      db.markTranscribed(file.id);
    }

    if (await hasVideoAtom(file)) {
      db.enqueueJob(file.id, "proxy");
      db.enqueueJob(file.id, "scenes");
    }

    db.completeJob(job.id);
    await maybeMarkReady(file.id);
  }

  async function handleAudio(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });
    const audioPath = join(mediaDir, "audio.wav");
    const timeoutMs = audioExtractTimeoutMs(file.durationS);

    if (file.mediaKind === "opatom") {
      const candidates = file.memberPaths ?? [file.path];
      let extracted = false;
      for (const candidate of candidates) {
        try {
          await extractAudio(candidate, audioPath, timeoutMs);
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
      await extractAudio(file.path, audioPath, timeoutMs);
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
  async function hasVideoAtom(file: {
    mediaKind: string;
    path: string;
    fps: number;
    videoUnplayable: boolean;
  }): Promise<boolean> {
    if (file.videoUnplayable) return false;
    if (file.mediaKind !== "opatom") return file.fps > 0;
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

    const proxyPath = await makeProxy(file.path, mediaDir, proxyTimeoutMs(file.durationS));
    db.setFileProxy(file.id, proxyPath);

    db.completeJob(job.id);
    await maybeMarkReady(file.id);
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
          await extractKeyframe(file.path, midpointS, outPath, KEYFRAME_TIMEOUT_MS);
          keyframePath = outPath;
          keyframeCount += 1;
        } catch {
          keyframePath = null;
        }
      }

      scenesWithKeyframes.push({
        startS: scene.startS,
        endS: scene.endS,
        startTc: file.fps > 0
          ? tcAddSeconds(file.startTc, scene.startS, file.fps, file.dropFrame)
          : formatElapsedOffset(scene.startS),
        endTc: file.fps > 0
          ? tcAddSeconds(file.startTc, scene.endS, file.fps, file.dropFrame)
          : formatElapsedOffset(scene.endS),
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
      db.waitJob(job.id, "Speech model not downloaded — Settings → Transcription");
      return;
    }

    const modelPath = findWhisperModel(whisperModel, dataDir);
    if (!modelPath) {
      db.waitJob(job.id, "Speech model not downloaded — Settings → Transcription");
      return;
    }

    const mediaDir = mediaDirFor(dataDir, file.id);
    const audioPath = join(mediaDir, "audio.wav");

    const segments = await transcribeAudio(
      audioPath,
      whisperBin,
      modelPath,
      transcribeTimeoutMs(file.durationS),
    );
    db.replaceTranscript(file.id, segments);
    db.markTranscribed(file.id);
    await maybeMarkReady(file.id);

    db.enqueueJob(file.id, "embed");

    db.completeJob(job.id);
  }

  async function maybeMarkReady(fileId: number): Promise<void> {
    const file = db.getFile(fileId);
    if (!file) return;
    const videoComplete = !(await hasVideoAtom(file)) ||
      (file.proxyPath !== null && file.hasVisualIndex);
    if (file.hasTranscript && videoComplete) {
      db.setFileStatus(fileId, "ready");
    }
  }

  async function handleVisualIndex(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const indexer = gemini();
    if (!indexer) {
      db.waitJob(job.id, "Gemini API key not set");
      return;
    }

    const scenes = db.listScenes(file.id);
    for (const scene of scenes) {
      const annotation = await indexer.annotateScene({
        proxyPath: file.proxyPath,
        keyframePaths: scene.keyframePath ? [scene.keyframePath] : [],
        startS: scene.startS,
        endS: scene.endS,
      });
      db.upsertAnnotation(scene.id, annotation);
      scheduleUpdate();
    }

    db.markVisuallyIndexed(file.id);
    await maybeMarkReady(file.id);

    db.enqueueJob(file.id, "embed");

    db.completeJob(job.id);
  }

  async function handleEmbed(job: Job): Promise<void> {
    const e = embedder();
    if (!e) {
      db.waitJob(job.id, "Gemini API key not set");
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

  async function repairFile(file: NonNullable<ReturnType<DailiesDB["getFile"]>>): Promise<void> {
    const hasVideo = await hasVideoAtom(file);
    let incomplete = false;

    if (!file.hasTranscript) {
      incomplete = true;
      if (file.audioChannels > 0) {
        if (!db.hasActiveJob(file.id, "transcribe")) db.enqueueJob(file.id, "audio");
      } else {
        db.replaceTranscript(file.id, []);
        db.markTranscribed(file.id);
      }
    }

    if (hasVideo) {
      if (!file.proxyPath) {
        incomplete = true;
        db.enqueueJob(file.id, "proxy");
      }
      if (!file.hasVisualIndex) {
        incomplete = true;
        if (!db.hasActiveJob(file.id, "visual_index")) db.enqueueJob(file.id, "scenes");
      }
    }

    if (
      db.listUnembeddedSegments(file.id).length > 0 ||
      db.listUnembeddedAnnotations(file.id).length > 0
    ) {
      db.enqueueJob(file.id, "embed");
    }

    if (incomplete) db.setFileStatus(file.id, "processing");
    await maybeMarkReady(file.id);
  }

  async function refreshPrerequisites(kind: "whisper" | "gemini" | "all"): Promise<void> {
    if (kind === "whisper" || kind === "all") {
      db.requeueWaitingJobs(["transcribe"]);
    }
    if (kind === "gemini" || kind === "all") {
      db.requeueWaitingJobs(["visual_index", "embed"]);
    }
    for (const file of db.listFiles()) {
      if (file.status === "error" && file.durationS === 0) continue;
      await repairFile(file);
    }
    scheduleUpdate();
    kick();
  }

  function isTransientError(err: unknown): boolean {
    const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return /\b429\b|\b5\d\d\b|rate.?limit|temporar|timeout|timed out|network|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket/i.test(
      message,
    );
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      const message = err instanceof Error ? err.message : String(err);
      if (isTransientError(err) && job.attempts < MAX_TRANSIENT_RETRIES) {
        await delay(RETRY_BASE_MS * 2 ** job.attempts);
        db.retryJob(job.id, message);
      } else if (job.stage === "proxy" || job.stage === "scenes") {
        // Video-stage give-up: degrade to audio-only instead of dead-ending the
        // file — a good transcript can still make it 'ready'. The failed job
        // stays visible in Settings.
        db.failJob(job.id, message);
        db.setVideoUnplayable(job.fileId, true);
        await maybeMarkReady(job.fileId);
      } else {
        db.failJob(job.id, message);
        db.setFileStatus(job.fileId, "error");
      }
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
    // Prerequisites may have arrived while this project was closed (model
    // downloaded with another/no project open, key added, app restarted) —
    // requeue waiting jobs now; handlers re-park them if still unmet.
    void refreshPrerequisites("all");
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
    grouper.close();
    await watcher.close();
  }

  return {
    watchFolder,
    unwatchFolder,
    scanFolder,
    ingestDocument,
    refreshPrerequisites,
    start,
    stop,
  };
}
