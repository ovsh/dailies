import { app, BrowserWindow, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { IPC } from "../shared/ipc";
import type { IndexUpdate } from "../shared/types";
import { setGlobalModelsDir } from "./pipeline/binaries";
import { createAppSettings } from "./app-settings";
import { createProjectManager } from "./project-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { buildMediaResponse, parseMediaRequestPath } from "./media-protocol";
import { initLog, log } from "./log";
import { initTelemetry } from "./telemetry";
import { createUpdater } from "./updater";

/**
 * When the app is launched from Finder/Dock (rather than a terminal), the
 * standard stdio descriptors 0/1/2 can be closed. Node's child_process.spawn
 * then fails with `spawn EBADF` for EVERY external tool we run — ffprobe,
 * ffmpeg, whisper — so nothing in the pipeline can process a single file.
 * Reopen any closed descriptor onto /dev/null before anything spawns. This
 * relies on lowest-available-fd allocation (a closed fd 0 is reused by the
 * next open), so run it first, before we open any other file.
 */
function ensureStandardStreams(): void {
  for (const fd of [0, 1, 2]) {
    try {
      fs.fstatSync(fd);
    } catch {
      try {
        fs.openSync("/dev/null", fd === 0 ? "r" : "w");
      } catch {
        /* best effort */
      }
    }
  }
}
ensureStandardStreams();

// Test/e2e harnesses point the app at an isolated profile so runs never touch
// the user's real projects. Must be set before anything reads userData.
const userDataOverride = process.env["DAILIES_USER_DATA"];
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
}

let win: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#1b1f27",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void w.loadURL(devUrl);
  } else {
    void w.loadFile(path.join(__dirname, "../../dist/renderer/index.html"));
  }
  return w;
}

void app.whenReady().then(async () => {
  // media:// — serves local media (proxies, keyframes, originals) with real
  // 200/206/416 Range semantics so <video>/<audio> can buffer and seek.
  protocol.handle("media", (request) => {
    const filePath = parseMediaRequestPath(request.url);
    return buildMediaResponse(filePath, request.headers.get("range"));
  });

  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });
  setGlobalModelsDir(path.join(dataDir, "models"));

  const settings = createAppSettings(dataDir);

  // Session log first (console + crash funnels live there), then telemetry
  // so every subsequent log line also lands in the remote breadcrumb trail.
  initLog(dataDir);
  initTelemetry({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    isEnabled: () => settings.getErrorReportingEnabled(),
  });
  log.info("app", "app.launch", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });
  let indexRevision = 0;
  const manager = createProjectManager({
    dataDir,
    settings,
    onUpdate: () => {
      const update: IndexUpdate = { revision: ++indexRevision };
      win?.webContents.send(IPC.indexUpdate, update);
    },
  });

  const updater = createUpdater((state) => {
    win?.webContents.send(IPC.updateEvent, state);
  });

  registerIpcHandlers({ manager, settings, dataDir, getWindow: () => win, updater });
  updater.start();

  // Re-open the last project (adopts a pre-projects install on first boot).
  try {
    await manager.openLastProject();
  } catch (err) {
    log.error("app", "app.project.open_failed", {}, err);
  }

  win = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });

  app.on("before-quit", () => {
    void manager.closeCurrent();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
