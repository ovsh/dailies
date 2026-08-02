/**
 * Probes a media file with ffprobe and hashes it to produce a FileInput
 * ready for DailiesDB.upsertFile.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import type { FileInput } from "../../shared/types";
import { findFfprobeBinary } from "./binaries";
import { run } from "./exec";
import { withVolumeRead } from "./io-gate";
import { PROBE_TIMEOUT_MS } from "./timeouts";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  avg_frame_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
}

interface FfprobeFormat {
  duration?: string;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [numStr, denStr] = rate.split("/");
  const num = Number(numStr);
  const den = Number(denStr ?? "1");
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function isNearDropFrameRate(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.05 || Math.abs(fps - 59.94) < 0.05;
}

const PARTIAL_HASH_CHUNK_BYTES = 1024 * 1024; // 1MB

/** Fast partial hash: sha1 of (file size + first 1MB + last 1MB). */
async function computeFileHash(path: string, size: number): Promise<string> {
  const hash = createHash("sha1");
  hash.update(String(size));

  const readChunk = (start: number, end: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(path, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });

  if (size <= PARTIAL_HASH_CHUNK_BYTES * 2) {
    const whole = await readChunk(0, Math.max(size - 1, 0));
    hash.update(whole);
  } else {
    const head = await readChunk(0, PARTIAL_HASH_CHUNK_BYTES - 1);
    const tail = await readChunk(size - PARTIAL_HASH_CHUNK_BYTES, size - 1);
    hash.update(head);
    hash.update(tail);
  }

  return hash.digest("hex");
}

export interface FileIdentity {
  path: string;
  filename: string;
  fileHash: string;
  size: number;
}

export async function computeFileIdentity(path: string): Promise<FileIdentity> {
  // stat + the two 1MB chunk reads are the whole I/O cost; hold one volume
  // read slot for all of it so discovery cannot fan out 30 hashes at once
  // onto one spinning drive.
  return withVolumeRead(path, async () => {
    const { size } = await stat(path);
    return {
      path,
      filename: basename(path),
      fileHash: await computeFileHash(path, size),
      size,
    };
  });
}

export async function probeFile(path: string, knownFileHash?: string): Promise<FileInput> {
  const ffprobeBin = findFfprobeBinary();
  const args = [
    // "error", not "quiet": when ffprobe fails, its stderr is the diagnosis,
    // and it must reach the failed-jobs table instead of a bare exit code.
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ];

  // Gated like analyzeMxf: the probe stage runs up to 8 jobs at once, and on
  // one external drive that alone is enough to push ffprobe past its timeout.
  // Nothing gated is held across this call — the computeFileIdentity below
  // acquires its own slot only after this one is released, so no nesting.
  const { stdout, stderr, code, timedOut } = await withVolumeRead(path, () =>
    run(ffprobeBin, args, { timeoutMs: PROBE_TIMEOUT_MS }),
  );
  if (timedOut) {
    throw new Error(`ffprobe timed out after ${PROBE_TIMEOUT_MS}ms for ${path}`);
  }
  if (code !== 0) {
    const detail = stderr.trim().split("\n").slice(-3).join(" · ").slice(0, 300);
    throw new Error(
      `ffprobe failed for ${path} (exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    );
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (err) {
    throw new Error(`ffprobe returned invalid JSON for ${path}: ${(err as Error).message}`);
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  const durationS = Number(parsed.format?.duration ?? videoStream?.tags?.["duration"] ?? 0) || 0;
  const fps = parseFrameRate(videoStream?.avg_frame_rate);
  const codec = videoStream?.codec_name ?? "unknown";
  const audioChannels = audioStream?.channels ?? 0;

  const startTc =
    videoStream?.tags?.["timecode"] ?? parsed.format?.tags?.["timecode"] ?? "00:00:00:00";

  const dropFrame = startTc.includes(";") || (isNearDropFrameRate(fps) && startTc.includes(";"));

  const fileHash = knownFileHash ?? (await computeFileIdentity(path)).fileHash;

  return {
    path,
    filename: basename(path),
    durationS,
    fps,
    dropFrame,
    startTc,
    codec,
    audioChannels,
    fileHash,
    hasVideo: videoStream !== undefined,
  };
}
