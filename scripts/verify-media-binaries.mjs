#!/usr/bin/env node
/**
 * Pins the ffmpeg/ffprobe binaries the app ships.
 *
 * ffmpeg-static downloads its binary at `npm ci` time from a GitHub release
 * with no checksum, and ffprobe-static ships prebuilt binaries in the npm
 * package — different upstream builds per platform. A silent change or a
 * weaker build is a decode-quality incident (green-noise proxies on Windows,
 * 0.5.x), so every release build verifies the exact bytes it is about to ship.
 *
 * Runs for the current platform/arch. Fails loud on any mismatch. To accept a
 * deliberate upgrade, rerun with --print and copy the new hashes into PINS.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

// sha256 per platform-arch, keyed like ffmpeg-static release assets.
const PINS = {
  "darwin-arm64": {
    // ffmpeg-static b6.1.1 (ffmpeg 6.0, evermeet arm64 build)
    ffmpeg: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
    // ffprobe-static 3.1.0 (ffprobe 4.4-tessus)
    ffprobe: "5b592e56f87ff754d94dadf99f38b4d0fb7d463eb780b50e0ca061d668d0e3f7",
  },
  "win32-x64": {
    // ffmpeg-static b6.1.1 release asset ffmpeg-win32-x64
    ffmpeg: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
    // ffprobe-static 3.1.0 (ffprobe 4.0.2)
    ffprobe: "4303ec85855340689b1f8aa5d9c1dc06ef3e3090682de3034edc3fca2b0798d5",
  },
};

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveBinaries() {
  const ffmpeg = require("ffmpeg-static");
  const ffprobe = require("ffprobe-static")?.path;
  if (typeof ffmpeg !== "string" || typeof ffprobe !== "string") {
    throw new Error("ffmpeg-static/ffprobe-static did not resolve a binary path");
  }
  return { ffmpeg, ffprobe };
}

const key = `${process.platform}-${process.arch}`;
const printOnly = process.argv.includes("--print");
const { ffmpeg, ffprobe } = resolveBinaries();
const actual = { ffmpeg: sha256(ffmpeg), ffprobe: sha256(ffprobe) };

if (printOnly) {
  console.log(`"${key}": {`);
  console.log(`  ffmpeg: "${actual.ffmpeg}",`);
  console.log(`  ffprobe: "${actual.ffprobe}",`);
  console.log(`},`);
  process.exit(0);
}

const pins = PINS[key];
if (!pins) {
  console.error(`verify-media-binaries: no pins recorded for ${key}`);
  process.exit(1);
}

let failed = false;
for (const [name, binPath] of Object.entries({ ffmpeg, ffprobe })) {
  if (actual[name] === pins[name]) {
    console.log(`verify-media-binaries: ${name} OK (${path.basename(binPath)})`);
  } else {
    failed = true;
    console.error(
      `verify-media-binaries: ${name} MISMATCH for ${key}\n` +
        `  path:     ${binPath}\n` +
        `  expected: ${pins[name]}\n` +
        `  actual:   ${actual[name]}\n` +
        `  The upstream binary changed. Do not ship until the new build is ` +
        `verified on real MXF/DNxHD media; then update PINS (run with --print).`,
    );
  }
}
process.exit(failed ? 1 : 0);
