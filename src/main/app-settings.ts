/**
 * Global (cross-project) settings: the Gemini key, quality mode, whisper model.
 * Stored as JSON in userData; the API key is encrypted with safeStorage
 * (macOS Keychain-backed). Replaces the old per-database settings for these.
 */
import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { QualityMode } from "../shared/types";

interface AppSettingsFile {
  geminiKeyEnc?: string;
  geminiKeyIsPlain?: boolean;
  qualityMode?: QualityMode;
  whisperModel?: string;
}

export interface AppSettingsStore {
  getApiKey(): string | null;
  setApiKey(key: string): boolean;
  hasApiKey(): boolean;
  getQualityMode(): QualityMode;
  setQualityMode(mode: QualityMode): void;
  getWhisperModel(): string;
  /** One-time import from a legacy per-project settings value (encrypted base64). */
  adoptLegacyKey(enc: string, isPlain: boolean): void;
}

export function createAppSettings(dataDir: string): AppSettingsStore {
  const file = path.join(dataDir, "app-settings.json");

  function read(): AppSettingsFile {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as AppSettingsFile;
    } catch {
      return {};
    }
  }

  function write(update: Partial<AppSettingsFile>): void {
    const next = { ...read(), ...update };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  }

  function decrypt(enc: string, isPlain: boolean): string | null {
    try {
      const buf = Buffer.from(enc, "base64");
      return isPlain ? buf.toString("utf8") : safeStorage.decryptString(buf);
    } catch {
      return null;
    }
  }

  return {
    getApiKey() {
      const s = read();
      if (!s.geminiKeyEnc) return null;
      return decrypt(s.geminiKeyEnc, s.geminiKeyIsPlain === true);
    },
    setApiKey(key: string) {
      const trimmed = key.trim();
      if (!trimmed) return false;
      const canEncrypt = safeStorage.isEncryptionAvailable();
      const enc = canEncrypt
        ? safeStorage.encryptString(trimmed).toString("base64")
        : Buffer.from(trimmed, "utf8").toString("base64");
      write({ geminiKeyEnc: enc, geminiKeyIsPlain: !canEncrypt });
      return true;
    },
    hasApiKey() {
      return this.getApiKey() !== null;
    },
    getQualityMode() {
      return read().qualityMode === "high" ? "high" : "standard";
    },
    setQualityMode(mode: QualityMode) {
      write({ qualityMode: mode });
    },
    getWhisperModel() {
      return read().whisperModel ?? "large-v3-turbo";
    },
    adoptLegacyKey(enc: string, isPlain: boolean) {
      if (read().geminiKeyEnc) return;
      write({ geminiKeyEnc: enc, geminiKeyIsPlain: isPlain });
    },
  };
}
