import { describe, expect, it } from "vitest";

import { downloadedUpdatePhase, updaterStrategy } from "../src/main/updater-strategy";

describe("updater strategy", () => {
  it("waits for native staging on macOS", () => {
    const strategy = updaterStrategy("darwin");
    expect(strategy).toEqual({ kind: "macos", downloadedPhase: "staging" });
    if (strategy) expect(downloadedUpdatePhase(strategy)).toBe("staging");
  });

  it("is ready after NSIS download validation on Windows", () => {
    const strategy = updaterStrategy("win32");
    expect(strategy).toEqual({
      kind: "windows",
      downloadedPhase: "ready",
    });
    if (strategy) expect(downloadedUpdatePhase(strategy)).toBe("ready");
  });

  it("disables updates on unsupported packages", () => {
    expect(updaterStrategy("linux")).toBeNull();
  });
});
