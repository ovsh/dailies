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
const output = path.join(buildDir, "icon.icns");

const sourcePng = await readFile(source);
const sourceWidth = sourcePng.readUInt32BE(16);
const sourceHeight = sourcePng.readUInt32BE(20);
if (sourceWidth !== 1024 || sourceHeight !== 1024) {
  throw new Error(`build/icon.png must be 1024x1024, got ${sourceWidth}x${sourceHeight}`);
}

const icon = png2icons.createICNS(sourcePng, png2icons.BICUBIC, 0);
if (!icon) throw new Error("png2icons did not produce build/icon.icns");

await writeFile(output, icon);
console.log(`Wrote ${output}`);
