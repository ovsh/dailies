import type { UpdatePhase } from "../shared/types";

export type UpdaterStrategy =
  | { kind: "macos"; downloadedPhase: "staging" }
  | { kind: "windows"; downloadedPhase: "ready" };

export function updaterStrategy(platform: NodeJS.Platform): UpdaterStrategy | null {
  if (platform === "darwin") {
    return { kind: "macos", downloadedPhase: "staging" };
  }
  if (platform === "win32") {
    return { kind: "windows", downloadedPhase: "ready" };
  }
  return null;
}

export function downloadedUpdatePhase(strategy: UpdaterStrategy): UpdatePhase {
  return strategy.downloadedPhase;
}
