/**
 * ffmpeg-backed derivative media generation: web-playable proxies,
 * single-frame keyframe thumbnails, and mono 16kHz WAV audio for whisper.
 */
import { join } from "node:path";

import { findFfmpegBinary, findFfprobeBinary } from "./binaries";
import { run } from "./exec";

/**
 * ffmpeg's FFMPEG_ERROR_RATE_EXCEEDED: more decoded frames errored than
 * -max_error_rate allows. A proxy that trips this is mostly noise — accepting
 * it once shipped green-static previews to a customer (Windows, 0.5.x), so it
 * now fails the stage instead of being stored.
 */
const ERROR_RATE_EXCEEDED = 69;

const PROXY_ENCODE_ARGS = [
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
];
const PROXY_AUDIO_ARGS = ["-c:a", "aac", "-b:a", "128k"];
const PROXY_MUX_ARGS = ["-movflags", "+faststart"];
/**
 * Second-attempt decode tolerance: throw damaged packets away at the demuxer
 * (+discardcorrupt) instead of feeding them to the decoder, and allow at most
 * 5% of decoded frames to error before ffmpeg fails the run. The earlier flags
 * here (-err_detect ignore_err, -max_error_rate 1) forced a desynced decoder
 * to keep producing frames — the classic green-macroblock noise — and then
 * declared success. Because discarded packets are not counted as frame errors,
 * the caller additionally checks the output duration against the source.
 */
const TOLERANT_INPUT_ARGS = [
  "-fflags",
  "+discardcorrupt",
  "-max_error_rate",
  "0.05",
];

/** A tolerant retry must still cover most of the source to be worth storing. */
const MIN_PROXY_DURATION_RATIO = 0.8;
const PROBE_TIMEOUT_MS = 20_000;

interface FfmpegRun {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** How it ended, e.g. "exit 69", "signal SIGKILL", "timed out after 60000ms". */
  how: string;
  /** Whole-line stderr summary — safe as the headline of a thrown message. */
  detail: string;
  /** Raw stderr tail, kept for the expandable full reason in Jobs. */
  tail: string;
}

/**
 * ffmpeg writes its progress counter with \r and no newline, so a raw tail of
 * stderr almost always begins mid-line and the first line of the thrown message
 * ends up a fragment like "chroma_qp_offset=0" — which is all the Jobs list
 * shows. Fold \r into \n and keep whole lines, the way probe/opatom summarise
 * their own failures.
 */
function ffmpegDetail(stderr: string): string {
  const lines = stderr
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(-3).join(" · ").slice(0, 300);
}

async function tryFfmpeg(args: string[], timeoutMs?: number): Promise<FfmpegRun> {
  const ffmpegBin = findFfmpegBinary();
  const { stderr, code, signal, timedOut } = await run(ffmpegBin, args, { timeoutMs });
  const detail = ffmpegDetail(stderr);
  const tail = stderr.slice(-2000);
  if (timedOut) {
    return { ok: false, code, timedOut, how: `timed out after ${timeoutMs}ms`, detail, tail };
  }
  if (code !== 0) {
    const how =
      code === null ? `signal ${signal ?? "unknown"}`
      : code === ERROR_RATE_EXCEEDED ? `exit ${code} (decode error rate exceeded)`
      : `exit ${code}`;
    return { ok: false, code, timedOut, how, detail, tail };
  }
  return { ok: true, code, timedOut, how: "", detail, tail };
}

async function runFfmpeg(args: string[], timeoutMs?: number): Promise<void> {
  const result = await tryFfmpeg(args, timeoutMs);
  if (!result.ok) {
    throw new Error(`ffmpeg failed (${result.how}): ${result.detail}\n${result.tail}`);
  }
}

