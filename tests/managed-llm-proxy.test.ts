import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_CHAT_MODELS,
  MANAGED_EMBEDDING_MODELS,
  matchBetaToken,
  parseBetaTokens,
  proxyToOpenRouter,
  sanitizeOperator,
  type UsageEntry,
} from "../infra/telemetry/lib/managed-llm";
import {
  CHAT_MODEL_OPTIONS,
  DEFAULT_CHAT_MODEL_ID,
  EMBEDDING_MODEL,
} from "../src/shared/types";

const ENV = { DAILIES_BETA_TOKENS: "ada:beta-one,beta-two", OPENROUTER_API_KEY: "sk-server" };
const CHAT_MODEL = DEFAULT_CHAT_MODEL_ID;

function chatRequest(init: {
  token?: string | null;
  operator?: string;
  body?: unknown;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== null) headers["authorization"] = `Bearer ${init.token ?? "beta-one"}`;
  if (init.operator !== undefined) headers["x-dailies-operator"] = init.operator;
  return new Request("https://telemetry.example/api/llm/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(init.body ?? { model: CHAT_MODEL, messages: [] }),
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function collect(): { entries: UsageEntry[]; log: (entry: UsageEntry) => void } {
  const entries: UsageEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

describe("beta token list", () => {
  it("labels named entries and numbers bare ones", () => {
    expect(parseBetaTokens("ada:beta-one, beta-two ,")).toEqual([
      { name: "ada", value: "beta-one" },
      { name: "#1", value: "beta-two" },
    ]);
  });

  it("is empty when the variable is unset", () => {
    expect(parseBetaTokens(undefined)).toEqual([]);
    expect(parseBetaTokens("  ")).toEqual([]);
  });

  it("matches only an exact bearer token", () => {
    const tokens = parseBetaTokens(ENV.DAILIES_BETA_TOKENS);

    expect(matchBetaToken("Bearer beta-two", tokens)).toEqual({ name: "#1", value: "beta-two" });
    expect(matchBetaToken("Bearer beta-on", tokens)).toBeNull();
    expect(matchBetaToken("beta-one", tokens)).toBeNull();
    expect(matchBetaToken(null, tokens)).toBeNull();
  });
});

describe("operator label", () => {
  it("strips anything that could forge a log line", () => {
    expect(sanitizeOperator("Ada\nlevel=error fake")).toBe("Ada levelerror fake");
    expect(sanitizeOperator('{"injected":1}')).toBe("injected1");
    expect(sanitizeOperator("   ")).toBeNull();
    expect(sanitizeOperator(null)).toBeNull();
  });

  it("caps the length like the app does", () => {
    expect(sanitizeOperator("x".repeat(80))).toHaveLength(40);
  });
});

describe("managed LLM proxy", () => {
  it("keeps the proxy model allowlists in sync with the app", () => {
    expect(MANAGED_CHAT_MODELS).toEqual(CHAT_MODEL_OPTIONS.map((option) => option.id));
    expect(MANAGED_EMBEDDING_MODELS).toEqual([EMBEDDING_MODEL]);
  });

  it("rejects missing and unexpected models before calling OpenRouter", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected upstream call");
    };
    const cases = [
      { path: "/chat/completions", body: { messages: [] } },
      { path: "/chat/completions", body: { model: "openai/unapproved", messages: [] } },
      { path: "/embeddings", body: { model: CHAT_MODEL, input: ["hello"] } },
    ];

    for (const item of cases) {
      const response = await proxyToOpenRouter(chatRequest({ body: item.body }), {
        path: item.path,
        env: ENV,
        fetchImpl,
        log: () => {},
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("model is not allowed");
    }
    expect(fetchCalls).toBe(0);
  });

  it("allows the application embedding model", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await proxyToOpenRouter(chatRequest({
      body: { model: EMBEDDING_MODEL, input: ["hello"] },
    }), {
      path: "/embeddings",
      env: ENV,
      fetchImpl,
      log: () => {},
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(fetchCalls).toBe(1);
  });

  it("rejects a missing or unknown token without calling OpenRouter", async () => {
    const fetchImpl = vi.fn();

    for (const token of [null, "not-a-token"]) {
      const res = await proxyToOpenRouter(chatRequest({ token }), {
        path: "/chat/completions",
        env: ENV,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: () => {},
      });
      expect(res.status).toBe(401);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is off when no beta tokens are configured", async () => {
    const res = await proxyToOpenRouter(chatRequest(), {
      path: "/chat/completions",
      env: { OPENROUTER_API_KEY: "sk-server" },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      log: () => {},
    });

    expect(res.status).toBe(503);
  });

  it("refuses a valid token when the server has no OpenRouter key", async () => {
    const res = await proxyToOpenRouter(chatRequest(), {
      path: "/chat/completions",
      env: { DAILIES_BETA_TOKENS: ENV.DAILIES_BETA_TOKENS },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      log: () => {},
    });

    expect(res.status).toBe(503);
  });

  it("forwards the body verbatim with the server key, never the beta token", async () => {
    const body = { model: CHAT_MODEL, messages: [{ role: "user", content: "hi" }] };
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({ choices: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const res = await proxyToOpenRouter(chatRequest({ body }), {
      path: "/chat/completions",
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });
    await res.text();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-server");
    expect(JSON.stringify(headers)).not.toContain("beta-one");
    expect(JSON.parse(String(init!.body))).toEqual(body);
  });

  it("streams SSE through byte for byte and logs the final usage", async () => {
    const frames = [
      ": OPENROUTER PROCESSING\n\n",
      `data: {"model":"${CHAT_MODEL}","choices":[{"delta":{"content":"he"}}]}\n\n`,
      'data: {"choices":[{"delta":{"content":"llo"}}],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n',
      "data: [DONE]\n\n",
    ];
    const { entries, log } = collect();
    const fetchImpl = vi.fn(async () => sseResponse(frames));

    const res = await proxyToOpenRouter(
      chatRequest({ operator: "Ada Lovelace", body: { model: CHAT_MODEL, stream: true } }),
      { path: "/chat/completions", env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, log },
    );

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(frames.join(""));
    expect(entries).toEqual([{
      t: expect.any(String) as unknown as string,
      route: "chat/completions",
      operator: "Ada Lovelace",
      token: "ada",
      model: CHAT_MODEL,
      status: 200,
      stream: true,
      usage: { prompt: 11, completion: 3, total: 14 },
    }]);
  });

  it("survives a malformed SSE frame without losing bytes", async () => {
    const frames = ["data: {not json\n\n", 'data: {"usage":{"total_tokens":5}}\n\n'];
    const { entries, log } = collect();

    const res = await proxyToOpenRouter(chatRequest({ body: { model: CHAT_MODEL, stream: true } }), {
      path: "/chat/completions",
      env: ENV,
      fetchImpl: (async () => sseResponse(frames)) as unknown as typeof fetch,
      log,
    });

    expect(await res.text()).toBe(frames.join(""));
    expect(entries[0]!.usage).toEqual({ total: 5 });
  });

  it("reads usage out of a non-streamed JSON reply", async () => {
    const { entries, log } = collect();
    const upstream = { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 9, total_tokens: 12 } };

    const res = await proxyToOpenRouter(chatRequest(), {
      path: "/chat/completions",
      env: ENV,
      fetchImpl: (async () => new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      log,
    });

    expect(await res.json()).toEqual(upstream);
    expect(entries[0]).toMatchObject({
      route: "chat/completions",
      stream: false,
      usage: { prompt: 9, total: 12 },
    });
  });

  it("passes an OpenRouter error through with its status and shape", async () => {
    const { entries, log } = collect();

    const res = await proxyToOpenRouter(chatRequest(), {
      path: "/chat/completions",
      env: ENV,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "at capacity" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      log,
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "at capacity" } });
    expect(entries[0]).toMatchObject({ status: 429 });
  });

  it("reports an unreachable upstream as 502", async () => {
    const { entries, log } = collect();

    const res = await proxyToOpenRouter(chatRequest(), {
      path: "/chat/completions",
      env: ENV,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      log,
    });

    expect(res.status).toBe(502);
    expect(entries[0]).toMatchObject({ status: 502 });
  });

  it("rejects a body that is not JSON", async () => {
    const request = new Request("https://telemetry.example/api/llm/embeddings", {
      method: "POST",
      headers: { authorization: "Bearer beta-one", "content-type": "application/json" },
      body: "not json",
    });

    const res = await proxyToOpenRouter(request, {
      path: "/embeddings",
      env: ENV,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      log: () => {},
    });

    expect(res.status).toBe(400);
  });

  it("never puts request content in the usage log", async () => {
    const { entries, log } = collect();
    const secret = "the witness names the town";

    const res = await proxyToOpenRouter(
      chatRequest({ body: { model: CHAT_MODEL, messages: [{ role: "user", content: secret }] } }),
      {
        path: "/chat/completions",
        env: ENV,
        fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: secret } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
        log,
      },
    );
    await res.text();

    expect(JSON.stringify(entries)).not.toContain(secret);
  });
});
