/**
 * Sealed secrets in the blob store.
 *
 * The OpenRouter key has to be rotatable from a browser, without the Vercel
 * CLI and without a redeploy, so the live value lives in the blob store rather
 * than in an environment variable. That store is public-by-URL: anything
 * written there must be assumed readable by anyone who learns the URL. So the
 * blob holds AES-256-GCM ciphertext and nothing else. The sealing key
 * (`DAILIES_KEY_SEAL`) stays in the server environment and never travels with
 * the blob — losing the blob leaks nothing, and losing the seal makes the blob
 * inert rather than dangerous.
 *
 * `OPENROUTER_API_KEY` stays as the fallback, so a deploy with no blob yet
 * behaves exactly as it did before this existed.
 *
 * The shape is deliberately generic (`SealedSecret`): beta tokens could move
 * here later by adding one more descriptor. They have not.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { del, list, put } from "@vercel/blob";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

/** How long a decrypted value is reused before the blob is read again. */
export const SECRET_CACHE_TTL_MS = 60_000;

export interface SealedSecret {
  /** Also the additional authenticated data, so an envelope cannot be replayed as another secret. */
  name: string;
  pathname: string;
}

export const OPENROUTER_KEY_SECRET: SealedSecret = {
  name: "openrouter-key",
  pathname: "secrets/openrouter-key.json",
};

export interface SealedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

/** Where sealed envelopes live. Injected so tests never touch the real store. */
export interface SecretBlobStore {
  read(pathname: string): Promise<string | null>;
  write(pathname: string, body: string): Promise<void>;
}

export interface VercelBlobClient {
  list(options: { prefix: string; limit: number }): Promise<{
    blobs: Array<{ pathname: string; url: string }>;
  }>;
  delete(url: string): Promise<void>;
  put(pathname: string, body: string, options: {
    access: "public";
    addRandomSuffix: false;
    contentType: "application/json";
    cacheControlMaxAge: 60;
  }): Promise<unknown>;
}

export interface CacheEntry {
  value: string | null;
  at: number;
}

/**
 * One cache per lambda instance. A rotation therefore reaches other warm
 * instances within SECRET_CACHE_TTL_MS, not instantly — see docs/managed-beta.md.
 */
const moduleCache = new Map<string, CacheEntry>();

/** Null unless the value is exactly 32 bytes of hex — a short seal is worse than none. */
export function readSealKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) return null;
  return Buffer.from(trimmed, "hex");
}

