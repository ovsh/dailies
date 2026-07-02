/**
 * Resolves paths to external tool binaries used by the pipeline:
 * ffmpeg, ffprobe (bundled via *-static packages, falling back to PATH),
 * and whisper-cli (a local, user-installed binary, never bundled).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// These packages may resolve to `null` in dev (e.g. unsupported platform/arch),
// so both imports and their usages are defensive.
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * In a packaged app the *-static packages resolve inside app.asar, but binaries
 * can only be executed from the asar-unpacked mirror (see build.asarUnpack).
 */
function unAsar(p: string): string {
  return p.includes("app.asar") ? p.replace("app.asar", "app.asar.unpacked") : p;
}

/** Absolute path to an ffmpeg binary, or the bare command name to rely on PATH. */
export function findFfmpegBinary(): string {
  if (typeof ffmpegStatic === "string" && ffmpegStatic.length > 0) {
    const p = unAsar(ffmpegStatic);
    if (existsSync(p)) return p;
  }
  return "ffmpeg";
}

/** Absolute path to an ffprobe binary, or the bare command name to rely on PATH. */
export function findFfprobeBinary(): string {
  const path = (ffprobeStatic as { path?: string } | null)?.path;
  if (typeof path === "string" && path.length > 0) {
    const p = unAsar(path);
    if (existsSync(p)) return p;
  }
  return "ffprobe";
}

const WHISPER_CANDIDATES = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];

/**
 * Locates the whisper-cli binary, checking in order:
 * 1. DAILIES_WHISPER_BIN env var
 * 2. common Homebrew install locations
 * 3. `which whisper-cli` on PATH
 * Returns null if none are found.
 */
export function findWhisperBinary(): string | null {
  const fromEnv = process.env["DAILIES_WHISPER_BIN"];
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }

  for (const candidate of WHISPER_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const which = spawnSync("which", ["whisper-cli"], { encoding: "utf8" });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found.length > 0 && existsSync(found)) {
      return found;
    }
  }

  return null;
}

/**
 * Locates a whisper.cpp ggml model file by name, checking in order:
 * 1. `${dataDir}/models/ggml-${modelName}.bin`
 * 2. `~/.cache/whisper/ggml-${modelName}.bin`
 * Returns null if none are found.
 */
export function findWhisperModel(modelName: string, dataDir: string): string | null {
  const inDataDir = join(dataDir, "models", `ggml-${modelName}.bin`);
  if (existsSync(inDataDir)) {
    return inDataDir;
  }

  const inCache = join(homedir(), ".cache", "whisper", `ggml-${modelName}.bin`);
  if (existsSync(inCache)) {
    return inCache;
  }

  return null;
}

function binaryRuns(bin: string): boolean {
  try {
    const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
    return result.error === undefined;
  } catch {
    return false;
  }
}

/** Quick availability check for ffmpeg and whisper, used by Settings UI. */
export function checkAvailability(): { ffmpeg: boolean; whisper: boolean } {
  const ffmpegBin = findFfmpegBinary();
  const ffmpeg = existsSync(ffmpegBin) || binaryRuns(ffmpegBin);

  const whisperBin = findWhisperBinary();
  const whisper = whisperBin !== null && (existsSync(whisperBin) || binaryRuns(whisperBin));

  return { ffmpeg, whisper };
}
