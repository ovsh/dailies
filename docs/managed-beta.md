# Managed LLM mode — closed beta

A few beta testers get chat and search without buying an OpenRouter key. Their
build carries a short, revocable **beta token** and the URL of a proxy we run.
The proxy holds the real OpenRouter key and forwards to
`https://openrouter.ai/api/v1`.

Two things this design protects, in order:

1. **The OpenRouter key never ships.** The active key is encrypted in Vercel
   Blob. The encryption seal and fallback key stay in Vercel environment
   variables. The app never sees any of them.
2. **The proxy does not store or log content.** Messages and embedding inputs
   pass through our Vercel function on their way to OpenRouter. The function
   logs usage metadata only: who, which model, and how many tokens.

## The hard gate

Managed mode exists only in a build that was packaged with both
`DAILIES_MANAGED_LLM_URL` and `DAILIES_MANAGED_LLM_TOKEN` set. They bake into
the main bundle at package time with `esbuild --define`, exactly like the
telemetry pair. A build without them — every dev build, every normal release —
has no managed access at all and behaves as it always has.

**A tester's own OpenRouter key always wins.** The routing rule, in
`src/main/managed-llm.ts`:

| user key set | managed baked | route                                    |
| ------------ | ------------- | ---------------------------------------- |
| yes          | either        | direct to OpenRouter with the user's key |
| no           | yes           | the proxy, with the beta token           |
| no           | no            | error: "OpenRouter API key not set"      |

## Server — the proxy

Source lives with the telemetry endpoints in `infra/telemetry/`, Vercel project
`dailies-telemetry` (team `digitalpro`):

    infra/telemetry/lib/managed-llm.ts          auth, forwarding, usage log
    infra/telemetry/lib/auth.ts                 bearer-token comparison
    infra/telemetry/lib/key-store.ts            encryption, Blob access, cache
    infra/telemetry/lib/admin.ts                rotation form and handler
    infra/telemetry/api/llm/admin.ts             GET and POST route
    infra/telemetry/api/llm/chat/completions.ts POST, SSE streaming passthrough
    infra/telemetry/api/llm/embeddings.ts       POST

Base URL for the app: `https://dailies-telemetry.vercel.app/api/llm`. The app
appends `/chat/completions` and `/embeddings` — the same paths it uses against
OpenRouter, so nothing else in the client changes.

Four environment variables are required. Set all four for **production only**:

| variable                | holds                                                     |
| ----------------------- | --------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | the initial credit-capped key and read-failure fallback   |
| `DAILIES_BETA_TOKENS`   | comma-separated beta tokens, each optionally `label:token` |
| `DAILIES_ADMIN_TOKEN`   | bearer token for the key-rotation page                    |
| `DAILIES_KEY_SEAL`      | 32-byte hex key that encrypts the Blob value               |

Labels make the usage log readable and are the unit of revocation:

    ada:9f3c…,marcus:7b21…

Missing `DAILIES_BETA_TOKENS` makes every request return `503`. An unknown or
absent bearer token returns `401`, and the proxy does not call OpenRouter. A
request returns `503` when neither the encrypted Blob value nor
`OPENROUTER_API_KEY` provides a key.

The Blob path is fixed at `secrets/openrouter-key.json`. The Blob is public by
URL, so it contains an AES-256-GCM envelope only. `DAILIES_KEY_SEAL` never goes
into the Blob.

### Spend cap

There is no metering in the proxy. **The cap is on the OpenRouter key itself**:
create the key in the OpenRouter dashboard with a credit limit, and that limit
is the ceiling for the whole beta. Set it to something you would not mind
losing — the beta is a handful of people, and a leaked token can spend up to
the cap before you notice.

### Usage log

One line per request in Vercel's runtime logs:

    managed-llm {"t":"…","route":"chat/completions","operator":"Ada","token":"ada",
                 "model":"google/gemini-2.5-flash","status":200,"stream":false,
                 "usage":{"prompt":812,"completion":140,"total":952}}

`operator` comes from the app's `X-Dailies-Operator` header (the same name that
labels telemetry batches), sanitized server-side so it cannot forge a log line.
Token counts appear when the reply carried a `usage` block; embeddings batches
are too large to parse and are logged without them. OpenRouter's own dashboard
remains the authoritative spend record.

## Deploy checklist

Run from `infra/telemetry/`. Nothing here is automated — the project has no Git
integration for this repo.

1. Create the OpenRouter key with a credit limit in the OpenRouter dashboard.
   Name it something like `dailies-managed-beta` so it is obvious what to
   revoke.
