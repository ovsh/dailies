# Plan: Auto-updates & end-to-end error logging

**Written 2026-07-22. Engineering plan — reviewed and self-critiqued at the end.**

Two features, both in service of one thing: users stay on the latest build with one
click, and when something breaks we can see exactly what happened without asking the
user to describe it.

---

## Where we are today

- **Distribution:** `npm run dist` builds a signed, notarized arm64 DMG locally
  (electron-builder). No CI, no update mechanism — users re-download DMGs by hand.
- **Logging:** `src/main/index.ts` patches `console.error`/`console.warn` to append
  plain-text lines to `userData/dailies.log`, plus `uncaughtException` /
  `unhandledRejection` hooks. No rotation, no structure, nothing from the renderer,
  nothing leaves the machine.
- **Failure surfaces we know about:** OpenRouter API errors (401/429/timeouts), whisper
  model missing or download failures, ffmpeg/ffprobe failures per stage, jobs stuck in
  `running`/`queued`, spawn `EBADF` when launched from Finder (fixed, see
  `index.ts:12`), better-sqlite3 ABI mismatches in dev.

---

## Feature 1 — One-click auto-updates

### Design in one paragraph

Use **electron-updater** (same ecosystem as our existing electron-builder config — it
reads the same signing setup and artifact metadata). The app checks a static update
feed on launch and every 10 minutes. When a newer version exists, a small pill appears
in the left rail: **"Update · v0.3.1"**. Clicking it downloads in the background
(progress in the pill), then the pill becomes **"Restart to update"** — one more click
and the app relaunches on the new version. Settings gets an **Updates** section with
the current version, a **Check now** button, last-checked time, and status. No modal
dialogs, no nagging, nothing interrupts playback or indexing.

### Hosting the feed — the one real decision

electron-updater needs an HTTPS location serving `latest-mac.yml` + the update zip.
Options, in order of preference:

1. **Public GitHub releases repo** (recommended): create `ovsh/dailies-releases`, a
   public repo containing only release artifacts (the source repo stays private).
   electron-builder publishes to it natively (`--publish always` with a `GH_TOKEN` on
   the *build machine only* — no token ships in the app). Zero new services, zero
   cost, versioned release notes for free.
2. **Cloudflare R2 / S3 + generic provider**: also fine, no new token in the app, but
   it's a new account/bucket to manage for no gain over option 1.
3. **Private GitHub repo as feed**: ruled out — would require shipping a GitHub token
   inside the app. Never do this.

> **Needs a decision from you:** is a public releases-only repo acceptable? If yes,
> nothing to sign up for. If no, we create an R2 bucket (free tier covers this).

### Implementation steps

1. **Build config** (`package.json` → `build`):
   - Add `zip` to `mac.target` alongside `dmg` — Squirrel.Mac (what electron-updater
     uses on macOS) updates from the zip; the DMG remains the first-install artifact.
   - Add `publish: { provider: "github", owner: "ovsh", repo: "dailies-releases" }`.
   - Release flow becomes: bump `version`, `npm run dist -- --publish always`, done.
     electron-builder uploads the dmg, zip, blockmap, and `latest-mac.yml`.
2. **`src/main/updater.ts`** (~100 lines): wraps `autoUpdater` from electron-updater.
   - `autoDownload: false` — the pill appears first; download starts on click.
   - Explicit state machine mirrored to the renderer over IPC:
     `idle → checking → available → downloading(percent) → ready → error(message)`.
   - Timer: check on `app.whenReady` + `setInterval` 10 min. Checks are a single
     small HTTPS GET of the yml — negligible cost at this cadence.
   - Skip entirely in dev (`VITE_DEV_SERVER_URL`) and e2e (`DAILIES_USER_DATA`) runs.
3. **IPC** (`src/shared/ipc.ts`): `getUpdateState`, `checkForUpdates`,
   `downloadUpdate`, `installUpdate`, and an `onUpdateEvent` push channel — same
   pattern as `onModelProgress`.
4. **Renderer:**
   - `UpdatePill` component in the rail: hidden when idle/checking; fades in (subtle,
     one-time transition — no pulsing/flashing) when `available`; shows percent while
     `downloading`; "Restart to update" when `ready`; on `error`, reverts to a quiet
     "Update available — download failed, retry" state.
   - `JobsSettingsScreen`: **Updates** card — version (`app.getVersion()`), Check now,
     last checked, current status, and on repeated failure a "Download DMG manually"
     link as the escape hatch.
