/**
 * One-click self-update via electron-updater. The feed (latest-mac.yml +
 * update zip) is published to GitHub releases by `npm run release`; the app
 * checks it on launch and every 10 minutes — a single ~1 KB HTTPS GET.
 *
 * Deliberately autoDownload=false: an update surfaces as a small pill in
 * the rail first, and the ~download only starts when the user clicks it
 * (editors on set are often on metered or terrible connections). After the
 * download, one more click relaunches into the new version.
 *
 * State machine, mirrored to the renderer on every transition:
 *   idle -> checking -> available -> downloading -> ready
 *                    \-> idle (no update)      \-> error (version kept, retry offered)
 */
import { app } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "../shared/types";
import { log } from "./log";

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 10 * 60_000;

export interface Updater {
  getState(): UpdateState;
  check(): void;
  download(): void;
  install(): void;
  /** Begins the periodic background checks (no-op when unsupported). */
  start(): void;
}

export function createUpdater(onEvent: (state: UpdateState) => void): Updater {
  // Self-update needs a packaged, installed app; dev and e2e runs have no
  // app-update.yml and must never touch a real install.
  const supported = app.isPackaged && !process.env["DAILIES_USER_DATA"];

  let state: UpdateState = {
    phase: "idle",
    version: null,
    percent: null,
    error: null,
    lastCheckedAt: null,
    supported,
  };

  function set(next: Partial<UpdateState>): void {
    state = { ...state, ...next };
    onEvent(state);
  }

  if (supported) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: () => {},
      debug: () => {},
      warn: (msg: unknown) => log.warn("updater", "updater.internal", { message: String(msg) }),
      error: (msg: unknown) => log.warn("updater", "updater.internal", { message: String(msg) }),
    };

    autoUpdater.on("checking-for-update", () => {
      if (state.phase === "idle") set({ phase: "checking" });
    });
    autoUpdater.on("update-available", (info) => {
      log.info("updater", "updater.available", { version: info.version });
      set({ phase: "available", version: info.version, error: null, lastCheckedAt: new Date().toISOString() });
    });
    autoUpdater.on("update-not-available", () => {
      set({ phase: "idle", version: null, error: null, lastCheckedAt: new Date().toISOString() });
    });
    autoUpdater.on("download-progress", (p) => {
      set({ phase: "downloading", percent: Math.round(p.percent) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      log.info("updater", "updater.downloaded", { version: info.version });
      set({ phase: "ready", version: info.version, percent: 100, error: null });
    });
    autoUpdater.on("error", (err) => {
      log.error("updater", "updater.failed", { during: state.phase }, err);
      // Keep the offered version so the pill can present a retry.
      set({
        phase: state.version ? "error" : "idle",
        percent: null,
        error: err.message,
        lastCheckedAt: new Date().toISOString(),
      });
    });
  }

  function check(): void {
    if (!supported) return;
    if (state.phase === "downloading" || state.phase === "ready") return;
    autoUpdater.checkForUpdates().catch(() => {
      // surfaced via the "error" event
    });
  }

  return {
    getState: () => state,
    check,
    download(): void {
      if (!supported || !state.version) return;
      if (state.phase === "downloading" || state.phase === "ready") return;
      log.info("updater", "updater.download.start", { version: state.version });
      set({ phase: "downloading", percent: 0, error: null });
      autoUpdater.downloadUpdate().catch(() => {
        // surfaced via the "error" event
      });
    },
    install(): void {
      if (!supported || state.phase !== "ready") return;
      log.info("updater", "updater.install", { version: state.version });
      autoUpdater.quitAndInstall();
    },
    start(): void {
      if (!supported) return;
      setTimeout(check, FIRST_CHECK_DELAY_MS);
      setInterval(check, CHECK_INTERVAL_MS);
    },
  };
}
