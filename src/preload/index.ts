import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DailiesAPI } from "../shared/ipc";
import type {
  ChatEvent,
  ChatScope,
  ClipListInput,
  ExportItem,
  ExportKind,
  IndexUpdate,
  MediaRole,
  MembershipSource,
  ModelDownloadProgress,
  UpdaterState,
} from "../shared/types";

const api: DailiesAPI = {
  // projects
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  createProject: (name: string) => ipcRenderer.invoke(IPC.createProject, name),
  openProject: (id: string) => ipcRenderer.invoke(IPC.openProject, id),
  getProjectState: () => ipcRenderer.invoke(IPC.getProjectState),

  // episodes & folders
  createEpisode: (code: string) => ipcRenderer.invoke(IPC.createEpisode, code),
  getEpisodeMembership: (episodeId: number) =>
    ipcRenderer.invoke(IPC.getEpisodeMembership, episodeId),
  setEpisodeMembershipSource: (episodeId: number, source: MembershipSource) =>
    ipcRenderer.invoke(IPC.setEpisodeMembershipSource, episodeId, source),
  replaceEpisodeClipList: (episodeId: number, input: ClipListInput) =>
    ipcRenderer.invoke(IPC.replaceEpisodeClipList, episodeId, input),
  addProjectFolder: (role: MediaRole, episodeId: number | null, e2eFolderPath?: string) =>
    ipcRenderer.invoke(IPC.addProjectFolder, role, episodeId, e2eFolderPath),
  removeProjectFolder: (folderId: number) =>
    ipcRenderer.invoke(IPC.removeProjectFolder, folderId),
  clearProjectCache: () => ipcRenderer.invoke(IPC.clearProjectCache),
  rescanFolders: (episodeId: number | null) => ipcRenderer.invoke(IPC.rescanFolders, episodeId),
  importDocuments: (episodeId: number | null) =>
    ipcRenderer.invoke(IPC.importDocuments, episodeId),

  // library
  listFiles: (episodeId?: number) => ipcRenderer.invoke(IPC.listFiles, episodeId),
  getFileDetail: (fileId: number) => ipcRenderer.invoke(IPC.getFileDetail, fileId),
  getWords: (segmentId: number) => ipcRenderer.invoke(IPC.getWords, segmentId),
  listJobs: () => ipcRenderer.invoke(IPC.listJobs),
  retryFile: (fileId: number) => ipcRenderer.invoke(IPC.retryFile, fileId),

  // settings
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setTelemetryEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.setTelemetryEnabled, enabled),
  setChatModel: (modelId: string) => ipcRenderer.invoke(IPC.setChatModel, modelId),
  exportDiagnostics: () => ipcRenderer.invoke(IPC.exportDiagnostics),
  downloadWhisperModel: () => ipcRenderer.invoke(IPC.downloadWhisperModel),
  onModelProgress: (cb: (p: ModelDownloadProgress) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ModelDownloadProgress) => cb(p);
    ipcRenderer.on(IPC.modelProgress, listener);
    return () => ipcRenderer.removeListener(IPC.modelProgress, listener);
  },
  setApiKey: (provider: "openrouter", key: string) => ipcRenderer.invoke(IPC.setApiKey, provider, key),

  // chat
  listChats: (scope?: ChatScope) => ipcRenderer.invoke(IPC.listChats, scope),
  getChat: (scopeOrChatId: ChatScope | number, maybeChatId?: number) => {
    if (typeof scopeOrChatId === "number") return ipcRenderer.invoke(IPC.getChat, scopeOrChatId);
    if (maybeChatId === undefined) throw new Error("getChat requires a chat id with a scope");
    return ipcRenderer.invoke(IPC.getChat, scopeOrChatId, maybeChatId);
  },
  sendChatMessage: (chatId: number | null, text: string, episodeId: number | null, turnId: string) =>
    ipcRenderer.invoke(IPC.sendChatMessage, chatId, text, episodeId, turnId),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ChatEvent) => cb(ev);
    ipcRenderer.on(IPC.chatEvent, listener);
    return () => ipcRenderer.removeListener(IPC.chatEvent, listener);
  },

  // export
  exportHits: (kind: ExportKind, items: ExportItem[]) =>
    ipcRenderer.invoke(IPC.exportHits, kind, items),
  getPipelineSnapshot: (scope: ChatScope) => ipcRenderer.invoke(IPC.getPipelineSnapshot, scope),
  getProjectActivities: () => ipcRenderer.invoke(IPC.getProjectActivities),
  retryPipelineFailures: (fileIds: number[]) => ipcRenderer.invoke(IPC.retryPipelineFailures, fileIds),
  exportPipelineFailures: (scope: ChatScope) => ipcRenderer.invoke(IPC.exportPipelineFailures, scope),
  exportLocators: (scope: ChatScope, items: ExportItem[]) =>
    ipcRenderer.invoke(IPC.exportLocators, scope, items),
  revealInFinder: (path: string) => ipcRenderer.invoke(IPC.revealInFinder, path),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),

  // project updates (indexing progress, scans)
  onProjectUpdate: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.projectUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.projectUpdate, listener);
  },
  onIndexUpdate: (cb: (update: IndexUpdate) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, update: IndexUpdate) => cb(update);
    ipcRenderer.on(IPC.indexUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.indexUpdate, listener);
  },

  fileUrl: (path: string) => `media://local/${encodeURIComponent(path)}`,

  // software update
  getUpdateState: () => ipcRenderer.invoke(IPC.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  restartToUpdate: () => ipcRenderer.invoke(IPC.restartToUpdate),
  onUpdateStateChanged: (cb: (state: UpdaterState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdaterState) => cb(state);
    ipcRenderer.on(IPC.updateStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.updateStateChanged, listener);
  },
};

contextBridge.exposeInMainWorld("dailies", api);
