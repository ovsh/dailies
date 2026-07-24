# Phase 7: Add support tools and perform the rollout

[Back to the plan](README.md)

## Goal

Let a user report a problem without finding files by hand, give engineering a useful timeline, and prove the first real update before normal publication begins.

## Settings experience

Add a `Diagnostics and support` card in `src/renderer/screens/JobsSettingsScreen.tsx` before destructive settings actions.

It contains:

- `Share anonymous diagnostics` toggle, off by default
- a plain-language `What is shared` disclosure
- `Copy support code`
- `Reveal local logs`
- `Preview diagnostics`
- `Export diagnostics`
- a bounded problem category selector
- `Send diagnostics`, available only after preview, confirmation, and remote sharing has been enabled for the restarted app
- `Clear diagnostics`

Use application-owned UI. Do not enable Sentry's default feedback widget because its screenshot and replay behavior does not fit this app.

## Support code

Show a short code made from the current release and incident or session ID. Example:

```text
0.3.0 / J7K4-P2Q8
```

The full local IDs stay in the manifest. The short code is for matching an exported bundle or local session and must not encode a project, path, device, or user identity.

The consent-gated transport records its event ID only after Sentry returns a successful response. Write that full ID to a closed local `remote.event.accepted` record and show `Copy remote event ID`. Future bundle manifests include that mapping. Support searches Sentry by the exact full ID. Do not truncate it for remote lookup.

## Diagnostic bundle

The main process owns bundle creation. Build it in a temporary directory, scan it, ZIP it, then either save it to a user-selected path or attach it to a closed `support.bundle` Sentry event. Use the pinned SDK's scoped attachment API and capture the event separately. Do not use Sentry Feedback or free-form remote text in version 1.

Contents:

1. `manifest.json` with release, build SHA, environment, OS version, architecture, Electron version, requested time range, support code, and included sections.
2. Bounded sanitized JSONL from the current and recent sessions.
3. A safe job snapshot with project key, job IDs, stages, statuses, attempts, timestamps, safe error codes, and aggregate counts.
4. Incident IDs and matching Sentry event IDs when remote sharing was enabled.
5. One problem category from `startup`, `update`, `indexing`, `chat`, `playback`, `export`, or `other`.

Always exclude:

- project databases and settings files
- API keys, authentication material, and environment variables
- paths, filenames, project or episode names, and clip keys
- prompts, responses, transcripts, documents, chat history, and activity text
- media, images, screenshots, source files, source maps, and minidumps

The preview shows filenames, sizes, time range, event counts, and the exclusion list. It does not need to render every JSONL row.

If the user wants to describe the problem in their own words, direct them to the normal support conversation and make clear that anything they paste there is outside the automatic diagnostics boundary.

Delete temporary bundles after save, send, cancel, or a startup cleanup pass. Retain no server-side copy outside Sentry's configured retention.

## Sentry operations

Before the pilot begins:

- name one person who owns issue triage
- create alerts only for new fatal or high-severity regression groups
- document expected response and deletion steps
- record the selected data region and retention
- review quota and noisy groups once per month
- disable a noisy event at its semantic owner, not with a growing dashboard filter list

Do not alert on every retry, timeout that recovered, update check failure, or sampled span.

## Bootstrap rollout

### Release A: updater-capable bootstrap

1. Complete Phases 1 through 6 with production update checks pointed at the public release repository.
2. Build, verify, and canary the release as a draft.
3. Publish the signed installer and feed.
4. Install it manually only on the owner and canary Macs. Existing users remain on 0.2.0 for this proof.
5. Confirm both apps report the expected update state and no startup regression.

### Release B: first self-update proof

1. Make a harmless visible version change and build the next patch release as a draft.
2. Verify and manually install the draft on a disposable test profile. Draft GitHub Releases are not visible to unauthenticated production updater clients.
3. Publish Release B. At this point, only the owner and canary have Release A, so exposure is limited.
4. On both Macs, discover Release B, click `Download update`, then click `Restart to update`.
5. Verify the app relaunches as Release B, opens the project, passes database integrity, resumes recoverable jobs, and sends no diagnostics without consent.
6. Opt in on the canary, trigger synthetic safe failures, and verify support-code correlation and source maps.
7. After both Macs pass, ask every existing 0.2.0 user to install Release B once manually. Future releases can self-update from there.

After proof, manually install each draft on the canary before publishing it. A production updater cannot fetch a draft without credentials. Do not add a separate canary channel or percentage rollout until the user base and failure cost justify it.

## Failure and recovery runbook

- If a draft fails, delete the draft and fix the build before any user can see it.
- If a published update is bad, stop promoting it and publish a higher patch version. Do not reuse the version or silently downgrade.
- Keep the latest known-good signed installer publicly available for manual recovery.
- Preserve the pre-upgrade database backup until the new version has opened the project successfully more than once.
- If the app cannot launch, support uses the manual installer and backup runbook. Do not ask users to edit SQLite directly.
- If diagnostics leak a forbidden fixture, disable the Sentry project transport, preserve only access logs needed for incident response, delete affected events under the chosen policy, and ship a corrected higher patch version.

## Tests

- Generate, preview, cancel, export, send, clear, and startup-clean bundles.
- Open the ZIP, enforce an exact entry manifest, and scan every decompressed entry for forbidden fixtures and common encodings. Raw archive-byte scanning is an additional check, not the proof.
- Disconnect during send and prove no hidden retry queue is created beyond the consented Sentry cache.
- Turn consent off before reconnecting and prove the queued event never sends.
- Run the complete Release A to Release B path on installed signed applications.
- Reopen a migrated copied project and run search, playback, chat, and export smoke tests.

## Gate

Phase 7 is complete when one existing-style installation has manually bootstrapped, two Macs have completed the real N to N+1 path, support can find a consented event from its exact remote event ID or match an exported bundle by local support code, and an opt-out user produces no remote traffic.

## Principles

Experience First gives the user preview, consent, and explicit control. Boundary Discipline scans the completed bundle at the last outbound boundary. Sequence Verifiable Units separates bootstrap from first self-update. Prove It Works requires signed installed applications and copied project data.
