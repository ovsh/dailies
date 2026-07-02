import type { DailiesAPI } from "../shared/ipc";

declare global {
  interface Window {
    dailies?: DailiesAPI;
  }
}
