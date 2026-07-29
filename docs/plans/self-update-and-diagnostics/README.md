# Self-update and diagnostics plan

Status: implementation plan only. No production updater or telemetry has been enabled.

> **2026-07-28 — repo went public.** `ovsh/dailies` is now the public source
> repository, so the update feed in 0.3.0 points at it directly
> (`build.publish` in `package.json`). The separate `ovsh/dailies-releases`
> repo and cross-repo token described below were designed around a private
> source repo and are no longer needed. A minimal updater (silent check at
> startup, silent download, native restart prompt) shipped in 0.3.0 — it is
> a small slice of the "Updates" experience in this plan, not the full
> quiet-dot/banner/diagnostics design, which remains unimplemented.

## Outcome

Dailies should gain two simple user-facing capabilities:

1. The app quietly discovers a new signed release, shows a small update indicator, downloads only after the user clicks, and restarts only after the user clicks again.
2. Every important operation produces a correlated, privacy-safe event timeline. Logs stay on the Mac by default. A user may opt into sending closed incident events to Sentry and, after enabling that sharing, explicitly send a diagnostic bundle.

The release system is the first dependency of both capabilities. The current app has no updater runtime, no release workflow, and no verified upgrade-safe database backup. The unpacked 0.2.0 app also fails strict signature verification. Production update checks must remain disabled until those conditions are fixed.

## Decisions

| Area | Decision | Why |
| --- | --- | --- |
| Update transport | `electron-updater` with GitHub Releases in a new public `ovsh/dailies-releases` repository | The source repository is private. A client token must never ship in the app. |
| Supported target | macOS 14 or newer on Apple Silicon | That is the only platform the current app and bundled Whisper binary support. |
| Check cadence | Check 30 seconds after launch, every 4 hours while running, and after wake or focus when the last check is stale | Releases are infrequent. Five-minute polling adds noise without improving the experience. |
| Download policy | `autoDownload = false` and `autoInstallOnAppQuit = false` | The user asked for a download button. Large downloads and restarts must be explicit. |
| Update notice | A quiet amber dot in the rail and a compact non-modal banner | It is visible without blinking, pulsing, or interrupting work. |
| Install policy | Show `Restart to update` only after the package is ready and active work can drain safely | Updating must not corrupt a project or interrupt indexing, chat, export, or migration. |
| Local diagnostics | A typed diagnostics facade backed by bounded `electron-log` files | This replaces the current synchronous, unbounded append logger. |
| Remote diagnostics | Sentry Developer plan, opt-in, limited to closed JavaScript incident events and manually named sampled spans | This supplies grouping, release attribution, source-mapped application frames, and safe operation traces without building an observability backend. |
| Native crash dumps | Excluded from version 1 | A minidump can contain process memory, including sensitive text or keys. It needs separate consent and policy review. |
| Session replay | Excluded | Footage, transcripts, notes, and chat make replay too risky and unnecessary. |
| Rollout | Give the updater-capable bootstrap to the owner and one canary, prove its first N to N+1 update, then distribute it more broadly | Percentage rollout machinery is needless for the current cohort. |

## User experience

### Updates

```text
Background check -> update available -> quiet dot and banner
                                      -> user clicks Download update
                                      -> progress appears
                                      -> user clicks Restart to update
                                      -> work drains, app restarts, project reopens
```

- Settings always shows the installed version, last successful check, and `Check for updates`.
- `Download update` is the one-click start. Restart remains a second click because it interrupts work and can close long-running processes.
- Background failures stay quiet. A manual check shows a short inline error with `Try again`.
- Dismissing the banner hides it for the current session. The rail dot and Settings card remain.
- The app never installs while work is active. It never silently restarts.
- Users on 0.2.0 need one final manual install because that version has no updater code.

### Support and diagnostics

```text
Operation -> typed safe event -> rotating local log
                              -> Sentry only when opted in and remotely allowed

Problem -> Copy support code or Export diagnostics -> sanitized recent session bundle
                                                    -> Send only when remote sharing is enabled
```

- The support code identifies an app release and session. It does not identify a person or project.
- `Share anonymous diagnostics` is off by default because Dailies handles confidential footage and currently promises a local-first workflow.
- Settings explains what is collected and what is never collected before consent is requested.
- A user can reveal the local log folder or inspect and export a sanitized bundle even when remote reporting was off. Sending requires remote sharing to be enabled after restart.

## Data shapes to establish first

### Update state

Use one discriminated union shared by main, preload, and renderer:

