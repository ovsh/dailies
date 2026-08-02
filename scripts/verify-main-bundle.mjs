import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MANAGED_ROUTE_MARKER = "/api/llm";

function requiredPair(env, first, second) {
  const firstValue = env[first]?.trim() ?? "";
  const secondValue = env[second]?.trim() ?? "";
  if (!firstValue || !secondValue) {
    throw new Error(`${first} and ${second} are required for bundle verification`);
  }
  return [firstValue, secondValue];
}

function assertContains(bundle, value, label) {
  if (!bundle.includes(value)) throw new Error(`The main bundle does not contain ${label}`);
}

function assertAbsent(bundle, value, label) {
  if (bundle.includes(value)) throw new Error(`The main bundle contains ${label}`);
}

export function verifyMainBundle(bundle, flavor, env) {
  const [telemetryUrl, telemetryToken] = requiredPair(
    env,
    "DAILIES_TELEMETRY_URL",
    "DAILIES_TELEMETRY_TOKEN",
  );
  assertContains(bundle, telemetryUrl, "the configured telemetry URL");
  assertContains(bundle, telemetryToken, "the configured telemetry token");
  assertAbsent(bundle, "$DAILIES_", "an unexpanded environment variable");
  assertAbsent(bundle, "__DAILIES_", "an unreplaced build constant");

  if (flavor === "stable") {
    assertAbsent(bundle, MANAGED_ROUTE_MARKER, "a managed LLM route");
    return;
  }
  if (flavor !== "managed") throw new Error("Bundle flavor must be stable or managed");

  const [managedUrl, managedToken] = requiredPair(
    env,
    "DAILIES_MANAGED_LLM_URL",
    "DAILIES_MANAGED_LLM_TOKEN",
  );
  assertContains(bundle, managedUrl, "the configured managed LLM URL");
  assertContains(bundle, managedToken, "the configured managed LLM token");
}

async function main() {
  const [flavor, bundlePath = "dist-electron/main/index.cjs"] = process.argv.slice(2);
  const bundle = await readFile(bundlePath, "utf8");
  verifyMainBundle(bundle, flavor, process.env);
  console.log(`Verified ${flavor} main bundle`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
