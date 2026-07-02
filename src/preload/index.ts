import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DailiesAPI } from "../shared/ipc";
import type { ChatEvent, ExportItem, ExportKind, QualityMode } from "../shared/types";

const api: DailiesAPI = {
  listFiles: () => ipcRenderer.invoke(IPC.listFiles),
  getFileDetail: (fileId: number) => ipcRenderer.invoke(IPC.getFileDetail, fileId),
  getWords: (segmentId: number) => ipcRenderer.invoke(IPC.getWords, segmentId),

  listJobs: () => ipcRenderer.invoke(IPC.listJobs),
  addWatchedFolder: () => ipcRenderer.invoke(IPC.addWatchedFolder),
  removeWatchedFolder: (path: string) => ipcRenderer.invoke(IPC.removeWatchedFolder, path),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setApiKey: (provider: "anthropic" | "gemini", key: string) =>
    ipcRenderer.invoke(IPC.setApiKey, provider, key),
  setQualityMode: (mode: QualityMode) => ipcRenderer.invoke(IPC.setQualityMode, mode),

  listChats: () => ipcRenderer.invoke(IPC.listChats),
  getChat: (chatId: number) => ipcRenderer.invoke(IPC.getChat, chatId),
  sendChatMessage: (chatId: number | null, text: string) =>
    ipcRenderer.invoke(IPC.sendChatMessage, chatId, text),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ChatEvent) => cb(ev);
    ipcRenderer.on(IPC.chatEvent, listener);
    return () => ipcRenderer.removeListener(IPC.chatEvent, listener);
  },

  exportHits: (kind: ExportKind, items: ExportItem[]) =>
    ipcRenderer.invoke(IPC.exportHits, kind, items),
  revealInFinder: (path: string) => ipcRenderer.invoke(IPC.revealInFinder, path),

  fileUrl: (path: string) => `media://local/${encodeURIComponent(path)}`,
};

contextBridge.exposeInMainWorld("dailies", api);
