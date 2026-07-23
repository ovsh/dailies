---
name: apple-sign
description: Sign and notarize the Dailies macOS build with the Digital Lane LLC Developer ID. Use when building a distributable (npm run dist / npm run release), when codesign or notarization fails, when Gatekeeper blocks the app, or when setting up a new Mac to cut releases.
---

# Sign & notarize Dailies

Dailies ships as a signed, notarized arm64 app under the **Digital Lane LLC**
Apple Developer account. electron-builder does the signing, hardened runtime,
notarization, and stapling automatically during `npm run dist` / `npm run release`
— this skill is about having the credentials in place, verifying the result, and
digging out when Apple says no.

**The one rule that matters most:** every release must be signed with the *same*
Developer ID identity. Squirrel.Mac validates that an update's signature matches
the installed app — change identities and every existing install silently fails
to update until users reinstall from DMG. Never sign a release with a personal
or ad-hoc identity.

## Preflight (once per build machine)

1. **Certificate.** Confirm the Developer ID Application cert is in the keychain:

   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   # want: "Developer ID Application: Digital Lane LLC (<TEAMID>)"
   ```

   The value in parentheses is the team ID — use it everywhere `APPLE_TEAM_ID`
   is needed. If the cert is missing: developer.apple.com → Certificates →
   create a **Developer ID Application** certificate (or export the existing one
   as .p12 from a Mac that has it — creating a new one revokes nothing but
   multiplies identities; prefer exporting). Double-click to install.

2. **Notarization credentials.** Two options; either works with electron-builder:

   - **Env vars** (simplest):
     ```sh
     export APPLE_ID="<apple account email>"
     export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # appleid.apple.com → App-Specific Passwords
     export APPLE_TEAM_ID="<TEAMID>"
     ```
   - **Keychain profile** (no secrets in shell history — nicer for a machine
     you keep):
     ```sh
     xcrun notarytool store-credentials dailies \
       --apple-id "<apple account email>" --team-id "<TEAMID>"
     export APPLE_KEYCHAIN_PROFILE=dailies
     ```

3. Xcode command line tools present (`xcrun notarytool --version` works).

## Build

```sh
npm run dist      # local: signed+notarized DMG and update zip into release/
npm run release   # same, plus publishes the auto-update feed (also needs GH_TOKEN)
```

Notarization adds a few minutes (Apple-side wait). electron-builder staples the
ticket automatically. If more than one signing identity is installed and the
wrong one gets picked, pin it: `export CSC_NAME="Digital Lane LLC (<TEAMID>)"`.

## Verify (do this after every release build)

```sh
APP=release/mac-arm64/Dailies.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep Authority   # must say Digital Lane LLC
spctl -a -vv "$APP"                          # want: accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"                # want: The validate action worked!
```

All four must pass before publishing the release. If `spctl` rejects a build
that just notarized, staple manually (`xcrun stapler staple "$APP"`) and re-check.

## Troubleshooting

| Error | Cause → fix |
|---|---|
| `unable to build chain to self-signed root` | Missing Apple intermediate CA — install "Developer ID G2 CA" from apple.com/certificateauthority |
| `errSecInternalComponent` during signing | Keychain locked (common over SSH) — `security unlock-keychain login.keychain-db` |
| Notarization status `Invalid` | Get the real reason: `xcrun notarytool log <submission-id>` (id is in electron-builder output). Usually an unsigned nested binary — check `asarUnpack`ed native modules |
| `The specified item could not be found in the keychain` | Cert installed in a different keychain/user than the build runs as |
| Gatekeeper "damaged / move to Trash" on users' Macs | Build shipped un-notarized — never work around this for users; rebuild and re-notarize (dev machine only: `xattr -d com.apple.quarantine`) |
| Installed apps stop self-updating after a release | Identity changed between releases — re-release with the standard cert; affected users reinstall once from DMG |

After signing works end to end, run the release dry-run in `docs/releasing.md`
(install previous DMG → watch it self-update) — notarization and the updater
share the same failure surface, so this proves both.
