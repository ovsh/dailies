import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(rootDir, "release");
const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;
const zipName = `Dailies-${version}-arm64-mac.zip`;
const dmgName = `Dailies-${version}-arm64.dmg`;
const zipPath = path.join(releaseDir, zipName);
const dmgPath = path.join(releaseDir, dmgName);

runCheck("codesign", ["--verify", "--verbose=2", dmgPath], "DMG signature");
runCheck("xcrun", ["stapler", "validate", dmgPath], "DMG notarization ticket");
runCheck(
  "spctl",
  ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", dmgPath],
  "DMG Gatekeeper assessment",
);

await buildBlockMap(zipPath, "gzip", `${zipPath}.blockmap`);
await buildBlockMap(dmgPath, "gzip", `${dmgPath}.blockmap`);

const zipInfo = await fileInfo(zipName, zipPath);
const dmgInfo = await fileInfo(dmgName, dmgPath);
const releaseDate = (await stat(zipPath)).mtime.toISOString();
const manifest = [
  `version: ${version}`,
  "files:",
  ...formatFile(zipInfo),
  ...formatFile(dmgInfo),
  `path: ${zipName}`,
  `sha512: ${zipInfo.sha512}`,
  `releaseDate: '${releaseDate}'`,
  "",
].join("\n");

await writeFile(path.join(releaseDir, "latest-mac.yml"), manifest);
console.log(`Finalized macOS release metadata for Dailies ${version}`);

function runCheck(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed. Sign, notarize, staple, and verify the DMG before finalizing.`);
  }
}

async function fileInfo(url, filePath) {
  const contents = await readFile(filePath);
  return {
    url,
    sha512: createHash("sha512").update(contents).digest("base64"),
    size: contents.length,
  };
}

function formatFile(file) {
  return [
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
  ];
}
