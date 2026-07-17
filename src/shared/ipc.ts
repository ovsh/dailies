/**
 * The typed API exposed to the renderer via contextBridge as `window.dailies`.
 * The renderer must never assume it exists (browser preview uses a mock).
 *
 * Project-scoped calls (files, chat, folders, episodes, export) operate on the
 * currently open project and reject when none is open.
 */
import type {
  AppSettings,
  ChatEvent,
  ChatMessageRecord,
  ChatSummary,
  Episode,
  ExportItem,
  ExportKind,
  ExportResult,
  FileDetail,
  IndexUpdate,
  Job,
  MediaFile,
  ModelDownloadProgress,
  MediaRole,
  Project,
  ProjectFolder,
  ProjectState,
  QualityMode,
  ApiKeyValidationStatus,
  WordTiming,
} from "./types";

export interface DailiesAPI {
  // projects
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  openProject(id: string): Promise<ProjectState>;
  /** null when no project is open (first run before any project exists). */
  getProjectState(): Promise<ProjectState | null>;

  // episodes & folders (current project)
  createEpisode(code: string): Promise<Episode>;
  /** Opens a native folder picker; returns the new folder or null if cancelled. */
  addProjectFolder(
    role: MediaRole,
    episodeId: number | null,
    /** Accepted only when it exactly matches DAILIES_E2E_FOLDER. */
    e2eFolderPath?: string,
  ): Promise<ProjectFolder | null>;
  removeProjectFolder(folderId: number): Promise<void>;
  clearProjectCache(): Promise<{ clearedFiles: number }>;
  /** Re-scans watched folders (all, or one episode's) and stamps lastScannedAt. */
  rescanFolders(episodeId: number | null): Promise<void>;
  /** Opens a multi-file picker for notes/docs/spreadsheets; returns count ingested. */
  importDocuments(episodeId: number | null): Promise<number>;

  // library (current project)
  listFiles(episodeId?: number): Promise<MediaFile[]>;
  getFileDetail(fileId: number): Promise<FileDetail>;
  getWords(segmentId: number): Promise<WordTiming[]>;
  listJobs(): Promise<Job[]>;

  // settings (global)
  getSettings(): Promise<AppSettings>;
  /** Starts (or joins) the speech-model download; progress arrives via onModelProgress. */
  downloadWhisperModel(): Promise<void>;
  onModelProgress(cb: (p: ModelDownloadProgress) => void): () => void;
  setApiKey(provider: "gemini", key: string): Promise<ApiKeyValidationStatus>;
  setQualityMode(mode: QualityMode): Promise<void>;

  // chat (current project; episodeId scopes the search, null = whole project)
  listChats(): Promise<ChatSummary[]>;
  getChat(chatId: number): Promise<ChatMessageRecord[]>;
  /** Starts a chat turn. Progress and the answer arrive via onChatEvent. */
  sendChatMessage(
    chatId: number | null,
    text: string,
    episodeId: number | null,
    turnId: string,
  ): Promise<{ chatId: number }>;
  onChatEvent(cb: (ev: ChatEvent) => void): () => void;

  // export (current project)
  exportHits(kind: ExportKind, items: ExportItem[]): Promise<ExportResult>;
  revealInFinder(path: string): Promise<void>;

  /** Fired when project state changes in the main process (indexing, scans). */
  onProjectUpdate(cb: () => void): () => void;

  /** Fired after coalesced file/job state changes. */
  onIndexUpdate(cb: (update: IndexUpdate) => void): () => void;

  /** Converts an absolute local path into a URL the renderer may load (media:// protocol). */
  fileUrl(path: string): string;
}

export const IPC = {
  listProjects: "dailies:listProjects",
  createProject: "dailies:createProject",
  openProject: "dailies:openProject",
  getProjectState: "dailies:getProjectState",
  createEpisode: "dailies:createEpisode",
  addProjectFolder: "dailies:addProjectFolder",
  removeProjectFolder: "dailies:removeProjectFolder",
  clearProjectCache: "dailies:clearProjectCache",
  rescanFolders: "dailies:rescanFolders",
  importDocuments: "dailies:importDocuments",
  listFiles: "dailies:listFiles",
  getFileDetail: "dailies:getFileDetail",
  getWords: "dailies:getWords",
  listJobs: "dailies:listJobs",
  getSettings: "dailies:getSettings",
  downloadWhisperModel: "dailies:downloadWhisperModel",
  modelProgress: "dailies:modelProgress",
  setApiKey: "dailies:setApiKey",
  setQualityMode: "dailies:setQualityMode",
  listChats: "dailies:listChats",
  getChat: "dailies:getChat",
  sendChatMessage: "dailies:sendChatMessage",
  chatEvent: "dailies:chatEvent",
  exportHits: "dailies:exportHits",
  revealInFinder: "dailies:revealInFinder",
  projectUpdate: "dailies:projectUpdate",
  indexUpdate: "dailies:indexUpdate",
} as const;
