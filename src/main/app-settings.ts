/**
 * Global (cross-project) settings: OpenRouter key, model profile, quality mode,
 * and whisper model.
 * Stored as JSON in userData; the API key is encrypted with safeStorage
 * (macOS Keychain-backed). Replaces the old per-database settings for these.
 */
import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { QualityMode } from "../shared/types";
import { DEFAULT_MODEL_PROFILE_ID, MODEL_PROFILES } from "../shared/types";

interface AppSettingsFile {
  /** Retained only so older settings files round-trip without losing fields. */
  geminiKeyEnc?: string;
  geminiKeyIsPlain?: boolean;
  openrouterKeyEnc?: string;
  openrouterKeyIsPlain?: boolean;
  modelProfileId?: string;
  qualityMode?: QualityMode;
  whisperModel?: string;
}

export interface AppSettingsStore {
  getOpenRouterKey(): string | null;
  setOpenRouterKey(key: string): boolean;
  hasOpenRouterKey(): boolean;
  getModelProfileId(): string;
  setModelProfileId(id: string): void;
  getQualityMode(): QualityMode;
  setQualityMode(mode: QualityMode): void;
  getWhisperModel(): string;
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
    getOpenRouterKey() {
      const s = read();
      if (!s.openrouterKeyEnc) return null;
      return decrypt(s.openrouterKeyEnc, s.openrouterKeyIsPlain === true);
    },
    setOpenRouterKey(key: string) {
      const trimmed = key.trim();
      if (!trimmed) return false;
      const canEncrypt = safeStorage.isEncryptionAvailable();
      const enc = canEncrypt
        ? safeStorage.encryptString(trimmed).toString("base64")
        : Buffer.from(trimmed, "utf8").toString("base64");
      write({ openrouterKeyEnc: enc, openrouterKeyIsPlain: !canEncrypt });
      return true;
    },
    hasOpenRouterKey() {
      return this.getOpenRouterKey() !== null;
    },
    getModelProfileId() {
      const id = read().modelProfileId;
      return MODEL_PROFILES.some((profile) => profile.id === id) ? id! : DEFAULT_MODEL_PROFILE_ID;
    },
    setModelProfileId(id: string) {
      if (!MODEL_PROFILES.some((profile) => profile.id === id)) {
        throw new Error(`Unknown model profile: ${id}`);
      }
      write({ modelProfileId: id });
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
  };
}
