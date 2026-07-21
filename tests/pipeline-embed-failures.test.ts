import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasEmbedder: true,
  makeProxy: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("../src/main/pipeline/binaries", () => ({
  findFfprobeBinary: () => "ffprobe",
  findWhisperBinary: () => null,
  findWhisperModel: () => null,
}));
vi.mock("../src/main/pipeline/proxy", () => ({
  extractAudio: vi.fn(async () => {}),
  extractKeyframe: vi.fn(async () => {}),
  makeProxy: mocks.makeProxy,
}));
vi.mock("../src/main/pipeline/scenes", () => ({
  detectScenes: vi.fn(async () => []),
}));
vi.mock("../src/main/pipeline/transcribe", () => ({
  transcribeAudio: vi.fn(async () => []),
}));
vi.mock("../src/main/pipeline/watcher", () => ({
  createWatcher: () => ({
    watchFolder() {},
    unwatchFolder() {},
    async close() {},
  }),
}));

import { OpenRouterApiError } from "../src/main/agents/openrouter-client";
import { openDatabase } from "../src/main/db/database";
import type { DailiesDB } from "../src/main/db/types";
import { createPipeline } from "../src/main/pipeline";

const openDbs: DailiesDB[] = [];

interface SeedFileOptions {
  filename: string;
  video?: boolean;
}

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-embed-failure-"));
  const db = openDatabase(path.join(dataDir, "test.db"));
  openDbs.push(db);
  const pipeline = createPipeline({
    db,
    dataDir,
    whisperModel: "tiny",
    embedder: () => (mocks.hasEmbedder ? { embed: mocks.embed } : null),
    onUpdate: () => {},
  });
  return { dataDir, db, pipeline };
}

function seedTranscribedFile(db: DailiesDB, opts: SeedFileOptions): number {
  const file = db.upsertFile({
    path: `/media/${opts.filename}`,
    filename: opts.filename,
    durationS: 5,
    fps: opts.video ? 24 : 0,
    dropFrame: false,
    startTc: opts.video ? "01:00:00:00" : "00:00:00:00",
    codec: opts.video ? "prores" : "pcm",
    audioChannels: 1,
    fileHash: `hash-${opts.filename}`,
    hasVideo: opts.video ?? false,
  });
  db.replaceTranscript(file.id, [{
    startS: 0,
    endS: 1,
    text: "transcribed and ready to embed",
    avgConf: 1,
    words: [],
  }]);
  db.markTranscribed(file.id);
  return file.id;
}

function setLegacyFileStatus(dataDir: string, fileId: number, status: string): void {
  const raw = new Database(path.join(dataDir, "test.db"));
  raw.prepare("UPDATE files SET status = ? WHERE id = ?").run(status, fileId);
  raw.close();
}

async function waitForJobStatus(
  db: DailiesDB,
  fileId: number,
  status: "waiting" | "error",
): Promise<void> {
  await vi.waitFor(() => {
    expect(db.listJobs().find((job) => job.fileId === fileId && job.stage === "embed")?.status)
      .toBe(status);
  }, { timeout: 5000 });
}

async function waitForDrain(db: DailiesDB): Promise<void> {
  await vi.waitFor(() => {
    expect(db.listJobs().some((job) => job.status === "queued" || job.status === "running"))
      .toBe(false);
  }, { timeout: 5000 });
}

beforeEach(() => {
  mocks.hasEmbedder = true;
  mocks.makeProxy.mockReset().mockResolvedValue("/cache/proxy.mp4");
  mocks.embed.mockReset().mockImplementation(async (texts: string[]) =>
    texts.map(() => new Float32Array(768).fill(1)));
});

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()!.close();
  vi.restoreAllMocks();
});

