import { describe, expect, it } from "vitest";
import { updaterStatesEqual } from "../src/shared/updater-state";
import type { UpdaterState } from "../src/shared/types";

const ready: UpdaterState = {
  phase: "ready",
  currentVersion: "0.4.3",
  availableVersion: "0.5.0",
};

describe("updaterStatesEqual", () => {
  it("treats a re-emitted identical state as equal (repeated update-downloaded pushes)", () => {
    // The main process sends a fresh object on every event; reference
    // inequality must not count as a change.
    expect(updaterStatesEqual(ready, { ...ready })).toBe(true);
  });

  it("detects a phase change", () => {
    expect(updaterStatesEqual(ready, { ...ready, phase: "staging" })).toBe(false);
  });

  it("detects an availableVersion change", () => {
    expect(updaterStatesEqual(ready, { ...ready, availableVersion: "0.5.1" })).toBe(false);
  });

  it("detects download progress ticks", () => {
    const a: UpdaterState = { phase: "downloading", currentVersion: "0.4.3", transferred: 10, total: 100 };
    expect(updaterStatesEqual(a, { ...a, transferred: 20 })).toBe(false);
    expect(updaterStatesEqual(a, { ...a })).toBe(true);
  });

  it("distinguishes undefined from set optional fields", () => {
    expect(updaterStatesEqual(ready, { ...ready, lastCheckedAt: 123 })).toBe(false);
    expect(updaterStatesEqual(ready, { ...ready, errorMessage: "x", errorKind: "unknown" })).toBe(false);
  });
});
