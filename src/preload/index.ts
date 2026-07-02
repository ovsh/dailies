import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DailiesAPI } from "../shared/ipc";
import type { ChatEvent, ExportItem, ExportKind, MediaRole, QualityMode } from "../shared/types";

const api: DailiesAPI = {
  // projects
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  createProject: (name: string) => ipcRenderer.invoke(IPC.createProject, name),
  openProject: (id: string) => ipcRenderer.invoke(IPC.openProject, id),
  getProjectState: () => ipcRenderer.invoke(IPC.getProjectState),

  // episodes & folders
  createEpisode: (code: string) => ipcRenderer.invoke(IPC.createEpisode, code),
  addProjectFolder: (role: MediaRole, episodeId: number | null) =>
    ipcRenderer.invoke(IPC.addProjectFolder, role, episodeId),
  removeProjectFolder: (folderId: number) =>
    ipcRenderer.invoke(IPC.removeProjectFolder, folderId),
  rescanFolders: (episodeId: number | null) => ipcRenderer.invoke(IPC.rescanFolders, episodeId),
  importDocuments: (episodeId: number | null) =>
    ipcRenderer.invoke(IPC.importDocuments, episodeId),

  // library
  listFiles: (episodeId?: number) => ipcRenderer.invoke(IPC.listFiles, episodeId),
  getFileDetail: (fileId: number) => ipcRenderer.invoke(IPC.getFileDetail, fileId),
  getWords: (segmentId: number) => ipcRenderer.invoke(IPC.getWords, segmentId),
  listJobs: () => ipcRenderer.invoke(IPC.listJobs),

  // settings
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setApiKey: (provider: "gemini", key: string) => ipcRenderer.invoke(IPC.setApiKey, provider, key),
  setQualityMode: (mode: QualityMode) => ipcRenderer.invoke(IPC.setQualityMode, mode),

  // chat
  listChats: () => ipcRenderer.invoke(IPC.listChats),
  getChat: (chatId: number) => ipcRenderer.invoke(IPC.getChat, chatId),
  sendChatMessage: (chatId: number | null, text: string, episodeId: number | null) =>
    ipcRenderer.invoke(IPC.sendChatMessage, chatId, text, episodeId),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ChatEvent) => cb(ev);
    ipcRenderer.on(IPC.chatEvent, listener);
    return () => ipcRenderer.removeListener(IPC.chatEvent, listener);
  },

  // export
  exportHits: (kind: ExportKind, items: ExportItem[]) =>
    ipcRenderer.invoke(IPC.exportHits, kind, items),
  revealInFinder: (path: string) => ipcRenderer.invoke(IPC.revealInFinder, path),

  // project updates (indexing progress, scans)
  onProjectUpdate: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.projectUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.projectUpdate, listener);
  },

  fileUrl: (path: string) => `media://local/${encodeURIComponent(path)}`,
};

contextBridge.exposeInMainWorld("dailies", api);
