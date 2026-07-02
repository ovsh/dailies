import { app, BrowserWindow, net, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db/database";
import { createPipeline, type Pipeline } from "./pipeline";
import { registerIpcHandlers } from "./ipc-handlers";
import { getWatchedFolders, getWhisperModel, getApiKey } from "./settings";
import { createGeminiEmbedder, createGeminiIndexer } from "./agents/gemini";

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
    backgroundColor: "#121014",
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

  const db = openDatabase(path.join(dataDir, "dailies.db"));
  db.resetRunningJobs();

  const pipeline: Pipeline = createPipeline({
    db,
    dataDir,
    whisperModel: getWhisperModel(db),
    gemini: () => {
      const key = getApiKey(db, "gemini");
      return key ? createGeminiIndexer(() => key) : null;
    },
    embedder: () => {
      const key = getApiKey(db, "gemini");
      return key ? createGeminiEmbedder(() => key) : null;
    },
    onUpdate: () => {
      win?.webContents.send("dailies:indexUpdate");
    },
  });

  registerIpcHandlers({ db, pipeline, getWindow: () => win });

  for (const folder of getWatchedFolders(db)) {
    pipeline.watchFolder(folder);
    void pipeline.scanFolder(folder);
  }
  pipeline.start();

  win = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });

  app.on("before-quit", () => {
    void pipeline.stop();
    db.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