2. Generate one beta token per tester. Save each value in the password manager:

       openssl rand -hex 24

3. Generate the admin token and the 32-byte encryption seal. Save both values
   in the password manager:

       openssl rand -hex 32    # DAILIES_ADMIN_TOKEN
       openssl rand -hex 32    # DAILIES_KEY_SEAL

4. Set the environment variables. Each command prompts for the value. Do not
   put a secret on the command line or in this public repository:

       npx vercel env add OPENROUTER_API_KEY production
       npx vercel env add DAILIES_BETA_TOKENS production
       npx vercel env add DAILIES_ADMIN_TOKEN production
       npx vercel env add DAILIES_KEY_SEAL production

5. Deploy:

       npx vercel --prod

6. Complete the first rotation. Open this URL:

       https://dailies-telemetry.vercel.app/api/llm/admin

   Enter `DAILIES_ADMIN_TOKEN` and the active OpenRouter key. A successful
   response shows a 12-character fingerprint. The page never returns the key.
   The encrypted Blob value becomes the primary key. `OPENROUTER_API_KEY`
   remains the fallback.

7. Smoke-test with a beta token:

       curl -sS -X POST https://dailies-telemetry.vercel.app/api/llm/chat/completions \
         -H "Authorization: Bearer $BETA_TOKEN" \
         -H "X-Dailies-Operator: smoke-test" \
         -H "Content-Type: application/json" \
         -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"say ok"}]}'

   Then check that a request with no token returns `401`, and that
   `"stream":true` produces `data:` frames as they arrive rather than in one
   lump.

## Building a beta app

    export DAILIES_TELEMETRY_URL=…            # as usual
    export DAILIES_TELEMETRY_TOKEN=…
    export DAILIES_MANAGED_LLM_URL=https://dailies-telemetry.vercel.app/api/llm
    export DAILIES_MANAGED_LLM_TOKEN=<that tester's token>
    APPLE_KEYCHAIN_PROFILE=digital-lane npm run dist:mac:managed

Verify before shipping:

    grep -c 'api/llm' dist-electron/main/index.cjs     # want 1

Then **rebuild without the two managed variables** before making any normal
release, and check the same grep returns 0.

### Distribution rule — this is the one that bites

A build with a beta token baked in **must never be published on GitHub**. This
repository and its release assets are public, and a compiled token can be
extracted from the app. A pre-release hides the build from stable updaters, but
it does not keep the token private.

- Build one private artifact per tester from the exact public release tag. Give
  it to that tester through a private file transfer. Do not publish beta updater
  metadata. The next normal stable release replaces the beta build.
- One token per tester where practical: the usage log then names who spent
  what, and a single tester can be cut off without disturbing the others.
- Never run the `Windows unsigned beta` workflow with these values as
  repository secrets. That workflow builds normal releases; a token added there
  would bake into every Windows build we ship.
- There is no managed Windows packaging workflow yet. A Windows beta needs the
  same per-tester build boundary and private transfer before it can ship.

This is the exception to the "releases ship both platforms at the same version"
policy in `CLAUDE.md` — a managed beta build is not a release.

## Kill switch and rotation

- **Revoke one tester**: remove their entry from `DAILIES_BETA_TOKENS` and
  redeploy. Their current build receives `401` responses until you give them a
  new managed build or they install a normal build and add their own key. The
  current UI does not show a distinct revoked state.
- **Kill the whole beta**: delete `DAILIES_BETA_TOKENS` and redeploy. You can
  also revoke all managed keys in the OpenRouter dashboard. Revocation stops
  spend without a Vercel deploy.
- **Rotate the OpenRouter key**: create a new credit-capped key. Open
  `https://dailies-telemetry.vercel.app/api/llm/admin`, enter the admin token
  and new key, and submit the form. Confirm that the displayed fingerprint
  changed. No Vercel deploy or app rebuild is necessary.
- **Rotate a beta token**: new `openssl rand -hex 24`, update the variable,
  redeploy, and give the tester a new build. This one does need a rebuild,
  which is why the two secrets are separate.

Each warm proxy instance caches its decrypted key for 60 seconds. After a
rotation, some requests can use the old key for up to one minute. Wait at least
one minute before you revoke the old key in OpenRouter.

The proxy reads `OPENROUTER_API_KEY` when the Blob is absent, cannot be read, or
cannot be decrypted. Keep that fallback key valid if availability during a
Blob failure matters. If a spent or revoked key is still in
`OPENROUTER_API_KEY`, replace that environment value and redeploy. Editing the
Blob through the admin page does not need a deploy.