5. **Failure handling:** if Squirrel can't write to `/Applications` (app run from DMG
   or a non-writable location), surface the manual-download link instead of erroring
   opaquely. All updater transitions go through the logger (Feature 2), so failed
   updates are visible remotely.

### Notes & constraints

- Updates require every release to be **signed with the same identity and
  notarized** — config already sets `notarize: true`; the README's "not yet
  notarized" note is stale and should be corrected once verified.
- The first release carrying the updater is still a manual download — auto-update
  only helps from the *next* release onward. Ship it early.
- electron-updater does differential downloads via blockmaps automatically — most
  updates won't re-download the whole ~200MB+ app.
- Staged rollouts (`stagingPercentage` in the yml) exist if we ever want them. Not now.

---

## Feature 2 — Session logging & end-to-end remote tracing

### Design in one paragraph

Two layers, cleanly separated. **Layer 1: a local structured session log** — every
session writes NDJSON events (timestamped, leveled, scoped) to rotating files in
`userData/logs/`; this is the complete record and it stays on the user's machine.
**Layer 2: Sentry for remote visibility** — crashes and errors are reported
automatically, and *every logger event is also recorded as a Sentry breadcrumb*, so
each error report arrives with the trail of the last ~100 events that led to it.
That breadcrumb trail is the "end-to-end trace": when a user hits a problem, we open
the Sentry event and read exactly what the app did — project opened, files discovered,
stage started, API call failed — without asking them anything.

### Why Sentry (yes, this needs a signup)

- `@sentry/electron` covers all three failure domains in one SDK: **native crashes**
  (minidumps), **main-process JS errors**, and **renderer errors** — with offline
  queueing (editors work offline; events send when back online).
- Free tier (5k events/mo) is far more than our current user base will generate.
- The alternative — our own ingest endpoint + storage + dashboard — is a standing
  service to build and operate. Rejected below in the critique.
- **Action for you:** create a Sentry org/project (sentry.io, free), grab the DSN.
  The DSN is public-safe and ships in the app.

### Layer 1: the logger (`src/main/log.ts`, ~80 lines — no library)

- API: `log.info(scope, event, fields?)` / `warn` / `error`, where `scope` is one of
  `app | pipeline | agents | db | export | updater | ui`, `event` is a stable
  dot-name (`pipeline.stage.failed`, `agents.request.error`), and `fields` is a flat
  JSON object.
- One NDJSON line per event: `{ts, level, scope, event, sessionId, ...fields}`.
  `sessionId` is a UUID minted per launch — it ties a local log file to Sentry events.
- Sync append (matches today's crash-safe behavior); rotate on startup at 5 MB, keep
  3 files. Volume is low — this is fine, measured before optimizing.
- Replaces the ad-hoc console patch in `index.ts`; `uncaughtException` /
  `unhandledRejection` / `console.error` still funnel in so nothing regresses.
- Renderer: preload exposes `window.dailies.log(level, scope, event, fields)`;
  `main.tsx` installs `window.onerror` + `unhandledrejection` handlers and a
  top-level React error boundary that log through it. Renderer events land in the
  same file with `proc: "renderer"`.

### What gets logged (the instrumentation pass)

Add calls at the seams that already exist — no restructuring:

| Scope | Events |
|---|---|
| `app` | launch (version, os, arch), project open/close, settings changed (names only) |
| `pipeline` | file discovered, stage start/finish/fail (stage, fileId, duration, exit code, stderr tail), **watchdog: job in `running`/`queued` past its `timeouts.ts` budget → `pipeline.stalled` with a job snapshot** — this is the "stuck state" detector |
| `agents` | chat turn start/end (turnId, duration, model, token counts), OpenRouter failures (status code, model — never prompt/response content) |
| `db` | migration run, open failure, corruption |
| `export` | export start/result (kind, item count), failures |
| `updater` | every state transition from Feature 1 |
| `ui` | screen navigation (breadcrumb value), error-boundary catches |

### Privacy rules (hard lines, enforced at the logger)

- **Never logged anywhere:** API keys, transcript text, chat prompts/responses,
  document contents.
- **Local log only:** full file paths.
- **Sent to Sentry:** error + stack, breadcrumb trail, version, sessionId, os. Media
  paths in breadcrumbs reduced to basenames. `beforeSend` scrubs `/Users/<name>` from
  stacks. README's privacy stance ("nothing is uploaded") must be updated to disclose
  crash/error reporting — and Settings gets a **"Send error reports"** toggle
  (default on) that gates Sentry init.

### Layer 2 wiring (~half a day)

1. `@sentry/electron/main` init in `index.ts` (gated on the settings toggle + not
   dev/e2e); `@sentry/electron/renderer` init in `main.tsx`. Tags: `appVersion`,
   `sessionId`.
2. The logger forwards every event as a Sentry breadcrumb (in-memory, free);
   `log.error(...)` with an `Error` in fields also calls `captureException`.
3. **"Report a problem"** button in Settings: captures a Sentry feedback event with
   the current rotated log files attached (user-initiated, so full logs are consented)
   plus an optional free-text description. This is the escalation path when an issue
   *doesn't* throw — e.g. "search returns nothing", "it feels stuck".

### The error catalog

Create `docs/errors.md`: one row per known failure class — symptom, log event name,
root cause, fix/workaround. Seed it with the known set (spawn EBADF, ABI mismatch,
OpenRouter 401/429, model missing, proxy transcode failures, stalled jobs) and add a
row whenever a new Sentry issue is diagnosed. Cheap, and it turns tribal knowledge
into something searchable next time.

---

## Critique & self-critique

**Where this plan could be accused of over-engineering — and why it isn't (or where
it was, and got cut):**

