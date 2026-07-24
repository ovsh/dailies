# Dailies — project notes for Claude

## Design work — use the design-motion skill

Any visual work (site/, app renderer redesigns, brand) goes through the
`design-motion` skill's sequence: `/impeccable shape` with a user-confirmed
content brief BEFORE any visual direction, real product screenshots (never
CSS depictions) on marketing surfaces, and the impeccable-finish-reviewer
before anything is called done.

Two separate visual worlds, do not mix them:
- The app renderer is the "screening room" (slate + brass,
  `src/renderer/theme/tokens.css`).
- The landing page is "The Bin" (steel-gray Media Composer chrome,
  `site/DESIGN.md`).

## Landing page — one deploy

`site/` here is the source of truth, but it DEPLOYS from the personal-website
repo (`~/Documents/code/personal-website/dailies/`, served at
ovsh.github.io/dailies/ — one deploy for the whole personal site). After any
site/ change run `scripts/sync-site.sh` and commit both repos. Never add a
GitHub Pages workflow to this repo.

## Signing & notarization — use /apple-sign

Use the `apple-sign` skill (`.claude/skills/apple-sign/`) for release builds:
`APPLE_KEYCHAIN_PROFILE=digital-lane npm run dist` signs with the Digital
Lane LLC Developer ID (team `7Z82LSPAPP`) and notarizes via the stored
notarytool profile; then notarize + staple the DMG itself and verify with
Gatekeeper before shipping. Never handle Apple ID passwords —
`notarytool store-credentials` is a user-only step.

## Marketing screenshots

Real app, real data only. `scripts/recapture-two.mjs` recaptures the two
site screenshots over CDP (launch the app with
`npx electron . --remote-debugging-port=9333` first). The indexed test
project lives in the default userData dir; the hero bin rows on the page
quote its real transcripts, so keep them verbatim if regenerated.
