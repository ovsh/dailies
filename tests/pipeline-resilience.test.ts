import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  makeProxyForTest: async (
    _path: string,
    _outDir: string,
    _timeoutMs?: number,
    _expectedDurationS?: number,
  ): Promise<string> => {
    throw new Error("Proxy test helper was not initialized");
  },
  whisperReady: false,
  probeFile: vi.fn(),
  identifyFile: vi.fn(),
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
  watcherOnFileRemoved: null as ((path: string) => void) | null,
  detectedScenes: [{ startS: 0, endS: 5 }],
  detectScenes: vi.fn(),
  makeProxy: vi.fn(),
  transcribe: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("../src/main/pipeline/binaries", () => ({
  findFfmpegBinary: () => "ffmpeg",
  findFfprobeBinary: () => "ffprobe",
  findWhisperBinary: () => (mocks.whisperReady ? "/fake/whisper" : null),
  findWhisperModel: () => (mocks.whisperReady ? "/fake/model.bin" : null),
}));
vi.mock("../src/main/pipeline/probe", () => ({
  probeFile: mocks.probeFile,
  computeFileIdentity: mocks.identifyFile,
}));
vi.mock("../src/main/pipeline/opatom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/pipeline/opatom")>();
  return {
    ...actual,
    analyzeMxf: vi.fn(async (_ffprobePath: string, filePath: string) =>
      mocks.mxfAtoms.get(filePath) ?? null),
  };
});
vi.mock("../src/main/pipeline/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/pipeline/exec")>()),
  run: mocks.run,
}));
vi.mock("../src/main/pipeline/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/pipeline/proxy")>();
  mocks.makeProxyForTest = actual.makeProxy;
  return {
    ...actual,
    extractAudio: vi.fn(async () => {}),
    extractKeyframe: vi.fn(async () => {}),
    makeProxy: mocks.makeProxy,
  };
});
vi.mock("../src/main/pipeline/scenes", () => ({
  detectScenes: mocks.detectScenes,
}));
vi.mock("../src/main/pipeline/transcribe", () => ({
  transcribeAudio: mocks.transcribe,
}));
vi.mock("../src/main/pipeline/watcher", () => ({
  createWatcher: (opts: {
    onFileFound(path: string): void;
    onFileRemoved(path: string): void;
  }) => {
    mocks.watcherOnFileFound = opts.onFileFound;
    mocks.watcherOnFileRemoved = opts.onFileRemoved;
    return { watchFolder() {}, unwatchFolder() {}, async close() {} };
  },
}));

import { openDatabase } from "../src/main/db/database";
import { FULL_CONTENT_HASH_LIMIT_BYTES } from "../src/main/file-hash";
import { createPipeline, PipelineBudget } from "../src/main/pipeline";
import type { DailiesDB } from "../src/main/db/types";
import type { SegmentInput } from "../src/shared/types";
import { isAudioOnly } from "../src/renderer/lib/media";

const openDbs: DailiesDB[] = [];
const tempDirs: string[] = [];

function createTestPipeline(db: DailiesDB, dataDir: string, budget?: PipelineBudget) {
  return createPipeline({
    db,
    dataDir,
    whisperModel: "tiny",
    embedder: () => ({ embed: mocks.embed }),
    onUpdate: () => {},
    budget,
  });
}

