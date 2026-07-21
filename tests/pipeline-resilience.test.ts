import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whisperReady: false,
  probeFile: vi.fn(),
  probeInput: null as null | Record<string, unknown>,
  probeByPath: new Map<string, Record<string, unknown>>(),
  mxfAtoms: new Map<string, {
    path: string;
    clipKey: string;
    clipName: string | null;
    essence: "video" | "audio";
    durationS: number;
    fps: number;
    dropFrame: boolean;
    startTc: string;
    codec: string;
  }>(),
  watcherOnFileFound: null as ((path: string) => void) | null,
  detectedScenes: [{ startS: 0, endS: 5 }],
  detectScenes: vi.fn(),
  makeProxy: vi.fn(),
  transcribe: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("../src/main/pipeline/binaries", () => ({
  findFfprobeBinary: () => "ffprobe",
  findWhisperBinary: () => (mocks.whisperReady ? "/fake/whisper" : null),
  findWhisperModel: () => (mocks.whisperReady ? "/fake/model.bin" : null),
}));
vi.mock("../src/main/pipeline/probe", () => ({
  probeFile: mocks.probeFile,
}));
vi.mock("../src/main/pipeline/opatom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/pipeline/opatom")>();
  return {
    ...actual,
    analyzeMxf: vi.fn(async (_ffprobePath: string, filePath: string) =>
      mocks.mxfAtoms.get(filePath) ?? null),
  };
});
vi.mock("../src/main/pipeline/proxy", () => ({
  extractAudio: vi.fn(async () => {}),
  extractKeyframe: vi.fn(async () => {}),
  makeProxy: mocks.makeProxy,
}));
vi.mock("../src/main/pipeline/scenes", () => ({
  detectScenes: mocks.detectScenes,
}));
vi.mock("../src/main/pipeline/transcribe", () => ({
  transcribeAudio: mocks.transcribe,
}));
vi.mock("../src/main/pipeline/watcher", () => ({
  createWatcher: (opts: { onFileFound(path: string): void }) => {
    mocks.watcherOnFileFound = opts.onFileFound;
    return { watchFolder() {}, unwatchFolder() {}, async close() {} };
  },
}));

import { openDatabase } from "../src/main/db/database";
import { createPipeline } from "../src/main/pipeline";
import type { DailiesDB } from "../src/main/db/types";
import { isAudioOnly } from "../src/renderer/lib/media";

const openDbs: DailiesDB[] = [];

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-pipeline-"));
  const db = openDatabase(path.join(dataDir, "test.db"));
  openDbs.push(db);
  const pipeline = createPipeline({
    db,
    dataDir,
    whisperModel: "tiny",
    embedder: () => ({ embed: mocks.embed }),
    onUpdate: () => {},
  });
  return { dataDir, db, pipeline };
}

async function waitForDrain(db: DailiesDB) {
  await vi.waitFor(() => {
    expect(db.listJobs().some((job) => job.status === "queued" || job.status === "running")).toBe(false);
  }, { timeout: 5000 });
}

function makeStable(filePath: string): void {
  const old = new Date(Date.now() - 10_000);
  utimesSync(filePath, old, old);
}

function setLegacyFileStatus(dataDir: string, fileId: number, status: string): void {
  const raw = new Database(path.join(dataDir, "test.db"));
  raw.prepare("UPDATE files SET status = ? WHERE id = ?").run(status, fileId);
  raw.close();
}

