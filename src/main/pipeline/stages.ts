import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { setFileStatusInternal } from "../db/database";
import type { DailiesDB } from "../db/types";
import { reconcileEpisodeMembership } from "../membership";
import type { Job, JobStage, MediaFile, TextEmbedder } from "../../shared/types";
import { formatElapsedOffset, tcAddSeconds } from "../../shared/timecode";
import { findFfprobeBinary, findWhisperBinary, findWhisperModel } from "./binaries";
import { isSystemicSpawnError } from "./exec";
import { analyzeMxf, readMxfProjectName } from "./opatom";
import { extractAudio, extractKeyframe, isNoAudioStreamError, makeProxy } from "./proxy";
import { probeFile } from "./probe";
import { detectScenes } from "./scenes";
import { computeFileStatus, latestJobsByStage } from "./status";
import {
  audioExtractTimeoutMs,
  KEYFRAME_TIMEOUT_MS,
  proxyTimeoutMs,
  transcribeTimeoutMs,
} from "./timeouts";
import { transcribeAudio } from "./transcribe";

const MAX_KEYFRAMES_PER_FILE = 40;
const EMBED_BATCH_SIZE = 64;

export interface StageOptions {
  db: DailiesDB;
  dataDir: string;
  whisperModel: string;
  embedder: () => TextEmbedder | null;
}

export interface Stages {
  run(job: Job, signal: AbortSignal): Promise<void>;
  embedDocChunks(signal?: AbortSignal): Promise<void>;
  reconcile(fileId: number): void;
  ensureWork(fileId: number): void;
  reconcileAndEnsureAllFiles(): void;
}

function mediaDirFor(dataDir: string, fileId: number): string {
  return join(dataDir, "media", String(fileId));
}

