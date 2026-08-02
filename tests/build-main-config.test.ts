import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/build-main.mjs");
const telemetry = {
  DAILIES_TELEMETRY_URL: "https://telemetry.example/api/ingest",
  DAILIES_TELEMETRY_TOKEN: "telemetry-token",
};

function validate(
  flavor: "auto" | "stable" | "managed",
  overrides: Record<string, string | undefined>,
) {
  const env = {
    ...process.env,
    DAILIES_TELEMETRY_URL: undefined,
    DAILIES_TELEMETRY_TOKEN: undefined,
    DAILIES_MANAGED_LLM_URL: undefined,
    DAILIES_MANAGED_LLM_TOKEN: undefined,
    ...overrides,
  };
  return spawnSync(
    process.execPath,
    [script, "--flavor", flavor, "--validate-only"],
    { env, encoding: "utf8" },
  );
}

describe("main build configuration", () => {
  it("accepts a credential-free stable release with telemetry", () => {
    expect(validate("stable", telemetry).status).toBe(0);
  });

  it("rejects managed credentials in a stable release without printing them", () => {
    const token = "private-managed-token";
    const result = validate("stable", {
      ...telemetry,
      DAILIES_MANAGED_LLM_URL: "https://proxy.example/api/llm",
      DAILIES_MANAGED_LLM_TOKEN: token,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Stable builds must not contain managed LLM credentials");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  });

  it("requires both managed values for a managed build", () => {
    const incomplete = validate("managed", {
      ...telemetry,
      DAILIES_MANAGED_LLM_URL: "https://proxy.example/api/llm",
    });
    const complete = validate("managed", {
      ...telemetry,
      DAILIES_MANAGED_LLM_URL: "https://proxy.example/api/llm",
      DAILIES_MANAGED_LLM_TOKEN: "managed-token",
    });

    expect(incomplete.status).not.toBe(0);
    expect(complete.status).toBe(0);
  });

  it("keeps development builds credential-free when no pairs are set", () => {
    expect(validate("auto", {}).status).toBe(0);
  });
});
