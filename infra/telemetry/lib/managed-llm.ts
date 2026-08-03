/**
 * Managed LLM proxy — closed beta only.
 *
 * A beta build of Dailies carries a revocable beta token instead of an
 * OpenRouter key. This module swaps that token for the real key and forwards
 * the request to OpenRouter unchanged. Two rules it must never break:
 *
 * - The OpenRouter key never leaves the server. It is resolved from sealed
 *   server storage and only ever written to the upstream header.
 * - Request and response CONTENT is never logged. The usage line carries who,
 *   which model, and how many tokens — nothing else. Model inputs pass through
 *   this server, but retaining them here would break the product's privacy
 *   promise.
 *
 * Spend is capped on the OpenRouter key itself (credit limit in their
 * dashboard); the proxy does no metering of its own. The kill switch is
 * removing a token from DAILIES_BETA_TOKENS, or revoking the OpenRouter key.
 */
import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";

import { bearerToken, constantTimeEqual } from "./auth";
import { resolveSealedSecret, type ResolvedSecret } from "./key-store";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Server-owned copies of the models shipped by the app. The proxy cannot
 * import from src/ because infra/telemetry deploys as its own Vercel root.
 * A test compares these lists with the app constants so either side cannot
 * change without an explicit proxy update.
 */
export const MANAGED_CHAT_MODELS = [
  "deepseek/deepseek-v4-flash-0731",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "x-ai/grok-4.5",
  "google/gemini-3.6-flash",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k3",
] as const;

export const MANAGED_EMBEDDING_MODELS = ["google/gemini-embedding-001"] as const;

const MANAGED_CHAT_MODEL_SET: ReadonlySet<string> = new Set<string>(MANAGED_CHAT_MODELS);
const MANAGED_EMBEDDING_MODEL_SET: ReadonlySet<string> = new Set<string>(MANAGED_EMBEDDING_MODELS);

/** Vercel functions cap request bodies at 4.5MB; stop short of that ourselves. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * How much of a non-SSE response we are willing to hold while looking for its
 * `usage` block. Chat replies are a few KB; an embeddings batch is megabytes
 * of floats, and those we simply stop reading. The bytes still stream to the
 * client either way — this cap only bounds the bookkeeping copy.
 */
const JSON_TAP_LIMIT = 512 * 1024;

export interface BetaToken {
  /** Label from `name:token`, or `#index` for a bare token. Appears in logs. */
  name: string;
  value: string;
}

export interface UsageCounts {
  prompt?: number;
  completion?: number;
  total?: number;
}

export interface UsageEntry {
  t: string;
  route: string;
  operator: string | null;
  token: string;
  model: string | null;
  status: number;
  stream: boolean;
  usage?: UsageCounts;
}

export interface ProxyEnv {
  DAILIES_BETA_TOKENS?: string | undefined;
  DAILIES_KEY_SEAL?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
}

export type OpenRouterKeyResolver = (env: ProxyEnv) => Promise<ResolvedSecret>;

export interface ProxyOptions {
  /** Path under the OpenRouter v1 base, e.g. "/chat/completions". */
  path: string;
  env?: ProxyEnv;
  fetchImpl?: typeof fetch;
  log?: (entry: UsageEntry) => void;
  /** Durable copy of the usage line. Injected so tests never touch the store. */
  persist?: (entry: UsageEntry) => void;
  now?: () => Date;
  resolveKey?: OpenRouterKeyResolver;
}

function readProxyEnv(source: NodeJS.ProcessEnv): ProxyEnv {
  return {
    DAILIES_BETA_TOKENS: source["DAILIES_BETA_TOKENS"],
    DAILIES_KEY_SEAL: source["DAILIES_KEY_SEAL"],
    OPENROUTER_API_KEY: source["OPENROUTER_API_KEY"],
  };
}

export function resolveOpenRouterKey(env: ProxyEnv): Promise<ResolvedSecret> {
  return resolveSealedSecret({
    seal: env.DAILIES_KEY_SEAL,
    fallback: env.OPENROUTER_API_KEY,
  });
}

/**
 * Comma-separated list so a tester can be added or revoked by editing one
 * environment variable — no deploy of new code. Entries are either a bare
 * token or `label:token`; a label makes the usage log readable.
 */