function setup(budget?: PipelineBudget) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-pipeline-"));
  const db = openDatabase(path.join(dataDir, "test.db"));
  openDbs.push(db);
  const pipeline = createTestPipeline(db, dataDir, budget);
  return { dataDir, db, pipeline };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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
  mocks.run.mockReset();
  mocks.whisperReady = false;
  mocks.probeFile.mockReset().mockImplementation(async (filePath: string) =>
    mocks.probeByPath.get(filePath) ?? mocks.probeInput);
  mocks.identifyFile.mockReset().mockImplementation(async (filePath: string) => {
    const input = mocks.probeByPath.get(filePath) ?? mocks.probeInput;
    if (!input || typeof input.fileHash !== "string") {
      throw new Error(`No file identity for ${filePath}`);
    }
    return {
      path: filePath,
      filename: path.basename(filePath),
      fileHash: input.fileHash,
      size: typeof input.size === "number" ? input.size : 1,
    };
  });
  mocks.probeInput = null;
  mocks.probeByPath.clear();
  mocks.mxfAtoms.clear();
  mocks.watcherOnFileFound = null;
  mocks.watcherOnFileRemoved = null;
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
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pipeline prerequisite and applicability handling", () => {
  it("encodes proxies as yuv420p", async () => {
    mocks.run.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    await mocks.makeProxyForTest("/media/avid-422.mov", "/cache");

    expect(mocks.run).toHaveBeenCalledWith("ffmpeg", [
      "-y",
      "-i",
      "/media/avid-422.mov",
      "-vf",
      "scale=960:-2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "26",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      path.join("/cache", "proxy.mp4"),
    ], { timeoutMs: undefined });
  });

  it("includes the terminating signal in a proxy failure", async () => {
    mocks.run.mockResolvedValue({
      stdout: "",
      stderr: "process stopped",
      code: null,
      signal: "SIGKILL",
      timedOut: false,
    });

    await expect(mocks.makeProxyForTest("/media/interrupted.mov", "/cache"))
      .rejects.toThrow("signal SIGKILL");
  });

  it("re-attempts an exit 69 first run instead of storing its mostly-noise output", async () => {
    // ffmpeg exit 69 (FFMPEG_ERROR_RATE_EXCEEDED) means most decoded frames
    // errored — the muxed output is mostly garbage. Accepting it once shipped
    // green-static previews; now it goes through the tolerant retry.
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-proxy-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "proxy.mp4"), "a complete proxy");
    mocks.run
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "[hevc @ 0x1] Could not find ref with POC 3\nConversion failed!\n",
        code: 69,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false });

    await expect(mocks.makeProxyForTest("/media/GH011482.MP4", dir))
      .resolves.toBe(path.join(dir, "proxy.mp4"));
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("fails when both attempts exceed the decode error rate", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-proxy-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "proxy.mp4"), "mostly noise");
    mocks.run.mockResolvedValue({
      stdout: "",
      stderr: "Conversion failed!\n",
      code: 69,
      signal: null,
      timedOut: false,
    });

    await expect(mocks.makeProxyForTest("/media/GH011482.MP4", dir))
      .rejects.toThrow("exit 69 (decode error rate exceeded)");
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("rejects a tolerant retry whose output covers too little of the source", async () => {
    // +discardcorrupt shortens the output without raising the frame error
    // rate, so duration is the only honest signal left.
    mocks.run.mockImplementation(async (bin: string, args: string[]) => {
      if (args.includes("-show_entries")) {
        return { stdout: "12.5\n", stderr: "", code: 0, signal: null, timedOut: false };
      }
      if (args.includes("+discardcorrupt")) {
        return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
      }
      return {
        stdout: "",
        stderr: "[mxf @ 0x1] Error while decoding\nConversion failed!\n",
        code: 1,
        signal: null,
        timedOut: false,
      };
    });

    await expect(
      mocks.makeProxyForTest("/media/DAMAGED.mxf", "/cache", undefined, 100),
    ).rejects.toThrow("dropped too much of the source: proxy is 12.5s of 100.0s");
  });

  it("keeps a tolerant retry that still covers the source duration", async () => {
    mocks.run.mockImplementation(async (bin: string, args: string[]) => {
      if (args.includes("-show_entries")) {
        return { stdout: "97.2\n", stderr: "", code: 0, signal: null, timedOut: false };
      }
      if (args.includes("+discardcorrupt")) {
        return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
      }
      return {
        stdout: "",
        stderr: "[mxf @ 0x1] Error while decoding\nConversion failed!\n",
        code: 1,
        signal: null,
        timedOut: false,
      };
    });

    await expect(
      mocks.makeProxyForTest("/media/SCRATCHED.mxf", "/cache", undefined, 100),
    ).resolves.toBe(path.join("/cache", "proxy.mp4"));
  });

  it("re-attempts a failed proxy once with tolerant decode flags", async () => {
    mocks.run
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "[hevc @ 0x1] Error while decoding\nConversion failed!\n",
        code: 1,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false });

    await expect(mocks.makeProxyForTest("/media/GH011482.MP4", "/cache"))
      .resolves.toBe(path.join("/cache", "proxy.mp4"));

    const retryArgs = mocks.run.mock.calls[1]?.[1] as string[];
    expect(retryArgs).toEqual([
      "-y",
      "-fflags",
      "+discardcorrupt",
      "-max_error_rate",
      "0.05",
      "-i",
      "/media/GH011482.MP4",
      "-vf",
      "scale=960:-2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "26",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      path.join("/cache", "proxy.mp4"),
    ]);
  });

  it("drops audio on the re-attempt when the audio encoder is what broke", async () => {
    mocks.run
      .mockResolvedValueOnce({
        stdout: "",
        stderr:
          "[aost#0:1/aac @ 0x1] Error initializing output stream: Error while opening encoder\n",
        code: 1,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false });

    await expect(mocks.makeProxyForTest("/media/12ch.mov", "/cache"))
      .resolves.toBe(path.join("/cache", "proxy.mp4"));

    const retryArgs = mocks.run.mock.calls[1]?.[1] as string[];
    expect(retryArgs).toContain("-an");
    expect(retryArgs).not.toContain("aac");
    expect(retryArgs).toContain("+faststart");
  });

  it("does not re-attempt a proxy that already ran out its timeout", async () => {
    mocks.run.mockResolvedValue({
      stdout: "",
      stderr: "frame= 900 fps=30\r",
      code: null,
      signal: "SIGKILL",
      timedOut: true,
    });

    await expect(mocks.makeProxyForTest("/media/huge.mov", "/cache", 1000))
      .rejects.toThrow("timed out after 1000ms");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("reports both attempts when the tolerant re-attempt fails too", async () => {
    mocks.run
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "moov atom not found\n",
        code: 1,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Invalid data found when processing input\n",
        code: 183,
        signal: null,
        timedOut: false,
      });

    await expect(mocks.makeProxyForTest("/media/truncated.mov", "/cache")).rejects.toThrow(
      /ffmpeg failed \(exit 1\): moov atom not found[\s\S]*tolerant retry also failed \(exit 183\): Invalid data found/,
    );
  });

  it("headlines a proxy failure with whole stderr lines, not a mid-line slice", async () => {
    // ffmpeg separates progress with \r, so slicing a fixed number of trailing
    // characters used to leave the first line of the message as a fragment.
    const noise = `frame= 1 fps=0\r`.repeat(400);
    mocks.run.mockResolvedValue({
      stdout: "",
      stderr: `${noise}[libx264 @ 0x1] chroma_qp_offset=0 threads=8\nConversion failed!\n`,
      code: 1,
      signal: null,
      timedOut: false,
    });

    const message = await mocks.makeProxyForTest("/media/GH011482.MP4", "/cache").then(
      () => "resolved",
      (err: Error) => err.message,
    );
    const headline = message.split("\n")[0] ?? "";
    expect(headline).toContain("Conversion failed!");
    expect(headline.startsWith("ffmpeg failed (exit 1): ")).toBe(true);
  });

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

  it("surfaces a terminal probe failure on a hash-only-discovered file as a file error", async () => {
    const { db, pipeline } = setup();
    mocks.probeFile.mockRejectedValue(new Error("ffprobe failed for /media/corrupt.mxf (exit 1)"));
    // Discovery only hashes: duration/fps/codec are unknown until probe runs.
    const file = db.upsertFile({
      path: "/media/corrupt.mxf",
      filename: "corrupt.mxf",
      durationS: 0,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "",
      audioChannels: 0,
      fileHash: "real-hash-from-discovery",
    });
    db.enqueueJob(file.id, "probe");
    pipeline.start();

    await vi.waitFor(() => expect(db.getFile(file.id)?.status).toBe("error"));
    expect(db.listJobsForFile(file.id).find((job) => job.stage === "probe")?.status).toBe("error");
    await pipeline.stop();

    // A restart must not re-attempt the deterministically failing probe —
    // reopening a terminal error is Retry's job, not the startup sweep's.
    const jobCountBefore = db.listJobsForFile(file.id).length;
    pipeline.start();
    await pipeline.refreshPrerequisites("all");
    expect(db.listJobsForFile(file.id).length).toBe(jobCountBefore);
    expect(db.getFile(file.id)?.status).toBe("error");
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

  it("clears a discovery failure and recreates probe work on retry", async () => {
    const { db, pipeline } = setup();
    mocks.probeFile.mockRejectedValueOnce(new Error("ffprobe still cannot read media"));
    const file = db.upsertFile({
      path: "/media/discovery-failure.mov",
      filename: "discovery-failure.mov",
      durationS: 0,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "",
      audioChannels: 0,
      fileHash: "unreadable:/media/discovery-failure.mov",
    });
    db.setDiscoveryFailure(file.id, "Permission denied");
    expect(db.listJobsForFile(file.id)).toEqual([]);

    await pipeline.retryFile(file.id);

    expect(db.getFile(file.id)).toMatchObject({
      discoveryFailed: false,
      status: "pending",
    });
    expect(db.listPipelineFileFacts().find((facts) => facts.file.id === file.id)?.discoveryError)
      .toBeNull();
    expect(db.listJobsForFile(file.id)).toEqual([
      expect.objectContaining({ stage: "probe", status: "queued" }),
    ]);

    pipeline.start();
    await vi.waitFor(() => {
      expect(db.listJobsForFile(file.id).find((job) => job.stage === "probe"))
        .toMatchObject({ status: "error", error: "ffprobe still cannot read media" });
    });
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

  it.each(["spawn EBADF", "spawn EMFILE"])(
    "retries a proxy after %s with backoff",
    async (error) => {
      const { db, pipeline } = setup();
      mocks.makeProxy
        .mockRejectedValueOnce(new Error(error))
        .mockImplementation(async (_path: string, outDir: string) => path.join(outDir, "proxy.mp4"));
      const file = db.upsertFile({
        path: "/media/fd-exhausted.mov",
        filename: "fd-exhausted.mov",
        durationS: 5,
        fps: 24,
        dropFrame: false,
        startTc: "01:00:00:00",
        codec: "prores",
        audioChannels: 2,
        fileHash: error,
        hasVideo: true,
      });
      db.replaceTranscript(file.id, []);
      db.markTranscribed(file.id);
      db.enqueueJob(file.id, "proxy");
      pipeline.start();

      await vi.waitFor(() => {
        expect(db.listJobsForFile(file.id).find((job) => job.stage === "proxy"))
          .toMatchObject({ status: "done", attempts: 1 });
      }, { timeout: 5000 });
      expect(mocks.makeProxy).toHaveBeenCalledTimes(2);
      expect(db.getFile(file.id)?.videoUnplayable).toBe(false);
      await pipeline.stop();
    },
  );

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

  it("treats a completed zero-scene detection as steady state", async () => {
    const { db, pipeline } = setup();
    mocks.detectedScenes = [];
    const file = db.upsertFile({
      path: "/media/short.mov",
      filename: "short.mov",
      durationS: 0.2,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "short-zero-scenes",
      hasVideo: true,
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);
    db.setFileProxy(file.id, "/cache/short-proxy.mp4");
    db.enqueueJob(file.id, "scenes");

    pipeline.start();
    await waitForDrain(db);
    await pipeline.refreshPrerequisites("all");
    await waitForDrain(db);
    await pipeline.refreshPrerequisites("all");
    await waitForDrain(db);

    expect(db.listScenes(file.id)).toEqual([]);
    expect(db.listJobsForFile(file.id).filter((job) => job.stage === "scenes")).toHaveLength(1);
    expect(mocks.detectScenes).toHaveBeenCalledTimes(1);
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

  it("keeps a throttled transcription queued while one transcription runs", async () => {
    // Pinned limits: the real caps scale with the machine's core count.
    const { db, pipeline } = setup(new PipelineBudget({
      concurrency: 2,
      transcribeConcurrency: 1,
    }));
    mocks.whisperReady = true;

    const transcription = deferred<SegmentInput[]>();
    mocks.transcribe.mockImplementationOnce(() => transcription.promise);

    const files = ["first", "second"].map((name) => {
      const file = db.upsertFile({
        path: `/media/${name}.wav`,
        filename: `${name}.wav`,
        durationS: 5,
        fps: 0,
        dropFrame: false,
        startTc: "00:00:00:00",
        codec: "pcm",
        audioChannels: 1,
        fileHash: name,
        hasVideo: false,
      });
      db.enqueueJob(file.id, "transcribe");
      return file;
    });

    pipeline.start();
    await vi.waitFor(() => {
      expect(mocks.transcribe).toHaveBeenCalledTimes(1);
      expect(db.listJobs().filter((job) => job.status === "running")).toHaveLength(1);
      expect(db.listJobs().filter((job) => job.status === "queued")).toHaveLength(1);
    });

    let stopped = false;
    const stopping = pipeline.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stoppedBeforeRunningWork = stopped;
    const throttledStatus = db.listJobsForFile(files[1]!.id)[0]?.status;

    transcription.resolve([{
      startS: 0,
      endS: 1,
      text: "finished during shutdown",
      avgConf: 1,
      words: [],
    }]);
    await stopping;
    await vi.waitFor(() => {
      expect(db.listJobsForFile(files[0]!.id).find((job) => job.stage === "transcribe")?.status)
        .toBe("done");
    });

    expect(stoppedBeforeRunningWork).toBe(false);
    expect(throttledStatus).toBe("queued");
    expect(db.listJobsForFile(files[1]!.id)[0]?.status).toBe("queued");
  });

  it("shares a two-stage, one-transcription budget across pipelines", async () => {
    const budget = new PipelineBudget({ concurrency: 2, transcribeConcurrency: 1 });
    const first = setup(budget);
    const second = setup(budget);
    mocks.whisperReady = true;

    let activeStages = 0;
    let activeTranscriptions = 0;
    let maxActiveStages = 0;
    let maxActiveTranscriptions = 0;
    const stageReleases: Array<ReturnType<typeof deferred<void>>> = [];

    async function holdStage(transcription: boolean): Promise<void> {
      const release = deferred<void>();
      stageReleases.push(release);
      activeStages += 1;
      if (transcription) activeTranscriptions += 1;
      maxActiveStages = Math.max(maxActiveStages, activeStages);
      maxActiveTranscriptions = Math.max(maxActiveTranscriptions, activeTranscriptions);
      await release.promise;
      activeStages -= 1;
      if (transcription) activeTranscriptions -= 1;
    }

    mocks.transcribe.mockImplementation(async () => {
      await holdStage(true);
      return [];
    });
    mocks.makeProxy.mockImplementation(async (_mediaPath: string, outDir: string) => {
      await holdStage(false);
      return path.join(outDir, "proxy.mp4");
    });

    for (const [index, context] of [first, second].entries()) {
      const audio = context.db.upsertFile({
        path: `/media/shared-${index}.wav`,
        filename: `shared-${index}.wav`,
        durationS: 5,
        fps: 0,
        dropFrame: false,
        startTc: "00:00:00:00",
        codec: "pcm",
        audioChannels: 1,
        fileHash: `shared-audio-${index}`,
        hasVideo: false,
      });
      const video = context.db.upsertFile({
        path: `/media/shared-${index}.mov`,
        filename: `shared-${index}.mov`,
        durationS: 5,
        fps: 24,
        dropFrame: false,
        startTc: "01:00:00:00",
        codec: "prores",
        audioChannels: 0,
        fileHash: `shared-video-${index}`,
        hasVideo: true,
      });
      context.db.enqueueJob(audio.id, "transcribe");
      context.db.enqueueJob(video.id, "proxy");
    }

    first.pipeline.start();
    second.pipeline.start();

    await vi.waitFor(() => expect(stageReleases).toHaveLength(2));
    expect(budget.totals).toEqual({
      inFlightCount: 2,
      transcribeInFlight: 1,
      concurrency: 2,
      baseConcurrency: 2,
    });
    expect(maxActiveStages).toBe(2);
    expect(maxActiveTranscriptions).toBe(1);

    for (const release of stageReleases) release.resolve();
    await vi.waitFor(() => expect(stageReleases.length).toBeGreaterThanOrEqual(4), {
      timeout: 5000,
    });
    for (const release of stageReleases) release.resolve();
    await waitForDrain(first.db);
    await waitForDrain(second.db);

    expect(maxActiveStages).toBe(2);
    expect(maxActiveTranscriptions).toBe(1);
    expect(budget.totals).toEqual({
      inFlightCount: 0,
      transcribeInFlight: 0,
      concurrency: 2,
      baseConcurrency: 2,
    });
    await first.pipeline.stop();
    await second.pipeline.stop();
  });

  it("rejects a drain after 15 seconds without aborting and permits a later drain", async () => {
    vi.useFakeTimers();
    const { db, pipeline } = setup();
    mocks.whisperReady = true;
    const transcription = deferred<SegmentInput[]>();
    mocks.transcribe.mockImplementationOnce(() => transcription.promise);
    const file = db.upsertFile({
      path: "/media/never-finishes.wav",
      filename: "never-finishes.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "never-finishes",
      hasVideo: false,
    });
    db.enqueueJob(file.id, "transcribe");

    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = pipeline.stop().finally(() => {
      stopped = true;
    });
    const timedOut = expect(stopping).rejects.toThrow("Pipeline drain timed out after 15000ms");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(stopped).toBe(false);
    expect(db.listJobsForFile(file.id).find((job) => job.stage === "transcribe")?.status)
      .toBe("running");

    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(stopped).toBe(true);
    expect(db.listJobsForFile(file.id).find((job) => job.stage === "transcribe")?.status)
      .toBe("running");

    transcription.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    await pipeline.stop();
    expect(db.listJobsForFile(file.id).find((job) => job.stage === "transcribe")?.status)
      .toBe("done");
  });

  it("aborts immediately and a fresh pipeline resets durable running work", async () => {
    const { dataDir, db, pipeline } = setup();
    mocks.whisperReady = true;
    const abandoned = deferred<SegmentInput[]>();
    const restarted = deferred<SegmentInput[]>();
    mocks.transcribe
      .mockImplementationOnce(() => abandoned.promise)
      .mockImplementationOnce(() => restarted.promise);
    const file = db.upsertFile({
      path: "/media/abandoned.wav",
      filename: "abandoned.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "abandoned",
      hasVideo: false,
    });
    db.enqueueJob(file.id, "transcribe");

    pipeline.start();
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(1));

    const stopping = pipeline.stop("abort");
    expect(db.listJobsForFile(file.id).find((job) => job.stage === "transcribe")?.status)
      .toBe("running");
    await stopping;

    abandoned.resolve([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const freshPipeline = createTestPipeline(db, dataDir);
    freshPipeline.start();
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(2));
    expect(db.listJobsForFile(file.id).find((job) => job.stage === "transcribe")?.status)
      .toBe("running");

    restarted.resolve([]);
    await vi.waitFor(() => {
      expect(db.listJobsForFile(file.id).find((job) => job.stage === "transcribe")?.status)
        .toBe("done");
    });
    await freshPipeline.stop();
  });

  it("bounds close when a folder scan never resolves", async () => {
    vi.useFakeTimers();
    const { dataDir, pipeline } = setup();
    const mediaPath = path.join(dataDir, "hung-scan.mov");
    writeFileSync(mediaPath, "fixture");
    makeStable(mediaPath);
    mocks.identifyFile.mockImplementationOnce(() => new Promise(() => {}));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    void pipeline.scanFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });
    await vi.waitFor(() => expect(mocks.identifyFile).toHaveBeenCalledWith(mediaPath));

    let stopped = false;
    const closing = pipeline.stop("abort").then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(stopped).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      "[pipeline] discovery close timed out waiting for folder scans",
    );
  });

  it("recreates discovery and finds files after a cache clear restart", async () => {
    const { dataDir, db, pipeline } = setup();
    const folder = db.addFolder(dataDir, "raw", null);
    pipeline.watchFolder(folder);
    const firstWatcherCallback = mocks.watcherOnFileFound;
    const originalPath = path.join(dataDir, "cache-clear.mov");
    writeFileSync(originalPath, "original");
    makeStable(originalPath);
    const file = db.upsertFile({
      path: originalPath,
      filename: "cache-clear.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "cache-clear",
      hasVideo: true,
    });
    db.replaceTranscript(file.id, []);
    db.markTranscribed(file.id);
    const mediaDir = path.join(dataDir, "media", String(file.id));
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(path.join(mediaDir, "proxy.mp4"), "cached proxy");

    await pipeline.stop("abort");
    rmSync(mediaDir, { recursive: true, force: true });
    db.clearDerivedState(file.id);
    db.enqueueJob(file.id, "probe");

    const discoveredPath = path.join(dataDir, "post-clear.mov");
    writeFileSync(discoveredPath, "discovered");
    makeStable(discoveredPath);
    mocks.probeByPath.set(originalPath, {
      ...file,
      path: originalPath,
      fileHash: "cache-clear",
    });
    mocks.probeByPath.set(discoveredPath, {
      ...file,
      id: undefined,
      path: discoveredPath,
      filename: "post-clear.mov",
      fileHash: "post-clear",
    });

    pipeline.watchFolder(folder);
    const rescan = pipeline.scanFolder(folder);
    pipeline.start();
    await rescan;

    expect(existsSync(path.join(mediaDir, "proxy.mp4"))).toBe(false);
    expect(mocks.watcherOnFileFound).not.toBe(firstWatcherCallback);
    expect(db.getFileByPath(discoveredPath)).not.toBeNull();

    const watchedPath = path.join(dataDir, "watched-after-clear.mov");
    writeFileSync(watchedPath, "watched");
    makeStable(watchedPath);
    mocks.probeByPath.set(watchedPath, {
      ...file,
      id: undefined,
      path: watchedPath,
      filename: "watched-after-clear.mov",
      fileHash: "watched-after-clear",
    });
    mocks.watcherOnFileFound?.(watchedPath);
    await vi.waitFor(() => expect(db.getFileByPath(watchedPath)).not.toBeNull());
    await pipeline.stop("abort");
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

  it("registers duplicate standard media as two locations with one job history", async () => {
    const { dataDir, db, pipeline } = setup();
    const episodeA = db.createEpisode("201");
    const episodeB = db.createEpisode("202");
    const folderAPath = path.join(dataDir, "episode-a");
    const folderBPath = path.join(dataDir, "episode-b");
    mkdirSync(folderAPath);
    mkdirSync(folderBPath);
    const folderA = db.addFolder(folderAPath, "raw", episodeA.id);
    const folderB = db.addFolder(folderBPath, "final", episodeB.id);
    pipeline.watchFolder(folderA);
    pipeline.watchFolder(folderB);
    const pathA = path.join(folderAPath, "shared.mov");
    const pathB = path.join(folderBPath, "shared-copy.mov");
    writeFileSync(pathA, "same bytes");
    writeFileSync(pathB, "same bytes");
    makeStable(pathA);
    makeStable(pathB);
    const identity = {
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "duplicate-hash",
      hasVideo: true,
    };
    mocks.probeByPath.set(pathA, { ...identity, path: pathA, filename: "shared.mov" });
    mocks.probeByPath.set(pathB, { ...identity, path: pathB, filename: "shared-copy.mov" });

    await pipeline.scanFolder(folderA);
    await pipeline.scanFolder(folderB);

    const files = db.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0]?.locations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: pathA, role: "raw" }),
      expect.objectContaining({ path: pathB, role: "final" }),
    ]));
    expect(files[0]?.role).toBe("final");
    expect(db.listJobs()).toEqual([
      expect.objectContaining({ fileId: files[0]?.id, stage: "probe" }),
    ]);
    expect(db.getEpisodeMemberIds(episodeA.id)).toEqual([files[0]?.id]);
    expect(db.getEpisodeMemberIds(episodeB.id)).toEqual([files[0]?.id]);
    await pipeline.stop();
  });

  it("promotes a remaining location and deletes media only after the last removal", async () => {
    const { dataDir, db, pipeline } = setup();
    const folderAPath = path.join(dataDir, "remove-a");
    const folderBPath = path.join(dataDir, "remove-b");
    mkdirSync(folderAPath);
    mkdirSync(folderBPath);
    const folderA = db.addFolder(folderAPath, "raw", null);
    const folderB = db.addFolder(folderBPath, "raw", null);
    pipeline.watchFolder(folderA);
    pipeline.watchFolder(folderB);
    const pathA = path.join(folderAPath, "remove.mov");
    const pathB = path.join(folderBPath, "remove-copy.mov");
    writeFileSync(pathA, "same bytes");
    writeFileSync(pathB, "same bytes");
    makeStable(pathA);
    makeStable(pathB);
    const identity = {
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "remove-hash",
      hasVideo: true,
    };
    mocks.probeByPath.set(pathA, { ...identity, path: pathA, filename: "remove.mov" });
    mocks.probeByPath.set(pathB, { ...identity, path: pathB, filename: "remove-copy.mov" });
    await pipeline.scanFolder(folderA);
    await pipeline.scanFolder(folderB);
    const file = db.listFiles()[0]!;
    const mediaDir = path.join(dataDir, "media", String(file.id));
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(path.join(mediaDir, "proxy.mp4"), "proxy");

    rmSync(pathA);
    mocks.watcherOnFileRemoved?.(pathA);
    await vi.waitFor(() => {
      expect(db.getFile(file.id)?.locations).toHaveLength(1);
      expect(db.getFile(file.id)?.path).toBe(pathB);
    });
    expect(existsSync(mediaDir)).toBe(true);

    rmSync(pathB);
    mocks.watcherOnFileRemoved?.(pathB);
    await vi.waitFor(() => expect(db.getFile(file.id)).toBeNull());
    expect(existsSync(mediaDir)).toBe(false);
    await pipeline.stop();
  });

  it("keeps zero-byte and large different-stem files separate", async () => {
    const { dataDir, db, pipeline } = setup();
    const folderAPath = path.join(dataDir, "safety-a");
    const folderBPath = path.join(dataDir, "safety-b");
    const folderCPath = path.join(dataDir, "safety-c");
    mkdirSync(folderAPath);
    mkdirSync(folderBPath);
    mkdirSync(folderCPath);
    const folderA = db.addFolder(folderAPath, "raw", null);
    const folderB = db.addFolder(folderBPath, "raw", null);
    const folderC = db.addFolder(folderCPath, "raw", null);
    pipeline.watchFolder(folderA);
    pipeline.watchFolder(folderB);
    pipeline.watchFolder(folderC);

    const emptyA = path.join(folderAPath, "empty-a.mov");
    const emptyB = path.join(folderBPath, "empty-b.mov");
    writeFileSync(emptyA, "");
    writeFileSync(emptyB, "");
    makeStable(emptyA);
    makeStable(emptyB);
    mocks.probeByPath.set(emptyA, { fileHash: "empty-hash", size: 0 });
    mocks.probeByPath.set(emptyB, { fileHash: "empty-hash", size: 0 });
    await pipeline.scanFolder(folderA);
    await pipeline.scanFolder(folderB);
    expect(db.listFiles()).toHaveLength(2);

    const largeSize = FULL_CONTENT_HASH_LIMIT_BYTES + 1;
    const largeA = path.join(folderAPath, "camera-a.mov");
    const largeB = path.join(folderBPath, "camera-a.mov");
    const largeC = path.join(folderCPath, "camera-b.mov");
    const bytes = Buffer.alloc(largeSize, 1);
    writeFileSync(largeA, bytes);
    writeFileSync(largeB, bytes);
    writeFileSync(largeC, bytes);
    makeStable(largeA);
    makeStable(largeB);
    makeStable(largeC);
    mocks.probeByPath.set(largeA, { fileHash: "large-hash", size: largeSize });
    mocks.probeByPath.set(largeB, { fileHash: "large-hash", size: largeSize });
    mocks.probeByPath.set(largeC, { fileHash: "large-hash", size: largeSize });
    await pipeline.scanFolder(folderA);
    await pipeline.scanFolder(folderB);
    await pipeline.scanFolder(folderC);

    const largeFiles = db.listFiles().filter((file) => file.fileHash === "large-hash");
    expect(largeFiles).toHaveLength(2);
    expect(largeFiles.map((file) => file.locations?.length).sort()).toEqual([1, 2]);
    await pipeline.stop();
  });

  it("keeps interleaved OP-Atom copies as separate bundles and shrinks one bundle", async () => {
    vi.useFakeTimers();
    const { dataDir, db, pipeline } = setup();
    const episodeA = db.createEpisode("301");
    const episodeB = db.createEpisode("302");
    const folderAPath = path.join(dataDir, "atom-a");
    const folderBPath = path.join(dataDir, "atom-b");
    mkdirSync(folderAPath);
    mkdirSync(folderBPath);
    const folderA = db.addFolder(folderAPath, "raw", episodeA.id);
    const folderB = db.addFolder(folderBPath, "raw", episodeB.id);
    pipeline.watchFolder(folderA);
    pipeline.watchFolder(folderB);
    const paths = [
      path.join(folderAPath, "CLIPV01.mxf"),
      path.join(folderBPath, "CLIPV01.mxf"),
      path.join(folderAPath, "CLIPA01.mxf"),
      path.join(folderBPath, "CLIPA01.mxf"),
    ];
    for (const filePath of paths) writeFileSync(filePath, path.basename(filePath));
    const clipKey = "umid-two-bundles";
    for (const filePath of paths) {
      mocks.mxfAtoms.set(filePath, {
        path: filePath,
        clipKey,
        clipName: "Two Bundles",
        essence: path.basename(filePath).includes("V") ? "video" : "audio",
        durationS: 5,
        fps: 24,
        dropFrame: false,
        startTc: "01:00:00:00",
        codec: path.basename(filePath).includes("V") ? "dnxhd" : "pcm_s24le",
      });
      mocks.probeByPath.set(filePath, {
        fileHash: filePath.includes("atom-a") ? "a".repeat(40) : "b".repeat(40),
      });
      mocks.watcherOnFileFound?.(filePath);
    }

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(db.listFiles()).toHaveLength(1));
    const file = db.listFiles()[0]!;
    expect(file.locations).toHaveLength(2);
    expect(file.locations?.map((location) =>
      location.memberPaths?.every((memberPath) =>
        path.dirname(memberPath) === path.dirname(location.path)
      )
    )).toEqual([true, true]);
    expect(db.listJobs()).toEqual([
      expect.objectContaining({ fileId: file.id, stage: "probe" }),
    ]);
    expect(db.getEpisodeMemberIds(episodeA.id)).toEqual([file.id]);
    expect(db.getEpisodeMemberIds(episodeB.id)).toEqual([file.id]);

    const removedBundlePath = paths[0];
    if (!removedBundlePath) throw new Error("Missing OP-Atom fixture path");
    rmSync(removedBundlePath);
    mocks.mxfAtoms.delete(removedBundlePath);
    mocks.watcherOnFileRemoved?.(removedBundlePath);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      const locations = db.getFile(file.id)?.locations ?? [];
      expect(locations).toHaveLength(2);
      expect(locations.find((location) => location.folderId === folderA.id)?.memberPaths)
        .toEqual([paths[2]]);
      expect(locations.find((location) => location.folderId === folderB.id)?.memberPaths)
        .toEqual([paths[1], paths[3]]);
    });
    expect(db.listJobs()).toEqual([
      expect.objectContaining({ fileId: file.id, stage: "probe" }),
    ]);
    expect(db.getEpisodeMemberIds(episodeA.id)).toEqual([file.id]);
    expect(db.getEpisodeMemberIds(episodeB.id)).toEqual([file.id]);
    await pipeline.stop();
  });

  it("invalidates OP-Atom derived state when content changes at the same member paths", async () => {
    vi.useFakeTimers();
    const { dataDir, db, pipeline } = setup();
    const folder = db.addFolder(dataDir, "raw", null);
    pipeline.watchFolder(folder);
    const videoPath = path.join(dataDir, "OVERWRITEV01.mxf");
    const audioPath = path.join(dataDir, "OVERWRITEA01.mxf");
    writeFileSync(videoPath, "video before");
    writeFileSync(audioPath, "audio before");
    const base = {
      clipKey: "umid-overwritten-in-place",
      clipName: "Overwritten In Place",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
    };
    mocks.mxfAtoms.set(videoPath, {
      ...base,
      path: videoPath,
      essence: "video",
      codec: "dnxhd",
    });
    mocks.mxfAtoms.set(audioPath, {
      ...base,
      path: audioPath,
      essence: "audio",
      codec: "pcm_s24le",
    });
    mocks.probeByPath.set(videoPath, { fileHash: "a".repeat(40) });
    mocks.probeByPath.set(audioPath, { fileHash: "b".repeat(40) });
    mocks.watcherOnFileFound?.(videoPath);
    mocks.watcherOnFileFound?.(audioPath);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(db.getFileByClipKey(base.clipKey)).not.toBeNull());
    const file = db.getFileByClipKey(base.clipKey);
    if (!file) throw new Error("Missing OP-Atom file");
    const originalProbe = db.claimNextJob();
    if (!originalProbe) throw new Error("Missing initial probe job");
    db.completeJob(originalProbe.id);
    db.replaceTranscript(file.id, [{
      startS: 0,
      endS: 1,
      text: "stale transcript",
      avgConf: 1,
      words: [],
    }]);
    db.markTranscribed(file.id);
    db.setFileProxy(file.id, "/cache/stale-proxy.mp4");
    db.replaceScenes(file.id, [{
      startS: 0,
      endS: 5,
      startTc: "01:00:00:00",
      endTc: "01:00:05:00",
      keyframePath: "/cache/stale-keyframe.jpg",
    }]);

    writeFileSync(audioPath, "audio after");
    mocks.probeByPath.set(audioPath, { fileHash: "c".repeat(40) });
    // Changed files arrive through the same found callback: the watcher
    // reports any stable path event and discovery re-ingests idempotently.
    mocks.watcherOnFileFound?.(audioPath);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => {
      expect(db.getFile(file.id)?.fileHash).toContain("c".repeat(40));
    });

    expect(db.getFile(file.id)).toMatchObject({
      hasTranscript: false,
      proxyPath: null,
    });
    expect(db.listSegments(file.id)).toEqual([]);
    expect(db.listScenes(file.id)).toEqual([]);
    expect(db.listJobsForFile(file.id)).toEqual([
      expect.objectContaining({ stage: "probe", status: "queued" }),
    ]);
    await pipeline.stop();
  });

  it("serializes interleaved late OP-Atom batches for the same clip", async () => {
    vi.useFakeTimers();
    const { dataDir, db, pipeline } = setup();
    pipeline.watchFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });
    const audioPath = path.join(dataDir, "SERIALA01.mxf");
    const videoPath = path.join(dataDir, "SERIALV01.mxf");
    writeFileSync(audioPath, "audio atom");
    writeFileSync(videoPath, "video atom");

    const base = {
      clipKey: "umid-serialized-batches",
      clipName: "Serialized Batches",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
    };
    mocks.mxfAtoms.set(audioPath, {
      ...base,
      path: audioPath,
      essence: "audio",
      codec: "pcm_s24le",
    });
    mocks.mxfAtoms.set(videoPath, {
      ...base,
      path: videoPath,
      essence: "video",
      codec: "dnxhd",
    });

    const delayedAudioHash = deferred<Record<string, unknown>>();
    mocks.identifyFile.mockImplementation(async (filePath: string) => {
      if (filePath === audioPath) return delayedAudioHash.promise;
      return {
        path: filePath,
        filename: path.basename(filePath),
        fileHash: "b".repeat(40),
        size: 1,
      };
    });

    mocks.watcherOnFileFound!(audioPath);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => {
      expect(mocks.identifyFile).toHaveBeenCalledWith(audioPath);
    });

    mocks.watcherOnFileFound!(videoPath);
    await vi.advanceTimersByTimeAsync(4000);
    delayedAudioHash.resolve({
      path: audioPath,
      filename: path.basename(audioPath),
      fileHash: "a".repeat(40),
      size: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => {
      expect(db.getFileByClipKey(base.clipKey)?.memberPaths).toEqual([videoPath, audioPath]);
    });
    expect(db.getFileByClipKey(base.clipKey)?.locations).toEqual([
      expect.objectContaining({ memberPaths: [videoPath, audioPath] }),
    ]);
    await pipeline.stop();
  });

  it("preserves a completed OP-Atom transcript when a late video atom arrives", async () => {
    vi.useFakeTimers();
    const { dataDir, db, pipeline } = setup();
    pipeline.watchFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });
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
    expect(joined.locations).toEqual([
      expect.objectContaining({ memberPaths: [videoPath, audioPath] }),
    ]);
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
    const realSetTimeout = setTimeout;
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
    // Windows can complete the asynchronous directory read after many empty
    // event-loop turns. Give real filesystem work time to finish before we
    // advance the fake stability timer.
    for (let i = 0; i < 500 && vi.getTimerCount() === 0; i += 1) {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
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

  it("defers standard ffprobe to the probe stage and calls it once", async () => {
    const { dataDir, db, pipeline } = setup();
    const mediaPath = path.join(dataDir, "probe-once.mov");
    writeFileSync(mediaPath, "complete");
    makeStable(mediaPath);
    mocks.probeInput = {
      path: mediaPath,
      filename: "probe-once.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "probe-once-hash",
      hasVideo: true,
    };

    await pipeline.scanFolder({
      id: 1,
      path: dataDir,
      role: "raw",
      episodeId: null,
      lastScannedAt: null,
    });

    expect(mocks.probeFile).not.toHaveBeenCalled();
    expect(db.getFileByPath(mediaPath)).toMatchObject({
      fileHash: "probe-once-hash",
      hasVideo: null,
    });

    pipeline.start();
    await vi.waitFor(() => expect(db.getFileByPath(mediaPath)?.status).toBe("ready"), {
      timeout: 5000,
    });
    expect(mocks.probeFile).toHaveBeenCalledTimes(1);
    await waitForDrain(db);
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
