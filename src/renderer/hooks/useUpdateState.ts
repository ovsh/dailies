import { useEffect, useState } from "react";
import { api } from "../api";
import type { UpdaterState } from "../../shared/types";
import { updaterStatesEqual } from "../../shared/updater-state";

const FALLBACK_STATE: UpdaterState = { phase: "idle", currentVersion: "" };

/** Subscribes to the main process's update state (see src/main/updater.ts). */
export function useUpdateState(): UpdaterState {
  const [state, setState] = useState<UpdaterState>(FALLBACK_STATE);

  useEffect(() => {
    let mounted = true;
    // Repeated pushes of the same state (e.g. "update-downloaded" re-firing on
    // a periodic check) must be no-ops, not re-renders: keep the old object.
    const apply = (s: UpdaterState) => setState((prev) => (updaterStatesEqual(prev, s) ? prev : s));
    void api.getUpdateState().then((s) => {
      if (mounted) apply(s);
    });
    const unsubscribe = api.onUpdateStateChanged(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return state;
}