```ts
type UpdateState = { currentVersion: string } & UpdateStatus;

type UpdateErrorCode =
  | "NETWORK_UNAVAILABLE"
  | "FEED_UNAVAILABLE"
  | "METADATA_INVALID"
  | "DOWNLOAD_INTEGRITY_FAILED"
  | "SIGNATURE_INVALID"
  | "DRAIN_TIMED_OUT"
  | "INSTALL_FAILED"
  | "UNCLASSIFIED_FAILURE";

type UpdateStatus =
  | { kind: "disabled"; reason: "development" | "unsupported" }
  | { kind: "idle"; lastCheckedAt: string | null }
  | { kind: "checking"; trigger: "startup" | "scheduled" | "resume" | "manual" }
  | { kind: "current"; checkedAt: string }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | {
      kind: "error";
      operation: "check" | "download" | "install";
      code: UpdateErrorCode;
      targetVersion?: string;
      retry: "check" | "download" | "none";
    };
```

The renderer can request a check, request a download, request a restart, read state, and subscribe to state. It cannot provide a feed URL, version, path, command, or release channel.

### Diagnostic event

Use a closed payload map. Do not accept an arbitrary object at the logging boundary.

```ts
type DiagnosticEnvelope<N extends DiagnosticEventName> = {
  schemaVersion: 1;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  name: N;
  process: "main" | "preload" | "renderer";
  release: string;
  buildSha: string;
  sessionId: string;
  correlation: {
    projectRef?: string;
    runId?: string;
    jobId?: string;
    turnId?: string;
    incidentId?: string;
  };
  payload: DiagnosticPayloadMap[N];
};
```

`projectRef` is derived with a per-install random salt. `sessionId` is new for each launch. Do not create a stable user, device, or installation identity. Rotate the salt when diagnostic data is cleared.

## Privacy boundary

Never place these values in a local support bundle or a remote event:

- API keys, authorization headers, cookies, environment variables, or settings files
- prompts, model responses, transcripts, notes, document text, or raw database rows
- media, thumbnails, waveforms, or screen captures
- filenames, absolute paths, project names, episode names, usernames, or email addresses
- request or response bodies from OpenRouter or another service

Error messages and raw stacks are not safe. Persist a stable error code, retry policy, and allowlisted application frames only. The renderer maps the code to fixed application-owned copy. Drop unknown names, messages, causes, and non-application frames before local persistence or remote capture. Never pass a raw `Error` to Sentry.

## Phases

Each phase has an independent gate. Do not start the next phase while the current gate is red.

1. [Make upgrades safe and shrink the package](01-upgrade-safety.md)
2. [Build the trusted release pipeline](02-release-pipeline.md)
3. [Add the updater domain and IPC](03-updater-domain.md)
4. [Add the update experience](04-update-experience.md)
5. [Build the local diagnostics foundation](05-local-diagnostics.md)
6. [Add Sentry and critical-flow instrumentation](06-sentry-and-instrumentation.md)
7. [Add support tools and perform the rollout](07-support-and-rollout.md)

The shared verification matrix is in [testing.md](testing.md).

## Delivery sequence and effort

| Milestone | Phases | Expected engineering effort | Release effect |
| --- | --- | --- | --- |
| Trusted bootstrap | 1 and 2 | 3 to 5 engineer-days plus Apple and GitHub credential setup | Produces a verified manual installer and update feed. |
| Update experience | 3 and 4 | 2 to 3 engineer-days | Produces the first manually installed updater-capable release. |
| Diagnostics pilot | 5 and 6 | 3 to 4 engineer-days plus Sentry setup | Produces bounded local logs and consented remote errors. |
| Support rollout | 7 | 1 to 2 engineer-days plus one real release cycle | Proves upgrade and support workflows end to end. |

These are planning ranges, not commitments. Apple credential access, notarization, and a real installed-version test are the likely schedule constraints.

## External setup

The setup work is authorized but not complete. Computer Use could not proceed because the Mac is locked, and local GitHub CLI authentication is expired.

1. Create a public repository named `ovsh/dailies-releases`. Give it a README and no source code.
2. Create a fine-grained GitHub token with `Contents: write` only on that repository and use it only in the release job. Store it as an Actions secret in the private source repository. This action requires confirmation when the persistent credential is created.
3. Confirm the Developer ID Application certificate and create an App Store Connect API key for CI notarization. Store all values as private repository secrets.
4. Create a Sentry organization and Electron project named `dailies-desktop`. Start on the free Developer plan. Choose the data region and retention policy, configure the project-side IP storage or scrubbing policy, and verify it with a test event before sending production events. If the selected plan cannot meet the policy, disclose that limitation or keep remote diagnostics disabled.
5. Create a Sentry source-map upload token limited to the project and store it only in the private source repository.

The public repository may contain signed release assets, update metadata, checksums, release notes, and a provenance manifest. It must not contain source maps, symbols, credentials, logs, or user data.

## Alternatives rejected

