/**
 * Resolves paths to external tool binaries used by the pipeline:
 * ffmpeg, ffprobe (bundled via *-static packages, falling back to PATH),
 * and whisper-cli (bundled for each supported release target).
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

export type WhisperRuntimeTarget =
  | { kind: "macos"; executable: "whisper-cli"; pathCommand: "which" }
  | { kind: "windows"; executable: "whisper-cli.exe"; pathCommand: "where.exe" };

export function whisperRuntimeTarget(platform: NodeJS.Platform): WhisperRuntimeTarget | null {
  if (platform === "darwin") {
    return { kind: "macos", executable: "whisper-cli", pathCommand: "which" };
  }
  if (platform === "win32") {
    return { kind: "windows", executable: "whisper-cli.exe", pathCommand: "where.exe" };
  }
  return null;
}

const MAC_WHISPER_CANDIDATES = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];

/**
 * The whisper-cli we ship inside the app (static arm64 build with embedded
 * Metal shaders on macOS and the pinned whisper.cpp x64 release on Windows.
 * Packaged: <Resources>/whisper/; dev: <repo>/vendor/whisper/.
 */
function bundledWhisperBinary(target: WhisperRuntimeTarget): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const moduleDir = typeof __dirname !== "undefined" ? __dirname : null;
  const candidates = [
    resourcesPath ? join(resourcesPath, "whisper", target.executable) : null,
    // dev: dist-electron/main/index.cjs -> repo root -> vendor
    moduleDir ? join(moduleDir, "..", "..", "vendor", "whisper", target.executable) : null,
    join(process.cwd(), "vendor", "whisper", target.executable),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** Global directory where downloaded speech models live (userData/models). */
let globalModelsDir: string | null = null;
export function setGlobalModelsDir(dir: string): void {
  globalModelsDir = dir;
}

/**
 * Locates the whisper-cli binary, checking in order:
 * 1. DAILIES_WHISPER_BIN env var
 * 2. the binary bundled with the app
 * 3. common Homebrew install locations on macOS
 * 4. `which` on macOS or `where.exe` on Windows
 * Returns null if none are found.
 */
export function findWhisperBinary(): string | null {
  const fromEnv = process.env["DAILIES_WHISPER_BIN"];
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }

  const target = whisperRuntimeTarget(process.platform);
  if (!target) return null;

  const bundled = bundledWhisperBinary(target);
  if (bundled) {
    return bundled;
  }

  if (target.kind === "macos") {
    for (const candidate of MAC_WHISPER_CANDIDATES) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const lookup = spawnSync(target.pathCommand, [target.executable], { encoding: "utf8" });
  if (lookup.status === 0) {
    for (const found of lookup.stdout.split(/\r?\n/)) {
      const candidate = found.trim();
      if (candidate.length > 0 && existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Locates a whisper.cpp ggml model file by name, checking in order:
 * 1. the global models dir (userData/models — where in-app downloads land)
 * 2. `${dataDir}/models/ggml-${modelName}.bin`
 * 3. `~/.cache/whisper/ggml-${modelName}.bin`
 * Returns null if none are found.
 */
export function findWhisperModel(modelName: string, dataDir: string): string | null {
  if (globalModelsDir) {
    const inGlobal = join(globalModelsDir, `ggml-${modelName}.bin`);
    if (existsSync(inGlobal)) {
      return inGlobal;
    }
  }

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
