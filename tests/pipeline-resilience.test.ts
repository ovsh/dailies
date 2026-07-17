import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whisperReady: false,
  probeInput: null as null | Record<string, unknown>,
  detectedScenes: [{ startS: 0, endS: 5 }],
  makeProxy: vi.fn(),
  transcribe: vi.fn(),
  annotate: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("../src/main/pipeline/binaries", () => ({
  findFfprobeBinary: () => "ffprobe",
  findWhisperBinary: () => (mocks.whisperReady ? "/fake/whisper" : null),
  findWhisperModel: () => (mocks.whisperReady ? "/fake/model.bin" : null),
}));
vi.mock("../src/main/pipeline/probe", () => ({
  probeFile: vi.fn(async () => mocks.probeInput),
}));
vi.mock("../src/main/pipeline/proxy", () => ({
  extractAudio: vi.fn(async () => {}),
  extractKeyframe: vi.fn(async () => {}),
  makeProxy: mocks.makeProxy,
}));
vi.mock("../src/main/pipeline/scenes", () => ({
  detectScenes: vi.fn(async () => mocks.detectedScenes),
}));
vi.mock("../src/main/pipeline/transcribe", () => ({
  transcribeAudio: mocks.transcribe,
}));
vi.mock("../src/main/pipeline/watcher", () => ({
  createWatcher: () => ({ watchFolder() {}, unwatchFolder() {}, async close() {} }),
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
    gemini: () => ({ annotateScene: mocks.annotate, lookAtScene: async () => "frame" }),
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

beforeEach(() => {
  mocks.whisperReady = false;
  mocks.probeInput = null;
  mocks.detectedScenes = [{ startS: 0, endS: 5 }];
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
  mocks.annotate.mockReset().mockResolvedValue({
    description: "a frame",
    objects: [],
    model: "test",
  });
  mocks.embed.mockReset().mockImplementation(async (texts: string[]) =>
    texts.map(() => new Float32Array(768).fill(1)));
});

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()!.close();
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
    });
    db.setFileStatus(file.id, "processing");
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
    });
    db.setFileStatus(file.id, "processing");
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
    });
    db.setFileStatus(file.id, "processing");
    db.enqueueJob(file.id, "transcribe");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("error"));
    expect(db.listJobs().find((job) => job.stage === "transcribe")?.status).toBe("error");
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
    });
    db.setFileStatus(file.id, "processing");
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
    });
    db.setFileStatus(file.id, "processing");
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
    });
    db.setFileStatus(hung.id, "processing");
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

  it("makes silent video ready with an explicit empty transcript and retries a transient API failure", async () => {
    const { db, pipeline } = setup();
    mocks.annotate
      .mockRejectedValueOnce(new Error("HTTP 429 rate limit"))
      .mockResolvedValue({ description: "recovered frame", objects: [], model: "test" });
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
    });
    db.enqueueJob(file.id, "probe");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("ready"), { timeout: 5000 });
    expect(db.getFile(file.id)?.hasTranscript).toBe(true);
    expect(db.listSegments(file.id)).toEqual([]);
    expect(db.listJobs().some((job) => job.stage === "transcribe")).toBe(false);
    expect(db.listJobs().find((job) => job.stage === "visual_index")?.attempts).toBe(1);
    await waitForDrain(db);
    await pipeline.stop();
  });

  it("repairs missing derived stages when an unchanged file is rescanned", async () => {
    const { dataDir, db, pipeline } = setup();
    const mediaPath = path.join(dataDir, "unchanged.mov");
    writeFileSync(mediaPath, "fixture");
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
