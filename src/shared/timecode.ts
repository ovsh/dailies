/**
 * Frame-accurate timecode math shared by export modules (locators, EDL) and
 * anywhere else that needs to convert between SMPTE timecode and frames or
 * seconds. Supports non-drop-frame (NDF) and drop-frame (DF) timecode.
 *
 * Nominal fps for frame math is the rounded fps (round(fps)):
 *   23.976 -> 24, 24 -> 24, 25 -> 25, 29.97 -> 30, 30 -> 30, 59.94 -> 60, 60 -> 60.
 * Drop-frame is only meaningful at 29.97 (2 frames dropped/min) and 59.94
 * (4 frames dropped/min); the algorithm below generalizes using the nominal
 * fps to derive the drop count (nominal/15, i.e. 2 for 30, 4 for 60).
 */

const TC_RE = /^(\d{1,2})[:;](\d{1,2})[:;](\d{1,2})[:;](\d{1,2})$/;
export const UNKNOWN_SOURCE_RATE_FALLBACK_FPS = 30;

/** Nominal (rounded) fps used for all frame-count math. */
function nominalFps(fps: number): number {
  return Math.round(fps);
}

/** Number of frames dropped at the start of each non-exempt minute. */
function dropFramesPerMinute(nominal: number): number {
  // 30 -> 2, 60 -> 4. Generalized as nominal / 15 (integer for supported rates).
  return Math.round(nominal / 15);
}

/**
 * Validate a timecode string of the form HH:MM:SS:FF (or with ";" in place
 * of any/all separators). Does not validate the frame field against fps.
 */
export function isValidTc(tc: string): boolean {
  return TC_RE.test(tc.trim());
}

interface TcParts {
  hh: number;
  mm: number;
  ss: number;
  ff: number;
}

function splitTc(tc: string): TcParts {
  const m = TC_RE.exec(tc.trim());
  if (!m) {
    throw new Error(`Invalid timecode: "${tc}"`);
  }
  return {
    hh: Number(m[1]),
    mm: Number(m[2]),
    ss: Number(m[3]),
    ff: Number(m[4]),
  };
}

/**
 * Parse a timecode string into an absolute frame count.
 * Accepts ":" or ";" as any/all separators. `dropFrame` selects the SMPTE
 * drop-frame decoding algorithm; frame math uses the nominal (rounded) fps.
 */
export function parseTc(tc: string, fps: number, dropFrame: boolean): number {
  const { hh, mm, ss, ff } = splitTc(tc);
  const nominal = nominalFps(fps);

  const totalMinutes = hh * 60 + mm;

  if (!dropFrame) {
    return ((totalMinutes * 60 + ss) * nominal) + ff;
  }

  const dropPerMin = dropFramesPerMinute(nominal);
  const minutesExemptEvery10 = Math.floor(totalMinutes / 10);
  const droppedFrames = dropPerMin * (totalMinutes - minutesExemptEvery10);

  const framesIfNdf = ((totalMinutes * 60 + ss) * nominal) + ff;
  return framesIfNdf - droppedFrames;
}

/**
 * Format an absolute frame count as a timecode string.
 * Drop-frame output uses ";" before the frames field (e.g. "01:00:00;02");
 * non-drop-frame output uses ":" throughout.
 */
