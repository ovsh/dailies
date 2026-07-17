/**
 * Scene-boundary detection via ffmpeg's scene-change filter, turned into a
 * list of contiguous [startS, endS) scenes spanning the whole file.
 */
import { findFfmpegBinary } from "./binaries";
import { run } from "./exec";
import { scenesTimeoutMs } from "./timeouts";

export interface DetectedScene {
  startS: number;
  endS: number;
}

const SCENE_THRESHOLD = 0.3;
const MIN_SCENE_LENGTH_S = 1.5;
const FALLBACK_CHUNK_S = 30;

const PTS_TIME_RE = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g;

function parseSceneBoundaries(stderr: string): number[] {
  const boundaries: number[] = [];
  for (const match of stderr.matchAll(PTS_TIME_RE)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      boundaries.push(value);
    }
  }
  return boundaries;
}

function buildFixedChunks(durationS: number): DetectedScene[] {
  const scenes: DetectedScene[] = [];
  for (let start = 0; start < durationS; start += FALLBACK_CHUNK_S) {
    const end = Math.min(start + FALLBACK_CHUNK_S, durationS);
    scenes.push({ startS: start, endS: end });
  }
  if (scenes.length === 0) {
    scenes.push({ startS: 0, endS: durationS });
  }
  return scenes;
}

function mergeShortScenes(scenes: DetectedScene[]): DetectedScene[] {
  if (scenes.length <= 1) return scenes;

  const merged: DetectedScene[] = [];
  for (const scene of scenes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.endS - prev.startS < MIN_SCENE_LENGTH_S) {
      prev.endS = scene.endS;
      continue;
    }
    merged.push({ ...scene });
  }

  // If the final scene ended up too short, fold it into its predecessor.
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    if (last && last.endS - last.startS < MIN_SCENE_LENGTH_S) {
      const prev = merged[merged.length - 2];
      if (prev) {
        prev.endS = last.endS;
        merged.pop();
      }
    }
  }

  return merged;
}

export async function detectScenes(path: string, durationS: number): Promise<DetectedScene[]> {
  const ffmpegBin = findFfmpegBinary();
  const timeoutMs = scenesTimeoutMs(durationS);
  const args = [
    "-i",
    path,
    "-vf",
    `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-f",
    "null",
    "-",
  ];

  const { stderr, timedOut } = await run(ffmpegBin, args, { timeoutMs });
  if (timedOut) {
    throw new Error(`ffmpeg scene detection timed out after ${timeoutMs}ms for ${path}`);
  }
  const boundaries = parseSceneBoundaries(stderr).sort((a, b) => a - b);

  if (boundaries.length === 0) {
    return buildFixedChunks(durationS);
  }

  const scenes: DetectedScene[] = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    if (boundary <= cursor || boundary >= durationS) continue;
    scenes.push({ startS: cursor, endS: boundary });
    cursor = boundary;
  }
  scenes.push({ startS: cursor, endS: durationS });

  const merged = mergeShortScenes(scenes);
  return merged.length > 0 ? merged : buildFixedChunks(durationS);
}
