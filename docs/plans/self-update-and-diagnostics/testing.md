# Verification matrix

[Back to the plan](README.md)

## Baseline

At planning time:

- `npm run typecheck` passes.
- `npm test` passes 17 test files and 139 tests.
- The source worktree was clean before these plan documents were added.
- The unpacked 0.2.0 application fails strict signature verification, so release verification is currently red.

## Required automated suites

| Suite | Purpose | Required result |
| --- | --- | --- |
| Existing typecheck and unit suite | Prevent application regressions | All pass |
| `migration-upgrade` | Upgrade 0.2.0 and current fixtures, failure recovery, integrity | No data loss and readable verified backup |
| `shutdown-coordinator` | Repeated quit, active work, child termination, timeout | One drain and no child left alive |
| `package-inspection` | Native architecture, forbidden files, size, embedded feed | Only expected arm64 content and public feed |
| `release-verification` | Mounted DMG, extracted ZIP application, Team ID, runtime, notarization, stapled application, and ZIP metadata | Downloaded assets pass their artifact-specific checks |
| `updater-state` | Legal transitions, timers, overlap, retries, install safety | Deterministic state and one operation at a time |
| `update-ui` | Copy, actions, accessibility, failure states | Every state reachable and keyboard usable |
| `diagnostics-contract` | Closed events, sanitization, rotation, correlation | Bounded and no forbidden content |
| `sentry-transport` | Consent, allowlist, sampling, offline purge | Zero traffic while off and safe envelopes while on |
| `support-bundle` | Preview, export, send, cleanup, exact ZIP manifest, and decompressed-entry scan | Only declared files and safe content |

Name scripts after their owned outcome rather than introducing one large test runner.

## Forbidden-content predicate

Use one shared predicate for local logs, Sentry envelopes, offline cache, decompressed support-bundle entries, public release assets, and source-map staging. Never treat a raw compressed-archive scan as proof that its entries are safe.

Test raw, URL-encoded, JSON-escaped, base64, lowercase, and uppercase forms where applicable. Include:

- fake OpenRouter and Sentry tokens
- authorization and cookie headers
- macOS username and home path
- media path and filename
- project and episode names
- prompt, response, transcript, document, and note fragments
- provider response body and query string
- settings JSON and database magic bytes

Any match blocks the phase. Do not add a suppression without documenting why that exact value is safe.

## Update fault matrix

Test each failure from a packaged application:

| Failure | Expected behavior |
| --- | --- |
| Offline or DNS failure during background check | Quiet local event, backoff, no global banner |
| Offline during manual check | Inline safe error and immediate retry action |
| Missing or malformed metadata | Remain on current version and record safe error code |
| Truncated or checksum-mismatched download | Never reach `ready`; allow retry |
| Wrong signing identity | Installation blocked and incident recorded |
| Check, download, or install clicked repeatedly | Reuse one in-flight operation |
| Mac sleeps during a check | No overlap after wake; stale check runs once |
| Active pipeline or chat during restart | Drain or return safely to `ready`; never force restart |
| Migration fails after update | Preserve original and verified backup; show recoverable support code |
| Published version is bad | Higher patch hotfix; no reused version or automatic downgrade |

## Diagnostics fault matrix

Use test-only failure injection that is absent from production packages.

| Scenario | Local result | Remote result after consent |
| --- | --- | --- |
| Main uncaught exception | One incident, bounded flush attempt, then process exits | One source-mapped issue when the consented transport is reachable; otherwise best effort |
| Renderer Error Boundary | One UI incident | One source-mapped issue |
| Preload failure | One process incident | One source-mapped issue |
| Caught chat failure | Turn timeline and terminal incident | Safe issue linked to sampled trace when present |
| Pipeline retry then success | Retry and recovery transitions | Breadcrumbs or sampled span, no error issue |
| Pipeline terminal timeout | One terminal incident | One safe issue |
| Model 429 then fallback | Status, retry, fallback, duration | No bodies and no issue if recovered |
| Update metadata error | Update state and code | Issue only if policy classifies it as actionable |
| 10,000 generated events | Bounded files and responsive app | Sampling and quota stay bounded |
| Opt out while offline events exist | Cache removed | No later upload |
| Try to send a bundle while opted out | Local preview and export remain available | Send action is disabled and no network starts |

Native `process.crash()` testing is deferred with native dump upload. Electron `render-process-gone` metadata should still be tested without a minidump.

## Real installed-update proof

This gate cannot be replaced with mocks:

1. Install signed Release A through its downloaded DMG.
2. Confirm Gatekeeper, app version, build SHA, and public feed.
3. Open a copy of a representative 0.2.0 project and run integrity checks.
4. Verify Release B as a draft, then publish it while Release A is installed only on the owner and canary Macs.
5. On both Macs, check manually, download, defer once, and restart before distributing the updater-capable build more broadly.
6. Confirm Release B relaunches, reopens the project, preserves settings and key access, and recovers jobs as designed.
7. Repeat on a second canary Mac before public promotion.

## Release commands and evidence

The implementation should provide checked scripts for these outcomes:

```text
npm run typecheck
npm test
npm run dist
npm run verify:package
npm run verify:release
npm run test:update-installed
npm run test:diagnostics-privacy
```

Exact script names may change once implementation files exist. Each command must return nonzero on failure and produce a short machine-readable evidence file. The release workflow attaches the evidence, checksums, and provenance to the private workflow run. Only safe provenance is copied to the public release.

## Final manual checklist

1. Update UX is quiet, keyboard accessible, and contains no forced restart.
2. Settings can check manually, download, restart, control diagnostics, and create a support bundle.
3. An exact remote event ID resolves to one consented Sentry event, or a local support code matches one exported bundle, without project or user identity.
4. Opt-out has been verified at the network layer, not inferred from a setting value.
5. Downloaded public assets, installed application, migrated database, and real Sentry issue all pass their respective gates.
