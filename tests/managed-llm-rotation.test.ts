import { describe, expect, it } from "vitest";

import { GET, POST } from "../infra/telemetry/api/llm/admin";
import { adminKeyPage, rotateOpenRouterKey } from "../infra/telemetry/lib/admin";
import { bearerToken, constantTimeEqual, matchBearer } from "../infra/telemetry/lib/auth";
import {
  OPENROUTER_KEY_SECRET,
  SECRET_CACHE_TTL_MS,
  createVercelBlobStore,
  fingerprint,
  readSealKey,
  resolveSealedSecret,
  seal,
  unseal,
  type CacheEntry,
  type SecretBlobStore,
} from "../infra/telemetry/lib/key-store";
import { proxyToOpenRouter, type OpenRouterKeyResolver } from "../infra/telemetry/lib/managed-llm";

const ADMIN_TOKEN = "ab".repeat(32);
const SEAL = "11".repeat(32);
const OTHER_SEAL = "22".repeat(32);
const FALLBACK_KEY = "sk-or-v1-fallback-key";
const ROTATED_KEY = "sk-or-v1-rotated-key";

class MemoryBlobStore implements SecretBlobStore {
  body: string | null = null;
  reads = 0;
  writes: Array<{ pathname: string; body: string }> = [];
  readError: Error | null = null;
  writeError: Error | null = null;

  async read(_pathname: string): Promise<string | null> {
    this.reads += 1;
    if (this.readError) throw this.readError;
    return this.body;
  }

  async write(pathname: string, body: string): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.body = body;
    this.writes.push({ pathname, body });
  }
}

function keyFrom(hex: string): Buffer {
  const key = readSealKey(hex);
  if (!key) throw new Error("test seal is invalid");
  return key;
}

function rotationRequest(key: string, token = ADMIN_TOKEN): Request {
  return new Request("https://telemetry.example/api/llm/admin", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ key }),
  });
}

