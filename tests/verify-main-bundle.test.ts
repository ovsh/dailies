import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/verify-main-bundle.mjs");
const TELEMETRY_URL = "https://telemetry.example/api/ingest";
const TELEMETRY_TOKEN = "private-telemetry-token";
const MANAGED_URL = "https://proxy.example/api/llm";
const MANAGED_TOKEN = "private-managed-token";

function verify(
  flavor: "stable" | "managed",
  bundle: string,
  overrides: Record<string, string | undefined> = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-bundle-check-"));
  const bundlePath = path.join(dir, "index.cjs");
  writeFileSync(bundlePath, bundle);
  return spawnSync(process.execPath, [script, flavor, bundlePath], {
    env: {
      ...process.env,
      DAILIES_TELEMETRY_URL: TELEMETRY_URL,
      DAILIES_TELEMETRY_TOKEN: TELEMETRY_TOKEN,
      DAILIES_MANAGED_LLM_URL: undefined,
      DAILIES_MANAGED_LLM_TOKEN: undefined,
      ...overrides,
    },
    encoding: "utf8",
  });
}

describe("main bundle verification", () => {
  it("accepts a stable bundle with telemetry and no managed route", () => {
    const result = verify("stable", `${TELEMETRY_URL} ${TELEMETRY_TOKEN}`);
    expect(result.status).toBe(0);
  });

  it("rejects a stable bundle with managed access without printing credentials", () => {
    const result = verify(
      "stable",
      `${TELEMETRY_URL} ${TELEMETRY_TOKEN} ${MANAGED_URL} ${MANAGED_TOKEN}`,
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MANAGED_TOKEN);
  });

  it("accepts a managed bundle only when both configured values are present", () => {
    const result = verify(
      "managed",
      `${TELEMETRY_URL} ${TELEMETRY_TOKEN} ${MANAGED_URL} ${MANAGED_TOKEN}`,
      {
        DAILIES_MANAGED_LLM_URL: MANAGED_URL,
        DAILIES_MANAGED_LLM_TOKEN: MANAGED_TOKEN,
      },
    );
    expect(result.status).toBe(0);
  });

  it("rejects shell variables that were not expanded", () => {
    const result = verify(
      "stable",
      `${TELEMETRY_URL} ${TELEMETRY_TOKEN} $DAILIES_TELEMETRY_URL`,
    );
    expect(result.status).not.toBe(0);
  });
});
