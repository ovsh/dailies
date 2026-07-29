import { useEffect, useState } from "react";
import { api } from "../api";
import type { UpdaterState } from "../../shared/types";

const FALLBACK_STATE: UpdaterState = { phase: "idle", currentVersion: "" };

/** Subscribes to the main process's update state (see src/main/updater.ts). */
export function useUpdateState(): UpdaterState {
  const [state, setState] = useState<UpdaterState>(FALLBACK_STATE);

  useEffect(() => {
    let mounted = true;
    void api.getUpdateState().then((s) => {
      if (mounted) setState(s);
    });
    const unsubscribe = api.onUpdateStateChanged((s) => setState(s));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return state;
}
