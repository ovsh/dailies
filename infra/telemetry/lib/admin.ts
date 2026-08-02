/**
 * Key rotation from a browser.
 *
 * Threat model, stated plainly: whoever holds `DAILIES_ADMIN_TOKEN` can set
 * the OpenRouter key the beta spends against. That is the whole access control
 * — there are no accounts and no audit trail beyond the rotation log line. It
 * is an internal tool for one person, and the credit limit on the OpenRouter
 * key is the backstop if the admin token ever leaks.
 *
 * What this code must never do: log, echo, or store the submitted key in
 * plaintext. The response carries a fingerprint; the blob carries ciphertext;
 * the log line carries neither.
 */
import { matchBearer } from "./auth";
import {
  fingerprint,
  OPENROUTER_KEY_SECRET,
  readSealKey,
  writeSealedSecret,
  type CacheEntry,
  type SecretBlobStore,
} from "./key-store";

const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 512;
const MAX_BODY_BYTES = 8 * 1024;
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const KEY_VALIDATION_TIMEOUT_MS = 10_000;

export interface AdminEnv {
  DAILIES_ADMIN_TOKEN?: string | undefined;
  DAILIES_KEY_SEAL?: string | undefined;
}

export interface RotateOptions {
  env?: AdminEnv;
  store?: SecretBlobStore;
  cache?: Map<string, CacheEntry>;
  log?: (message: string) => void;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

function readAdminEnv(source: NodeJS.ProcessEnv): AdminEnv {
  return {
    DAILIES_ADMIN_TOKEN: source["DAILIES_ADMIN_TOKEN"],
    DAILIES_KEY_SEAL: source["DAILIES_KEY_SEAL"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The local shape check runs before the authoritative OpenRouter request. */
function readSubmittedKey(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const raw = body["key"];
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) return null;
  if (/\s/.test(key)) return null;
  // Printable ASCII only; anything else is a paste accident, not a key.
  if (!/^[\x21-\x7e]+$/.test(key)) return null;
  return key;
}

type KeyValidation = "valid" | "invalid" | "unavailable";

async function validateSubmittedKey(key: string, fetchImpl: typeof fetch): Promise<KeyValidation> {
  try {
    const response = await fetchImpl(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(KEY_VALIDATION_TIMEOUT_MS),
    });
    if (response.ok) return "valid";
    if (response.status === 401 || response.status === 403) return "invalid";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function rotateOpenRouterKey(request: Request, options: RotateOptions = {}): Promise<Response> {
  const env = options.env ?? readAdminEnv(process.env);
  const log = options.log ?? ((message: string) => console.log(message));

  if (!env.DAILIES_ADMIN_TOKEN?.trim()) return json(503, { error: "rotation is not configured" });
  if (!matchBearer(request.headers.get("authorization"), env.DAILIES_ADMIN_TOKEN)) {
    return json(401, { error: "unauthorized" });
  }

  const sealKey = readSealKey(env.DAILIES_KEY_SEAL);
  if (!sealKey) return json(503, { error: "DAILIES_KEY_SEAL is missing or not 32 bytes of hex" });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid json" });
  }

  const key = readSubmittedKey(parsed);
  // Never repeat what was sent — the rejection reason is generic on purpose.
  if (!key) return json(400, { error: "key must be 16-512 printable characters with no spaces" });

  const validation = await validateSubmittedKey(key, options.fetchImpl ?? fetch);
  if (validation === "invalid") return json(400, { error: "OpenRouter rejected the key" });
  if (validation === "unavailable") {
    return json(502, { error: "OpenRouter key validation is unavailable" });
  }

  const print = fingerprint(key);
  try {
    await writeSealedSecret({
      value: key,
      sealKey,
      ...(options.store ? { store: options.store } : {}),
      ...(options.cache ? { cache: options.cache } : {}),
    });
  } catch (error) {
    log(`managed-llm key-rotation-failed ${JSON.stringify({
      t: (options.now ?? (() => new Date()))().toISOString(),
      secret: OPENROUTER_KEY_SECRET.name,
      reason: error instanceof Error ? error.name : "unknown",
    })}`);
    return json(502, { error: "could not store the key" });
  }

  log(`managed-llm key-rotated ${JSON.stringify({
    t: (options.now ?? (() => new Date()))().toISOString(),
    secret: OPENROUTER_KEY_SECRET.name,
    fingerprint: print,
  })}`);
  return json(200, { ok: true, fingerprint: print });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Rotate OpenRouter key</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 2rem 1rem; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 1.5rem; }
  label { display: block; margin-bottom: 1rem; }
  span { display: block; margin-bottom: .35rem; opacity: .7; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit;
          border: 1px solid currentColor; border-radius: 3px; background: transparent; color: inherit; }
  button { padding: .5rem 1rem; font: inherit; cursor: pointer; }
  #out { min-height: 1.5rem; margin: 1rem 0 0; }
  .bad { color: #b00020; }
</style>
</head>
<body>
<main>
  <h1>Rotate OpenRouter key</h1>
  <form id="form" autocomplete="off">
    <label>
      <span>Admin token</span>
      <input id="admin" type="password" autocomplete="off" spellcheck="false" required>
    </label>
    <label>
      <span>New OpenRouter key</span>
      <input id="key" type="password" autocomplete="new-password" spellcheck="false"
             autocapitalize="off" autocorrect="off" required>
    </label>
    <button type="submit">Rotate</button>
  </form>
  <p id="out" role="status" aria-live="polite"></p>
</main>
<script>
  const form = document.getElementById('form');
  const out = document.getElementById('out');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    out.className = '';
    out.textContent = 'Rotating…';
    try {
      const res = await fetch(location.pathname, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + document.getElementById('admin').value.trim(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key: document.getElementById('key').value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        out.textContent = 'Done. Fingerprint ' + data.fingerprint + '. Live everywhere within a minute.';
        form.reset();
      } else {
        out.className = 'bad';
        out.textContent = res.status + ': ' + (data.error || 'failed');
      }
    } catch {
      out.className = 'bad';
      out.textContent = 'Network error.';
    }
  });
</script>
</body>
</html>
`;

/** Static form; it holds no secrets and posts to its own path. */
export function adminKeyPage(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