export function framesToTc(frames: number, fps: number, dropFrame: boolean): string {
  const nominal = nominalFps(fps);
  let frameCount = Math.round(frames);
  const negative = frameCount < 0;
  if (negative) frameCount = -frameCount;

  let hh: number, mm: number, ss: number, ff: number;

  if (!dropFrame) {
    ff = frameCount % nominal;
    const totalSeconds = Math.floor(frameCount / nominal);
    ss = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    mm = totalMinutes % 60;
    hh = Math.floor(totalMinutes / 60) % 24;
  } else {
    // Standard SMPTE drop-frame decode. Every minute drops `dropPerMin`
    // frame numbers at :00, except minutes divisible by 10.
    const dropPerMin = dropFramesPerMinute(nominal);
    const framesPerMin = nominal * 60 - dropPerMin;
    const framesPer10Min = nominal * 60 * 10 - dropPerMin * 9;

    const tenMinBlocks = Math.floor(frameCount / framesPer10Min);
    const remainder = frameCount % framesPer10Min;

    // Within a 10-minute block, minute 0 has `nominal*60` frames (no drop);
    // minutes 1-9 each have `framesPerMin` frames (dropPerMin dropped at :00).
    const firstMinuteFrames = nominal * 60;
    let minuteInBlock: number;
    let framesSinceMinuteStart: number;
    if (remainder < firstMinuteFrames) {
      minuteInBlock = 0;
      framesSinceMinuteStart = remainder;
    } else {
      const rest = remainder - firstMinuteFrames;
      minuteInBlock = 1 + Math.floor(rest / framesPerMin);
      // Frame numbers 0..dropPerMin-1 don't exist in these minutes, so the
      // displayed frame field starts at dropPerMin.
      framesSinceMinuteStart = dropPerMin + (rest % framesPerMin);
    }

    const totalMinutes = tenMinBlocks * 10 + minuteInBlock;
    hh = Math.floor(totalMinutes / 60) % 24;
    mm = totalMinutes % 60;
    ss = Math.floor(framesSinceMinuteStart / nominal);
    ff = framesSinceMinuteStart % nominal;
  }

  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const sep = dropFrame ? ";" : ":";
  const sign = negative ? "-" : "";
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/** Round seconds to the nearest frame count at the given fps (nominal). */
export function secondsToFrames(s: number, fps: number): number {
  const nominal = nominalFps(fps);
  return Math.round(s * nominal);
}

/**
 * Convert a timecode to real elapsed seconds, using the *actual* fps
 * (e.g. 29.97, not 30) so drop-frame timecodes map back to true wall-clock
 * time. Frame decoding (drop-frame adjustment) still uses the nominal fps.
 */
export function tcToSeconds(tc: string, fps: number, dropFrame: boolean): number {
  const frames = parseTc(tc, fps, dropFrame);
  return frames / fps;
}

/**
 * Add `s` real seconds to a timecode, returning a new timecode string.
 * Uses actual fps to convert seconds to frames, then nominal fps for
 * frame/timecode formatting.
 */
export function tcAddSeconds(tc: string, s: number, fps: number, dropFrame: boolean): string {
  const startFrames = parseTc(tc, fps, dropFrame);
  const deltaFrames = Math.round(s * fps);
  return framesToTc(startFrames + deltaFrames, fps, dropFrame);
}

/** Format elapsed time when no source edit rate exists (for example, audio-only media). */
export function formatElapsedOffset(s: number): string {
  const totalMs = Math.max(Math.round(s * 1000), 0);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `+${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
}

/** Resolve an offset to source TC, or to an explicit elapsed offset when fps is unknown. */
export function sourceTcAtOffset(
  startTc: string,
  offsetS: number,
  fps: number,
  dropFrame: boolean,
): string {
  return fps > 0 ? tcAddSeconds(startTc, offsetS, fps, dropFrame) : formatElapsedOffset(offsetS);
}

export interface DerivedSourceTimecode {
  tc: string;
  sourceRateFallback: boolean;
}

export function deriveSourceTimecode(
  startTc: string,
  offsetS: number,
  fps: number,
  dropFrame: boolean,
): DerivedSourceTimecode {
  const sourceRateFallback = !(fps > 0);
  return {
    tc: tcAddSeconds(
      startTc,
      offsetS,
      sourceRateFallback ? UNKNOWN_SOURCE_RATE_FALLBACK_FPS : fps,
      sourceRateFallback ? false : dropFrame,
    ),
    sourceRateFallback,
  };
}

/**
 * Compare two timecodes at the given fps/dropFrame.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareTc(a: string, b: string, fps: number, dropFrame: boolean): number {
  return parseTc(a, fps, dropFrame) - parseTc(b, fps, dropFrame);
}
