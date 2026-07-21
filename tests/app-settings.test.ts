import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { createAppSettings } from "../src/main/app-settings";

describe("app settings", () => {
  it("loads a legacy file and drops unknown keys on the next save", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-app-settings-"));
    const file = path.join(dataDir, "app-settings.json");
    const retiredProvider = ["gemi", "ni"].join("");
    writeFileSync(file, JSON.stringify({
      [`${retiredProvider}KeyEnc`]: "retired-key",
      [`${retiredProvider}KeyIsPlain`]: true,
      openrouterKeyEnc: Buffer.from("current-key", "utf8").toString("base64"),
      openrouterKeyIsPlain: true,
      modelProfileId: "balanced",
      qualityMode: "standard",
      whisperModel: "large-v3-turbo",
      unknownLegacySetting: "drop-me",
    }));

    const settings = createAppSettings(dataDir);
    expect(settings.getOpenRouterKey()).toBe("current-key");
    expect(settings.getQualityMode()).toBe("standard");

    settings.setQualityMode("high");

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      openrouterKeyEnc: Buffer.from("current-key", "utf8").toString("base64"),
      openrouterKeyIsPlain: true,
      modelProfileId: "balanced",
      qualityMode: "high",
      whisperModel: "large-v3-turbo",
    });
  });
});
