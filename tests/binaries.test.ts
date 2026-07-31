import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findWhisperBinary, whisperRuntimeTarget } from "../src/main/pipeline/binaries";

const originalOverride = process.env["DAILIES_WHISPER_BIN"];

afterEach(() => {
  if (originalOverride === undefined) delete process.env["DAILIES_WHISPER_BIN"];
  else process.env["DAILIES_WHISPER_BIN"] = originalOverride;
});

describe("binary resolution under ESM", () => {
  it("degrades gracefully when __dirname is unavailable", () => {
    expect(() => findWhisperBinary()).not.toThrow();
  });

  it("uses the Windows executable name and PATH lookup command", () => {
    expect(whisperRuntimeTarget("win32")).toEqual({
      kind: "windows",
      executable: "whisper-cli.exe",
      pathCommand: "where.exe",
    });
  });

  it("keeps the macOS executable name and PATH lookup command", () => {
    expect(whisperRuntimeTarget("darwin")).toEqual({
      kind: "macos",
      executable: "whisper-cli",
      pathCommand: "which",
    });
  });

  it("accepts an explicit Windows executable path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dailies-whisper-bin-"));
    const executable = join(dir, "whisper-cli.exe");
    writeFileSync(executable, "test");
    process.env["DAILIES_WHISPER_BIN"] = executable;
    try {
      expect(findWhisperBinary()).toBe(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