export function seal(secret: SealedSecret, plaintext: string, sealKey: Buffer): SealedEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, sealKey, iv);
  cipher.setAAD(Buffer.from(secret.name, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws on a tampered, truncated, or wrong-secret envelope. */
export function unseal(secret: SealedSecret, envelope: unknown, sealKey: Buffer): string {
  if (!isRecord(envelope)) throw new Error("envelope is not an object");
  if (envelope["v"] !== ENVELOPE_VERSION) throw new Error("unsupported envelope version");
  const { iv, tag, ct } = envelope;
  if (typeof iv !== "string" || typeof tag !== "string" || typeof ct !== "string") {
    throw new Error("envelope is missing a field");
  }
  const decipher = createDecipheriv(ALGORITHM, sealKey, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(secret.name, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** Short SHA-256 prefix. Enough to tell two keys apart, useless for recovering one. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/**
 * The live blob store, driven the same way the ingest endpoint drives it:
 * `put` for writes, `list` + `fetch(blob.url)` for reads.
 */
export function createVercelBlobStore(client: VercelBlobClient): SecretBlobStore {
  return {
    async read(pathname: string): Promise<string | null> {
      const blob = await findBlob(client, pathname);
      if (!blob) return null;
      const url = new URL(blob.url);
      url.searchParams.set("rotation-read", String(Date.now()));
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`blob read ${response.status}`);
      return await response.text();
    },
    async write(pathname: string, body: string): Promise<void> {
      const existing = await findBlob(client, pathname);
      if (existing) await client.delete(existing.url);
      await client.put(pathname, body, {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        cacheControlMaxAge: 60,
      });
    },
  };
}

export const vercelBlobStore = createVercelBlobStore({
  async list(options) {
    return await list(options);
  },
  async delete(url) {
    await del(url);
  },
  async put(pathname, body, options) {
    return await put(pathname, body, options);
  },
});

async function findBlob(
  client: VercelBlobClient,
  pathname: string,
): Promise<{ pathname: string; url: string } | null> {
  const { blobs } = await client.list({ prefix: pathname, limit: 1 });
  return blobs.find((candidate) => candidate.pathname === pathname) ?? null;
}

export type SecretSource = "cache" | "blob" | "env" | "none";

export interface ResolveSecretOptions {
  secret?: SealedSecret;
  /** Raw `DAILIES_KEY_SEAL`. Without a valid one the blob is skipped entirely. */
  seal?: string | undefined;
  /** Raw `OPENROUTER_API_KEY`, used when the blob is absent or unreadable. */
  fallback?: string | undefined;
  store?: SecretBlobStore;
  cache?: Map<string, CacheEntry>;
  now?: () => number;
  /** Never receives key material. */
  diagnostic?: (message: string) => void;
}

export interface ResolvedSecret {
  value: string | null;
  source: SecretSource;
}

/**
 * Resolution order: fresh cache, then the blob, then the environment variable.
 *
 * Any failure degrades instead of erroring. The environment variable protects
 * a beta session from a Blob outage or an invalid envelope.
 */
export async function resolveSealedSecret(options: ResolveSecretOptions = {}): Promise<ResolvedSecret> {
  const secret = options.secret ?? OPENROUTER_KEY_SECRET;
  const cache = options.cache ?? moduleCache;
  const now = (options.now ?? Date.now)();
  const diagnostic = options.diagnostic ?? defaultDiagnostic;
  const envValue = options.fallback?.trim();
  const fallback = (): ResolvedSecret =>
    envValue ? { value: envValue, source: "env" } : { value: null, source: "none" };

  const sealKey = readSealKey(options.seal);
  if (!sealKey) {
    if (options.seal !== undefined && options.seal.trim().length > 0) {
      diagnostic(`key-store: DAILIES_KEY_SEAL is not 32 bytes of hex; using the environment key`);
    }
    return fallback();
  }

  const cached = cache.get(secret.pathname);
  if (cached && now - cached.at < SECRET_CACHE_TTL_MS) {
    // A cached null means "checked recently, there is no blob" — do not re-read.
    return cached.value ? { value: cached.value, source: "cache" } : fallback();
  }

  try {
    const body = await (options.store ?? vercelBlobStore).read(secret.pathname);
    if (body === null) {
      cache.set(secret.pathname, { value: null, at: now });
      return fallback();
    }
    const value = unseal(secret, JSON.parse(body), sealKey);
    cache.set(secret.pathname, { value, at: now });
    return { value, source: "blob" };
  } catch (error) {
    // Only the error's class name: a decrypt failure can quote buffer state.
    diagnostic(`key-store: ${secret.name} unavailable (${error instanceof Error ? error.name : "unknown"})`);
    return fallback();
  }
}

/** Seals and stores a new value, and primes this instance's cache with it. */
export async function writeSealedSecret(options: {
  secret?: SealedSecret;
  value: string;
  sealKey: Buffer;
  store?: SecretBlobStore;
  cache?: Map<string, CacheEntry>;
  now?: () => number;
}): Promise<void> {
  const secret = options.secret ?? OPENROUTER_KEY_SECRET;
  const envelope = seal(secret, options.value, options.sealKey);
  await (options.store ?? vercelBlobStore).write(secret.pathname, JSON.stringify(envelope));
  (options.cache ?? moduleCache).set(secret.pathname, {
    value: options.value,
    at: (options.now ?? Date.now)(),
  });
}

function defaultDiagnostic(message: string): void {
  console.warn(`managed-llm ${message}`);
}
