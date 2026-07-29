import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadWhisperModel } from "./model-download";
import { IPC } from "../shared/ipc";
import type {
  AppSettings,
  ApiKeyStatus,
  ChatEvent,
  ChatScope,
  DiagnosticsExportOutcome,
  ExportItem,
  ExportKind,
  FileDetail,
  LocatorExportOutcome,
  MediaRole,
  PipelineSnapshot,
  ProjectActivity,
  StructuredAgentAnswer,
} from "../shared/types";
import type { DailiesDB } from "./db/types";
import type { ProjectManager } from "./project-manager";
import type { AppSettingsStore } from "./app-settings";
import type { UpdaterService } from "./updater";
import { checkAvailability, findWhisperModel } from "./pipeline/binaries";
import { DOC_EXTENSIONS } from "./pipeline/docs";
import { runChatTurn } from "./agents/supervisor";
import { createOpenRouterClient, validateOpenRouterKey } from "./agents/openrouter-client";
import { createOpenRouterEmbedder } from "./agents/openrouter";
import { writeExport, writeLocatorExport } from "./export";
import { resolvePlaybackPath } from "./playback-path";
import { computePipelineSnapshot } from "./pipeline/status";

/** Builds the derived pipeline snapshot for a scope from fact + document queries. */
function projectSnapshot(db: DailiesDB, scope: ChatScope): PipelineSnapshot {
  const facts = db.listPipelineFileFacts(scope);
  const producerNoteCount = db
    .listDocuments()
    .filter((doc) => scope.episodeId === null || doc.episodeId === scope.episodeId)
    .length;
  return computePipelineSnapshot(facts, producerNoteCount);
}

interface FailureExportRow {
  clip: string;
  path: string;
  stage: string;
  reason: string;
  attempts: number;
  updatedAt: string;
}

