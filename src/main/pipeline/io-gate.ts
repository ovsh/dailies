/**
 * Per-volume read throttle.
 *
 * Discovery fans out unbounded parallel ffprobe/hash reads (one per member
 * path of an OP-Atom clip, one per discovered file) while the job queue runs
 * up to 8 adaptive concurrent stages. That concurrency is chosen from CPU
 * load, which is blind to disk saturation: on one USB spinning drive the
 * heads thrash, every read slows down, and ffprobe hits PROBE_TIMEOUT_MS.
 *
 * This gate caps how many read operations may touch the SAME volume at once.
 * Work on other volumes (and on the internal SSD) is unaffected.
 *
 * Callers MUST NOT nest withVolumeRead calls for the same volume: a nested
 * acquire waits behind its own outer holder and deadlocks once the limit is
 * reached. The wrap points are therefore the innermost I/O calls
 * (analyzeMxf's ffprobe run, computeFileIdentity's stat+hash, probeFile's
 * ffprobe run) and none of them calls another gated function while holding a
 * slot.
 */
import { statSync } from "node:fs";

/**
 * Conservative, HDD-safe defaults. A 5400/7200rpm USB drive collapses into
 * seek thrash well before it saturates bandwidth, so a spinning external
 * volume gets 2 concurrent readers; an internal SSD tolerates far more, and
 * 6 is enough to keep the pipeline fed without starving playback reads.
 * These are guesses tuned for the worst realistic case — replace them with
 * per-device values once real telemetry tells us the rotational/queue-depth
 * profile of the drives users actually run on.
 */
export const EXTERNAL_VOLUME_READ_LIMIT = 2;
export const INTERNAL_VOLUME_READ_LIMIT = 6;

/** Key used for anything not on a recognisable removable/mounted volume. */
export const INTERNAL_VOLUME_KEY = "internal";

const DARWIN_VOLUMES_PREFIX = "/Volumes/";

function darwinVolumeKey(path: string): string {
  if (!path.startsWith(DARWIN_VOLUMES_PREFIX)) return INTERNAL_VOLUME_KEY;
  const rest = path.slice(DARWIN_VOLUMES_PREFIX.length);
  const name = rest.split("/")[0] ?? "";
  if (name.length === 0) return INTERNAL_VOLUME_KEY;
  return `${DARWIN_VOLUMES_PREFIX}${name}`;
}

function win32VolumeKey(path: string): string {
  // UNC: \\server\share\... (or the forward-slash spelling Node also accepts).
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(path);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
  const drive = /^([A-Za-z]):/.exec(path);
  if (drive) return `${drive[1].toUpperCase()}:`;
  return INTERNAL_VOLUME_KEY;
}

/**
 * The volume a path lives on, as a stable string key.
 * darwin: `/Volumes/<name>` or "internal".
 * win32: `E:` / `\\server\share` or "internal".
 * anything else: "internal" (no cheap mount-point mapping worth the code).
 */
export function volumeKeyForPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return darwinVolumeKey(path);
  if (platform === "win32") return win32VolumeKey(path);
  return INTERNAL_VOLUME_KEY;
}

// `/Volumes/Macintosh HD` is a symlink to `/`, so the boot volume shows up
// under /Volumes like any external drive. Compare device ids to tell them
// apart, and cache: the answer cannot change while the mount exists.
const bootVolumeCache = new Map<string, boolean>();

function isDarwinBootVolume(key: string): boolean {
  const cached = bootVolumeCache.get(key);
  if (cached !== undefined) return cached;
  let isBoot = false;
  try {
    isBoot = statSync(key).dev === statSync("/").dev;
  } catch {
    // Not mounted (or unreadable): treat as external — the cautious limit.
    isBoot = false;
  }
  bootVolumeCache.set(key, isBoot);
  return isBoot;
}

/** Concurrent-read limit for a volume key. */
export function limitForVolumeKey(
  key: string,
  platform: NodeJS.Platform = process.platform,
): number {
  if (key === INTERNAL_VOLUME_KEY) return INTERNAL_VOLUME_READ_LIMIT;
  if (platform === "darwin") {
    return isDarwinBootVolume(key) ? INTERNAL_VOLUME_READ_LIMIT : EXTERNAL_VOLUME_READ_LIMIT;
  }
  if (platform === "win32") {
    return key === "C:" ? INTERNAL_VOLUME_READ_LIMIT : EXTERNAL_VOLUME_READ_LIMIT;
  }
  return INTERNAL_VOLUME_READ_LIMIT;
}

interface VolumeGate {
  active: number;
  limit: number;
  /** FIFO waiters; each resolver receives an already-counted slot. */
  waiters: (() => void)[];
}

const gates = new Map<string, VolumeGate>();

function gateFor(key: string, platform: NodeJS.Platform): VolumeGate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { active: 0, limit: limitForVolumeKey(key, platform), waiters: [] };
    gates.set(key, gate);
  }
  return gate;
}

function acquire(gate: VolumeGate): Promise<void> | undefined {
  if (gate.active < gate.limit) {
    gate.active += 1;
    return undefined;
  }
  return new Promise<void>((resolve) => {
    gate.waiters.push(resolve);
  });
}

function release(gate: VolumeGate): void {
  const next = gate.waiters.shift();
  // Hand the slot straight to the next waiter instead of decrementing and
  // letting a later arrival jump the queue.
  if (next) next();
  else gate.active -= 1;
}

export interface VolumeReadOptions {
  /** Override the platform used to key/limit the volume. Tests only. */
  platform?: NodeJS.Platform;
}

/**
 * Runs `fn` while holding one read slot on the volume that `path` lives on.
 * Waits FIFO when the volume is at its limit, and always releases the slot.
 *
 * There is deliberately no timeout in here: the gated operations carry their
 * own (PROBE_TIMEOUT_MS), and that clock starts only once `fn` runs — queue
 * time must never be charged against ffprobe.
 */
export async function withVolumeRead<T>(
  path: string,
  fn: () => Promise<T>,
  opts?: VolumeReadOptions,
): Promise<T> {
  const platform = opts?.platform ?? process.platform;
  const gate = gateFor(volumeKeyForPath(path, platform), platform);
  const wait = acquire(gate);
  if (wait) await wait;
  try {
    return await fn();
  } finally {
    release(gate);
  }
}

/** Test hook: drop all gate state (never call from app code). */
export function __resetVolumeGatesForTests(): void {
  gates.clear();
  bootVolumeCache.clear();
}
