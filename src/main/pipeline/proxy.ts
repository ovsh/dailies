/**
 * ffmpeg-backed derivative media generation: web-playable proxies,
 * single-frame keyframe thumbnails, and mono 16kHz WAV audio for whisper.
 */
import { join } from "node:path";

import { findFfmpegBinary } from "./binaries";
import { run } from "./exec";

async function runFfmpeg(args: string[], timeoutMs?: number): Promise<void> {
  const ffmpegBin = findFfmpegBinary();
  const { stderr, code, signal, timedOut } = await run(ffmpegBin, args, { timeoutMs });
  if (timedOut) {
    throw new Error(`ffmpeg timed out after ${timeoutMs}ms`);
  }
  if (code !== 0) {
    const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
    throw new Error(`ffmpeg failed (${reason}): ${stderr.slice(-2000)}`);
  }
}

/** Generates a 960px-wide H.264/AAC proxy with faststart, returns its output path. */
export async function makeProxy(path: string, outDir: string, timeoutMs?: number): Promise<string> {
  const outPath = join(outDir, "proxy.mp4");
  await runFfmpeg([
    "-y",
    "-i",
    path,
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
    outPath,
  ], timeoutMs);
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
