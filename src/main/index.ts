import { app, BrowserWindow, Menu, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { IPC } from "../shared/ipc";
import type { IndexUpdate } from "../shared/types";
import { setGlobalModelsDir } from "./pipeline/binaries";
import { createAppSettings } from "./app-settings";
import { createProjectManager } from "./project-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { buildMediaResponse, parseMediaRequestPath } from "./media-protocol";
import { createWindowRef } from "./window-ref";
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

// On macOS the app keeps running after the window closes; anything pushing
// to the renderer must go through winRef.get(), which returns null once the
// window is destroyed.
const winRef = createWindowRef<BrowserWindow>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * Electron's own default menu (About / Services / Hide / Quit, standard Edit
 * and Window menus) but with "Check for Updates…" inserted under About, in
 * the standard macOS location. Building it by hand — rather than relying on
 * the implicit default — is the only way to add that one item.
 */
function buildAppMenu(checkForUpdates: () => void): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => checkForUpdates() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#9ea4a9",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
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
  return winRef.track(w);
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

  // Crash-visibility for remote debugging: everything lands in dailies.log.
  // Rotated at a size cap — a persistent error storm once grew an unrotated
  // log past 700 MB, which is unusable as a diagnostic and hostile to disks.
  const logFile = path.join(dataDir, "dailies.log");
  const rotatedLogFile = `${logFile}.1`;
  const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
  let logBytes = 0;
  const rotateLogIfNeeded = () => {
    if (logBytes <= LOG_ROTATE_BYTES) return;
    fs.rmSync(rotatedLogFile, { force: true });
    fs.renameSync(logFile, rotatedLogFile);
    logBytes = 0;
  };
  try {
    logBytes = fs.statSync(logFile).size;
    rotateLogIfNeeded();
  } catch {
    // no log yet
  }
  const logLine = (level: string, args: unknown[]) => {
    try {
      const text = args
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a)))
        .join(" ");
      const line = `${new Date().toISOString()} [${level}] ${text}\n`;
      fs.appendFileSync(logFile, line);
      logBytes += Buffer.byteLength(line);
      rotateLogIfNeeded();
    } catch {
      // never let logging break the app
    }
  };
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => (logLine("error", args), origError(...args));
  console.warn = (...args: unknown[]) => (logLine("warn", args), origWarn(...args));
  process.on("uncaughtException", (err) => logLine("uncaught", [err]));
  process.on("unhandledRejection", (reason) => logLine("unhandledRejection", [reason]));

  const settings = createAppSettings(dataDir);
  let indexRevision = 0;
  const manager = createProjectManager({
    dataDir,
    settings,
    onUpdate: () => {
      const update: IndexUpdate = { revision: ++indexRevision };
      winRef.get()?.webContents.send(IPC.indexUpdate, update);
    },
  });

  const updater = createUpdater(winRef.get);
  registerIpcHandlers({ manager, settings, dataDir, getWindow: winRef.get, updater });
  buildAppMenu(() => void updater.checkNow());

  // Re-open the last project (adopts a pre-projects install on first boot).
  try {
    await manager.openLastProject();
  } catch (err) {
    console.error("Failed to open last project:", err);
  }

  createWindow();
  updater.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("before-quit", () => {
    void manager.closeCurrent();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
