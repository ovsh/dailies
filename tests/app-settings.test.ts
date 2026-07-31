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
import { chatModelSelection, DEFAULT_CHAT_MODEL_ID } from "../src/shared/types";

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

    settings.setOpenRouterKey("current-key");

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      openrouterKeyEnc: Buffer.from("current-key", "utf8").toString("base64"),
      openrouterKeyIsPlain: true,
      whisperModel: "large-v3-turbo",
    });
  });

  it("stores chat model and effort separately", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-app-settings-"));
    const settings = createAppSettings(dataDir);

    expect(settings.getChatModelId()).toBeNull();
    expect(settings.getChatEffort()).toBeNull();

    settings.setChatModelId("x-ai/grok-4.5");
    settings.setChatEffort("medium");
    expect(settings.getChatModelId()).toBe("x-ai/grok-4.5");
    expect(settings.getChatEffort()).toBe("medium");

    // Round-trips through the file.
    const reloaded = createAppSettings(dataDir);
    expect(reloaded.getChatModelId()).toBe("x-ai/grok-4.5");
    expect(reloaded.getChatEffort()).toBe("medium");
  });

  it("resolves legacy files (combined preset id, no effort) to the preset's old effort", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-app-settings-"));
    const file = path.join(dataDir, "app-settings.json");
    // Old builds stored only the preset id; effort was baked into the preset.
    writeFileSync(file, JSON.stringify({ chatModelId: "openai/gpt-5.6-sol" }));

    const settings = createAppSettings(dataDir);
    const selection = chatModelSelection(settings.getChatModelId(), settings.getChatEffort());
    expect(selection.option.id).toBe("openai/gpt-5.6-sol");
    expect(selection.effort).toBe("medium"); // the old "GPT-5.6 Sol · Medium" preset
  });

  it("defaults new installs to DeepSeek V4 Flash at high effort", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-app-settings-"));
    const settings = createAppSettings(dataDir);
    const selection = chatModelSelection(settings.getChatModelId(), settings.getChatEffort());
    expect(selection.option.id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(selection.option.id).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(selection.effort).toBe("high");
  });

  it("clamps an effort the selected model does not support", () => {
    // Gemini Flash takes no reasoning parameter at all.
    expect(chatModelSelection("google/gemini-3.6-flash", "max").effort).toBeNull();
    // Grok caps out at high; a stored gpt-5.6 "max" falls back to Grok's default.
    expect(chatModelSelection("x-ai/grok-4.5", "max").effort).toBe("high");
    // A supported stored effort is kept.
    expect(chatModelSelection("x-ai/grok-4.5", "low").effort).toBe("low");
    // An unknown model id falls back to the default selection.
    expect(chatModelSelection("nonexistent/model", null).option.id).toBe(DEFAULT_CHAT_MODEL_ID);
  });
});
