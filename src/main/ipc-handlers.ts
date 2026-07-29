import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { downloadWhisperModel } from "./model-download";
import { IPC } from "../shared/ipc";
import type {
  AppSettings,
  ApiKeyStatus,
  ChatEvent,
  ExportItem,
  ExportKind,
  FileDetail,
  MediaRole,
} from "../shared/types";
import type { ProjectManager } from "./project-manager";
import type { AppSettingsStore } from "./app-settings";
import { checkAvailability, findWhisperModel } from "./pipeline/binaries";
import { DOC_EXTENSIONS } from "./pipeline/docs";
import { runChatTurn } from "./agents/supervisor";
import { createOpenRouterClient, validateOpenRouterKey } from "./agents/openrouter-client";
import { createOpenRouterEmbedder } from "./agents/openrouter";
import { writeExport } from "./export";
import { resolvePlaybackPath } from "./playback-path";

export interface IpcContext {
  manager: ProjectManager;
  settings: AppSettingsStore;
  dataDir: string;
  getWindow: () => BrowserWindow | null;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const { manager, settings, dataDir } = ctx;

  const emitChatEvent = (ev: ChatEvent) => {
    ctx.getWindow()?.webContents.send(IPC.chatEvent, ev);
  };
  const emitProjectUpdate = () => {
    ctx.getWindow()?.webContents.send(IPC.projectUpdate);
  };
  let cachedApiKeyStatus: ApiKeyStatus | null = null;

  async function getApiKeyStatus(): Promise<ApiKeyStatus> {
    const key = settings.getOpenRouterKey();
    if (!key) return "missing";
    if (cachedApiKeyStatus) return cachedApiKeyStatus;
    const status = await validateOpenRouterKey(key);
    if (status !== "unavailable") cachedApiKeyStatus = status;
    return status;
  }

  /** Every project-scoped handler goes through this. */
  const requireProject = () => {
    const c = manager.current();
    if (!c) throw new Error("No project is open");
    return c;
  };

  // ---- projects ----
  ipcMain.handle(IPC.listProjects, () => manager.listProjects());
  ipcMain.handle(IPC.createProject, (_e, name: string) => manager.createProject(name));
  ipcMain.handle(IPC.openProject, (_e, id: string) => manager.openProject(id));
  ipcMain.handle(IPC.getProjectState, () => manager.currentState());

  // ---- episodes & folders ----
  ipcMain.handle(IPC.createEpisode, (_e, code: string) => {
    const { db } = requireProject();
    const ep = db.createEpisode(code);
    emitProjectUpdate();
    return ep;
  });

