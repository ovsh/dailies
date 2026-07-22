# Releasing Dailies

The app self-updates from a static feed on GitHub releases. Users see an update
pill in the rail within ~10 minutes of a release being published; one click
downloads, a second click restarts into the new version.

## One-time setup

1. **Create the public releases repo** `ovsh/dailies-releases` (empty; it only
   ever holds release artifacts — the source repo stays private). The feed
   location is set in `package.json` → `build.publish`.
2. **GitHub token on the build machine**: `export GH_TOKEN=…` with `repo` scope
   for `dailies-releases`. The token is used at publish time only — it never
   ships in the app.
3. **Sentry** (error reporting): create a project at sentry.io (free tier),
   paste the DSN into `SENTRY_DSN` in `src/main/telemetry.ts`. Until that
   constant is set, telemetry is a no-op and "Report a problem" says it is not
   configured in this build.

## Every release

```bash
# 1. bump "version" in package.json (electron-updater compares semver)
# 2. build, sign, notarize, and publish dmg + zip + latest-mac.yml:
GH_TOKEN=… npm run release
# 3. publish the draft release on github.com/ovsh/dailies-releases
```

`npm run release` = native rebuild for Electron → renderer + main bundles →
`electron-builder --mac --publish always`. It uploads:

- `Dailies-<v>-arm64.dmg` — first-install artifact (what the website links to)
- `Dailies-<v>-arm64-mac.zip` + `.blockmap` — what installed apps update from
  (differential download via the blockmap)
- `latest-mac.yml` — the feed file the app polls

## Rules that keep auto-update working

- **Same signing identity every release.** An update signed with a different
  cert fails Squirrel.Mac's validation and strands users on the old version
  (they must reinstall from DMG once). Notarization stays required.
- **Never delete or edit published feed assets.** Fixing a bad release means
  shipping a higher version, not rewriting an old one.
- The first release that *carries* the updater still reaches users manually;
  auto-update only helps from the release after it.

## Dry run (do once before the first real release)

1. Publish a `0.x.y` release to `dailies-releases`.
2. Install the previous DMG build, open it, wait ≤10 min (or Settings →
   Updates → Check now).
3. Confirm: pill appears → download → "Restart to update" → relaunches on the
   new version, and the updater transitions show up in the session log
   (`updater.*` events).
