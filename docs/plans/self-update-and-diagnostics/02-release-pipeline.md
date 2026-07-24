# Phase 2: Build the trusted release pipeline

[Back to the plan](README.md)

## Goal

Produce one reproducible macOS arm64 release whose signature, notarization ticket, update metadata, and provenance are verified before publication.

## Release topology

```text
private ovsh/dailies source
  -> clean GitHub Actions macOS build
  -> signed and notarized draft assets
  -> verification and owner canary
  -> public ovsh/dailies-releases GitHub Release
  -> unauthenticated electron-updater clients
```

The public repository exists because the source repository is private. The installed app receives no GitHub credential.

## External setup

Create these resources before enabling the workflow:

1. Public repository `ovsh/dailies-releases` with a short README stating that it contains official Dailies installers only.
2. A fine-grained token with `Contents: write` only on `ovsh/dailies-releases`, used only by the release job.
3. A Developer ID Application certificate available to the build runner.
4. An App Store Connect API key limited to notarization duties.

Store credentials only as secrets in the private source repository. Never copy them into the public repository, build output, update metadata, logs, or provenance.

## Build configuration

Update `package.json`:

- Add an explicit GitHub publish provider for owner `ovsh` and repository `dailies-releases`.
- Build both `dmg` and `zip` for macOS arm64. The ZIP is required for macOS update metadata.
- Set `forceCodeSigning: true` for release builds.
- Keep `appId` fixed as `com.dailies.app`.
- Set the supported minimum macOS version explicitly.
- Generate blockmaps and `latest-mac.yml` through electron-builder.
- Change `npm run dist` so it invokes `electron-builder --mac` and therefore honors both configured macOS targets. Remove the current `--mac dmg` override.

Do not call `setFeedURL` at runtime. Use the generated `app-update.yml` so the feed is part of the verified package.

## Workflow

Add `.github/workflows/release.yml` and small scripts under `scripts/release/`. Pin third-party Actions to full commit SHAs.

### Validate

- Trigger from a manually approved `vX.Y.Z` tag.
- Require the tag, `package.json` version, and release version to match.
- Run `npm ci`, `npm run typecheck`, and `npm test` in a clean checkout.
- Refuse a dirty lockfile or missing signing and notarization credentials.

### Build

- Build on a native Apple Silicon or supported macOS runner.
- Sign every nested executable with the expected Team ID.
- Notarize the built application and staple its ticket, then package that verified application into the ZIP updater payload.
- Build the DMG from the verified application, submit the DMG for notarization, and staple the DMG ticket.
- Produce the blockmaps and update metadata.
- Generate and embed one `build-info.json` containing the application version, source commit, short build SHA, build time, workflow run ID, and a closed map from `BuildAssetId` to packaged main, preload, and renderer bundle paths. The application, diagnostics, source-map upload, and provenance read this same artifact.

### Verify the downloaded assets

Upload to a draft release, download the assets into a fresh directory, then verify the downloaded copies:

- Validate the DMG's stapled ticket, then mount it. Run `codesign --verify --deep --strict`, Team ID, hardened-runtime, `spctl --assess`, architecture, minimum-version, and stapler checks against its application.
- Extract the ZIP. Run the same application signature, Team ID, hardened-runtime, architecture, minimum-version, and stapled-ticket checks against the extracted application. A ZIP is not itself stapled.
- Check `latest-mac.yml` version, path, size, and SHA-512 against the ZIP updater payload only.
- Verify the DMG separately through its SHA-256, mount, and mounted-application assessment.
- embedded `app-update.yml` points only to `ovsh/dailies-releases`
- embedded `build-info.json` agrees with the tag, source commit, and provenance
- no source maps, secrets, Linux binaries, or x64 binaries are packaged

The current unpacked 0.2.0 app fails strict `codesign` verification. Treat that as a blocker to solve, not a warning to suppress.

### Attach provenance

Create `provenance.json` with:

```ts
type ReleaseProvenance = {
  version: string;
  sourceCommit: string;
  lockfileSha256: string;
  workflowRunUrl: string;
  builderVersions: Record<string, string>;
  artifacts: Array<{ name: string; sha256: string; size: number }>;
};
```

This manifest connects public binaries to the private-source commit without exposing source.

### Publish

- Keep the release in draft state while the owner and one canary install it.
- Treat that installation as manual artifact verification. An unauthenticated production updater cannot see a draft release.
- Publish only after every verification job and the canary checklist pass.
- Never replace an already published binary under the same version.
- If a release is bad, publish a higher patch version. Do not downgrade automatically.

Do not implement percentage staging in version 1. The current user cohort is too small to justify mutable rollout metadata.

## Assets allowed in the public repository

- signed DMG and ZIP
- blockmaps and `latest-mac.yml`
- checksums and `provenance.json`
- release notes with no private source details

The repository must never contain source maps, debug symbols, tokens, certificates, diagnostic events, support bundles, or user data.

## Tests

### Static

- Validate tag and package version mismatch failures.
- Validate metadata against known good and corrupted assets.
- Scan unpacked packages and public upload lists for forbidden files and credential patterns.
- Verify the workflow grants the minimum GitHub permissions.

### Runtime

- Install the downloaded draft DMG on a clean Mac and launch it without Gatekeeper bypass steps.
- Confirm the application reports the expected release and build SHA.
- Open and use a copied project after installation.

## Gate

Phase 2 is complete when a downloaded draft passes the artifact-specific DMG, extracted-ZIP application, update-metadata, signature, notarization, checksum, architecture, package-content, and launch checks. Publishing stays manual. Phase 7 proves N to N+1 only after Release B is public and Release A exists only on the two canary Macs.

## Principles

Boundary Discipline keeps credentials and private artifacts on the CI side. Make Operations Idempotent forbids republishing a version. Sequence Verifiable Units uses validate, build, draft, download, verify, canary, and publish boundaries. Prove It Works checks the downloaded artifact on a clean Mac.
