/**
 * Minimal auto-update: check once at startup, download silently, prompt to
 * restart once the download lands. No manual UI yet — see
 * docs/plans/self-update-and-diagnostics/ for the fuller experience.
 */
import { app, dialog, BrowserWindow } from "electron";
// CJS interop: electron-updater ships no ESM build, and under esbuild-cjs
// output a named import of `autoUpdater` resolves to undefined at runtime.
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;

export function startAutoUpdater(): void {
  // Dev runs and e2e harnesses (DAILIES_USER_DATA set) must never touch the
  // updater: no packaged app, no feed, no accidental restarts mid-test.
  if (!app.isPackaged || process.env["DAILIES_USER_DATA"]) return;

  autoUpdater.logger = {
    info: (message?: unknown) => console.warn(message),
    warn: (message?: unknown) => console.warn(message),
    error: (message?: unknown) => console.error(message),
  };
  autoUpdater.autoDownload = true;

  autoUpdater.on("update-downloaded", (info) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const promise = win
      ? dialog.showMessageBox(win, {
          message: "An update is ready",
          detail: `Dailies ${info.version} has been downloaded. Restart to use it.`,
          buttons: ["Restart now", "Later"],
          defaultId: 0,
        })
      : dialog.showMessageBox({
          message: "An update is ready",
          detail: `Dailies ${info.version} has been downloaded. Restart to use it.`,
          buttons: ["Restart now", "Later"],
          defaultId: 0,
        });
    void promise.then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error("Update check failed:", err);
  });
}
