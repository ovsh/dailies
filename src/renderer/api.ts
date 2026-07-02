import type { DailiesAPI } from "../shared/ipc";
import { createMockApi } from "./mock/api";

export const api: DailiesAPI = window.dailies ?? createMockApi();

/**
 * Converts an absolute local media path into something an <img>/<video> can load.
 * Data URIs (mock) and already-resolved URLs pass through untouched.
 */
export function mediaUrl(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  if (p.startsWith("data:") || p.startsWith("http") || p.startsWith("media:")) return p;
  return api.fileUrl(p);
}
