/**
 * Global (cross-project) settings: OpenRouter key and whisper model.
 * Stored as JSON in userData. Electron safeStorage uses Keychain on macOS and
 * DPAPI on Windows. Replaces the old per-database settings for these.
 */
import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface AppSettingsFile {
  openrouterKeyEnc?: string;
  openrouterKeyIsPlain?: boolean;
  whisperModel?: string;
  chatModelId?: string;
  chatEffort?: string;
  telemetryEnabled?: boolean;
  telemetryInstallId?: string;
}

function parseAppSettings(value: unknown): AppSettingsFile {
  if (typeof value !== "object" || value === null) return {};

  const settings: AppSettingsFile = {};
  if ("openrouterKeyEnc" in value && typeof value.openrouterKeyEnc === "string") {
    settings.openrouterKeyEnc = value.openrouterKeyEnc;
  }
  if ("openrouterKeyIsPlain" in value && typeof value.openrouterKeyIsPlain === "boolean") {
    settings.openrouterKeyIsPlain = value.openrouterKeyIsPlain;
  }
  if ("whisperModel" in value && typeof value.whisperModel === "string") {
    settings.whisperModel = value.whisperModel;
  }
  if ("chatModelId" in value && typeof value.chatModelId === "string") {
    settings.chatModelId = value.chatModelId;
  }
  if ("chatEffort" in value && typeof value.chatEffort === "string") {
    settings.chatEffort = value.chatEffort;
  }
  if ("telemetryEnabled" in value && typeof value.telemetryEnabled === "boolean") {
    settings.telemetryEnabled = value.telemetryEnabled;
  }
  if ("telemetryInstallId" in value && typeof value.telemetryInstallId === "string") {
    settings.telemetryInstallId = value.telemetryInstallId;
  }
  return settings;
}

export interface AppSettingsStore {
  getOpenRouterKey(): string | null;
  setOpenRouterKey(key: string): boolean;
  hasOpenRouterKey(): boolean;
  getWhisperModel(): string;
  /** Raw stored id; callers resolve/validate against CHAT_MODEL_OPTIONS. */
  getChatModelId(): string | null;
  setChatModelId(id: string): void;
  /**
   * Raw stored reasoning effort; callers resolve/validate against the selected
   * model's supported efforts. Null on legacy installs that stored only the
   * combined model preset — resolution falls back to the model's default effort.
   */
  getChatEffort(): string | null;
  setChatEffort(effort: string): void;
  getTelemetryEnabled(): boolean;
  setTelemetryEnabled(enabled: boolean): void;
  /** Stable anonymous install id, created on first read. */
  getTelemetryInstallId(): string;
}

export function createAppSettings(dataDir: string): AppSettingsStore {
  const file = path.join(dataDir, "app-settings.json");

  function read(): AppSettingsFile {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return parseAppSettings(parsed);
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
    getWhisperModel() {
      // q8_0: same model quantized to 8 bits — ~30-60% faster, half the
      // download (870MB vs 1.6GB), WER loss under measurement noise.
      return read().whisperModel ?? "large-v3-turbo-q8_0";
    },
    getChatModelId() {
      return read().chatModelId ?? null;
    },
    setChatModelId(id: string) {
      write({ chatModelId: id });
    },
    getChatEffort() {
      return read().chatEffort ?? null;
    },
    setChatEffort(effort: string) {
      write({ chatEffort: effort });
    },
    getTelemetryEnabled() {
      return read().telemetryEnabled ?? true;
    },
    setTelemetryEnabled(enabled: boolean) {
      write({ telemetryEnabled: enabled });
    },
    getTelemetryInstallId() {
      const s = read();
      if (s.telemetryInstallId) return s.telemetryInstallId;
      const id = randomUUID();
      write({ telemetryInstallId: id });
      return id;
    },
  };
}
