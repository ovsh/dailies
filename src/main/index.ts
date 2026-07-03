import { app, BrowserWindow, net, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { IPC } from "../shared/ipc";
import { setGlobalModelsDir } from "./pipeline/binaries";
import { createAppSettings } from "./app-settings";
import { createProjectManager } from "./project-manager";
import { registerIpcHandlers } from "./ipc-handlers";

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

void app.whenReady().then(() => {
  // media:// — serves local media (proxies, keyframes, originals) to the renderer.
  protocol.handle("media", (request) => {
    const raw = request.url.slice("media://local/".length);
    const filePath = decodeURIComponent(raw);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });
  setGlobalModelsDir(path.join(dataDir, "models"));

  // Crash-visibility for remote debugging: everything lands in dailies.log.
  const logFile = path.join(dataDir, "dailies.log");
  const logLine = (level: string, args: unknown[]) => {
    try {
      const text = args
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a)))
        .join(" ");
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${text}\n`);
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
  const manager = createProjectManager({
    dataDir,
    settings,
    onUpdate: () => {
      win?.webContents.send(IPC.projectUpdate);
    },
  });

  registerIpcHandlers({ manager, settings, dataDir, getWindow: () => win });

  // Re-open the last project (adopts a pre-projects install on first boot).
  try {
    manager.openLastProject();
  } catch (err) {
    console.error("Failed to open last project:", err);
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