describe("optional embed job failures", () => {
  it("fails a permanent API error without retrying or poisoning a ready file", async () => {
    const { db, pipeline } = setup();
    const fileId = seedTranscribedFile(db, {
      filename: "bad-request.wav",
    });
    mocks.embed.mockRejectedValue(new OpenRouterApiError("bad request", 400));
    db.enqueueJob(fileId, "embed");

    pipeline.start();

    await waitForJobStatus(db, fileId, "error");
    expect(db.listJobs().find((job) => job.fileId === fileId && job.stage === "embed"))
      .toMatchObject({ attempts: 1, error: "bad request" });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(db.getFile(fileId)?.status).toBe("ready");
    await pipeline.stop();
  });

  it("retries a rate limit to the cap without poisoning a ready file", async () => {
    const { db, pipeline } = setup();
    const fileId = seedTranscribedFile(db, {
      filename: "rate-limited.wav",
    });
    mocks.embed.mockRejectedValue(new OpenRouterApiError("provider busy", 429));
    db.enqueueJob(fileId, "embed");

    pipeline.start();

    await waitForJobStatus(db, fileId, "error");
    expect(db.listJobs().find((job) => job.fileId === fileId && job.stage === "embed"))
      .toMatchObject({ attempts: 4, error: "provider busy" });
    expect(mocks.embed).toHaveBeenCalledTimes(4);
    expect(db.getFile(fileId)?.status).toBe("ready");
    await pipeline.stop();
  });

  it("waits for a missing API key without changing a ready file", async () => {
    mocks.hasEmbedder = false;
    const { db, pipeline } = setup();
    const fileId = seedTranscribedFile(db, {
      filename: "missing-key.wav",
    });
    db.enqueueJob(fileId, "embed");

    pipeline.start();

    await waitForJobStatus(db, fileId, "waiting");
    expect(db.listJobs().find((job) => job.fileId === fileId && job.stage === "embed")?.error)
      .toBe("OpenRouter API key not set — Settings → AI");
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(db.getFile(fileId)?.status).toBe("ready");
    await pipeline.stop();
  });

  it("repairs a legacy file poisoned by a terminal embed failure", async () => {
    const { dataDir, db, pipeline } = setup();
    const fileId = seedTranscribedFile(db, {
      filename: "legacy-poisoned.wav",
    });
    setLegacyFileStatus(dataDir, fileId, "error");
    db.enqueueJob(fileId, "embed");
    const legacyJob = db.claimNextJob();
    expect(legacyJob?.stage).toBe("embed");
    db.failJob(legacyJob!.id, "legacy OpenRouter failure");

    mocks.hasEmbedder = false;
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(fileId)?.status).toBe("ready"));
    await waitForJobStatus(db, fileId, "waiting");
    expect(db.listJobs().find((job) => job.id === legacyJob!.id)?.status).toBe("error");
    expect(db.listJobs()).toContainEqual(expect.objectContaining({
      fileId,
      stage: "embed",
      status: "waiting",
    }));
    await pipeline.stop();
  });

  it("reopens existing embed failures when Gemini becomes available", async () => {
    const { db, pipeline } = setup();
    const firstFileId = seedTranscribedFile(db, {
      filename: "first-embed-retry.wav",
    });
    const secondFileId = seedTranscribedFile(db, {
      filename: "second-embed-retry.wav",
    });

    db.enqueueJob(firstFileId, "embed");
    const firstEmbedJob = db.claimNextJob()!;
    db.retryJob(firstEmbedJob.id, "transient embed failure");
    expect(db.claimNextJob()?.id).toBe(firstEmbedJob.id);
    db.failJob(firstEmbedJob.id, "terminal first embed failure");

    db.enqueueJob(secondFileId, "embed");
    const secondEmbedJob = db.claimNextJob()!;
    db.failJob(secondEmbedJob.id, "terminal second embed failure");

    db.enqueueJob(firstFileId, "transcribe");
    const transcribeJob = db.claimNextJob()!;
    db.failJob(transcribeJob.id, "non-embed failure");
    const jobIdsBeforeRefresh = db.listJobs().map((job) => job.id).sort((a, b) => a - b);

    await pipeline.refreshPrerequisites("gemini");

    const jobs = db.listJobs();
    expect(jobs.map((job) => job.id).sort((a, b) => a - b)).toEqual(jobIdsBeforeRefresh);
    expect(jobs.find((job) => job.id === firstEmbedJob.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
    });
    expect(jobs.find((job) => job.id === secondEmbedJob.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
    });
    expect(jobs.find((job) => job.id === transcribeJob.id)).toMatchObject({
      status: "error",
      attempts: 1,
      error: "non-embed failure",
    });
    expect(jobs.filter((job) => job.stage === "embed")).toHaveLength(2);
    await pipeline.stop();
  });

  it("leaves video processing while its proxy is still pending", async () => {
    let finishProxy: ((path: string) => void) | null = null;
    mocks.makeProxy.mockImplementation(() => new Promise<string>((resolve) => {
      finishProxy = resolve;
    }));
    const { db, pipeline } = setup();
    const fileId = seedTranscribedFile(db, {
      filename: "pending-proxy.mov",
      video: true,
    });
    db.replaceScenes(fileId, [{
      startS: 0,
      endS: 5,
      startTc: "01:00:00:00",
      endTc: "01:00:05:00",
      keyframePath: "/cache/keyframe.jpg",
    }]);
    mocks.embed.mockRejectedValue(new OpenRouterApiError("bad request", 400));
    db.enqueueJob(fileId, "proxy");
    db.enqueueJob(fileId, "embed");

    pipeline.start();

    await waitForJobStatus(db, fileId, "error");
    expect(db.getFile(fileId)?.status).toBe("processing");

    expect(finishProxy).not.toBeNull();
    finishProxy!("/cache/proxy.mp4");
    await waitForDrain(db);
    expect(db.getFile(fileId)?.status).toBe("ready");
    await pipeline.stop();
  });
});
