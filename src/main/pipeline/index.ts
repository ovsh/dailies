/**
 * Orchestrates the local media-processing pipeline: watches folders, walks
 * files through probe -> {audio, proxy, scenes} -> transcribe -> embed,
 * persisting every result via DailiesDB and notifying the
 * renderer. Also ingests documents (producer notes, scripts) alongside
 * media, and groups Avid OP-Atom MXF essence atoms into single clips.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

import { OpenRouterApiError } from "../agents/openrouter-client";
import { setFileStatusInternal } from "../db/database";
import type { DailiesDB } from "../db/types";
import type {
  FileInput,
  Job,
  MediaFile,
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
import { computeFileStatus, latestJobsByStage, STAGE_POLICY } from "./status";
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
const SCAN_STABILITY_WINDOW_MS = 3000;

function parseMemberHashMap(fileHash: string): Map<string, string> {
  const members = new Map<string, string>();
  if (!fileHash) return members;
  for (const entry of fileHash.split("|")) {
    const separator = entry.lastIndexOf(":");
    const path = entry.slice(0, separator);
    const hash = entry.slice(separator + 1);
    if (separator <= 0 || !path || !/^[a-f0-9]{40}$/i.test(hash)) return new Map();
    members.set(path, hash);
  }
  return members;
}

function isUnchangedSuperset(oldFileHash: string, newMap: Map<string, string>): boolean {
  const oldMap = parseMemberHashMap(oldFileHash);
  if (oldMap.size === 0) return false;
  for (const [path, hash] of oldMap) {
    if (newMap.get(path) !== hash) return false;
  }
  return true;
}

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
  const { db, dataDir, whisperModel, embedder, onUpdate } = opts;

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

  function reconcile(fileId: number): void {
    const file = db.getFile(fileId);
    if (!file) return;
    const status = computeFileStatus({
      hasVideo: file.hasVideo,
      hasTranscript: file.hasTranscript,
      proxyPath: file.proxyPath,
      videoUnplayable: file.videoUnplayable,
      discoveryFailed: file.discoveryFailed,
      probed: !file.discoveryFailed &&
        file.fileHash.length > 0 &&
        !file.fileHash.startsWith("unreadable:"),
      latestJobs: latestJobsByStage(db.listJobsForFile(fileId)),
    });
    if (status !== file.status) setFileStatusInternal(db, fileId, status);
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
    const newHashMap = parseMemberHashMap(fileHash);
    if (
      existing &&
      existing.memberPaths &&
      existing.memberPaths.length === memberPaths.length &&
      existing.memberPaths.every((path, index) => path === memberPaths[index]) &&
      existing.fileHash === fileHash
    ) {
      reconcile(existing.id);
      ensureWork(existing.id);
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
      hasVideo: videoAtoms.length > 0,
    };

    if (existing && isUnchangedSuperset(existing.fileHash, newHashMap)) {
      // Member set grew (e.g. video atom finally landed) but every
      // previously-known atom is byte-identical — preserve finished work.
      const updated = db.updateOpAtomMembers(existing.id, input);
      reconcile(updated.id);
      ensureWork(updated.id);
      scheduleUpdate();
      return;
    }

    const file = db.upsertFile(input);
    db.enqueueJob(file.id, "probe");
    reconcile(file.id);
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
    // (audio/proxy/scenes/transcribe) is still fully deferred
    // to the worker loop via enqueueJob — this call never dispatches those.
    let probed: FileInput;
    try {
      probed = await probeFile(path);
    } catch (err) {
      // Unreadable media (corrupt file, unsupported MXF variant) must remain
      // VISIBLE as an error rather than silently disappearing — otherwise the
      // clip count doesn't match what the editor put in the folder and it
      // looks like the app "lost" a file. Record a stub in error state.
      let unreadable = existing;
      if (!unreadable) {
        unreadable = db.upsertFile({
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
      }
      db.setDiscoveryFailed(unreadable.id, true);
      reconcile(unreadable.id);
      scheduleUpdate();
      console.warn(`onFileFound: unreadable media ${path}:`, err);
      return;
    }
    probed.role = roleForPath(path);
    probed.episodeId = episodeIdForPath(path);
    if (existing?.discoveryFailed) db.setDiscoveryFailed(existing.id, false);

    if (!existing) {
      const byHash = db.getFileByHash(probed.fileHash);
      if (
        byHash?.mediaKind === "standard" &&
        byHash.path !== path &&
        !existsSync(byHash.path)
      ) {
        // A remounted drive or renamed folder changes the absolute path but
        // not the content hash, so keep the existing clip's derived state.
        const repointed = db.repointFilePath(byHash.id, path, probed.filename);
        reconcile(repointed.id);
        ensureWork(repointed.id);
        scheduleUpdate();
        return;
      }
    }

    if (existing && existing.fileHash === probed.fileHash) {
      // File identity is unchanged, but derived processing may be incomplete.
      reconcile(existing.id);
      ensureWork(existing.id);
      return;
    }

    const file = db.upsertFile(probed);
    db.enqueueJob(file.id, "probe");
    reconcile(file.id);
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

  async function isStableForScan(path: string): Promise<boolean> {
    try {
      const first = await stat(path);
      if (Date.now() - first.mtimeMs >= SCAN_STABILITY_WINDOW_MS) return true;
      await delay(SCAN_STABILITY_WINDOW_MS);
      const second = await stat(path);
      return first.size === second.size && first.mtimeMs === second.mtimeMs;
    } catch {
      return false;
    }
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
          if (!(await isStableForScan(file))) {
            console.warn(
              `scanFolder: ${file} is still being written; the watcher will pick it up`,
            );
            continue;
          }
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

    await hasVideoAtom(file);
    db.completeJob(job.id);
    ensureWork(file.id);
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

  async function hasVideoAtom(
    file: Pick<MediaFile, "id" | "hasVideo" | "mediaKind" | "path">,
  ): Promise<boolean> {
    if (file.hasVideo !== null) return file.hasVideo;

    let hasVideo: boolean;
    if (file.mediaKind === "opatom") {
      const info = await analyzeMxf(findFfprobeBinary(), file.path);
      hasVideo = info?.essence === "video";
    } else {
      const probed = await probeFile(file.path);
      hasVideo = probed.hasVideo ?? probed.fps > 0;
    }
    db.setFileHasVideo(file.id, hasVideo);
    reconcile(file.id);
    return hasVideo;
  }

  async function handleProxy(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (file.videoUnplayable || !(await hasVideoAtom(file))) {
      // Audio-only opatom clip — nothing to make a proxy from.
      db.completeJob(job.id);
      return;
    }

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });

    const proxyPath = await makeProxy(file.path, mediaDir, proxyTimeoutMs(file.durationS));
    db.setFileProxy(file.id, proxyPath);

    db.completeJob(job.id);
  }

  async function handleScenes(job: Job): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (file.videoUnplayable || !(await hasVideoAtom(file))) {
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

    db.enqueueJob(file.id, "embed");

    db.completeJob(job.id);
  }

  async function handleEmbed(job: Job): Promise<void> {
    const e = embedder();
    if (!e) {
      db.waitJob(job.id, "OpenRouter API key not set — Settings → AI");
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

    await embedDocChunks();
    db.completeJob(job.id);
  }

  function ensureWork(fileId: number): void {
    const file = db.getFile(fileId);
    if (!file || file.discoveryFailed) return;

    if (db.listUnembeddedSegments(file.id).length > 0) {
      db.enqueueJob(file.id, "embed");
    }

    if (file.hasVideo === null) {
      db.enqueueJob(file.id, "probe");
      reconcile(file.id);
      return;
    }

    if (!file.hasTranscript) {
      if (file.audioChannels > 0) {
        if (!db.hasActiveJob(file.id, "transcribe")) db.enqueueJob(file.id, "audio");
      } else {
        db.replaceTranscript(file.id, []);
        db.markTranscribed(file.id);
      }
    }

    if (file.hasVideo && !file.videoUnplayable) {
      if (!file.proxyPath) db.enqueueJob(file.id, "proxy");
      const scenes = db.listScenes(file.id);
      if (!scenes.some((scene) => scene.keyframePath !== null)) {
        db.enqueueJob(file.id, "scenes");
      }
    }

    reconcile(file.id);
  }

  function reconcileAndEnsureAllFiles(): void {
    db.backfillDiscoveryFailures();
    const files = db.listFiles();
    for (const file of files) reconcile(file.id);
    for (const file of files) ensureWork(file.id);
  }

  async function refreshPrerequisites(kind: "whisper" | "gemini" | "all"): Promise<void> {
    if (kind === "whisper" || kind === "all") {
      db.requeueWaitingJobs(["transcribe"]);
    }
    if (kind === "gemini") {
      db.reopenErroredJobs(undefined, ["embed"]);
    }
    if (kind === "gemini" || kind === "all") {
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
        case "embed":
          await handleEmbed(job);
          break;
        default: {
          const unhandledStage: never = job.stage;
          throw new Error(`Unhandled job stage: ${String(unhandledStage)}`);
        }
      }
    } catch (err) {
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
      reconcile(job.fileId);
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
    retryFile,
    refreshPrerequisites,
    start,
    stop,
  };
}
