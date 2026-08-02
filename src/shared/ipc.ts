/**
 * The typed API exposed to the renderer via contextBridge as `window.dailies`.
 * The renderer must never assume it exists (browser preview uses a mock).
 *
 * Project-scoped calls (files, chat, folders, episodes, export) operate on the
 * currently open project and reject when none is open.
 */
import type {
  AppSettings,
  ChatEffort,
  ChatScope,
  ChatEvent,
  ChatMessageRecord,
  ChatSummary,
  ClipListInput,
  Episode,
  EpisodeMembershipReport,
  EpisodeProposal,
  ExportItem,
  ExportKind,
  DiagnosticsExportOutcome,
  ExportWriteOutcome,
  FileDetail,
  IndexUpdate,
  Job,
  MediaFile,
  ModelDownloadProgress,
  MediaRole,
  MembershipSource,
  LocatorExportOutcome,
  PipelineProgress,
  PipelineSnapshot,
  ProjectActivity,
  Project,
  ProjectFolder,
  ProjectState,
  ApiKeyValidationStatus,
  UpdaterState,
  WordTiming,
} from "./types";

export interface ClipListImportDiagnostic {
  sourceName: string;
  line: number;
  message: string;
}

export interface ClipListImportBlocked {
  kind: "blocked";
  diagnostics: ClipListImportDiagnostic[];
}

export interface DailiesAPI {
  /** Host platform, exposed once so renderer chrome can match the native window. */
  readonly platform: NodeJS.Platform;

  // projects
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  openProject(id: string): Promise<ProjectState>;
  /** null when no project is open (first run before any project exists). */
  getProjectState(): Promise<ProjectState | null>;

  // episodes & folders (current project)
  createEpisode(code: string): Promise<Episode>;
  getEpisodeMembership(episodeId: number): Promise<EpisodeMembershipReport>;
  setEpisodeMembershipSource(
    episodeId: number,
    source: MembershipSource,
  ): Promise<EpisodeMembershipReport>;
  replaceEpisodeClipList(
    episodeId: number,
    input: ClipListInput,
  ): Promise<EpisodeMembershipReport | ClipListImportBlocked>;
  /**
   * Starts episode detection from Avid media tags: queues a tag read for any
   * clip that never had one, then returns what the stored tags say so far.
   * Reading tags is background work, so call getEpisodeProposal again while
   * pendingClipCount is above zero.
   */
  detectEpisodesFromMedia(): Promise<EpisodeProposal>;
  /** The current proposal without queueing anything. */
  getEpisodeProposal(): Promise<EpisodeProposal>;
  /** Creates one media-tag episode per accepted row. */
  applyEpisodeProposal(
    rows: Array<{ code: string; sourceProject: string }>,
  ): Promise<Episode[]>;
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
  setTelemetryEnabled(enabled: boolean): Promise<AppSettings>;
  /** Trimmed and capped in main; an empty string clears the name. */
  setOperatorName(name: string): Promise<AppSettings>;
  /**
   * Selects the chat model (id must be one of CHAT_MODEL_OPTIONS) and,
   * optionally, its reasoning effort (must be supported by that model).
   * When effort is omitted the stored effort is kept and resolved against
   * the new model (unsupported values fall back to the model's default).
   */
  setChatModel(modelId: string, effort?: ChatEffort): Promise<AppSettings>;
  /** Zips dailies.log, the failure list, versions, and the pipeline snapshot into Dailies Exports. */
  exportDiagnostics(): Promise<DiagnosticsExportOutcome>;
  /** Starts (or joins) the speech-model download; progress arrives via onModelProgress. */
  downloadWhisperModel(): Promise<void>;
  onModelProgress(cb: (p: ModelDownloadProgress) => void): () => void;
  setApiKey(provider: "openrouter", key: string): Promise<ApiKeyValidationStatus>;

  // chat (current project; episodeId scopes the search, null = whole project)
  listChats(): Promise<ChatSummary[]>;
  listChats(scope: ChatScope): Promise<ChatSummary[]>;
  getChat(chatId: number): Promise<ChatMessageRecord[]>;
  getChat(scope: ChatScope, chatId: number): Promise<ChatMessageRecord[]>;
  /** Starts a chat turn. Progress and the answer arrive via onChatEvent. */
  sendChatMessage(
    chatId: number | null,
    text: string,
    episodeId: number | null,
    turnId: string,
  ): Promise<{ chatId: number }>;
  onChatEvent(cb: (ev: ChatEvent) => void): () => void;

  // export (current project)
  exportHits(kind: ExportKind, items: ExportItem[]): Promise<ExportWriteOutcome>;
  getPipelineSnapshot(scope: ChatScope): Promise<PipelineSnapshot>;
  /** Cheap per-tick status for the indexing panel; no failure reasons or id lists. */
  getPipelineProgress(scope: ChatScope): Promise<PipelineProgress>;
  getProjectActivities(): Promise<ProjectActivity[]>;
  retryPipelineFailures(fileIds: number[]): Promise<PipelineSnapshot>;
  exportPipelineFailures(scope: ChatScope): Promise<
    | { kind: "written"; path: string; count: number }
    | { kind: "blocked"; reason: "no-failures" }
  >;
  exportLocators(scope: ChatScope, items: ExportItem[]): Promise<LocatorExportOutcome>;
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
  getEpisodeMembership: "dailies:getEpisodeMembership",
  setEpisodeMembershipSource: "dailies:setEpisodeMembershipSource",
  replaceEpisodeClipList: "dailies:replaceEpisodeClipList",
  detectEpisodesFromMedia: "dailies:detectEpisodesFromMedia",
  getEpisodeProposal: "dailies:getEpisodeProposal",
  applyEpisodeProposal: "dailies:applyEpisodeProposal",
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
  setTelemetryEnabled: "dailies:setTelemetryEnabled",
  setOperatorName: "dailies:setOperatorName",
  setChatModel: "dailies:setChatModel",
  exportDiagnostics: "dailies:exportDiagnostics",
  downloadWhisperModel: "dailies:downloadWhisperModel",
  modelProgress: "dailies:modelProgress",
  setApiKey: "dailies:setApiKey",
  listChats: "dailies:listChats",
  getChat: "dailies:getChat",
  sendChatMessage: "dailies:sendChatMessage",
  chatEvent: "dailies:chatEvent",
  exportHits: "dailies:exportHits",
  getPipelineSnapshot: "dailies:getPipelineSnapshot",
  getPipelineProgress: "dailies:getPipelineProgress",
  getProjectActivities: "dailies:getProjectActivities",
  retryPipelineFailures: "dailies:retryPipelineFailures",
  exportPipelineFailures: "dailies:exportPipelineFailures",
  exportLocators: "dailies:exportLocators",
  revealInFinder: "dailies:revealInFinder",
  openExternal: "dailies:openExternal",
  projectUpdate: "dailies:projectUpdate",
  indexUpdate: "dailies:indexUpdate",
  getUpdateState: "dailies:getUpdateState",
  checkForUpdates: "dailies:checkForUpdates",
  restartToUpdate: "dailies:restartToUpdate",
  updateStateChanged: "dailies:updateStateChanged",
} as const;