- **OpenTelemetry / real distributed tracing:** considered because the request says
  "trace end to end" — rejected. This is a single-process desktop app; spans, trace
  IDs, and a collector add infrastructure for zero diagnostic gain over breadcrumbs +
  sessionId. "Trace" here means *reconstruct the session*, and breadcrumbs do that.
- **Shipping all session logs to a log platform (Datadog/Axiom/Loki):** rejected.
  It's the privacy-worst and cost-worst option, and 99% of shipped lines would never
  be read. Errors-with-context (automatic) plus full logs on explicit user action
  covers the actual debugging need. Revisit only if support volume proves otherwise.
- **A logging library (electron-log/pino/winston):** electron-log is genuinely good
  (rotation, IPC transport built in) and this was a close call. Custom won because we
  need the Sentry-breadcrumb hook and a strict NDJSON schema either way — the glue is
  the same size as the whole 80-line module, and it's one less dependency in the main
  process. If the custom module grows past ~150 lines, switch to electron-log.
- **Custom update server (Hazel/Nucleus/etc.):** rejected. A static yml + zip on
  GitHub releases is the entire requirement. A server adds an operated component and
  a domain for literally no feature we need (staged rollout works from the static yml
  anyway).
- **10-minute update checks:** arguably too frequent for a desktop app (hourly is
  typical), but the cost is a ~1 KB fetch and the product goal is "user sees the
  update fast." Kept at 10 min; trivial to tune later.
- **`autoDownload: false`:** one more click than fully-silent updates. Deliberate —
  the spec asks for a visible download button, and editors on set may be on metered
  or terrible connections; a ~200 MB background download shouldn't start unannounced.
- **Honest risks:** (1) Auto-update is unforgiving about signing — one release built
  with the wrong cert breaks the chain and forces a manual reinstall; the release
  dry-run below exists to catch this. (2) Sentry default-on telemetry changes our
  privacy story; the README update + toggle are part of the work, not optional
  polish. (3) No CI means releases depend on one laptop's signing setup — out of
  scope here, but worth a follow-up GitHub Actions workflow.

---

## Order of work & estimates

| # | Work | Estimate |
|---|---|---|
| 1 | Logger module + renderer forwarding + instrumentation pass + watchdog | 1–1.5 days |
| 2 | Sentry wiring, privacy scrubbing, settings toggle, "Report a problem" | 0.5–1 day |
| 3 | Updater module + IPC + UpdatePill + Settings section | 1 day |
| 4 | Release-flow dry run: publish v0.2.x to the feed, install previous build, watch it self-update end to end | 0.5 day |
| 5 | `docs/errors.md` seed + README privacy/notarization updates | 0.5 day |

Logging ships first on purpose: it instruments the updater, so the update dry-run
(step 4) is itself the first end-to-end test of the tracing.

**Decisions needed before starting:** ① public `dailies-releases` repo — yes/no;
② create the Sentry project and provide the DSN.
