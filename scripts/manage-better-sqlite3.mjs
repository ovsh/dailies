#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("better-sqlite3/package.json");
const packageRoot = path.dirname(packageJsonPath);
const projectRoot = path.resolve(packageRoot, "..", "..");
const activeBinding = path.join(packageRoot, "build", "Release", "better_sqlite3.node");
const betterSqliteVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;

const validationProgram = `
const Database = require(process.env.DAILIES_BETTER_SQLITE3_ROOT);
const options = process.env.DAILIES_NATIVE_BINDING
  ? { nativeBinding: process.env.DAILIES_NATIVE_BINDING }
  : undefined;
const db = new Database(":memory:", options);
db.prepare("SELECT 1").get();
db.close();
`;

function electronSpec() {
  const executable = require("electron");
  const packagePath = require.resolve("electron/package.json");
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const result = spawnSync(executable, ["-p", "process.versions.modules"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not determine Electron's native ABI.${formatFailure(result)}`);
  }
  return {
    name: "electron",
    version,
    abi: result.stdout.trim(),
    command: executable,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function nodeSpec() {
  return {
    name: "node",
    version: process.versions.node,
    abi: process.versions.modules,
    command: process.execPath,
    env: {},
  };
}

function cachePath(spec) {
  const filename = `${spec.name}-${spec.version}-abi-${spec.abi}-${process.platform}-${process.arch}.node`;
  return path.join(projectRoot, ".native-cache", `better-sqlite3-${betterSqliteVersion}`, filename);
}

function validate(spec, binding) {
  const env = {
    ...process.env,
    ...spec.env,
    DAILIES_BETTER_SQLITE3_ROOT: packageRoot,
  };
  if (binding) env.DAILIES_NATIVE_BINDING = binding;
  else delete env.DAILIES_NATIVE_BINDING;

  const result = spawnSync(spec.command, ["-e", validationProgram], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  return result.status === 0;
}

function atomicCopy(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}

function cacheActive(spec, overwrite = false) {
  if (!existsSync(activeBinding) || !validate(spec, activeBinding)) return false;
  const cached = cachePath(spec);
  if (overwrite || !existsSync(cached) || !validate(spec, cached)) {
    atomicCopy(activeBinding, cached);
    console.log(`[native] cached better-sqlite3 for ${spec.name} ${spec.version} (ABI ${spec.abi})`);
  }
  return true;
}

function restoreCached(spec) {
  const cached = cachePath(spec);
  if (!existsSync(cached)) return false;
  if (!validate(spec, cached)) {
    rmSync(cached, { force: true });
    return false;
  }
  atomicCopy(cached, activeBinding);
  if (!validate(spec)) {
    throw new Error(`Cached ${spec.name} binding failed after it was restored to ${activeBinding}.`);
  }
  console.log(`[native] restored better-sqlite3 for ${spec.name} ${spec.version} (ABI ${spec.abi})`);
  return true;
}

function cleanNodeBuildEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "npm_config_runtime",
    "npm_config_target",
    "npm_config_disturl",
    "npm_config_build_from_source",
  ]) {
    delete env[key];
  }
  return env;
}

function rebuildNode() {
  console.log("[native] building better-sqlite3 for system Node (one-time cache miss)");
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli ? [npmCli, "rebuild", "better-sqlite3"] : ["rebuild", "better-sqlite3"];
  return spawnSync(command, args, {
    cwd: projectRoot,
    env: cleanNodeBuildEnvironment(),
    stdio: "inherit",
  });
}

function rebuildElectron() {
  console.log("[native] building better-sqlite3 for Electron (one-time cache miss)");
  const cli = path.join(path.dirname(require.resolve("@electron/rebuild")), "cli.js");
  return spawnSync(process.execPath, [cli, "-f", "-w", "better-sqlite3"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
}

function formatFailure(result) {
  const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  return details ? `\n${details}` : "";
}

function ensure(target, force) {
  const node = nodeSpec();
  const electron = electronSpec();
  const desired = target === "node" ? node : electron;
  const previouslyActive = validate(node) ? node : validate(electron) ? electron : null;

  // Save whichever flavor is currently installed before a rebuild replaces it.
  cacheActive(node);
  cacheActive(electron);

  if (!force && cacheActive(desired)) {
    console.log(`[native] better-sqlite3 is ready for ${desired.name} (ABI ${desired.abi})`);
    return;
  }
  if (!force && restoreCached(desired)) return;

  try {
    const result = desired.name === "node" ? rebuildNode() : rebuildElectron();
    if (result.status !== 0) {
      throw new Error(`Failed to build better-sqlite3 for ${desired.name}.${formatFailure(result)}`);
    }
    if (!validate(desired)) {
      throw new Error(`The rebuilt better-sqlite3 binary does not load in ${desired.name} ABI ${desired.abi}.`);
    }
    cacheActive(desired, true);
    console.log(`[native] better-sqlite3 is ready for ${desired.name} (ABI ${desired.abi})`);
  } catch (error) {
    // node-gyp removes build/ before compiling. Put the prior working flavor back
    // so a denied/interrupted build does not leave either development world broken.
    if (previouslyActive) restoreCached(previouslyActive);
    throw error;
  }
}

const target = process.argv[2];
const force = process.argv.includes("--force");
if (target !== "node" && target !== "electron") {
  console.error("Usage: node scripts/manage-better-sqlite3.mjs <node|electron> [--force]");
  process.exit(2);
}

try {
  ensure(target, force);
} catch (error) {
  console.error(`[native] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
