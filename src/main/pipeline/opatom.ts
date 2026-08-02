/**
 * Avid OP-Atom MXF support. Avid media (`Avid MediaFiles/MXF/1/*.mxf`) is
 * OP-Atom: each .mxf holds ONE essence track (audio or video) of a source
 * clip; atoms of the same clip share a material package UMID (clipKey).
 */
import { run } from "./exec";
import { withVolumeRead } from "./io-gate";
import { PROBE_TIMEOUT_MS } from "./timeouts";

export interface MxfAtomInfo {
  path: string;
  clipKey: string;
  clipName: string | null;
  essence: "video" | "audio";
  durationS: number;
  fps: number;
  dropFrame: boolean;
  startTc: string;
  codec: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
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

/**
 * Audio OP-Atom streams have no video avg_frame_rate, but some MXF writers
 * expose the package/track edit rate as a tag. Preserve 0 when no edit rate is
 * exposed: 0 means unknown and is preferable to inventing a source rate.
 */
function findAudioEditRate(format: FfprobeFormat | undefined, streams: FfprobeStream[]): number {
  const tagSets = [format?.tags ?? {}, ...streams.map((stream) => stream.tags ?? {})];
  for (const tags of tagSets) {
    for (const [key, value] of Object.entries(tags)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const isEditRate = normalized.includes("edit_rate") ||
        (normalized.includes("timecode") && normalized.includes("rate"));
      if (!isEditRate) continue;
      const rate = parseFrameRate(value);
      if (rate > 0) return rate;
    }
  }
  for (const stream of streams) {
    const rate = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
    if (rate > 0) return rate;
  }
  return 0;
}

function findPackageUmid(format: FfprobeFormat | undefined, streams: FfprobeStream[]): string | null {
  const formatTags = format?.tags ?? {};
  if (typeof formatTags["material_package_umid"] === "string") {
    return formatTags["material_package_umid"];
  }
  for (const stream of streams) {
    const tags = stream.tags ?? {};
    for (const [key, value] of Object.entries(tags)) {
      if (key.toLowerCase().endsWith("package_umid") && typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Runs ffprobe (json, -show_format -show_streams) against an .mxf file and
 * returns its OP-Atom info, or null when the file is not OP-Atom (e.g. it
 * carries both audio and video streams — treat as standard media).
 *
 * Null strictly means "probed successfully, and this is not an atom". A
 * probe that could not run or exited nonzero THROWS instead: treating a
 * transient failure (spawn error, drive hiccup, timeout) as "not OP-Atom"
 * sends the atom down the standard-ingest path, which plants a standalone
 * files row at the atom's path that every later clip registration collides
 * with.
 */
export async function analyzeMxf(ffprobePath: string, path: string): Promise<MxfAtomInfo | null> {
  const args = [
    // "error", not "quiet": on failure the stderr tail is the diagnosis.
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ];

  // Only the spawn+read is gated (parsing below is pure CPU). The timeout
  // clock starts inside the gate, so waiting for a busy drive never eats
  // into ffprobe's own budget.
  const { stdout, stderr, code, timedOut } = await withVolumeRead(path, () =>
    run(ffprobePath, args, { timeoutMs: PROBE_TIMEOUT_MS }),
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
  const videoStreams = streams.filter((s) => s.codec_type === "video" && s.codec_name !== "none");
  const audioStreams = streams.filter((s) => s.codec_type === "audio");

  // OP-Atom carries a single essence track per file. If both audio and video
  // streams are present, this is standard (non-atom) media.
  if (videoStreams.length > 0 && audioStreams.length > 0) {
    return null;
  }
  if (videoStreams.length === 0 && audioStreams.length === 0) {
    return null;
  }

  const clipKey = findPackageUmid(parsed.format, streams);
  if (!clipKey) {
    return null;
  }

  const clipName = parsed.format?.tags?.["material_package_name"] ?? null;
  const essence: "video" | "audio" = videoStreams.length > 0 ? "video" : "audio";

  const primaryStream = essence === "video" ? videoStreams[0] : audioStreams[0];

  const fps = essence === "video"
    ? parseFrameRate(primaryStream?.avg_frame_rate)
    : findAudioEditRate(parsed.format, streams);

  const startTc =
    primaryStream?.tags?.["timecode"] ?? parsed.format?.tags?.["timecode"] ?? "00:00:00:00";

  const dropFrame = startTc.includes(";") || (isNearDropFrameRate(fps) && startTc.includes(";"));

  const durationS =
    Number(parsed.format?.duration ?? primaryStream?.tags?.["duration"] ?? 0) || 0;

  const codec = primaryStream?.codec_name ?? "unknown";

  return {
    path,
    clipKey,
    clipName,
    essence,
    durationS,
    fps,
    dropFrame,
    startTc,
    codec,
  };
}

export interface OpAtomClip {
  clipKey: string;
  clipName: string | null;
  atoms: MxfAtomInfo[];
}

export interface OpAtomGrouperOptions {
  debounceMs?: number;
  onClip(clip: OpAtomClip): void;
}

const DEFAULT_DEBOUNCE_MS = 4000;

/**
 * Collects OP-Atom essence atoms and emits complete clips after quiescence:
 * groups by clipKey, (re)starting a per-group timer on every new atom for
 * that clip. Each timer fire consumes its batch; callers can reconstruct
 * earlier membership from durable clipKey state when a late atom arrives.
 */
export class OpAtomGrouper {
  private readonly debounceMs: number;
  private readonly onClip: (clip: OpAtomClip) => void;
  private readonly groups = new Map<string, MxfAtomInfo[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: OpAtomGrouperOptions) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onClip = opts.onClip;
  }

  addAtom(info: MxfAtomInfo): void {
    const existing = this.groups.get(info.clipKey) ?? [];
    const samePath = existing.findIndex((atom) => atom.path === info.path);
    if (samePath >= 0) existing[samePath] = info;
    else existing.push(info);
    this.groups.set(info.clipKey, existing);

    const existingTimer = this.timers.get(info.clipKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.timers.delete(info.clipKey);
      const atoms = this.groups.get(info.clipKey);
      this.groups.delete(info.clipKey);
      if (!atoms || atoms.length === 0) return;

      const clipName = atoms.find((a) => a.clipName)?.clipName ?? null;
      this.onClip({ clipKey: info.clipKey, clipName, atoms });
    }, this.debounceMs);

    this.timers.set(info.clipKey, timer);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.groups.clear();
  }
}
