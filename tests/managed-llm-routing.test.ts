import { afterEach, describe, expect, it, vi } from "vitest";

import { managedLlmConfig, resolveLlmRoute } from "../src/main/managed-llm";
import { createOpenRouterClient } from "../src/main/agents/openrouter-client";
import { hasLlmAccessStatus, type ApiKeyStatus } from "../src/shared/types";

const MANAGED = { baseUrl: "https://proxy.example/api/llm", token: "beta-token" };

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

describe("LLM routing", () => {
  it("treats user-funded and managed access as ready", () => {
    const readiness = Object.fromEntries(
      (["missing", "managed", "connected", "invalid", "unavailable"] satisfies ApiKeyStatus[])
        .map((status) => [status, hasLlmAccessStatus(status)]),
    );

    expect(readiness).toEqual({
      missing: false,
      managed: true,
      connected: true,
      invalid: false,
      unavailable: false,
    });
  });

  it("sends a user key straight to OpenRouter", () => {
    const route = resolveLlmRoute({ userKey: "sk-user", managed: MANAGED, operatorName: "Ada" });

    expect(route).toEqual({
      kind: "direct",
      baseUrl: "https://openrouter.ai/api/v1",
      authToken: "sk-user",
    });
  });

  it("ignores a blank user key rather than routing direct with it", () => {
    const route = resolveLlmRoute({ userKey: "   ", managed: MANAGED });

    expect(route?.kind).toBe("managed");
  });

  it("uses the proxy only when there is no user key", () => {
    const route = resolveLlmRoute({ userKey: null, managed: MANAGED, operatorName: "Ada" });

    expect(route).toEqual({
      kind: "managed",
      baseUrl: "https://proxy.example/api/llm",
      authToken: "beta-token",
      operator: "Ada",
    });
  });

  it("has no route when there is neither a key nor a managed build", () => {
    expect(resolveLlmRoute({ userKey: null, managed: null })).toBeNull();
  });
});

describe("baked managed config", () => {
  it("is absent in a build without both values", () => {
    expect(managedLlmConfig()).toBeNull();

    vi.stubGlobal("__DAILIES_MANAGED_LLM_URL__", "https://proxy.example/api/llm");
    expect(managedLlmConfig()).toBeNull();
  });

  it("trims a trailing slash so the paths join cleanly", () => {
    vi.stubGlobal("__DAILIES_MANAGED_LLM_URL__", "https://proxy.example/api/llm/");
    vi.stubGlobal("__DAILIES_MANAGED_LLM_TOKEN__", "  beta-token  ");

    expect(managedLlmConfig()).toEqual({
      baseUrl: "https://proxy.example/api/llm",
      token: "beta-token",
    });
  });
});

describe("OpenRouter client in managed mode", () => {
  it("calls the proxy with the beta token and the operator label", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenRouterClient(() => null, {
      managed: () => MANAGED,
      operatorName: () => "Ada Lovelace",
    });

    await client.chat({ model: "test-model", messages: [] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://proxy.example/api/llm/chat/completions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer beta-token",
      "HTTP-Referer": "https://dailies.app",
      "X-Title": "Dailies",
      "X-Dailies-Operator": "Ada Lovelace",
    });
  });

  it("routes embeddings through the proxy too", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenRouterClient(() => null, { managed: () => MANAGED });

    await client.embed("test-model", ["hello"]);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://proxy.example/api/llm/embeddings");
  });

  it("omits the operator header when the install has no name yet", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenRouterClient(() => null, { managed: () => MANAGED });

    await client.chat({ model: "test-model", messages: [] });

    expect(fetchMock.mock.calls[0]![1]?.headers).not.toHaveProperty("X-Dailies-Operator");
  });

  it("never sends the beta token when the operator has their own key", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenRouterClient(() => "sk-user", {
      managed: () => MANAGED,
      operatorName: () => "Ada",
    });

    await client.chat({ model: "test-model", messages: [] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-user" });
    expect(init?.headers).not.toHaveProperty("X-Dailies-Operator");
  });

  it("still fails when there is no key and no managed build", async () => {
    const client = createOpenRouterClient(() => null, { managed: () => null });

    await expect(client.chat({ model: "test-model", messages: [] }))
      .rejects.toThrow("OpenRouter API key not set");
  });
});