export function createStages(opts: StageOptions): Stages {
  const { db, dataDir, whisperModel, embedder } = opts;

  function checkActive(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Pipeline job was abandoned");
  }

  function reconcileMediaTagEpisodes(...projectNames: Array<string | null>): void {
    const changedTags = new Set(projectNames.filter((name): name is string => name !== null));
    if (changedTags.size === 0) return;
    for (const episode of db.listEpisodes()) {
      if (
        episode.membershipSource === "media-tag" &&
        episode.mediaTag !== null &&
        changedTags.has(episode.mediaTag)
      ) {
        reconcileEpisodeMembership(db, episode.id);
      }
    }
  }

  function reconcile(fileId: number): void {
    const file = db.getFile(fileId);
    if (!file) return;
    const latestJobs = latestJobsByStage(db.listJobsForFile(fileId));
    // "Probed" means a probe actually succeeded — discovery only hashes, so a
    // hash alone proves nothing about the media being readable.
    const probed = !file.discoveryFailed &&
      !file.fileHash.startsWith("unreadable:") &&
      (file.durationS > 0 || latestJobs.get("probe")?.status === "done");
    const status = computeFileStatus({
      hasVideo: file.hasVideo,
      hasTranscript: file.hasTranscript,
      proxyPath: file.proxyPath,
      videoUnplayable: file.videoUnplayable,
      discoveryFailed: file.discoveryFailed,
      probed,
      latestJobs,
    });
    if (status !== file.status) setFileStatusInternal(db, fileId, status);
  }

  async function embedDocChunks(signal?: AbortSignal): Promise<void> {
    const e = embedder();
    if (!e) return;
    try {
      const pending = db.listUnembeddedDocChunks(EMBED_BATCH_SIZE);
      if (pending.length === 0) return;
      const vectors = await e.embed(pending.map((c) => c.text));
      checkActive(signal);
      pending.forEach((chunk, i) => {
        const vector = vectors[i];
        if (vector) db.upsertEmbedding("doc", chunk.refId, vector);
      });
    } catch (err) {
      console.error("[pipeline] doc embedding failed:", err);
    }
  }

  async function handleProbe(job: Job, signal: AbortSignal): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (file.mediaKind === "standard" && file.hasVideo === null) {
      const probed = await probeFile(file.path, file.fileHash);
      checkActive(signal);
      const updated = db.upsertFile({
        ...probed,
        role: file.role,
      });
      if (updated.sourceProject !== file.sourceProject) {
        reconcileMediaTagEpisodes(file.sourceProject, updated.sourceProject);
      }
    } else {
      await hasVideoAtom(file, signal);
    }
    checkActive(signal);
    db.completeJob(job.id);
    ensureWork(file.id);
  }

  async function handleAudio(job: Job, signal: AbortSignal): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });
    const audioPath = join(mediaDir, "audio.wav");
    const timeoutMs = audioExtractTimeoutMs(file.durationS);

    if (file.mediaKind === "opatom") {
      const candidates = file.memberPaths ?? [file.path];
      let extracted = false;
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          await extractAudio(candidate, audioPath, timeoutMs);
          checkActive(signal);
          extracted = true;
          break;
        } catch (err) {
          checkActive(signal);
          // Out-of-descriptors means the PROCESS can't spawn — nothing about
          // this clip. Surface it as-is so the queue treats it as transient
          // instead of recording a bogus per-file failure.
          if (isSystemicSpawnError(err)) throw err;
          if (!isNoAudioStreamError(err)) lastError = err;
          continue;
        }
      }
      if (!extracted) {
        if (lastError === null) {
          // Every member is video-only essence (render, motion effect,
          // still). No dialogue is a fact about the clip, not a failure:
          // index it with an empty transcript so it is searchable by name.
          db.replaceTranscript(file.id, []);
          db.markTranscribed(file.id);
          db.completeJob(job.id);
          return;
        }
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
          `Audio extraction failed for every member of opatom clip ${file.id}: ${message}`,
        );
      }
    } else {
      await extractAudio(file.path, audioPath, timeoutMs);
      checkActive(signal);
    }

    checkActive(signal);
    db.enqueueJob(file.id, "transcribe");

    db.completeJob(job.id);
  }

  async function hasVideoAtom(
    file: Pick<MediaFile, "id" | "hasVideo" | "mediaKind" | "path" | "fileHash">,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (file.hasVideo !== null) return file.hasVideo;

    let hasVideo: boolean;
    if (file.mediaKind === "opatom") {
      const info = await analyzeMxf(findFfprobeBinary(), file.path);
      checkActive(signal);
      hasVideo = info?.essence === "video";
    } else {
      const probed = await probeFile(file.path, file.fileHash);
      checkActive(signal);
      hasVideo = probed.hasVideo ?? probed.fps > 0;
    }
    db.setFileHasVideo(file.id, hasVideo);
    reconcile(file.id);
    return hasVideo;
  }

  async function handleProxy(job: Job, signal: AbortSignal): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (file.videoUnplayable || !(await hasVideoAtom(file, signal))) {
      // Audio-only opatom clip — nothing to make a proxy from.
      db.completeJob(job.id);
      return;
    }

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });

    const proxyPath = await makeProxy(file.path, mediaDir, proxyTimeoutMs(file.durationS));
    checkActive(signal);
    db.setFileProxy(file.id, proxyPath);

    db.completeJob(job.id);
  }

  async function handleScenes(job: Job, signal: AbortSignal): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    if (file.videoUnplayable || !(await hasVideoAtom(file, signal))) {
      // Audio-only opatom clip — no video to scene-detect.
      db.completeJob(job.id);
      return;
    }

    const mediaDir = mediaDirFor(dataDir, file.id);
    await mkdir(mediaDir, { recursive: true });

    const detected = await detectScenes(file.path, file.durationS);
    checkActive(signal);

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
          checkActive(signal);
          keyframePath = outPath;
          keyframeCount += 1;
        } catch {
          checkActive(signal);
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

    checkActive(signal);
    db.replaceScenes(file.id, scenesWithKeyframes);
    db.completeJob(job.id);
  }

  async function handleTranscribe(job: Job, signal: AbortSignal): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const whisperBin = findWhisperBinary();
    if (!whisperBin) {
      db.waitJob(job.id, "Speech model not downloaded — Settings → Transcription");
      return;
    }

    // Pre-0.5.2 installs have ggml-large-v3-turbo.bin on disk but not the
    // q8_0 default — keep transcribing with the old file rather than parking
    // every job until the user downloads the new one.
    const modelPath =
      findWhisperModel(whisperModel, dataDir) ??
      (whisperModel === "large-v3-turbo-q8_0"
        ? findWhisperModel("large-v3-turbo", dataDir)
        : null);
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
    checkActive(signal);
    db.replaceTranscript(file.id, segments);
    db.markTranscribed(file.id);

    db.enqueueJob(file.id, "embed");

    db.completeJob(job.id);
  }

  async function handleEmbed(job: Job, signal: AbortSignal): Promise<void> {
    const e = embedder();
    if (!e) {
      db.waitJob(job.id, "OpenRouter API key not set — Settings → AI");
      return;
    }

    const segments = db.listUnembeddedSegments(job.fileId);
    for (let i = 0; i < segments.length; i += EMBED_BATCH_SIZE) {
      const batch = segments.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await e.embed(batch.map((s) => s.text));
      checkActive(signal);
      batch.forEach((seg, idx) => {
        const vector = vectors[idx];
        if (vector) db.upsertEmbedding("segment", seg.refId, vector);
      });
    }

    await embedDocChunks(signal);
    checkActive(signal);
    db.completeJob(job.id);
  }

  function ensureWork(fileId: number): void {
    const file = db.getFile(fileId);
    if (!file || file.discoveryFailed) return;

    const latestJobs = latestJobsByStage(db.listJobsForFile(file.id));
    // Local stages fail deterministically — a terminal error stays terminal
    // until an explicit Retry (or key-save for embed) reopens it. Without this
    // guard every app open would re-run known-failing ffmpeg/whisper work.
    const schedulable = (stage: JobStage): boolean =>
      latestJobs.get(stage)?.status !== "error";

    if (db.listUnembeddedSegments(file.id).length > 0) {
      db.enqueueJob(file.id, "embed");
    }

    if (file.hasVideo === null) {
      if (schedulable("probe")) db.enqueueJob(file.id, "probe");
      reconcile(file.id);
      return;
    }

    if (!file.hasTranscript) {
      if (file.audioChannels > 0) {
        if (
          !db.hasActiveJob(file.id, "transcribe") &&
          schedulable("audio") && schedulable("transcribe")
        ) {
          db.enqueueJob(file.id, "audio");
        }
      } else {
        db.replaceTranscript(file.id, []);
        db.markTranscribed(file.id);
      }
    }

    if (file.hasVideo && !file.videoUnplayable) {
      if (!file.proxyPath && schedulable("proxy")) db.enqueueJob(file.id, "proxy");
      const scenes = db.listScenes(file.id);
      const scenesJob = latestJobs.get("scenes");
      if (
        scenesJob?.status !== "done" &&
        schedulable("scenes") &&
        !scenes.some((scene) => scene.keyframePath !== null)
      ) {
        db.enqueueJob(file.id, "scenes");
      }
    }

    reconcile(file.id);
  }

  /**
   * Reads the Avid project tag of one already-indexed clip.
   *
   * Header-only and deliberately inert: it enqueues nothing, touches no
   * derived state, and never calls ensureWork. Only a successful header read
   * with no tag records an untagged clip. Read failures propagate to the queue
   * so a temporary drive or ffprobe problem can be retried.
   */
  async function handleMediaTag(job: Job, signal: AbortSignal): Promise<void> {
    const file = db.getFile(job.fileId);
    if (!file) throw new Error(`Job ${job.id}: file ${job.fileId} not found`);

    const path = file.memberPaths?.[0] ?? file.path;
    const projectName = await readMxfProjectName(findFfprobeBinary(), path);
    checkActive(signal);

    if (projectName !== null) {
      db.setFileSourceProject(file.id, projectName);
      // A tag read after the fact can hand this clip to an existing episode.
      reconcileMediaTagEpisodes(file.sourceProject, projectName);
    }
    db.completeJob(job.id);
  }

  function reconcileAndEnsureAllFiles(): void {
    db.backfillDiscoveryFailures();
    const files = db.listFiles();
    for (const file of files) reconcile(file.id);
    for (const file of files) ensureWork(file.id);
  }

  async function run(job: Job, signal: AbortSignal): Promise<void> {
    switch (job.stage) {
      case "probe":
        await handleProbe(job, signal);
        break;
      case "audio":
        await handleAudio(job, signal);
        break;
      case "proxy":
        await handleProxy(job, signal);
        break;
      case "scenes":
        await handleScenes(job, signal);
        break;
      case "transcribe":
        await handleTranscribe(job, signal);
        break;
      case "embed":
        await handleEmbed(job, signal);
        break;
      case "media-tag":
        await handleMediaTag(job, signal);
        break;
      default: {
        const unhandledStage: never = job.stage;
        throw new Error(`Unhandled job stage: ${String(unhandledStage)}`);
      }
    }
  }

  return {
    run,
    embedDocChunks,
    reconcile,
    ensureWork,
    reconcileAndEnsureAllFiles,
  };
}
