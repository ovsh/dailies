import type { UpdaterState } from "./types";

/**
 * Field-wise equality for UpdaterState. The main process re-emits state on
 * every updater event — including repeated "update-downloaded" notifications
 * from periodic checks — so the renderer uses this to drop pushes that change
 * nothing instead of re-rendering (repeated events must be idempotent).
 */
export function updaterStatesEqual(a: UpdaterState, b: UpdaterState): boolean {
  return (
    a.phase === b.phase &&
    a.currentVersion === b.currentVersion &&
    a.availableVersion === b.availableVersion &&
    a.transferred === b.transferred &&
    a.total === b.total &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.errorMessage === b.errorMessage &&
    a.errorKind === b.errorKind
  );
}
