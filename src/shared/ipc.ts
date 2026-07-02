/**
 * The typed API exposed to the renderer via contextBridge as `window.dailies`.
 * The renderer must never assume it exists (browser preview uses a mock).
 */
import type {
  AppSettings,
  ChatEvent,
  ChatMessageRecord,
  ChatSummary,
  ExportItem,
  ExportKind,
  ExportResult,
  FileDetail,
  Job,
  MediaFile,
  MediaRole,
  QualityMode,
  WordTiming,
} from "./types";

export interface DailiesAPI {
  // library
  listFiles(): Promise<MediaFile[]>;
  getFileDetail(fileId: number): Promise<FileDetail>;
  getWords(segmentId: number): Promise<WordTiming[]>;

  // jobs & folders
  listJobs(): Promise<Job[]>;
  /** Opens a native folder picker; returns the chosen path or null. */
  addWatchedFolder(role: MediaRole): Promise<string | null>;
  removeWatchedFolder(path: string): Promise<void>;

  // settings
  getSettings(): Promise<AppSettings>;
  setApiKey(provider: "gemini", key: string): Promise<boolean>;
  setQualityMode(mode: QualityMode): Promise<void>;

  // chat
  listChats(): Promise<ChatSummary[]>;
  getChat(chatId: number): Promise<ChatMessageRecord[]>;
  /** Starts a chat turn. Progress and the answer arrive via onChatEvent. */
  sendChatMessage(chatId: number | null, text: string): Promise<{ chatId: number }>;
  onChatEvent(cb: (ev: ChatEvent) => void): () => void;

  // export
  exportHits(kind: ExportKind, items: ExportItem[]): Promise<ExportResult>;
  revealInFinder(path: string): Promise<void>;

  /** Converts an absolute local path into a URL the renderer may load (media:// protocol). */
  fileUrl(path: string): string;
}

export const IPC = {
  listFiles: "dailies:listFiles",
  getFileDetail: "dailies:getFileDetail",
  getWords: "dailies:getWords",
  listJobs: "dailies:listJobs",
  addWatchedFolder: "dailies:addWatchedFolder",
  removeWatchedFolder: "dailies:removeWatchedFolder",
  getSettings: "dailies:getSettings",
  setApiKey: "dailies:setApiKey",
  setQualityMode: "dailies:setQualityMode",
  listChats: "dailies:listChats",
  getChat: "dailies:getChat",
  sendChatMessage: "dailies:sendChatMessage",
  chatEvent: "dailies:chatEvent",
  exportHits: "dailies:exportHits",
  revealInFinder: "dailies:revealInFinder",
} as const;
