import { EMBEDDING_MODEL, type ChatEffort } from "../../shared/types";
import {
  managedLlmConfig,
  OPENROUTER_BASE_URL,
  resolveLlmRoute,
  type LlmRoute,
  type ManagedLlmConfig,
} from "../managed-llm";

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "required" | "none";
  response_format?: { type: "json_object" };
  /** OpenRouter reasoning control; ignored by models without reasoning. */
  reasoning?: { effort: ChatEffort };
}

export interface ChatResponse {
  message: { content: string | null; tool_calls?: ToolCall[] };
}

export interface OpenRouterClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(model: string, input: string[], dimensions?: number): Promise<number[][]>;
}

function headers(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://dailies.app",
    "X-Title": "Dailies",
  };
}

/** Same headers either way, plus the operator label the proxy attributes usage to. */
function routeHeaders(route: LlmRoute): Record<string, string> {
  const base = headers(route.authToken);
  if (route.kind === "managed" && route.operator) base["X-Dailies-Operator"] = route.operator;
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class OpenRouterApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OpenRouterApiError";
  }
}

function apiError(status: number, body: unknown): OpenRouterApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const detail = error && typeof error.message === "string" ? `: ${error.message}` : "";
  return new OpenRouterApiError(`OpenRouter API error ${status}${detail}`, status);
}

export interface OpenRouterClientOptions {
  /** Read per request so a rename applies to the next call, not the next launch. */
  operatorName?: () => string | null;
  /** Test seam; production reads the config baked in at package time. */
  managed?: () => ManagedLlmConfig | null;
}

export function createOpenRouterClient(
  getKey: () => string | null,
  options: OpenRouterClientOptions = {},
): OpenRouterClient {
  function requireRoute(): LlmRoute {
    const route = resolveLlmRoute({
      userKey: getKey(),
      managed: (options.managed ?? managedLlmConfig)(),
      operatorName: options.operatorName?.() ?? null,
    });
    if (!route) throw new Error("OpenRouter API key not set");
    return route;
  }

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const route = requireRoute();
      const response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: routeHeaders(route),
        body: JSON.stringify({
          ...req,
          provider: { allow_fallbacks: false },
        }),
      });
      const body = await readJson(response);
      if (!response.ok) throw apiError(response.status, body);

      const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
      const first = choices[0];
      const message = isRecord(first) && isRecord(first.message) ? first.message : null;
      if (!message) throw new Error("OpenRouter chat response did not include a message");
      return {
        message: {
          content: typeof message.content === "string" ? message.content : null,
          ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls as ToolCall[] } : {}),
        },
      };
    },

    async embed(_model: string, input: string[], dimensions?: number): Promise<number[][]> {
      const route = requireRoute();
      const response = await fetch(`${route.baseUrl}/embeddings`, {
        method: "POST",
        headers: routeHeaders(route),
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input,
          ...(dimensions === undefined ? {} : { dimensions }),
          provider: { allow_fallbacks: false },
        }),
      });
      const body = await readJson(response);
      if (!response.ok) throw apiError(response.status, body);

      const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
      if (!data) throw new Error("OpenRouter embeddings response did not include data");
      return data
        .filter(isRecord)
        .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
        .map((row) => (Array.isArray(row.embedding) ? row.embedding.map(Number) : []));
    },
  };
}

export async function validateOpenRouterKey(
  key: string,
): Promise<"connected" | "invalid" | "unavailable"> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      method: "GET",
      headers: headers(key),
      signal: controller.signal,
    });
    if (response.status === 200) return "connected";
    if (response.status === 401 || response.status === 403) return "invalid";
    return "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}
