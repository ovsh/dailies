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
  ApiKeyValidationStatus,
  UpdaterState,
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
  retryFile(fileId: number): Promise<void>;

  // settings (global)
  getSettings(): Promise<AppSettings>;
  /** Starts (or joins) the speech-model download; progress arrives via onModelProgress. */
  downloadWhisperModel(): Promise<void>;
  onModelProgress(cb: (p: ModelDownloadProgress) => void): () => void;
  setApiKey(provider: "openrouter", key: string): Promise<ApiKeyValidationStatus>;

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
  /** Opens an https:// URL in the system browser (e.g. the OpenRouter key page). */
  openExternal(url: string): Promise<void>;

  /** Fired when project state changes in the main process (indexing, scans). */
  onProjectUpdate(cb: () => void): () => void;

  /** Fired after coalesced file/job state changes. */
  onIndexUpdate(cb: (update: IndexUpdate) => void): () => void;

  /** Converts an absolute local path into a URL the renderer may load (media:// protocol). */
  fileUrl(path: string): string;

  // software update (main owns the feed; renderer only expresses intent)
  /** Works in dev too: {phase:"idle", currentVersion} when the updater is disabled. */
  getUpdateState(): Promise<UpdaterState>;
  /** Manual check. No-op when the updater is disabled. */
  checkForUpdates(): Promise<void>;
  /** Quits and installs the downloaded update. Only meaningful from phase "ready". */
  restartToUpdate(): Promise<void>;
  onUpdateStateChanged(cb: (state: UpdaterState) => void): () => void;
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
  retryFile: "dailies:retryFile",
  getSettings: "dailies:getSettings",
  downloadWhisperModel: "dailies:downloadWhisperModel",
  modelProgress: "dailies:modelProgress",
  setApiKey: "dailies:setApiKey",
  listChats: "dailies:listChats",
  getChat: "dailies:getChat",
  sendChatMessage: "dailies:sendChatMessage",
  chatEvent: "dailies:chatEvent",
  exportHits: "dailies:exportHits",
  revealInFinder: "dailies:revealInFinder",
  openExternal: "dailies:openExternal",
  projectUpdate: "dailies:projectUpdate",
  indexUpdate: "dailies:indexUpdate",
  getUpdateState: "dailies:getUpdateState",
  checkForUpdates: "dailies:checkForUpdates",
  restartToUpdate: "dailies:restartToUpdate",
  updateStateChanged: "dailies:updateStateChanged",
} as const;
