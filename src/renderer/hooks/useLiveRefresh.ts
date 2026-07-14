import { useEffect } from "react";
import { api } from "../api";

/** Coalesces index-update bursts and never overlaps refresh requests. */
export function useLiveRefresh(refresh: () => Promise<void>, delayMs = 250): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let rerun = false;
    let disposed = false;

    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (inFlight) {
          rerun = true;
          return;
        }
        inFlight = true;
        void refresh()
          .catch(() => {
            // The screen's refresh owns its inline error state.
          })
          .finally(() => {
            inFlight = false;
            if (rerun) {
              rerun = false;
              schedule();
            }
          });
      }, delayMs);
    };

    const unsubscribe = api.onIndexUpdate(schedule);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [delayMs, refresh]);
}