  ipcMain.handle(IPC.addProjectFolder, async (
    _e,
    role: MediaRole,
    episodeId: number | null,
    e2eFolderPath?: string,
  ) => {
    const c = requireProject();
    let folderPath: string | undefined;
    if (e2eFolderPath !== undefined) {
      if (!process.env["DAILIES_E2E_FOLDER"] || e2eFolderPath !== process.env["DAILIES_E2E_FOLDER"]) {
        throw new Error("Automated folder path is not enabled for this app session");
      }
      folderPath = e2eFolderPath;
    } else {
      const win = ctx.getWindow();
      if (!win) return null;
      const res = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: role === "final" ? "Choose a finals folder to watch" : "Choose a footage folder to watch",
      });
      folderPath = res.filePaths[0];
      if (res.canceled || !folderPath) return null;
    }
    const folder = c.db.addFolder(folderPath, role, episodeId);
    c.pipeline.watchFolder(folder);
    void c.pipeline.scanFolder(folder).then(() => {
      c.db.setFolderScanned(folder.id, new Date().toISOString());
      emitProjectUpdate();
    });
    emitProjectUpdate();
    return folder;
  });

  ipcMain.handle(IPC.removeProjectFolder, async (_e, folderId: number) => {
    const c = requireProject();
    const folder = c.db.listFolders().find((f) => f.id === folderId);
    if (folder) {
      c.pipeline.unwatchFolder(folder.path);
      const deletedFiles = c.db.deleteFilesUnderPath(folder.path);
      await Promise.all(
        deletedFiles.map((file) =>
          fs.promises.rm(path.join(c.mediaDir, String(file.id)), { recursive: true, force: true })
        ),
      );
      c.db.removeFolder(folderId);
      emitProjectUpdate();
    }
  });

  ipcMain.handle(IPC.clearProjectCache, async () => {
    const c = requireProject();
    await c.pipeline.stop();
    const files = c.db.listFiles();
    for (const file of files) {
      await fs.promises.rm(path.join(c.mediaDir, String(file.id)), { recursive: true, force: true });
      c.db.clearDerivedState(file.id);
      c.db.enqueueJob(file.id, "probe");
    }
    c.pipeline.start();
    emitProjectUpdate();
    return { clearedFiles: files.length };
  });

  ipcMain.handle(IPC.rescanFolders, async (_e, episodeId: number | null) => {
    const c = requireProject();
    const folders = c.db
      .listFolders()
      .filter((f) => episodeId === null || f.episodeId === episodeId);
    await Promise.all(
      folders.map(async (f) => {
        await c.pipeline.scanFolder(f);
        c.db.setFolderScanned(f.id, new Date().toISOString());
      }),
    );
    emitProjectUpdate();
  });

  ipcMain.handle(IPC.importDocuments, async (_e, episodeId: number | null) => {
    const c = requireProject();
    const win = ctx.getWindow();
    if (!win) return 0;
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      title: "Import notes, documents, spreadsheets",
      filters: [
        { name: "Documents", extensions: DOC_EXTENSIONS.map((e) => e.replace(/^\./, "")) },
      ],
    });
    if (res.canceled) return 0;
    let count = 0;
    for (const p of res.filePaths) {
      if (await c.pipeline.ingestDocument(p, episodeId)) count += 1;
    }
    emitProjectUpdate();
    return count;
  });

  // ---- library ----
  ipcMain.handle(IPC.listFiles, (_e, episodeId?: number) =>
    requireProject().db.listFiles(episodeId),
  );

  ipcMain.handle(IPC.getFileDetail, (_e, fileId: number): FileDetail => {
    const { db, mediaDir } = requireProject();
    const file = db.getFile(fileId);
    if (!file) throw new Error(`Unknown file ${fileId}`);
    return {
      file,
      playbackPath: resolvePlaybackPath(file, mediaDir),
      scenes: db.listScenes(fileId),
      segments: db.listSegments(fileId),
    };
  });

  ipcMain.handle(IPC.getWords, (_e, segmentId: number) => requireProject().db.getWords(segmentId));
  ipcMain.handle(IPC.listJobs, () => requireProject().db.listJobs());
  ipcMain.handle(IPC.retryFile, (_e, fileId: number): Promise<void> =>
    requireProject().pipeline.retryFile(fileId));

  // ---- settings (global) ----
  ipcMain.handle(IPC.getSettings, async (): Promise<AppSettings> => {
    const avail = checkAvailability();
    const model = settings.getWhisperModel();
    const apiKeyStatus = await getApiKeyStatus();
    return {
      apiKeySet: apiKeyStatus !== "missing",
      apiKeyStatus,
      whisperModel: model,
      whisperAvailable: avail.whisper,
      whisperModelReady: findWhisperModel(model, dataDir) !== null,
      ffmpegAvailable: avail.ffmpeg,
    };
  });

  ipcMain.handle(IPC.downloadWhisperModel, () => {
    const model = settings.getWhisperModel();
    void downloadWhisperModel(model, path.join(dataDir, "models"), (p) => {
      ctx.getWindow()?.webContents.send(IPC.modelProgress, p);
      if (p.done && !p.error) {
        void manager.current()?.pipeline.refreshPrerequisites("whisper");
      }
    }).catch(() => {
      /* surfaced via the progress error event */
    });
  });

  ipcMain.handle(IPC.setApiKey, async (_e, _provider: "openrouter", key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return "invalid";
    const status = await validateOpenRouterKey(trimmed);
    if (status !== "connected") return status;
    const saved = settings.setOpenRouterKey(trimmed);
    cachedApiKeyStatus = saved ? "connected" : null;
    if (saved) void manager.current()?.pipeline.refreshPrerequisites("openrouter");
    return saved ? "connected" : "invalid";
  });
  // ---- chat ----
  ipcMain.handle(IPC.listChats, () => requireProject().db.listChats());
  ipcMain.handle(IPC.getChat, (_e, chatId: number) => requireProject().db.getChatMessages(chatId));

  ipcMain.handle(
    IPC.sendChatMessage,
    (_e, chatId: number | null, text: string, episodeId: number | null, turnId: string) => {
      const c = requireProject();
      const chat =
        chatId !== null && c.db.listChats().some((ch) => ch.id === chatId)
          ? { id: chatId }
          : c.db.createChat(text.slice(0, 48));
      const id = chat.id;

      c.db.addChatMessage(id, "user", text);

      void (async () => {
        const apiKey = settings.getOpenRouterKey();
        if (!apiKey) {
          emitChatEvent({
            type: "error",
            chatId: id,
            turnId,
            message: "Add your OpenRouter API key in Settings to start chatting.",
          });
          emitChatEvent({ type: "done", chatId: id, turnId });
          return;
        }
        try {
          const client = createOpenRouterClient(() => apiKey);
          const answer = await runChatTurn({
            db: c.db,
            history: c.db.getChatMessages(id).slice(0, -1),
            userText: text,
            apiKey,
            embedder: createOpenRouterEmbedder(client),
            episodeId,
            emit: (ev) => emitChatEvent({ ...ev, chatId: id, turnId }),
            client,
          });
          c.db.addChatMessage(id, "assistant", answer.prose, answer.hits);
          emitChatEvent({ type: "answer", chatId: id, turnId, answer });
        } catch (err) {
          emitChatEvent({
            type: "error",
            chatId: id,
            turnId,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          emitChatEvent({ type: "done", chatId: id, turnId });
        }
      })();

      return { chatId: id };
    },
  );

  // ---- export ----
  ipcMain.handle(IPC.exportHits, (_e, kind: ExportKind, items: ExportItem[]) => {
    const { db } = requireProject();
    const outDir = path.join(app.getPath("documents"), "Dailies Exports");
    return writeExport(kind, items, (fid) => db.getFile(fid), outDir);
  });

  ipcMain.handle(IPC.revealInFinder, (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // https-only: never let the renderer launch arbitrary protocols/apps.
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
}
