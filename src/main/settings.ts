/**
 * Settings + secret storage. API keys are encrypted with Electron safeStorage
 * (macOS Keychain-backed) and persisted in the settings table as base64.
 */
import { safeStorage } from "electron";
import type { DailiesDB } from "./db/types";
import type { QualityMode } from "../shared/types";

type Provider = "anthropic" | "gemini";

const keyName = (p: Provider) => `apiKey.${p}.enc`;

export function setApiKey(db: DailiesDB, provider: Provider, key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const enc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed).toString("base64")
    : Buffer.from(trimmed, "utf8").toString("base64");
  db.setSetting(keyName(provider), enc);
  db.setSetting(`apiKey.${provider}.plain`, safeStorage.isEncryptionAvailable() ? "0" : "1");
  return true;
}

export function getApiKey(db: DailiesDB, provider: Provider): string | null {
  const enc = db.getSetting(keyName(provider));
  if (!enc) return null;
  const isPlain = db.getSetting(`apiKey.${provider}.plain`) === "1";
  try {
    const buf = Buffer.from(enc, "base64");
    return isPlain ? buf.toString("utf8") : safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export function hasApiKey(db: DailiesDB, provider: Provider): boolean {
  return getApiKey(db, provider) !== null;
}

export function getWatchedFolders(db: DailiesDB): string[] {
  const raw = db.getSetting("watchedFolders");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setWatchedFolders(db: DailiesDB, folders: string[]): void {
  db.setSetting("watchedFolders", JSON.stringify([...new Set(folders)]));
}

export function getQualityMode(db: DailiesDB): QualityMode {
  return db.getSetting("qualityMode") === "high" ? "high" : "standard";
}

export function setQualityMode(db: DailiesDB, mode: QualityMode): void {
  db.setSetting("qualityMode", mode);
}

export function getWhisperModel(db: DailiesDB): string {
  return db.getSetting("whisperModel") ?? "large-v3-turbo";
}