function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildFailureCsv(rows: FailureExportRow[]): string {
  const header = ["Clip", "Path", "Stage", "Reason", "Attempts", "Updated At"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [row.clip, row.path, row.stage, row.reason, row.attempts, row.updatedAt]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\n");
}

function exportTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function structuredAnswerContent(answer: StructuredAgentAnswer): string {
  switch (answer.kind) {
    case "message":
      return answer.text;
    case "empty":
      return "";
    case "results":
      return answer.summary ?? "";
  }
}

export interface IpcContext {
  manager: ProjectManager;
  settings: AppSettingsStore;
  dataDir: string;
  getWindow: () => BrowserWindow | null;
  updater: UpdaterService;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const { manager, settings, dataDir, updater } = ctx;

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
    const folders = c.db.listFolders();
    const files = c.db.listFiles();
    try {
      await c.pipeline.stop("abort");
      for (const file of files) {
        await fs.promises.rm(path.join(c.mediaDir, String(file.id)), { recursive: true, force: true });
        c.db.clearDerivedState(file.id);
        c.db.enqueueJob(file.id, "probe");
      }
    } finally {
      try {
        for (const folder of folders) {
          c.pipeline.watchFolder(folder);
          void c.pipeline.scanFolder(folder);
        }
      } finally {
        c.pipeline.start();
      }
    }
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
  const assembleSettings = async (): Promise<AppSettings> => {
    const avail = checkAvailability();
    const model = settings.getWhisperModel();
    const apiKeyStatus = await getApiKeyStatus();
    return {
      apiKeySet: apiKeyStatus !== "missing",
      apiKeyStatus,
      telemetryEnabled: settings.getTelemetryEnabled(),
      whisperModel: model,
      whisperAvailable: avail.whisper,
      whisperModelReady: findWhisperModel(model, dataDir) !== null,
      ffmpegAvailable: avail.ffmpeg,
    };
  };

  ipcMain.handle(IPC.getSettings, () => assembleSettings());

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
  ipcMain.handle(IPC.listChats, (_e, scope?: ChatScope) => {
    const { db } = requireProject();
    return scope === undefined ? db.listChats() : db.listChats(scope);
  });

  ipcMain.handle(IPC.getChat, (_e, arg1: ChatScope | number, arg2?: number) => {
    const { db } = requireProject();
    if (typeof arg1 === "number") return db.getChatMessages(arg1);
    const chatId = arg2;
    if (chatId === undefined) throw new Error("getChat requires a chat id with a scope");
    const chat = db.getChat(chatId);
    if (!chat || chat.episodeId !== arg1.episodeId) {
      throw new Error(`Chat ${chatId} is not bound to this scope`);
    }
    return db.getChatMessages(chatId);
  });

  ipcMain.handle(
    IPC.sendChatMessage,
    (_e, chatId: number | null, text: string, episodeId: number | null, turnId: string) => {
      const c = requireProject();

      // A chat's episode binding is immutable. New chats bind to the
      // renderer's current scope; an existing chat always runs in its
      // stored scope, never the renderer's — a stale renderer scope for an
      // existing chat is a bug, not a silent retarget.
      let id: number;
      let boundEpisodeId: number | null;
      if (chatId === null) {
        const created = c.db.createChat(text.slice(0, 48), { episodeId });
        id = created.id;
        boundEpisodeId = episodeId;
      } else {
        const existing = c.db.getChat(chatId);
        if (!existing) throw new Error(`Unknown chat ${chatId}`);
        if (existing.episodeId !== episodeId) {
          throw new Error(`Chat ${chatId} is bound to a different scope`);
        }
        id = chatId;
        boundEpisodeId = existing.episodeId;
      }

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
        const endChatTurn = c.beginChatTurn();
        try {
          const client = createOpenRouterClient(() => apiKey);
          const answer = await runChatTurn({
            db: c.db,
            history: c.db.getChatMessages(id).slice(0, -1),
            userText: text,
            apiKey,
            embedder: createOpenRouterEmbedder(client),
            episodeId: boundEpisodeId,
            emit: (ev) => emitChatEvent({ ...ev, chatId: id, turnId }),
            client,
          });
          c.db.addChatMessage(id, "assistant", structuredAnswerContent(answer), answer);
          emitChatEvent({ type: "answer", chatId: id, turnId, answer });
        } catch (err) {
          emitChatEvent({
            type: "error",
            chatId: id,
            turnId,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          endChatTurn();
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

  // Scoped locator export for Board A/C: every item must resolve to a real
  // file still bound to the active scope, or the whole export is blocked —
  // a stale file or scope mismatch is never a silently dropped marker.
  ipcMain.handle(
    IPC.exportLocators,
    (_e, scope: ChatScope, items: ExportItem[]): LocatorExportOutcome => {
      const { db } = requireProject();
      if (items.length === 0) return { kind: "blocked", reason: "no-hits" };
      const allValid = items.every((item) => {
        const file = db.getFile(item.fileId);
        if (!file) return false;
        if (scope.episodeId !== null && file.episodeId !== scope.episodeId) return false;
        return true;
      });
      if (!allValid) return { kind: "blocked", reason: "no-valid-sources" };
      const outDir = path.join(app.getPath("documents"), "Dailies Exports");
      return writeLocatorExport(items, (fid) => db.getFile(fid), outDir);
    },
  );

  ipcMain.handle(IPC.revealInFinder, (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // https-only: never let the renderer launch arbitrary protocols/apps.
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });

  // ---- pipeline visibility ----
  ipcMain.handle(IPC.getPipelineSnapshot, (_e, scope: ChatScope): PipelineSnapshot => {
    const { db } = requireProject();
    const t0 = Date.now();
    const facts = db.listPipelineFileFacts(scope);
    const tFacts = Date.now();
    const producerNoteCount = db
      .listDocuments()
      .filter((doc) => scope.episodeId === null || doc.episodeId === scope.episodeId)
      .length;
    const snapshot = computePipelineSnapshot(facts, producerNoteCount);
    const tDone = Date.now();
    console.log(
      `[pipeline-snapshot] rows=${facts.length} derivMs=${tDone - tFacts} ` +
        `ipcMs=${tDone - t0} bytes=${JSON.stringify(snapshot).length}`,
    );
    return snapshot;
  });

  ipcMain.handle(IPC.getProjectActivities, (): ProjectActivity[] => {
    return manager.retained().map((c) => {
      const snapshot = projectSnapshot(c.db, { episodeId: null });
      return {
        projectId: c.project.id,
        projectName: c.project.name,
        counts: snapshot.counts,
        activeFiles: snapshot.activeFiles,
      };
    });
  });

  ipcMain.handle(IPC.retryPipelineFailures, async (_e, fileIds: number[]): Promise<PipelineSnapshot> => {
    const { db, pipeline } = requireProject();
    const validIds = fileIds.filter((id) => db.getFile(id) !== null);
    for (const fileId of validIds) {
      await pipeline.retryFile(fileId);
    }
    emitProjectUpdate();
    return projectSnapshot(db, { episodeId: null });
  });

  ipcMain.handle(IPC.setTelemetryEnabled, (_e, enabled: boolean): Promise<AppSettings> => {
    settings.setTelemetryEnabled(enabled === true);
    return assembleSettings();
  });

  // Bundles what a remote bug report needs: log, failure list, versions,
  // snapshot. The tester sends the zip by hand — nothing uploads itself.
  ipcMain.handle(IPC.exportDiagnostics, async (): Promise<DiagnosticsExportOutcome> => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "dailies-diagnostics-"));
    try {
      const logFile = path.join(dataDir, "dailies.log");
      if (fs.existsSync(logFile)) {
        fs.copyFileSync(logFile, path.join(staging, "dailies.log"));
      }

      const versions = [
        `app ${app.getVersion()}`,
        `electron ${process.versions.electron}`,
        `node ${process.versions.node}`,
        `platform ${process.platform} ${os.release()}`,
      ].join("\n");
      fs.writeFileSync(path.join(staging, "versions.txt"), `${versions}\n`, "utf8");

      const c = manager.current();
      if (c) {
        const snapshot = projectSnapshot(c.db, { episodeId: null });
        fs.writeFileSync(
          path.join(staging, "pipeline-snapshot.json"),
          JSON.stringify(snapshot, null, 2),
          "utf8",
        );
        if (snapshot.failures.length > 0) {
          const rows: FailureExportRow[] = snapshot.failures.map((failure) => {
            const file = c.db.getFile(failure.fileId);
            return {
              clip: file?.clipName ?? failure.filename,
              path: file?.path ?? "",
              stage: failure.stage,
              reason: failure.reason,
              attempts: failure.attempts,
              updatedAt: failure.updatedAt,
            };
          });
          fs.writeFileSync(path.join(staging, "failures.csv"), buildFailureCsv(rows), "utf8");
        }
      }

      const outDir = path.join(app.getPath("documents"), "Dailies Exports");
      fs.mkdirSync(outDir, { recursive: true });
      const zipPath = path.join(outDir, `dailies-diagnostics-${exportTimestamp()}.zip`);
      await new Promise<void>((resolve, reject) => {
        execFile("ditto", ["-c", "-k", "--sequesterRsrc", staging, zipPath], (err) =>
          err ? reject(err) : resolve(),
        );
      });
      return { kind: "written", path: zipPath };
    } catch (err) {
      return {
        kind: "blocked",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  ipcMain.handle(IPC.exportPipelineFailures, (_e, scope: ChatScope) => {
    const { db } = requireProject();
    const snapshot = projectSnapshot(db, scope);
    if (snapshot.failures.length === 0) {
      return { kind: "blocked" as const, reason: "no-failures" as const };
    }
    const rows: FailureExportRow[] = snapshot.failures.map((failure) => {
      const file = db.getFile(failure.fileId);
      return {
        clip: file?.clipName ?? failure.filename,
        path: file?.path ?? "",
        stage: failure.stage,
        reason: failure.reason,
        attempts: failure.attempts,
        updatedAt: failure.updatedAt,
      };
    });
    const outDir = path.join(app.getPath("documents"), "Dailies Exports");
    fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, `dailies-failures-${exportTimestamp()}.csv`);
    fs.writeFileSync(filePath, buildFailureCsv(rows), "utf8");
    return { kind: "written" as const, path: filePath, count: rows.length };
  });

  // ---- software update ----
  ipcMain.handle(IPC.getUpdateState, () => updater.getState());
  ipcMain.handle(IPC.checkForUpdates, () => updater.checkNow());
  ipcMain.handle(IPC.restartToUpdate, () => updater.restartNow());
}