/** Duration of a finished proxy in seconds, or null when ffprobe cannot say. */
async function probeDurationS(path: string): Promise<number | null> {
  try {
    const { stdout, code, timedOut } = await run(
      findFfprobeBinary(),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (timedOut || code !== 0) return null;
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

/**
 * ffmpeg tags every message about an audio OUTPUT stream with an `aost#`
 * prefix, so this matches only when the encode broke on the audio side — a
 * >8-channel production-sound layout the native aac encoder refuses, say. A
 * silent proxy is worth far more than no proxy.
 */
function audioSideFailed(result: FfmpegRun): boolean {
  return /\baost#|Unsupported channel layout|Audio encoding failed/i.test(
    `${result.detail}\n${result.tail}`,
  );
}

/**
 * Generates a 960px-wide H.264/AAC proxy with faststart, returns its output path.
 *
 * A run that decodes cleanly (exit 0) is stored as-is. Anything else gets one
 * tolerant retry that drops damaged packets but still fails on a >5% frame
 * error rate; its output must also cover most of the source duration
 * (discarded packets shorten the output without counting as errors). A file
 * this cannot proxy honestly fails the stage — the UI then says "No preview"
 * instead of playing decoder noise, and Retry re-runs it.
 */
export async function makeProxy(
  path: string,
  outDir: string,
  timeoutMs?: number,
  expectedDurationS?: number,
): Promise<string> {
  const outPath = join(outDir, "proxy.mp4");
  const first = await tryFfmpeg([
    "-y",
    "-i",
    path,
    ...PROXY_ENCODE_ARGS,
    ...PROXY_AUDIO_ARGS,
    ...PROXY_MUX_ARGS,
    outPath,
  ], timeoutMs);
  if (first.ok) return outPath;
  // A second full encode of something that already ran out the clock would only
  // spend the same timeout again.
  if (first.timedOut) {
    throw new Error(`ffmpeg failed (${first.how}): ${first.detail}\n${first.tail}`);
  }

  console.warn(`[pipeline] proxy tolerant retry (first attempt ${first.how}) for ${path}`);
  const second = await tryFfmpeg([
    "-y",
    ...TOLERANT_INPUT_ARGS,
    "-i",
    path,
    ...PROXY_ENCODE_ARGS,
    ...(audioSideFailed(first) ? ["-an"] : PROXY_AUDIO_ARGS),
    ...PROXY_MUX_ARGS,
    outPath,
  ], timeoutMs);
  if (!second.ok) {
    throw new Error(
      `ffmpeg failed (${first.how}): ${first.detail}\n` +
        `tolerant retry also failed (${second.how}): ${second.detail}\n` +
        second.tail,
    );
  }

  if (expectedDurationS !== undefined && expectedDurationS > 0) {
    const proxyDurationS = await probeDurationS(outPath);
    if (
      proxyDurationS !== null &&
      proxyDurationS < expectedDurationS * MIN_PROXY_DURATION_RATIO
    ) {
      throw new Error(
        `ffmpeg failed (${first.how}): ${first.detail}\n` +
          `tolerant retry dropped too much of the source: proxy is ` +
          `${proxyDurationS.toFixed(1)}s of ${expectedDurationS.toFixed(1)}s\n` +
          second.tail,
      );
    }
  }
  console.warn(`[pipeline] proxy tolerant retry succeeded for ${path}`);
  return outPath;
}

/** Extracts a single JPEG frame at `atS` seconds, scaled to 640px wide. */
export async function extractKeyframe(
  path: string,
  atS: number,
  outPath: string,
  timeoutMs?: number,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-ss",
    String(Math.max(atS, 0)),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    outPath,
  ], timeoutMs);
}

/**
 * True when an extractAudio failure means the input simply has no audio
 * stream (video-only essence) — a fact about the media, not an error.
 */
export function isNoAudioStreamError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not contain any stream|no audio stream|Stream specifier .* matches no streams/i.test(
    message,
  );
}

/**
 * Extracts mono 16kHz PCM16 WAV audio, suitable for whisper.cpp.
 * There is intentionally no seek/trim: the WAV starts at source t=0, so
 * transcript startS offsets map 1:1 to playback time.
 */
export async function extractAudio(path: string, outWav: string, timeoutMs?: number): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i",
    path,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outWav,
  ], timeoutMs);
}