| Alternative | Reason to reject now |
| --- | --- |
| Put a GitHub token in the desktop app | Every installation would contain a durable credential. The private GitHub provider is unsuitable for normal end users. |
| Build an S3, R2, or custom update service | It adds storage, access policy, deployment, and monitoring with no current user benefit. |
| Build a custom logging backend or OpenTelemetry stack | It adds ingestion, retention, alerting, and on-call work before the event model is known. |
| Upload every log line to Sentry | It is expensive, noisy, and likely to expose private material. |
| Enable session replay | The risk is disproportionate for an app that displays private footage and text. |
| Check every 5 or 10 minutes | An app release is not time-critical. Launch, resume, four-hour checks, and a manual button are enough. |
| Install automatically on quit | The current shutdown path does not await project closure. The user also loses control over when a large update is applied. |
| Implement automatic rollback | Current database migrations are not downgrade-safe. A reliable rollback system would require a second launcher, boot-success tracking, and schema compatibility rules. Use backup plus a higher-version hotfix. |
| Add a generic stuck-state watchdog | Pipeline stages already have explicit timeouts and recovery. Instrument those paths before adding another state machine. |

## Self-critique

### Complexity that is justified

- A public release repository and cross-repository credential are extra infrastructure. They are justified only because the source repository is private and clients must download without a shipped token.
- A typed event map takes more initial work than `console.log`. It is the main control preventing arbitrary user content from reaching disk or Sentry.
- A pre-migration backup and release verification job slow releases. They are necessary because a failed upgrade cannot safely downgrade the current database.

### Complexity deliberately deferred

- No Windows or Linux updater until those applications exist.
- No staged percentage rollout, channel system, CDN, custom backend, OpenTelemetry collector, replay, product analytics, or native minidump upload.
- No dashboard for every event. Start with errors, release health, and a small support timeline.
- No automatic rollback. Keep a signed manual installer and ship a higher patch version.

### Main residual risks

1. A public feed makes release assets visible to anyone. It does not expose private source, but release notes and provenance must be written accordingly.
2. Sentry source maps reveal source to Sentry. They stay private from users, but contractual review may still be needed.
3. Redaction is a control, not proof. Canary tests and an explicit event allowlist remain release gates.
4. `quitAndInstall` is unsafe until long-running child processes and database closure can be awaited or terminated predictably.
5. Existing users cannot receive the first updater-capable build automatically.

## Definition of done

The work is complete only when all of these are true:

1. A clean CI build produces a verified DMG and a ZIP containing the signed, notarized, stapled application. The downloaded DMG, extracted ZIP application, and update metadata each pass their artifact-specific checks.
2. An installed version N discovers N+1, downloads after one click, restarts after one click, preserves the project database, and reports N+1 after relaunch.
3. Update checks never overlap, background failures stay non-disruptive, and restart cannot begin while tracked work is unsafe.
4. A synthetic main, preload, renderer, pipeline, model, and updater failure can be correlated by session and operation without revealing canary secrets or content.
5. Any user can inspect and export a bounded diagnostic bundle. An opted-in user can send it after confirmation, while an opted-out user causes no Sentry traffic.

## Implementation guidance

For each phase, read the named files before changing them and keep the phase gate green before proceeding. Apply the project skills in this order:

1. Use `how` to trace the current path and `architect` to confirm types and boundaries.
2. Use `typescript-best-practices`, `security-best-practices`, and the pstack principles named in each phase while editing.
3. Use `interrogate` after the first implementation pass, then `unslop` on UI copy and documentation.
4. Use `show-me-your-work` for the release-chain and privacy decisions.
5. Use Computer Use or the existing packaged-app CDP scripts to verify the real installed application. Use `babysit` after a pull request is opened if that skill becomes available.

The plan follows Foundational Thinking by putting signing and data safety first. Experience First produced the quiet indicator and explicit restart. Laziness Protocol removed custom servers, replay, staged rollout, and automatic rollback. Model the Domain produced the two closed unions. Boundary Discipline puts validation and redaction at IPC, network, logging, and Sentry boundaries. Make Operations Idempotent requires one in-flight check, one download, and one install transition. Prove It Works requires installed N to N+1 and real outbound-envelope tests.

## Primary references

- [electron-builder auto-update guide](https://www.electron.build/docs/features/auto-update/)
- [electron-builder GitHub publishing guide](https://www.electron.build/publish/)
- [electron-builder macOS signing](https://www.electron.build/docs/features/code-signing/code-signing-mac/)
- [electron-builder notarization](https://www.electron.build/docs/notarization/)
- [Apple notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Sentry Electron setup](https://docs.sentry.io/platforms/javascript/guides/electron/)
- [Sentry data collection](https://docs.sentry.io/platforms/javascript/guides/electron/data-management/data-collected/)
- [Sentry pricing](https://sentry.io/pricing/)
- [GitHub release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
