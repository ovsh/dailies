import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const png2icons = require("png2icons");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const buildDir = path.join(repoDir, "build");
const source = path.join(buildDir, "icon.png");
const icnsOutput = path.join(buildDir, "icon.icns");
const icoOutput = path.join(buildDir, "icon.ico");

const sourcePng = await readFile(source);
const sourceWidth = sourcePng.readUInt32BE(16);
const sourceHeight = sourcePng.readUInt32BE(20);
if (sourceWidth !== 1024 || sourceHeight !== 1024) {
  throw new Error(`build/icon.png must be 1024x1024, got ${sourceWidth}x${sourceHeight}`);
}

const icns = png2icons.createICNS(sourcePng, png2icons.BICUBIC, 0);
if (!icns) throw new Error("png2icons did not produce build/icon.icns");

const ico = png2icons.createICO(sourcePng, png2icons.BICUBIC2, 0, false, true);
if (!ico) throw new Error("png2icons did not produce build/icon.ico");

await Promise.all([
  writeFile(icnsOutput, icns),
  writeFile(icoOutput, ico),
]);
console.log(`Wrote ${icnsOutput} and ${icoOutput}`);
