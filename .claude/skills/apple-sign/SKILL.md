---
name: apple-sign
description: Sign, notarize, staple and verify the Dailies macOS DMG with the Digital Lane LLC Developer ID certificate. Use whenever the user wants to sign, notarize, release, or distribute the app; when Gatekeeper blocks it ("app is damaged", "cannot be opened because the developer cannot be verified", quarantine warnings); or before publishing a GitHub release.
---

# Apple Sign & Notarize — Dailies (Digital Lane LLC)

Dailies is an Electron app built by electron-builder (`npm run dist`), which
already handles signing (hardened runtime is on in `package.json → build.mac`)
and notarization (`notarize: true`). The one thing it needs is credentials,
supplied as a notarytool keychain profile, never as a password in the
environment:

```bash
APPLE_KEYCHAIN_PROFILE=digital-lane npm run dist
```

That signs the app with `Developer ID Application: Digital Lane LLC
(7Z82LSPAPP)`, notarizes the .app via the stored `digital-lane` profile,
staples it, and produces `release/Dailies-<version>-arm64.dmg`.

## After the build: notarize + staple the DMG itself

electron-builder notarizes the app bundle. Submit the DMG too so the disk
image opens clean offline:

```bash
xcrun notarytool submit release/Dailies-<version>-arm64.dmg \
  --keychain-profile digital-lane --wait
xcrun stapler staple release/Dailies-<version>-arm64.dmg
```

## Verify before shipping (all three must pass)

```bash
hdiutil attach release/Dailies-<version>-arm64.dmg
spctl -a -vv "/Volumes/Dailies/Dailies.app"        # accepted · Notarized Developer ID
codesign --verify --strict --deep "/Volumes/Dailies/Dailies.app"
xcrun stapler validate release/Dailies-<version>-arm64.dmg
hdiutil detach "/Volumes/Dailies"
```

## One-time setup: notary credentials (user must do this personally)

If `xcrun notarytool history --keychain-profile digital-lane` errors, the
profile is missing. Do NOT create it yourself — it requires the user's Apple
ID app-specific password, which the agent must never handle. Ask the user to
run:

```bash
xcrun notarytool store-credentials digital-lane \
  --apple-id <apple-id-email> --team-id 7Z82LSPAPP
```

(App-specific password from https://account.apple.com → Sign-In and Security.)

## Troubleshooting

- **codesign "User interaction is not allowed"**: the keychain wants approval
  to use the private key. The user clicks "Always Allow" once on the dialog.
- **notarytool "Invalid"**: `xcrun notarytool log <submission-id>
  --keychain-profile digital-lane`. Usual causes: an unsigned nested binary
  under asarUnpack (ffmpeg/ffprobe/whisper), missing hardened runtime, or a
  missing secure timestamp. electron-builder signs nested native code it
  knows about; check `vendor/whisper` binaries got signed
  (`codesign -dv` each Mach-O under the mounted app's Resources).
- **Identity check**: `security find-identity -v -p codesigning` must list
  `Developer ID Application: Digital Lane LLC (7Z82LSPAPP)`.
- **Cert expired/revoked**: renew at the Apple Developer portal, download,
  double-click, re-check find-identity.
