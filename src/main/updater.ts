/**
 * Auto-update: checks at launch, every hour, and whenever any window comes
 * to front (throttled). Downloads silently in the background, waits for the
 * platform updater to validate it, and installs on restart or next quit.
 * No dialogs — state pushes to the renderer over
 * IPC, which renders the banner, the top-right cluster (UpdateCluster —
 * hidden while the banner is up so only one restart affordance shows), the
 * rail chip, and the Settings & Jobs "Software update" panel
 * (JobsSettingsScreen) — those are the only consumers of this state.
 */
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow } from "electron";
// CJS interop: electron-updater ships no ESM build, and under esbuild-cjs
// output a named import of `autoUpdater` resolves to undefined at runtime.
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { IPC } from "../shared/ipc";
import type { UpdaterState } from "../shared/types";
import { downloadedUpdatePhase, updaterStrategy } from "./updater-strategy";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const FOCUS_CHECK_THROTTLE_MS = 10 * 60 * 1000; // at most once per 10 minutes

export interface UpdaterService {
  /** Wires electron-updater and schedules launch/hourly/focus checks. No-op when disabled. */
  start(): void;
  getState(): UpdaterState;
  /** User-initiated check (menu item or the Settings "Check now" button). No-op when disabled. */
  checkNow(): Promise<void>;
  /** Quits and installs. Only meaningful from phase "ready"; no-op when disabled. */
  restartNow(): void;
}

function classifyUpdateError(err: unknown): {
  errorKind: NonNullable<UpdaterState["errorKind"]>;
  errorMessage: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  if (/read-only volume/i.test(raw)) {
    return {
      errorKind: "read-only-volume",
      errorMessage: "Dailies cannot update itself from the Downloads folder or the disk image. Move Dailies to Applications, then retry.",
    };
  }
  if (/net::|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network/i.test(raw)) {
    return { errorKind: "network", errorMessage: "Could not reach GitHub — retrying in an hour" };
  }
  return { errorKind: "unknown", errorMessage: "Update check failed — retrying in an hour" };
}

export function createUpdater(getWindow: () => BrowserWindow | null): UpdaterService {
  const strategy = updaterStrategy(process.platform);
  // Dev runs and e2e harnesses (DAILIES_USER_DATA set) must never touch the
  // updater: no packaged app, no feed, no accidental restarts mid-test. Linux
  // packaging is not supported, so it has no updater strategy.
  const enabled = strategy !== null && app.isPackaged && !process.env["DAILIES_USER_DATA"];

  let state: UpdaterState = { phase: "idle", currentVersion: app.getVersion() };
  let busy = false; // a check (and its follow-on download) is in flight
  let manual = false; // whether the in-flight check was user-initiated
  let pendingAvailableVersion: string | undefined;
  let lastFocusCheckAt = 0;

  function pushState(patch: Partial<UpdaterState>): void {
    state = { ...state, ...patch };
    getWindow()?.webContents.send(IPC.updateStateChanged, state);
  }

  function settle(patch: Partial<UpdaterState>): void {
    busy = false;
    manual = false;
    pushState(patch);
  }

  function runCheck(isManual: boolean): Promise<void> {
    if (!enabled) return Promise.resolve();
    // Never overlap checks, and don't re-check while an update is staging or
    // sitting ready to install (a fresh check would just re-download it). A
    // manual click during a quiet background check promotes it instead of
    // being swallowed, so the user sees their click land.
    if (busy || state.phase === "ready" || state.phase === "staging") {
      if (busy && isManual && !manual && state.phase !== "downloading" && state.phase !== "staging") {
        manual = true;
        pushState({ phase: "checking" });
      }
      return Promise.resolve();
    }
    busy = true;
    manual = isManual;
    return autoUpdater.checkForUpdates().then(
      () => undefined,
      (err: unknown) => {
        settle({ phase: "error", ...classifyUpdateError(err), lastCheckedAt: Date.now() });
      },
    );
  }

  function setupListeners(): void {
    autoUpdater.on("checking-for-update", () => {
      // Scheduled checks never flash the row — only a manual one shows "Checking…".
      if (manual) pushState({ phase: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
      pendingAvailableVersion = info.version;
      // Stay quiet until the download actually starts (first progress tick).
    });

    autoUpdater.on("update-not-available", () => {
      settle({
        phase: "idle",
        lastCheckedAt: Date.now(),
        errorMessage: undefined,
        errorKind: undefined,
        availableVersion: undefined,
        transferred: undefined,
        total: undefined,
      });
    });

    autoUpdater.on("download-progress", (p) => {
      pushState({
        phase: "downloading",
        availableVersion: pendingAvailableVersion ?? state.availableVersion,
        transferred: Math.round(p.transferred),
        total: Math.round(p.total),
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      if (!strategy) return;
      // macOS still needs the native Squirrel.Mac staging event. NSIS has
      // already validated the downloaded package at this point on Windows.
      if (state.phase === "ready" && state.availableVersion === info.version) return;
      const phase = downloadedUpdatePhase(strategy);
      const patch: Partial<UpdaterState> = {
        phase,
        availableVersion: info.version,
        transferred: undefined,
        total: undefined,
      };
      if (phase === "ready") settle(patch);
      else pushState(patch);
    });

    if (strategy?.kind === "macos") {
      // Squirrel.Mac has validated and staged the update. Installing on
      // restart is now guaranteed to work.
      nativeAutoUpdater.on("update-downloaded", () => {
        settle({ phase: "ready", availableVersion: pendingAvailableVersion ?? state.availableVersion });
      });
    }

    // Native staging failures (bad signature, ShipIt errors) surface here via
    // electron-updater's own native error forwarding.
    autoUpdater.on("error", (err) => {
      settle({ phase: "error", ...classifyUpdateError(err), lastCheckedAt: Date.now() });
    });
  }

  return {
    start(): void {
      if (!enabled) return;

      autoUpdater.logger = {
        info: (message?: unknown) => console.warn(message),
        warn: (message?: unknown) => console.warn(message),
        error: (message?: unknown) => console.error(message),
      };
      autoUpdater.autoDownload = true;
      // autoInstallOnAppQuit stays at its electron-updater default (true).

      setupListeners();

      void runCheck(false); // launch check

      setInterval(() => void runCheck(false), CHECK_INTERVAL_MS);

      app.on("browser-window-focus", () => {
        const now = Date.now();
        if (now - lastFocusCheckAt < FOCUS_CHECK_THROTTLE_MS) return;
        lastFocusCheckAt = now;
        void runCheck(false);
      });
    },

    getState(): UpdaterState {
      return state;
    },

    checkNow(): Promise<void> {
      return runCheck(true);
    },

    restartNow(): void {
      if (!enabled) return;
      if (state.phase !== "ready" || !strategy) return;
      // Preserve the established Squirrel.Mac handoff. electron-updater owns
      // the NSIS install on Windows.
      if (strategy.kind === "macos") nativeAutoUpdater.quitAndInstall();
      else autoUpdater.quitAndInstall();
    },
  };
}
