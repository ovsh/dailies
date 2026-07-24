# Phase 6: Add Sentry and critical-flow instrumentation

[Back to the plan](README.md)

## Goal

Send consented, privacy-safe errors and sampled traces to Sentry with source-mapped stacks. Keep the local diagnostics contract as the source of truth and Sentry as one optional adapter.

## Service choice

Use the Sentry Developer plan for the pilot. It is enough for one operator and the current event volume. Upgrade only when another dashboard user, higher retention, or additional operational features are actually needed.

Create one Sentry Electron project named `dailies-desktop`. Decide the data region, retention, deletion procedure, and person responsible for triage before production events are enabled.

## Consent

Add one version 1 setting:

```ts
type DiagnosticsPreference = {
  shareAnonymousDiagnostics: boolean;
};
```

- Default is `false` for existing and new installations.
- Local diagnostics remain enabled either way.
- When false, skip Sentry SDK initialization and remove its owned offline cache before any transport starts.
- `Send diagnostics` is disabled while this setting is false. Version 1 has no one-time hidden transport.
- Turning sharing off first flips a transport-level deny gate and aborts in-flight requests. Main then tells renderer and preload to apply the same gate and acknowledge, discards queued sends, closes each client with zero flush time, removes every configured Sentry cache directory, and stops new capture. Test this sequence both online and offline, then reconnect and prove nothing is uploaded.
- Turning sharing on may require one app restart so main, preload, and renderer initialize consistently. State that in the UI.
- Do not add native crash-dump consent in version 1. The feature is absent, not hidden behind this toggle.

## SDK setup

Add `@sentry/electron` as a production dependency and pin the chosen version in the lockfile.

Initialize it in main, preload, and renderer because `contextIsolation` is enabled. The user-data test override must run before main SDK initialization.

Set `defaultIntegrations: false`. The version 1 integration allowlist is deliberately empty in main, preload, and renderer. Sentry receives only closed `captureEvent` payloads and manually started constant-name spans. Add a snapshot test over each configured integration name so an SDK upgrade cannot silently enable a default. In particular, do not enable:

- native minidumps and any second crash reporter
- Sentry Logs and Session Replay
- screenshots and the default Feedback widget
- console, DOM, and automatic network breadcrumbs
- local-variable capture and automatic runtime source-context enrichment
- automatic fetch or HTTP tracing
- server name and user objects

Set `sendDefaultPii: false` and `includeServerName: false`, but do not treat those flags as the privacy control. Configure and verify the Sentry project-side IP storage or scrubbing policy. If the selected plan cannot guarantee the documented policy, disclose the remaining network-metadata handling or keep the integration disabled. The Phase 5 classifier and fixed event map are the application controls.

Use the same final allowlist in local serialization, `beforeSend`, manual breadcrumb construction, span processing, support export, and tests. `beforeSend` builds a new event from approved fields instead of deleting fields from the SDK event. Drop an event if a forbidden pattern survives. Construct an exception event from `SafeIncident.code`, fixed application copy, and its `SafeFrame` values. Never call `captureException` and never give Sentry a raw `Error`, message, stack string, or cause.

Configure one explicit cache directory beneath user data for each process that persists events. Record those exact paths in the diagnostics adapter, not in settings. Startup with sharing off removes them before SDK initialization. Do not let the SDK choose an untracked cache location.

Wrap the selected Sentry transport with the consent deny gate, request abort control, and a success callback that records the full event ID only after a successful Sentry response. Do not build another retry queue.

## Release and source maps

Use one release value across all processes:

```text
com.dailies.app@<version>+<short-build-sha>
```

Update the build scripts to emit source maps for renderer, main, and preload into a private CI directory. In the private release workflow:

1. Inject or associate debug IDs.
2. Upload maps with a project-scoped Sentry token.
3. Verify a synthetic stack resolves to TypeScript.
4. Delete maps before electron-builder packages the app.
5. Scan the package and public release assets to prove no map or token remains.

Source maps disclose shipped application code to Sentry. Confirm that this is acceptable under project contracts. If static prompt literals must not appear in `sourcesContent`, upload maps without sources content and accept reduced context.

## Instrument semantic owners

Do not forward general console output. Emit at the place that owns the outcome.

### Application and IPC

- application start, ready, clean shutdown, unclean previous exit, and update restart
- safe renderer, preload, main, child-process, and unresponsive failures
- mutating IPC duration and outcome at a shared registration wrapper, without arguments or results

### Project and pipeline

- project activation and closure through `src/main/project-manager.ts`
- claimed, launched, waiting, retry, success, failure, cancel, and boot recovery through `src/main/pipeline/queue.ts`
- one attempt span per pipeline stage
- existing stage timeout and recovery outcomes from `src/main/pipeline/timeouts.ts`

Do not add a second generic stuck-state machine. First instrument the existing deadlines. Add a health event only when a stage exceeds its own deadline plus a small grace period or later recovers.

### Models and agents

- model operation, configured model identifier, status, duration, retry, fallback, and provider request ID in `src/main/agents/openrouter-client.ts`
- agent turn, iteration, and constant tool-name spans in `src/main/agents/supervisor.ts`
- never request bodies, response bodies, chat text, activity strings, tool arguments, or tool results
- capture a terminal model or turn error once. Earlier retries become safe breadcrumbs.

### Updater

- trigger, state transition, target version, duration, and safe error code from the Phase 3 service
- never the release URL, local file path, token, or raw provider error body

## Sampling and indexing

- Send sanitized errors at 100 percent after consent.
- Sample chat-turn traces at 20 percent.
- Sample pipeline-stage and mutating-IPC traces at 5 percent.
- Omit read-only IPC tracing in version 1.
- Record all safe semantic transitions locally.

Use low-cardinality tags for release, environment, process, architecture, stage, and safe error code. Keep project, run, job, turn, and session identifiers in structured context rather than tags. Put a short incident ID on captured errors so support can match a user report.

## Tests

### Transport and privacy

- Use an in-memory Sentry transport to inspect the final serialized envelope.
- Prove consent off produces zero network attempts and removes old queued events before initialization.
- While online with an in-flight test event, opt out and prove the deny gate aborts the request before client close can flush it. Repeat offline, reconnect, and prove nothing sends.
- Snapshot the integration names for main, preload, and renderer and prove all three lists are empty.
- Pass every Phase 5 forbidden fixture through errors, breadcrumbs, spans, offline storage, and attachments.
- Fail the release if any forbidden value survives.

### Source maps and packaged processes

- Trigger controlled main, renderer, and preload errors in a packaged test build.
- Confirm each event has the same release and resolves to the correct TypeScript source line.
- Confirm no `.map`, Sentry token, DSN secret beyond the intended public DSN, or source text ships in public artifacts.

### Traces

- Verify one chat turn connects its safe model and tool spans.
- Verify one pipeline attempt connects its retry or terminal outcome.
- Verify caught chat and pipeline failures produce incidents, not only fatal crashes.
- Verify long work below its existing deadline does not produce a false stuck incident.

## Gate

Phase 6 is complete when an opted-in packaged build produces source-mapped errors and correlated sampled traces, an opted-out build makes zero Sentry requests, and forbidden-fixture scans pass across live and offline envelopes.

## Principles

Boundary Discipline treats Sentry as an untrusted outbound boundary. Redesign From First Principles keeps the local contract independent of the vendor. Laziness Protocol uses one hosted service and disables broad SDK features. Prove It Works inspects actual serialized envelopes and packaged stacks.
