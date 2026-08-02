import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const MAIN_EXTERNALS = [
  "electron",
  "better-sqlite3",
  "ffmpeg-static",
  "ffprobe-static",
  "electron-updater",
];

const BUILD_FLAVORS = new Set(["auto", "stable", "managed"]);

function readFlavor(argv) {
  const index = argv.indexOf("--flavor");
  if (index === -1) return "auto";
  const flavor = argv[index + 1];
  if (!BUILD_FLAVORS.has(flavor)) {
    throw new Error("--flavor must be auto, stable, or managed");
  }
  return flavor;
}

function configuredPair(env, first, second) {
  const firstValue = env[first]?.trim() ?? "";
  const secondValue = env[second]?.trim() ?? "";
  if ((firstValue.length > 0) !== (secondValue.length > 0)) {
    throw new Error(`${first} and ${second} must be set together`);
  }
  return {
    configured: firstValue.length > 0,
    firstValue,
    secondValue,
  };
}

export function resolveBuildConfig(env, flavor) {
  if (!BUILD_FLAVORS.has(flavor)) throw new Error("Invalid build flavor");

  const telemetry = configuredPair(
    env,
    "DAILIES_TELEMETRY_URL",
    "DAILIES_TELEMETRY_TOKEN",
  );
  const managed = configuredPair(
    env,
    "DAILIES_MANAGED_LLM_URL",
    "DAILIES_MANAGED_LLM_TOKEN",
  );

  if (flavor !== "auto" && !telemetry.configured) {
    throw new Error("Release builds require DAILIES_TELEMETRY_URL and DAILIES_TELEMETRY_TOKEN");
  }
  if (flavor === "stable" && managed.configured) {
    throw new Error("Stable builds must not contain managed LLM credentials");
  }
  if (flavor === "managed" && !managed.configured) {
    throw new Error("Managed builds require DAILIES_MANAGED_LLM_URL and DAILIES_MANAGED_LLM_TOKEN");
  }

  return {
    flavor,
    define: {
      __DAILIES_TELEMETRY_URL__: JSON.stringify(telemetry.firstValue),
      __DAILIES_TELEMETRY_TOKEN__: JSON.stringify(telemetry.secondValue),
      __DAILIES_MANAGED_LLM_URL__: JSON.stringify(managed.firstValue),
      __DAILIES_MANAGED_LLM_TOKEN__: JSON.stringify(managed.secondValue),
    },
  };
}

export async function buildMain(config) {
  await build({
    entryPoints: ["src/main/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: MAIN_EXTERNALS,
    define: config.define,
    outfile: "dist-electron/main/index.cjs",
  });
  await build({
    entryPoints: ["src/preload/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: "dist-electron/preload/index.cjs",
  });
}

async function main() {
  const flavor = readFlavor(process.argv.slice(2));
  const config = resolveBuildConfig(process.env, flavor);
  if (!process.argv.includes("--validate-only")) await buildMain(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
