/**
 * Managed LLM mode — closed beta only.
 *
 * A handful of testers should get chat and search without buying an
 * OpenRouter key first. Those builds carry a revocable beta token and a proxy
 * URL instead; the proxy (infra/telemetry, /api/llm) holds the real key.
 *
 * Invariants:
 * - The URL and token bake in at package time, exactly like telemetry's. A
 *   build without both — every dev build and every normal release — has no
 *   managed access at all, so the feature cannot leak past the beta.
 * - A user-supplied key always wins and goes straight to OpenRouter. Managed
 *   mode is the fallback for people who have no key, never an override for
 *   people who do.
 */

// Replaced by esbuild --define at package time; empty in dev builds.
declare const __DAILIES_MANAGED_LLM_URL__: string;
declare const __DAILIES_MANAGED_LLM_TOKEN__: string;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ManagedLlmConfig {
  /** Base URL; `/chat/completions` and `/embeddings` hang off it, as on OpenRouter. */
  baseUrl: string;
  token: string;
}

export type LlmRoute =
  | { kind: "direct"; baseUrl: string; authToken: string }
  | { kind: "managed"; baseUrl: string; authToken: string; operator: string | null };

/** The baked proxy config, or null when this build has no managed access. */
export function managedLlmConfig(): ManagedLlmConfig | null {
  const url = typeof __DAILIES_MANAGED_LLM_URL__ === "string" ? __DAILIES_MANAGED_LLM_URL__ : "";
  const token = typeof __DAILIES_MANAGED_LLM_TOKEN__ === "string" ? __DAILIES_MANAGED_LLM_TOKEN__ : "";
  const baseUrl = url.trim().replace(/\/+$/, "");
  const trimmedToken = token.trim();
  if (baseUrl.length === 0 || trimmedToken.length === 0) return null;
  return { baseUrl, token: trimmedToken };
}

/** True on a beta build. Callers use it to answer "can this install use an LLM at all". */
export function managedLlmAvailable(): boolean {
  return managedLlmConfig() !== null;
}

/**
 * The whole routing rule, in one place: own key first, managed second,
 * nothing third.
 */
export function resolveLlmRoute(opts: {
  userKey: string | null;
  managed: ManagedLlmConfig | null;
  operatorName?: string | null;
}): LlmRoute | null {
  const userKey = opts.userKey?.trim();
  if (userKey) return { kind: "direct", baseUrl: OPENROUTER_BASE_URL, authToken: userKey };
  if (!opts.managed) return null;
  return {
    kind: "managed",
    baseUrl: opts.managed.baseUrl,
    authToken: opts.managed.token,
    operator: opts.operatorName ?? null,
  };
}
