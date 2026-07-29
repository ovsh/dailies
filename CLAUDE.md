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

- App `Dailies.app`, bundle id `com.dailies.app`; artifacts land in
  `release/Dailies-<version>-arm64.dmg`, plus (from 0.3.0, for auto-update)
  `release/Dailies-<version>-arm64-mac.zip` and `release/latest-mac.yml`.
  Both the ZIP and `latest-mac.yml` must be uploaded to the GitHub release
  alongside the DMG, or existing installs never see the update.
- electron-builder does the signing and app notarization itself — it just
  needs the shared profile: `APPLE_KEYCHAIN_PROFILE=digital-lane npm run dist`
  (hardened runtime is on in `package.json → build.mac`, `notarize: true`).
- It does NOT notarize the DMG. Submit and staple that yourself afterward,
  then verify the mounted app with `spctl` before shipping.
- Nested Mach-O under `asarUnpack` (ffmpeg/ffprobe/whisper) is the usual cause
  of an `Invalid` notarization — check each with `codesign -dv`.

The `digital-lane` notarytool profile is per-team and already set up — no
first-run credential step. Never handle Apple ID passwords.

## Marketing screenshots

Real app, real data only. `scripts/recapture-two.mjs` recaptures the two
site screenshots over CDP (launch the app with
`npx electron . --remote-debugging-port=9333` first). The indexed test
project lives in the default userData dir; the hero bin rows on the page
quote its real transcripts, so keep them verbatim if regenerated.
