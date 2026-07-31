/**
 * ffmpeg-backed derivative media generation: web-playable proxies,
 * single-frame keyframe thumbnails, and mono 16kHz WAV audio for whisper.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { findFfmpegBinary } from "./binaries";
import { run } from "./exec";

/**
 * ffmpeg's FFMPEG_ERROR_RATE_EXCEEDED. transcode() already returned success and
 * the output is fully muxed (trailer written, faststart applied) — ffmpeg only
 * swaps the exit code at the very end because more decoded frames errored than
 * -max_error_rate (default 2/3) allows. Damaged camera-card media trips this
 * constantly, and the file ffmpeg just wrote is byte-for-byte what a run
 * without the check would have produced, so it is the proxy we want.
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
 * Second-attempt decode tolerance: keep going through damaged packets, throw
 * corrupt frames away instead of feeding them to the decoder, and never let the
 * error rate alone fail a run that produced output. The output contract is
 * unchanged — same 960px H.264/AAC faststart proxy.mp4.
 */
const TOLERANT_INPUT_ARGS = [
  "-err_detect",
  "ignore_err",
  "-fflags",
  "+discardcorrupt",
  "-max_error_rate",
  "1",
];

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
    const how = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
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

/** True once ffmpeg has actually left a non-empty file at `path`. */
async function wroteOutput(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
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

/** Generates a 960px-wide H.264/AAC proxy with faststart, returns its output path. */
export async function makeProxy(path: string, outDir: string, timeoutMs?: number): Promise<string> {
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
  if (first.code === ERROR_RATE_EXCEEDED && (await wroteOutput(outPath))) return outPath;
  // A second full encode of something that already ran out the clock would only
  // spend the same timeout again.
  if (first.timedOut) {
    throw new Error(`ffmpeg failed (${first.how}): ${first.detail}\n${first.tail}`);
  }

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
  if (second.ok) return outPath;
  if (second.code === ERROR_RATE_EXCEEDED && (await wroteOutput(outPath))) return outPath;

  throw new Error(
    `ffmpeg failed (${first.how}): ${first.detail}\n` +
      `tolerant retry also failed (${second.how}): ${second.detail}\n` +
      second.tail,
  );
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