const acceptedKeyFetch: typeof fetch = async (input, init) => {
  expect(String(input)).toBe("https://openrouter.ai/api/v1/key");
  expect(init?.method).toBe("GET");
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ROTATED_KEY}`);
  return new Response(JSON.stringify({ data: { label: "managed beta" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

describe("bearer authentication", () => {
  it("parses one bearer token and rejects other authorization schemes", () => {
    expect(bearerToken("Bearer secret-token")).toBe("secret-token");
    expect(bearerToken("bearer   secret-token ")).toBe("secret-token");
    expect(bearerToken("Basic secret-token")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it("matches exact tokens, including unequal-length comparisons", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("short", "a-much-longer-value")).toBe(false);
    expect(matchBearer("Bearer expected", "expected")).toBe(true);
    expect(matchBearer("Bearer expected-extra", "expected")).toBe(false);
    expect(matchBearer(null, "expected")).toBe(false);
  });
});

describe("sealed key storage", () => {
  it("round-trips through AES-256-GCM without storing plaintext", () => {
    const sealKey = keyFrom(SEAL);
    const envelope = seal(OPENROUTER_KEY_SECRET, ROTATED_KEY, sealKey);
    const encoded = JSON.stringify(envelope);

    expect(encoded).not.toContain(ROTATED_KEY);
    expect(envelope.v).toBe(1);
    expect(unseal(OPENROUTER_KEY_SECRET, envelope, sealKey)).toBe(ROTATED_KEY);
  });

  it("rejects a tampered envelope and a wrong seal", () => {
    const envelope = seal(OPENROUTER_KEY_SECRET, ROTATED_KEY, keyFrom(SEAL));
    const tampered = { ...envelope, ct: `${envelope.ct.slice(0, -2)}AA` };

    expect(() => unseal(OPENROUTER_KEY_SECRET, tampered, keyFrom(SEAL))).toThrow();
    expect(() => unseal(OPENROUTER_KEY_SECRET, envelope, keyFrom(OTHER_SEAL))).toThrow();
  });

  it("uses a fresh cache before the blob, then refreshes at the TTL", async () => {
    const store = new MemoryBlobStore();
    const cache = new Map<string, CacheEntry>();
    let now = 1_000;
    store.body = JSON.stringify(seal(OPENROUTER_KEY_SECRET, "sk-first-rotation", keyFrom(SEAL)));

    const first = await resolveSealedSecret({ seal: SEAL, fallback: FALLBACK_KEY, store, cache, now: () => now });
    expect(first).toEqual({ value: "sk-first-rotation", source: "blob" });
    expect(store.reads).toBe(1);

    store.body = JSON.stringify(seal(OPENROUTER_KEY_SECRET, ROTATED_KEY, keyFrom(SEAL)));
    now += SECRET_CACHE_TTL_MS - 1;
    const cached = await resolveSealedSecret({ seal: SEAL, fallback: FALLBACK_KEY, store, cache, now: () => now });
    expect(cached).toEqual({ value: "sk-first-rotation", source: "cache" });
    expect(store.reads).toBe(1);

    now += 1;
    const refreshed = await resolveSealedSecret({ seal: SEAL, fallback: FALLBACK_KEY, store, cache, now: () => now });
    expect(refreshed).toEqual({ value: ROTATED_KEY, source: "blob" });
    expect(store.reads).toBe(2);
  });

  it("falls back to the environment for an absent, unreadable, or invalid blob", async () => {
    const diagnostics: string[] = [];
    const store = new MemoryBlobStore();

    expect(await resolveSealedSecret({
      seal: SEAL,
      fallback: FALLBACK_KEY,
      store,
      cache: new Map(),
      diagnostic: (message) => diagnostics.push(message),
    })).toEqual({ value: FALLBACK_KEY, source: "env" });

    store.readError = new Error(`failed near ${ROTATED_KEY}`);
    expect(await resolveSealedSecret({
      seal: SEAL,
      fallback: FALLBACK_KEY,
      store,
      cache: new Map(),
      diagnostic: (message) => diagnostics.push(message),
    })).toEqual({ value: FALLBACK_KEY, source: "env" });

    store.readError = null;
    store.body = JSON.stringify(seal(OPENROUTER_KEY_SECRET, ROTATED_KEY, keyFrom(OTHER_SEAL)));
    expect(await resolveSealedSecret({
      seal: SEAL,
      fallback: FALLBACK_KEY,
      store,
      cache: new Map(),
      diagnostic: (message) => diagnostics.push(message),
    })).toEqual({ value: FALLBACK_KEY, source: "env" });
    expect(diagnostics.join(" ")).not.toContain(ROTATED_KEY);
  });

  it("uses the environment directly when the seal is absent or invalid", async () => {
    const store = new MemoryBlobStore();

    expect(await resolveSealedSecret({ fallback: FALLBACK_KEY, store, cache: new Map() }))
      .toEqual({ value: FALLBACK_KEY, source: "env" });
    expect(await resolveSealedSecret({ seal: "too-short", fallback: FALLBACK_KEY, store, cache: new Map(), diagnostic: () => {} }))
      .toEqual({ value: FALLBACK_KEY, source: "env" });
    expect(store.reads).toBe(0);
  });

  it("replaces the exact Vercel Blob path without a random suffix", async () => {
    const calls: string[] = [];
    const store = createVercelBlobStore({
      async list(options) {
        expect(options).toEqual({ prefix: OPENROUTER_KEY_SECRET.pathname, limit: 1 });
        return { blobs: [{ pathname: OPENROUTER_KEY_SECRET.pathname, url: "https://blob.example/current" }] };
      },
      async delete(url) {
        expect(url).toBe("https://blob.example/current");
        calls.push("delete");
      },
      async put(pathname, body, options) {
        expect(pathname).toBe(OPENROUTER_KEY_SECRET.pathname);
        expect(body).toBe("sealed-envelope");
        expect(options).toEqual({
          access: "public",
          addRandomSuffix: false,
          contentType: "application/json",
          cacheControlMaxAge: 60,
        });
        calls.push("put");
      },
    });

    await store.write(OPENROUTER_KEY_SECRET.pathname, "sealed-envelope");

    expect(calls).toEqual(["delete", "put"]);
  });
});

describe("key rotation admin", () => {
  it("serves a no-store form with no configured secret in its HTML", async () => {
    const page = adminKeyPage();
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("Rotate OpenRouter key");
    expect(html).not.toContain(ADMIN_TOKEN);
    expect(html).not.toContain(ROTATED_KEY);
  });

  it("rejects missing configuration and bad authorization before storage", async () => {
    const store = new MemoryBlobStore();
    const unconfigured = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY), {
      env: {}, store, log: () => {},
    });
    const unauthorized = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY, "wrong-token"), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL }, store, log: () => {},
    });

    expect(unconfigured.status).toBe(503);
    expect(unauthorized.status).toBe(401);
    expect(store.writes).toHaveLength(0);
  });

  it("stores ciphertext and returns only a short fingerprint", async () => {
    const store = new MemoryBlobStore();
    const logs: string[] = [];
    const response = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL },
      store,
      cache: new Map(),
      fetchImpl: acceptedKeyFetch,
      log: (message) => logs.push(message),
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const responseBody = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseBody)).toEqual({ ok: true, fingerprint: fingerprint(ROTATED_KEY) });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.pathname).toBe(OPENROUTER_KEY_SECRET.pathname);
    expect(store.writes[0]?.body).not.toContain(ROTATED_KEY);
    expect(unseal(OPENROUTER_KEY_SECRET, JSON.parse(store.writes[0]?.body ?? ""), keyFrom(SEAL)))
      .toBe(ROTATED_KEY);
    expect(responseBody).not.toContain(ROTATED_KEY);
    expect(logs.join(" ")).not.toContain(ROTATED_KEY);
    expect(logs.join(" ")).toContain(fingerprint(ROTATED_KEY));
  });

  it("does not expose the key when storage fails or input is invalid", async () => {
    const store = new MemoryBlobStore();
    store.writeError = new Error(`cannot store ${ROTATED_KEY}`);
    const logs: string[] = [];
    const failed = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL },
      store,
      fetchImpl: acceptedKeyFetch,
      log: (message) => logs.push(message),
    });
    const invalid = await rotateOpenRouterKey(rotationRequest("short"), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL },
      store,
      log: (message) => logs.push(message),
    });
    const output = `${await failed.text()} ${await invalid.text()} ${logs.join(" ")}`;

    expect(failed.status).toBe(502);
    expect(invalid.status).toBe(400);
    expect(output).not.toContain(ROTATED_KEY);
  });

  it("does not store, log, or echo a key that OpenRouter rejects", async () => {
    const store = new MemoryBlobStore();
    store.body = "existing-envelope";
    const logs: string[] = [];
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 401 });

    const response = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL },
      store,
      fetchImpl,
      log: (message) => logs.push(message),
    });
    const output = `${await response.text()} ${logs.join(" ")}`;

    expect(response.status).toBe(400);
    expect(store.body).toBe("existing-envelope");
    expect(store.writes).toHaveLength(0);
    expect(output).not.toContain(ROTATED_KEY);
  });

  it("does not change storage when OpenRouter validation is unavailable", async () => {
    const store = new MemoryBlobStore();
    store.body = "existing-envelope";
    const logs: string[] = [];
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`network failed near ${ROTATED_KEY}`);
    };

    const response = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL },
      store,
      fetchImpl,
      log: (message) => logs.push(message),
    });
    const output = `${await response.text()} ${logs.join(" ")}`;

    expect(response.status).toBe(502);
    expect(store.body).toBe("existing-envelope");
    expect(store.writes).toHaveLength(0);
    expect(output).not.toContain(ROTATED_KEY);
  });

  it("exports GET and POST from the Vercel route", async () => {
    expect(typeof POST).toBe("function");
    const page = GET();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Rotate OpenRouter key");
  });
});

describe("proxy rotation path", () => {
  it("uses the key written by the admin endpoint instead of the environment fallback", async () => {
    const store = new MemoryBlobStore();
    const rotated = await rotateOpenRouterKey(rotationRequest(ROTATED_KEY), {
      env: { DAILIES_ADMIN_TOKEN: ADMIN_TOKEN, DAILIES_KEY_SEAL: SEAL },
      store,
      cache: new Map(),
      fetchImpl: acceptedKeyFetch,
      log: () => {},
    });
    expect(rotated.status).toBe(200);

    const proxyCache = new Map<string, CacheEntry>();
    const resolveKey: OpenRouterKeyResolver = (env) => resolveSealedSecret({
      seal: env.DAILIES_KEY_SEAL,
      fallback: env.OPENROUTER_API_KEY,
      store,
      cache: proxyCache,
    });
    let upstreamAuthorization: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      upstreamAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const request = new Request("https://telemetry.example/api/llm/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer beta-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash-0731", messages: [] }),
    });

    const response = await proxyToOpenRouter(request, {
      path: "/chat/completions",
      env: {
        DAILIES_BETA_TOKENS: "tester:beta-token",
        DAILIES_KEY_SEAL: SEAL,
        OPENROUTER_API_KEY: FALLBACK_KEY,
      },
      resolveKey,
      fetchImpl,
      log: () => {},
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(upstreamAuthorization).toBe(`Bearer ${ROTATED_KEY}`);
    expect(upstreamAuthorization).not.toContain(FALLBACK_KEY);
  });
});