beforeEach(() => {
  mocks.whisperReady = false;
  mocks.probeFile.mockReset().mockImplementation(async (filePath: string) =>
    mocks.probeByPath.get(filePath) ?? mocks.probeInput);
  mocks.probeInput = null;
  mocks.probeByPath.clear();
  mocks.mxfAtoms.clear();
  mocks.watcherOnFileFound = null;
  mocks.detectedScenes = [{ startS: 0, endS: 5 }];
  mocks.detectScenes.mockReset().mockImplementation(async () => mocks.detectedScenes);
  mocks.makeProxy.mockReset().mockImplementation(
    async (_path: string, outDir: string) => path.join(outDir, "proxy.mp4"),
  );
  mocks.transcribe.mockReset().mockResolvedValue([{
    startS: 0,
    endS: 1,
    text: "a recovered transcript",
    avgConf: 1,
    words: [],
  }]);
  mocks.embed.mockReset().mockImplementation(async (texts: string[]) =>
    texts.map(() => new Float32Array(768).fill(1)));
});

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()!.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pipeline prerequisite and applicability handling", () => {
  it("requeues and processes a waiting transcription when startup finds the model", async () => {
    const { db, pipeline } = setup();
    const file = db.upsertFile({
      path: "/media/waiting-audio.wav",
      filename: "waiting-audio.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "waiting-audio",
      hasVideo: false,
    });
    db.enqueueJob(file.id, "transcribe");
    const waitingJob = db.claimNextJob();
    db.waitJob(waitingJob!.id, "model missing while project was closed");
    expect(db.listJobs()[0]?.status).toBe("waiting");

    mocks.whisperReady = true;
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("ready"), { timeout: 5000 });
    expect(db.listJobs().find((job) => job.id === waitingJob!.id)?.status).toBe("done");
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("requeues a waiting transcription when the model arrives", async () => {
    const { db, pipeline } = setup();
    const file = db.upsertFile({
      path: "/media/audio.wav",
      filename: "audio.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "audio",
      hasVideo: false,
    });
    db.enqueueJob(file.id, "transcribe");
    pipeline.start();

    await vi.waitFor(() => expect(db.listJobs().some((job) => job.status === "waiting")).toBe(true));
    expect(db.getFile(file.id)?.status).toBe("processing");

    mocks.whisperReady = true;
    await pipeline.refreshPrerequisites("whisper");
    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("ready"), { timeout: 5000 });
    expect(db.getFile(file.id)?.hasTranscript).toBe(true);
    expect(mocks.transcribe).toHaveBeenCalled();
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("surfaces a terminal job failure as a file error instead of leaving processing stuck", async () => {
    const { db, pipeline } = setup();
    mocks.whisperReady = true;
    mocks.transcribe.mockRejectedValue(new Error("invalid whisper output"));
    const file = db.upsertFile({
      path: "/media/bad-audio.wav",
      filename: "bad-audio.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "bad-audio",
      hasVideo: false,
    });
    db.enqueueJob(file.id, "transcribe");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("error"));
    expect(db.listJobs().find((job) => job.stage === "transcribe")?.status).toBe("error");
    await pipeline.stop();
  });

  it("backfills and preserves an unreadable legacy stub on startup", async () => {
    const { dataDir, db, pipeline } = setup();
    const file = db.upsertFile({
      path: "/media/unreadable.mov",
      filename: "unreadable.mov",
      durationS: 0,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "unknown",
      audioChannels: 0,
      fileHash: "unreadable:/media/unreadable.mov",
    });
    setLegacyFileStatus(dataDir, file.id, "error");

    pipeline.start();

    await vi.waitFor(() => {
      expect(db.getFile(file.id)).toMatchObject({
        status: "error",
        discoveryFailed: true,
      });
    });
    expect(db.listJobsForFile(file.id)).toEqual([]);
    await pipeline.stop();
  });

  it("queues and persists one probe for legacy unknown video", async () => {
    const { db, pipeline } = setup();
    const file = db.upsertFile({
      path: "/media/legacy-video.mov",
      filename: "legacy-video.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "legacy-video",
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);

    await pipeline.refreshPrerequisites("all");

    expect(db.getFile(file.id)).toMatchObject({
      hasVideo: null,
      status: "processing",
    });
    expect(db.listJobsForFile(file.id)).toEqual([
      expect.objectContaining({ stage: "probe", status: "queued" }),
    ]);
    expect(mocks.probeFile).not.toHaveBeenCalled();

    mocks.probeInput = {
      path: file.path,
      filename: file.filename,
      durationS: file.durationS,
      fps: file.fps,
      dropFrame: file.dropFrame,
      startTc: file.startTc,
      codec: file.codec,
      audioChannels: file.audioChannels,
      fileHash: file.fileHash,
      hasVideo: true,
    };
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.hasVideo).toBe(true));
    await waitForDrain(db);
    expect(mocks.probeFile).toHaveBeenCalledTimes(1);

    await pipeline.refreshPrerequisites("all");
    expect(mocks.probeFile).toHaveBeenCalledTimes(1);
    await pipeline.stop();
  });

  it("retries the same terminal transcription job while stopped", async () => {
    const { db, pipeline } = setup();
    const file = db.upsertFile({
      path: "/media/retry-audio.wav",
      filename: "retry-audio.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "retry-audio",
      hasVideo: false,
    });
    db.enqueueJob(file.id, "transcribe");
    const failedJob = db.claimNextJob()!;
    db.retryJob(failedJob.id, "transient transcription failure");
    expect(db.claimNextJob()?.id).toBe(failedJob.id);
    db.failJob(failedJob.id, "terminal transcription failure");

    await pipeline.retryFile(file.id);

    expect(db.listJobs().filter((job) =>
      job.fileId === file.id && job.stage === "transcribe"
    )).toEqual([
      expect.objectContaining({
        id: failedJob.id,
        status: "queued",
        attempts: 0,
        error: null,
      }),
    ]);
    expect(db.getFile(file.id)?.status).toBe("processing");
    await pipeline.stop();
  });

  it("degrades a video with an undecodable proxy to ready audio-only media", async () => {
    const { db, pipeline } = setup();
    mocks.makeProxy.mockRejectedValue(
      new Error("Invalid data found when processing input"),
    );
    const file = db.upsertFile({
      path: "/media/undecodable.mov",
      filename: "undecodable.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "exotic",
      audioChannels: 2,
      fileHash: "undecodable",
      hasVideo: true,
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);
    db.enqueueJob(file.id, "proxy");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("ready"), { timeout: 5000 });
    const degraded = db.getFile(file.id)!;
    expect(degraded.videoUnplayable).toBe(true);
    expect(degraded.proxyPath).toBeNull();
    expect(isAudioOnly(degraded)).toBe(true);
    expect(db.listJobs().find((job) => job.stage === "proxy")?.status).toBe("error");
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("degrades a proxy after transient retries are exhausted", async () => {
    const { db, pipeline } = setup();
    mocks.makeProxy.mockRejectedValue(new Error("HTTP 429 rate limit"));
    const file = db.upsertFile({
      path: "/media/rate-limited.mov",
      filename: "rate-limited.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "rate-limited",
      hasVideo: true,
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);
    db.enqueueJob(file.id, "proxy");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.videoUnplayable).toBe(true), {
      timeout: 5000,
    });
    const proxyJob = db.listJobs().find((job) => job.stage === "proxy");
    expect(proxyJob).toMatchObject({ status: "error", attempts: 4 });
    expect(db.getFile(file.id)?.status).toBe("ready");
    expect(mocks.makeProxy).toHaveBeenCalledTimes(4);
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("keeps a scenes failure job-only without degrading playable video", async () => {
    const { db, pipeline } = setup();
    mocks.detectScenes.mockRejectedValue(new Error("scene detection failed"));
    const file = db.upsertFile({
      path: "/media/scene-failure.mov",
      filename: "scene-failure.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "scene-failure",
      hasVideo: true,
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);
    db.setFileProxy(file.id, "/cache/proxy.mp4");
    db.enqueueJob(file.id, "scenes");

    pipeline.start();

    await vi.waitFor(() => {
      expect(db.listJobsForFile(file.id).find((job) => job.stage === "scenes")?.status)
        .toBe("error");
    });
    expect(db.getFile(file.id)).toMatchObject({
      status: "ready",
      videoUnplayable: false,
    });
    await pipeline.stop();
  });

  it("retries a timed-out proxy and frees its slot for later unrelated work", async () => {
    const { db, pipeline } = setup();
    mocks.makeProxy.mockImplementation(async (mediaPath: string, outDir: string) => {
      if (mediaPath === "/media/hung.mov") {
        throw new Error("ffmpeg proxy timed out after 90000ms");
      }
      return path.join(outDir, "proxy.mp4");
    });
    const hung = db.upsertFile({
      path: "/media/hung.mov",
      filename: "hung.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "hung",
      hasVideo: true,
    });
    db.replaceTranscript(hung.id, []);
    db.markTranscribed(hung.id);
    db.enqueueJob(hung.id, "proxy");
    pipeline.start();

    await vi.waitFor(() => {
      expect(db.listJobs().find((job) => job.fileId === hung.id && job.stage === "proxy"))
        .toMatchObject({ status: "error", attempts: 4 });
    }, { timeout: 5000 });
    expect(mocks.makeProxy.mock.calls.filter(([mediaPath]) => mediaPath === hung.path)).toHaveLength(4);

    const unrelated = db.upsertFile({
      path: "/media/unrelated.mov",
      filename: "unrelated.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "02:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "unrelated",
      hasVideo: true,
    });
    db.enqueueJob(unrelated.id, "probe");

    await vi.waitFor(() => expect(db.getFile(unrelated.id)?.status).toBe("ready"), {
      timeout: 5000,
    });
    expect(db.listJobs().find((job) => job.fileId === unrelated.id && job.stage === "probe")?.status)
      .toBe("done");
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("makes silent video ready with an explicit empty transcript and proxy", async () => {
    const { db, pipeline } = setup();
    const file = db.upsertFile({
      path: "/media/silent.mov",
      filename: "silent.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "silent",
      hasVideo: true,
    });
    db.enqueueJob(file.id, "probe");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("ready"), { timeout: 5000 });
    expect(db.getFile(file.id)?.hasTranscript).toBe(true);
    expect(db.listSegments(file.id)).toEqual([]);
    expect(db.listJobs().some((job) => job.stage === "transcribe")).toBe(false);
    expect(db.getFile(file.id)?.proxyPath).not.toBeNull();
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("repairs missing derived stages when an unchanged file is rescanned", async () => {
    const { dataDir, db, pipeline } = setup();
    const mediaPath = path.join(dataDir, "unchanged.mov");
    writeFileSync(mediaPath, "fixture");
    makeStable(mediaPath);
    mocks.probeInput = {
      path: mediaPath,
      filename: "unchanged.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "same-hash",
      hasVideo: true,
    };
    db.upsertFile(mocks.probeInput as never);

    await pipeline.scanFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });

    const stages = db.listJobs().map((job) => job.stage);
    expect(stages).toEqual(expect.arrayContaining(["audio", "proxy", "scenes"]));
    await pipeline.stop();
  });

  it("repoints moved standard media by hash without clearing derived state", async () => {
    const { dataDir, db, pipeline } = setup();
    const scanDir = path.join(dataDir, "remounted");
    mkdirSync(scanDir);
    const oldPath = path.join(dataDir, "missing-volume", "clip.mov");
    const newPath = path.join(scanDir, "renamed.mov");
    writeFileSync(newPath, "same bytes");
    makeStable(newPath);

    const original = db.upsertFile({
      path: oldPath,
      filename: "clip.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "moved-hash",
      hasVideo: true,
    });
    db.replaceTranscript(original.id, [{
      startS: 0,
      endS: 1,
      text: "keep this transcript",
      avgConf: 1,
      words: [],
    }]);
    db.markTranscribed(original.id);
    db.setFileProxy(original.id, "/cache/proxy.mp4");
    db.replaceScenes(original.id, [{
      startS: 0,
      endS: 5,
      startTc: "01:00:00:00",
      endTc: "01:00:05:00",
      keyframePath: "/cache/keyframe-0.jpg",
    }]);
    // Prevent ensureWork from treating the preserved transcript as missing embed work.
    const segmentId = db.listSegments(original.id)[0]!.id;
    db.upsertEmbedding("segment", segmentId, new Float32Array(768));
    mocks.probeByPath.set(newPath, {
      ...original,
      path: newPath,
      filename: "renamed.mov",
      fileHash: "moved-hash",
    });

    await pipeline.scanFolder({
      id: 1,
      path: scanDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });

    expect(db.listFiles()).toHaveLength(1);
    expect(db.getFile(original.id)).toMatchObject({
      path: newPath,
      filename: "renamed.mov",
      hasTranscript: true,
      proxyPath: "/cache/proxy.mp4",
    });
    expect(db.listSegments(original.id)[0]?.text).toBe("keep this transcript");
    expect(db.listJobs()).toEqual([]);
    await pipeline.stop();
  });

  it("keeps a duplicate as a new file when the hash-matched old path still exists", async () => {
    const { dataDir, db, pipeline } = setup();
    const scanDir = path.join(dataDir, "copies");
    mkdirSync(scanDir);
    const oldPath = path.join(dataDir, "original.mov");
    const newPath = path.join(scanDir, "copy.mov");
    writeFileSync(oldPath, "same bytes");
    writeFileSync(newPath, "same bytes");
    makeStable(oldPath);
    makeStable(newPath);

    const original = db.upsertFile({
      path: oldPath,
      filename: "original.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "duplicate-hash",
      hasVideo: true,
    });
    mocks.probeByPath.set(newPath, {
      path: newPath,
      filename: "copy.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "duplicate-hash",
      hasVideo: true,
    });

    await pipeline.scanFolder({
      id: 1,
      path: scanDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });

    const copy = db.getFileByPath(newPath);
    expect(copy?.id).not.toBe(original.id);
    expect(db.listFiles()).toHaveLength(2);
    expect(db.listJobs()).toContainEqual(expect.objectContaining({
      fileId: copy?.id,
      stage: "probe",
    }));
    await pipeline.stop();
  });

  it("preserves a completed OP-Atom transcript when a late video atom arrives", async () => {
    vi.useFakeTimers();
    const { dataDir, db, pipeline } = setup();
    const audioPath = path.join(dataDir, "CLIPA01.mxf");
    const videoPath = path.join(dataDir, "CLIPV01.mxf");
    writeFileSync(audioPath, "audio atom");
    writeFileSync(videoPath, "video atom");
    const base = {
      clipKey: "umid-late-video",
      clipName: "Late Video",
      durationS: 5,
      dropFrame: false,
      startTc: "01:00:00:00",
    };
    mocks.mxfAtoms.set(audioPath, {
      ...base,
      path: audioPath,
      essence: "audio",
      fps: 24,
      codec: "pcm_s24le",
    });
    mocks.mxfAtoms.set(videoPath, {
      ...base,
      path: videoPath,
      essence: "video",
      fps: 24,
      codec: "dnxhd",
    });
    mocks.probeByPath.set(audioPath, { fileHash: "a".repeat(40) });
    mocks.probeByPath.set(videoPath, { fileHash: "b".repeat(40) });

    expect(mocks.watcherOnFileFound).not.toBeNull();
    mocks.watcherOnFileFound!(audioPath);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(db.listFiles()).toHaveLength(1));

    const audioOnly = db.listFiles()[0]!;
    db.replaceTranscript(audioOnly.id, [{
      startS: 0,
      endS: 1,
      text: "finished before video arrived",
      avgConf: 1,
      words: [],
    }]);
    db.markTranscribed(audioOnly.id);
    db.enqueueJob(audioOnly.id, "embed");
    expect(db.getFile(audioOnly.id)?.hasTranscript).toBe(true);
    const priorJobIds = new Set(db.listJobs().map((job) => job.id));

    mocks.watcherOnFileFound!(videoPath);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() =>
      expect(db.getFile(audioOnly.id)?.memberPaths).toEqual([videoPath, audioPath]));

    const joined = db.getFile(audioOnly.id)!;
    expect(joined.hasTranscript).toBe(true);
    expect(db.listSegments(joined.id)[0]?.text).toBe("finished before video arrived");
    const newStages = db.listJobs()
      .filter((job) => !priorJobIds.has(job.id))
      .map((job) => job.stage)
      .sort();
    expect(newStages).toEqual(["proxy", "scenes"]);
    await pipeline.stop();
  });

  it("skips a manually scanned video that changes during the stability window", async () => {
    const realSetImmediate = setImmediate;
    vi.useFakeTimers();
    const { dataDir, db, pipeline } = setup();
    const mediaPath = path.join(dataDir, "copying.mov");
    writeFileSync(mediaPath, "partial");
    mocks.probeByPath.set(mediaPath, {
      path: mediaPath,
      filename: "copying.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "partial-hash",
      hasVideo: true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const scan = pipeline.scanFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });
    for (let i = 0; i < 20 && vi.getTimerCount() === 0; i += 1) {
      await new Promise<void>((resolve) => realSetImmediate(resolve));
    }
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    setTimeout(() => appendFileSync(mediaPath, " more"), 1000);
    await vi.advanceTimersByTimeAsync(3000);
    await scan;

    expect(db.getFileByPath(mediaPath)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("watcher will pick it up"));
    warn.mockRestore();
    await pipeline.stop();
  });

  it("immediately scans a video older than the stability window", async () => {
    const { dataDir, db, pipeline } = setup();
    const mediaPath = path.join(dataDir, "settled.mov");
    writeFileSync(mediaPath, "complete");
    makeStable(mediaPath);
    mocks.probeByPath.set(mediaPath, {
      path: mediaPath,
      filename: "settled.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "settled-hash",
      hasVideo: true,
    });

    await pipeline.scanFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });

    expect(db.getFileByPath(mediaPath)).not.toBeNull();
    expect(db.listJobs()).toContainEqual(expect.objectContaining({ stage: "probe" }));
    await pipeline.stop();
  });

  it("stores detected scene ranges as source drop-frame timecode", async () => {
    const { db, pipeline } = setup();
    mocks.detectedScenes = [
      { startS: 1 / 29.97, endS: 2 / 29.97 },
    ];
    const file = db.upsertFile({
      path: "/media/df-scene.mov",
      filename: "df-scene.mov",
      durationS: 5,
      fps: 29.97,
      dropFrame: true,
      startTc: "00:00:59;29",
      codec: "prores",
      audioChannels: 0,
      fileHash: "df-scene",
      hasVideo: true,
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);
    db.enqueueJob(file.id, "scenes");

    pipeline.start();

    await vi.waitFor(() => expect(db.listScenes(file.id)).toHaveLength(1), { timeout: 5000 });
    expect(db.listScenes(file.id)[0]).toMatchObject({
      startTc: "00:01:00;02",
      endTc: "00:01:00;03",
    });
    await waitForDrain(db);
    await pipeline.stop();
  });
});
