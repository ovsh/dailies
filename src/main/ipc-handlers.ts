import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc";
import type {
  AppSettings,
  ChatEvent,
  ExportItem,
  ExportKind,
  FileDetail,
  QualityMode,
} from "../shared/types";
import type { DailiesDB } from "./db/types";
import type { Pipeline } from "./pipeline";
import { checkAvailability } from "./pipeline/binaries";
import { runChatTurn } from "./agents/supervisor";
import { createGeminiIndexer } from "./agents/gemini";
import { writeExport } from "./export";
import {
  getApiKey,
  getQualityMode,
  getWatchedFolders,
  getWhisperModel,
  hasApiKey,
  setApiKey,
  setQualityMode,
  setWatchedFolders,
} from "./settings";

export interface IpcContext {
  db: DailiesDB;
  pipeline: Pipeline;
  getWindow: () => BrowserWindow | null;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const { db, pipeline } = ctx;

  const emitChatEvent = (ev: ChatEvent) => {
    ctx.getWindow()?.webContents.send(IPC.chatEvent, ev);
  };

  // ---- library ----
  ipcMain.handle(IPC.listFiles, () => db.listFiles());

  ipcMain.handle(IPC.getFileDetail, (_e, fileId: number): FileDetail => {
    const file = db.getFile(fileId);
    if (!file) throw new Error(`Unknown file ${fileId}`);
    return {
      file,
      scenes: db.listScenes(fileId),
      segments: db.listSegments(fileId),
      annotations: db.listAnnotations(fileId),
    };
  });

  ipcMain.handle(IPC.getWords, (_e, segmentId: number) => db.getWords(segmentId));

  // ---- jobs & folders ----
  ipcMain.handle(IPC.listJobs, () => db.listJobs());

  ipcMain.handle(IPC.addWatchedFolder, async () => {
    const win = ctx.getWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Choose a footage folder to watch",
    });
    const folder = res.filePaths[0];
    if (res.canceled || !folder) return null;
    const folders = getWatchedFolders(db);
    if (!folders.includes(folder)) {
      setWatchedFolders(db, [...folders, folder]);
      pipeline.watchFolder(folder);
      void pipeline.scanFolder(folder);
    }
    return folder;
  });

  ipcMain.handle(IPC.removeWatchedFolder, (_e, folder: string) => {
    setWatchedFolders(
      db,
      getWatchedFolders(db).filter((f) => f !== folder),
    );
    pipeline.unwatchFolder(folder);
  });

  // ---- settings ----
  ipcMain.handle(IPC.getSettings, (): AppSettings => {
    const avail = checkAvailability();
    return {
      geminiKeySet: hasApiKey(db, "gemini"),
      watchedFolders: getWatchedFolders(db),
      qualityMode: getQualityMode(db),
      whisperModel: getWhisperModel(db),
      whisperAvailable: avail.whisper,
      ffmpegAvailable: avail.ffmpeg,
    };
  });

  ipcMain.handle(IPC.setApiKey, (_e, provider: "gemini", key: string) =>
    setApiKey(db, provider, key),
  );

  ipcMain.handle(IPC.setQualityMode, (_e, mode: QualityMode) => setQualityMode(db, mode));

  // ---- chat ----
  ipcMain.handle(IPC.listChats, () => db.listChats());
  ipcMain.handle(IPC.getChat, (_e, chatId: number) => db.getChatMessages(chatId));

  ipcMain.handle(IPC.sendChatMessage, (_e, chatId: number | null, text: string) => {
    const chat =
      chatId !== null && db.listChats().some((c) => c.id === chatId)
        ? { id: chatId }
        : db.createChat(text.slice(0, 48));
    const id = chat.id;

    db.addChatMessage(id, "user", text);

    // Run the turn asynchronously; progress + answer arrive as events.
    void (async () => {
      const geminiKey = getApiKey(db, "gemini");
      if (!geminiKey) {
        emitChatEvent({
          type: "error",
          chatId: id,
          message: "Add your Gemini API key in Settings to start chatting.",
        });
        emitChatEvent({ type: "done", chatId: id });
        return;
      }
      try {
        const answer = await runChatTurn({
          db,
          history: db.getChatMessages(id).slice(0, -1),
          userText: text,
          geminiKey,
          qualityMode: getQualityMode(db),
          gemini: createGeminiIndexer(() => geminiKey),
          emit: (ev) => emitChatEvent({ ...ev, chatId: id }),
        });
        db.addChatMessage(id, "assistant", answer.prose, answer.hits);
        emitChatEvent({ type: "answer", chatId: id, answer });
      } catch (err) {
        emitChatEvent({
          type: "error",
          chatId: id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        emitChatEvent({ type: "done", chatId: id });
      }
    })();

    return { chatId: id };
  });

  // ---- export ----
  ipcMain.handle(IPC.exportHits, (_e, kind: ExportKind, items: ExportItem[]) => {
    const outDir = path.join(app.getPath("documents"), "Dailies Exports");
    return writeExport(kind, items, (fid) => db.getFile(fid), outDir);
  });

  ipcMain.handle(IPC.revealInFinder, (_e, p: string) => {
    shell.showItemInFolder(p);
  });
}
