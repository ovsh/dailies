import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenRouterClient,
  type ToolCall,
} from "../src/main/agents/openrouter-client";
import { createOpenRouterEmbedder } from "../src/main/agents/openrouter";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter client", () => {
  it("sends OpenAI-compatible system, tool, and image message shapes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenRouterClient(() => "test-key");

    await client.chat({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Follow the evidence." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is visible?" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" },
            },
          ],
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "search_visuals",
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "HTTP-Referer": "https://dailies.app",
      "X-Title": "Dailies",
    });
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.messages).toEqual([
      { role: "system", content: "Follow the evidence." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is visible?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" } },
        ],
      },
    ]);
    expect(body.tools).toEqual([{
      type: "function",
      function: {
        name: "search_visuals",
        parameters: { type: "object", properties: {} },
      },
    }]);
  });

  it("returns tool calls from the assistant message", async () => {
    const toolCall: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "search_transcripts", arguments: "{\"query\":\"bear\"}" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ message: { content: null, tool_calls: [toolCall] } }],
    })));

    const client = createOpenRouterClient(() => "test-key");
    const response = await client.chat({ model: "test-model", messages: [] });

    expect(response.message.tool_calls).toEqual([toolCall]);
  });

  it("includes the HTTP status in API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: { message: "Provider is at capacity" },
    }, 429)));

    const client = createOpenRouterClient(() => "test-key");
    await expect(client.chat({ model: "test-model", messages: [] })).rejects.toThrow("429");
  });

  it("batches embeddings at 100, sends dimensions, and normalizes vectors", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const vector = new Array<number>(768).fill(0);
      vector[0] = 3;
      vector[1] = 4;
      return jsonResponse({
        data: body.input.map((_text, index) => ({ index, embedding: vector })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenRouterClient(() => "test-key");
    const embedder = createOpenRouterEmbedder(client);

    const vectors = await embedder.embed(Array.from({ length: 101 }, (_, index) => `text ${index}`));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[]; dimensions: number };
      expect(body.model).toBe("google/gemini-embedding-001");
      expect(body.input.length).toBeLessThanOrEqual(100);
      expect(body.dimensions).toBe(768);
    }
    expect(vectors).toHaveLength(101);
    expect(vectors[0]).toHaveLength(768);
    expect(vectors[0]![0]).toBeCloseTo(0.6, 5);
    expect(vectors[0]![1]).toBeCloseTo(0.8, 5);
  });

  it("rejects embeddings with the wrong dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: new Array<number>(767).fill(0) }],
    })));
    const client = createOpenRouterClient(() => "test-key");
    const embedder = createOpenRouterEmbedder(client);

    await expect(embedder.embed(["wrong size"])).rejects.toThrow("expected 768");
  });
});
