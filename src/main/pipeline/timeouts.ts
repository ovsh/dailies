/**
 * Generous per-stage ceilings: normal media work gets ample time, but a hung
 * child always eventually dies and releases its pipeline concurrency slot.
 */
function clamp(ms: number, min: number, max: number): number {
  return Math.min(Math.max(ms, min), max);
}

function durationTimeoutMs(durationS: number, multiplier: number, min: number, max: number): number {
  if (Number.isNaN(durationS) || durationS <= 0) return min;
  return clamp(durationS * multiplier * 1000, min, max);
}

export const PROBE_TIMEOUT_MS = 20_000;
export const KEYFRAME_TIMEOUT_MS = 20_000;

export function proxyTimeoutMs(durationS: number): number {
  return durationTimeoutMs(durationS, 6, 90_000, 45 * 60_000);
}

export function scenesTimeoutMs(durationS: number): number {
  return durationTimeoutMs(durationS, 6, 90_000, 45 * 60_000);
}

export function audioExtractTimeoutMs(durationS: number): number {
  return durationTimeoutMs(durationS, 4, 60_000, 30 * 60_000);
}

export function transcribeTimeoutMs(durationS: number): number {
  return durationTimeoutMs(durationS, 10, 2 * 60_000, 60 * 60_000);
}