export function parseBetaTokens(raw: string | undefined): BetaToken[] {
  if (!raw) return [];
  const tokens: BetaToken[] = [];
  raw.split(",").forEach((entry, index) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const colon = trimmed.indexOf(":");
    const labelled = colon > 0 && colon < trimmed.length - 1;
    const name = labelled ? trimmed.slice(0, colon).trim() : `#${index}`;
    const value = labelled ? trimmed.slice(colon + 1).trim() : trimmed;
    if (value) tokens.push({ name: name || `#${index}`, value });
  });
  return tokens;
}

/** Null for a missing, malformed, or unknown token. */
export function matchBetaToken(header: string | null, tokens: BetaToken[]): BetaToken | null {
  const presented = bearerToken(header);
  if (!presented) return null;
  // No early exit: every token is compared so a match late in the list costs
  // the same as one at the front.
  let matched: BetaToken | null = null;
  for (const token of tokens) {
    if (constantTimeEqual(token.value, presented)) matched = token;
  }
  return matched;
}

/**
 * The operator name is attacker-controlled text that lands in a log line, so
 * strip anything that could forge a line break or a field separator.
 */
export function sanitizeOperator(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    // Whitespace first, so a newline separates words instead of welding them.
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} .,'’\-_]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 40)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUsage(value: unknown): UsageCounts | null {
  if (!isRecord(value)) return null;
  const counts: UsageCounts = {};
  if (typeof value["prompt_tokens"] === "number") counts.prompt = value["prompt_tokens"];
  if (typeof value["completion_tokens"] === "number") counts.completion = value["completion_tokens"];
  if (typeof value["total_tokens"] === "number") counts.total = value["total_tokens"];
  return Object.keys(counts).length > 0 ? counts : null;
}

/**
 * Passes every byte through untouched and, on the side, remembers the last
 * `usage` block and model id it saw. Parsing is wrapped in try/catch
 * throughout: the byte stream is the product, the token count is a bonus, and
 * a malformed frame must never cost the tester their answer.
 */
function usageTap(
  mode: "sse" | "json",
  onEnd: (usage: UsageCounts | null, model: string | null) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let overflowed = false;
  let usage: UsageCounts | null = null;
  let model: string | null = null;

  function absorb(frame: unknown): void {
    if (!isRecord(frame)) return;
    if (typeof frame["model"] === "string") model = frame["model"];
    const counts = readUsage(frame["usage"]);
    if (counts) usage = counts;
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (overflowed) return;
      try {
        pending += decoder.decode(chunk, { stream: true });
        if (mode === "json") {
          if (pending.length > JSON_TAP_LIMIT) {
            overflowed = true;
            pending = "";
          }
          return;
        }
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          // Skips OpenRouter's `: OPENROUTER PROCESSING` keep-alive comments.
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          absorb(JSON.parse(payload));
        }
        if (pending.length > JSON_TAP_LIMIT) pending = "";
      } catch {
        pending = "";
      }
    },
    flush() {
      try {
        if (mode === "json" && !overflowed && pending) absorb(JSON.parse(pending));
      } catch {
        // A body we could not parse just means no token count for this call.
      }
      onEnd(usage, model);
    },
  });
}

function defaultLog(entry: UsageEntry): void {
  // One line, one JSON object: greppable in Vercel's runtime logs.
  console.log(`managed-llm ${JSON.stringify(entry)}`);
}

/**
 * The same line, kept. Vercel's runtime logs age out within days, so the
 * dashboard reads these blobs instead.
 *
 * Three constraints, in order of importance:
 * - It must never delay or fail the proxy. Nothing awaits this; the synchronous
 *   part is wrapped so a misconfigured store cannot throw into the response
 *   path, and the promise's rejection is handled rather than dropped.
 * - It writes the SAME object the log line carries — no request or response
 *   content, ever. The blob store is public-by-URL, so this is the boundary
 *   that keeps the privacy promise true.
 * - Without a store token (dev, tests) it does nothing at all.
 *
 * `waitUntil` is what makes "fire and forget" true on Vercel. The runtime is
 * free to freeze the instance the moment the response ends, so an unregistered
 * background write is simply lost — most often on the last request of a quiet
 * period, which is the one worth having. It extends the instance's life, not
 * the client's wait.
 */
