# Dailies — project notes for Claude

## Design work — use the design-motion skill

Any visual work (site/, app renderer redesigns, brand) goes through the
`design-motion` skill's sequence: `/impeccable shape` with a user-confirmed
content brief BEFORE any visual direction, real product screenshots (never
CSS depictions) on marketing surfaces, and the impeccable-finish-reviewer
before anything is called done.

One visual world, "The Bin" (steel-gray Media Composer chrome), two
expressions: the app renderer follows root `DESIGN.md`
(tokens in `src/renderer/theme/tokens.css`), the landing page follows
`site/DESIGN.md`. The old dark "screening room" app theme is retired.

## Landing page — one deploy

`site/` here is the source of truth, but it DEPLOYS from the personal-website
repo (`~/Documents/code/personal-website/dailies/`, served at
ovsh.github.io/dailies/ — one deploy for the whole personal site). After any
site/ change run `scripts/sync-site.sh` and commit both repos. Never add a
GitHub Pages workflow to this repo.

## Signing & notarization — use the global apple-sign skill

The procedure (identity, notarize → staple → verify order, troubleshooting)
lives in the global `apple-sign` skill, `~/.claude/skills/apple-sign/`.

Dailies' specifics:

- App `Dailies.app`, bundle id `com.dailies.app`. Every build writes five
  artifacts to `release/`, and ALL FIVE go on the GitHub release:

      Dailies-<version>-arm64.dmg
      Dailies-<version>-arm64-mac.zip
      Dailies-<version>-arm64.dmg.blockmap
      Dailies-<version>-arm64-mac.zip.blockmap
      latest-mac.yml

  The ZIP and `latest-mac.yml` are mandatory (from 0.3.0) — without them
  existing installs never see the update at all. The two `.blockmap` files
  make the update a small delta instead of a full ~260MB download.
  electron-builder always generates them; they get lost because the
  `gh release create` asset list is written by hand. v0.4.0 through v0.5.0
  shipped without them. A delta needs a blockmap on BOTH sides — the
  installed version and the new one — so the chain only restarts once two
  consecutive releases carry them (0.5.1 is the first again).
- electron-builder does the signing and app notarization itself — it just
  needs the shared profile: `APPLE_KEYCHAIN_PROFILE=digital-lane npm run dist`
  (hardened runtime is on in `package.json → build.mac`, `notarize: true`).
- It does NOT notarize the DMG. Submit and staple that yourself afterward,
  then run `npm run finalize:mac` to rebuild both blockmaps and
  `latest-mac.yml` from the final bytes. Verify the mounted app with `spctl`
  before shipping.
- Nested Mach-O under `asarUnpack` (ffmpeg/ffprobe/whisper) is the usual cause
  of an `Invalid` notarization — check each with `codesign -dv`.

The `digital-lane` notarytool profile is per-team and already set up — no
first-run credential step. Never handle Apple ID passwords.

## Telemetry (from 0.5.3)

Always-on log shipping for installs with the toggle on. The app streams
its log lines to `https://dailies-telemetry.vercel.app/api/ingest`
(Vercel project `dailies-telemetry`, team digitalpro; source in
`infra/telemetry/`). Read a day's logs:
`/api/dump?token=<DAILIES_INGEST_TOKEN>&day=YYYY-MM-DD`.

- The endpoint URL and token bake into the main bundle at build time
  from `DAILIES_TELEMETRY_URL` / `DAILIES_TELEMETRY_TOKEN`. A dist run
  WITHOUT both env vars ships a silent build — export them before
  `npm run dist`. The token is `DAILIES_INGEST_TOKEN` in
  `infra/telemetry/.env.local` (gitignored; refresh with
  `npx vercel env pull --environment production` in that directory).
- Never commit the token — this repo is public.
- Dev builds (no env vars) send nothing. Verify a release build with
  `grep -c dailies-telemetry dist-electron/main/index.cjs` (want 1).
- Blob store `dailies-logs-3` holds the batches (public-by-URL blobs,
  token-gated endpoints). No retention policy yet — add cleanup before
  any wide rollout.

## Marketing screenshots

Real app, real data only. `scripts/recapture-two.mjs` recaptures the two
site screenshots over CDP (launch the app with
`npx electron . --remote-debugging-port=9333` first). The indexed test
project lives in the default userData dir; the hero bin rows on the page
quote its real transcripts, so keep them verbatim if regenerated.
