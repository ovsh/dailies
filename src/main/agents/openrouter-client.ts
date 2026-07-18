const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

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

function apiError(status: number, body: unknown): Error {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const detail = error && typeof error.message === "string" ? `: ${error.message}` : "";
  return new Error(`OpenRouter API error ${status}${detail}`);
}

export function createOpenRouterClient(getKey: () => string | null): OpenRouterClient {
  function requireKey(): string {
    const key = getKey();
    if (!key) throw new Error("OpenRouter API key not set");
    return key;
  }

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: headers(requireKey()),
        body: JSON.stringify(req),
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

    async embed(model: string, input: string[], dimensions?: number): Promise<number[][]> {
      const response = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
        method: "POST",
        headers: headers(requireKey()),
        body: JSON.stringify({ model, input, ...(dimensions === undefined ? {} : { dimensions }) }),
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