function defaultPersist(entry: UsageEntry): void {
  if (!process.env["BLOB_READ_WRITE_TOKEN"]) return;
  try {
    const at = new Date(entry.t);
    const stamp = Number.isNaN(at.getTime()) ? new Date() : at;
    const day = stamp.toISOString().slice(0, 10);
    const key = `llm/${day}/${stamp.getTime()}-${randomUUID().slice(0, 8)}.json`;
    const write = put(key, JSON.stringify(entry), {
      access: "public",
      contentType: "application/json",
    }).catch((error: unknown) => {
      // Bookkeeping is not worth a failed request, but a store that has been
      // silently rejecting writes for a week is worth knowing about.
      console.warn(`managed-llm persist failed ${key}: ${String(error)}`);
    });
    try {
      waitUntil(write);
    } catch {
      // Outside a request context (a local script, a test) there is nothing to
      // extend; the promise still runs to completion on its own.
    }
  } catch (error) {
    console.warn(`managed-llm persist skipped: ${String(error)}`);
  }
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function modelAllowed(route: string, model: unknown): model is string {
  if (typeof model !== "string") return false;
  if (route === "chat/completions") return MANAGED_CHAT_MODEL_SET.has(model);
  if (route === "embeddings") return MANAGED_EMBEDDING_MODEL_SET.has(model);
  return false;
}

/**
 * Authenticates a beta token, then forwards the body verbatim to OpenRouter
 * with the server-held key. The response — SSE or JSON, success or error — is
 * streamed straight back so the app sees exactly what OpenRouter said.
 */
export async function proxyToOpenRouter(request: Request, options: ProxyOptions): Promise<Response> {
  const env = options.env ?? readProxyEnv(process.env);
  const log = options.log ?? defaultLog;
  const persist = options.persist ?? defaultPersist;
  const fetchImpl = options.fetchImpl ?? fetch;
  const route = options.path.replace(/^\//, "");

  const tokens = parseBetaTokens(env.DAILIES_BETA_TOKENS);
  if (tokens.length === 0) return plain(503, "managed llm is off");

  const token = matchBetaToken(request.headers.get("authorization"), tokens);
  if (!token) return plain(401, "unauthorized");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return plain(413, "payload too large");
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) return plain(413, "payload too large");
  const body = parseObject(raw);
  if (!body) return plain(400, "invalid json");

  const requestedModel = body["model"];
  if (!modelAllowed(route, requestedModel)) return plain(400, "model is not allowed");

  let resolved: ResolvedSecret;
  try {
    resolved = await (options.resolveKey ?? resolveOpenRouterKey)(env);
  } catch {
    return plain(503, "managed llm is not configured");
  }
  const key = resolved.value?.trim();
  if (!key) return plain(503, "managed llm is not configured");

  const operator = sanitizeOperator(request.headers.get("x-dailies-operator"));
  const stream = body["stream"] === true;
  const at = (options.now ?? (() => new Date()))().toISOString();

  const record = (status: number, usage: UsageCounts | null, model: string | null): void => {
    const entry: UsageEntry = {
      t: at,
      route,
      operator,
      token: token.name,
      model: requestedModel ?? model,
      status,
      stream,
      ...(usage ? { usage } : {}),
    };
    // record() runs inside the streaming TransformStream's flush. A throw there
    // does not surface as an error — it tears the SSE stream down mid-answer,
    // which the app sees as a truncated reply. Bookkeeping never gets to do
    // that, injected or not.
    try {
      log(entry);
      persist(entry);
    } catch (error) {
      console.warn(`managed-llm record failed: ${String(error)}`);
    }
  };

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${OPENROUTER_BASE_URL}${options.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://dailies.app",
        "X-Title": "Dailies",
      },
      body: raw,
      signal: request.signal,
    });
  } catch {
    record(502, null, null);
    return plain(502, "upstream unavailable");
  }

  const headers = new Headers({ "cache-control": "no-store" });
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // Ask any proxy in front of us not to buffer the event stream.
  headers.set("x-accel-buffering", "no");

  if (!upstream.body) {
    record(upstream.status, null, null);
    return new Response(null, { status: upstream.status, headers });
  }

  const mode = (contentType ?? "").includes("text/event-stream") ? "sse" : "json";
  const tapped = upstream.body.pipeThrough(
    usageTap(mode, (usage, model) => record(upstream.status, usage, model)),
  );
  return new Response(tapped, { status: upstream.status, headers });
}
