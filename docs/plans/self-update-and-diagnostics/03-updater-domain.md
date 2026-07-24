# Phase 3: Add the updater domain and IPC

[Back to the plan](README.md)

## Goal

Own all update behavior in the main process behind a small typed state machine. The renderer can express user intent but cannot control the update source or install arbitrary files.

## Dependencies

- Add `electron-updater` as a production dependency.
- Add it to the main esbuild external list so its runtime files remain available to Electron.
- Pass the diagnostics logger from Phase 5 when that phase lands. Until then, use an injected no-op logger in tests and the normal updater logger in production.

## Files

Create:

- `src/main/updater.ts`
- `src/main/updater.test.ts`
- `src/renderer/hooks/useUpdateState.ts`

Change:

- `src/shared/types.ts`
- `src/shared/ipc.ts`
- `src/preload/index.ts`
- `src/main/ipc-handlers.ts`
- `src/main/index.ts`
- `src/renderer/api.ts`
- `src/renderer/global.d.ts`
- `src/renderer/mock/api.ts`

## Main-process service

Create one `UpdateService` with injected updater, clock, timer, shutdown coordinator, and logger. Keep the renderer out of this object.

```ts
interface UpdateService {
  start(): void;
  getState(): UpdateState;
  check(trigger: "manual" | "startup" | "scheduled" | "resume"): Promise<UpdateState>;
  download(): Promise<void>;
  install(): Promise<void>;
  subscribe(listener: (state: UpdateState) => void): () => void;
  stop(): void;
}
```

Configuration:

- `autoDownload = false`
- `autoInstallOnAppQuit = false`
- `allowPrerelease = false`
- `allowDowngrade = false`
- enable only in a packaged macOS arm64 production build

Do not render release-note HTML supplied by the feed. Version and short application-owned copy are enough.

## Scheduling

1. Schedule the first background check 30 seconds after the window is ready.
2. Schedule the next one-shot timer four hours after the previous check finishes.
3. On wake or window focus, check only if the last completed check is older than four hours.
4. A manual request runs immediately unless another check is already active.
5. Reuse one in-flight promise so checks cannot overlap.
6. On failure, leave manual checking available and back off background attempts. Cap retry delay at six hours.

Use a one-shot timer rather than `setInterval`. Stop and replace the timer after each state transition so sleep, a slow network, or a long check cannot create overlapping work.

## State transitions

```text
disabled

idle or current -> checking -> current
                            -> available
                            -> idle after a failed background check
                            -> error after a failed manual check

available or retryable download error -> downloading -> ready
                                                   -> error

ready -> installing -> process exit after a successful drain
                    -> ready after a drain timeout
```

Rules:

- `download()` is valid only from `available` or a retryable download error.
- `install()` is valid only from `ready`.
- Repeated download or install requests return the active operation instead of starting another.
- A failed scheduled check records a safe error code, returns to `idle`, and does not show global UI.
- A failed manual check returns an `UpdateErrorCode`. The renderer maps it to fixed inline Settings copy.
- A failed download preserves `targetVersion` and `retry: "download"` so retry is unambiguous.
- Installation enters `installing` and calls the Phase 1 shutdown coordinator. Only a `ready` drain result may flush diagnostics and invoke `quitAndInstall` once. A timeout returns to `ready` with a fixed error code and never calls the installer.

## IPC contract

Expose exactly these methods through the existing preload API:

```ts
getUpdateState(): Promise<UpdateState>;
checkForUpdates(): Promise<UpdateState>;
downloadUpdate(): Promise<void>;
restartToUpdate(): Promise<void>;
onUpdateState(listener: (state: UpdateState) => void): () => void;
```

Validate all returned state at the preload boundary. The renderer never supplies a version, file path, URL, release channel, or command.

## Tests

### Unit

Use a fake updater and fake clock to cover:

- all legal transitions and rejection of illegal transitions
- startup, four-hour, wake, focus, and manual triggers
- a slow check followed by multiple manual requests
- background retry and maximum backoff
- download progress clamped to 0 through 100
- checksum, network, metadata, and signing failures
- double download and double install
- shutdown ready and timed-out results, including proof that timeout never calls `quitAndInstall`
- disabled development and unsupported-platform states

### Runtime

- Point a packaged test build at a controlled test feed through test-only updater configuration that is absent from production packages.
- Verify no network request occurs in development.
- Verify a manual check works immediately after launch.
- Disconnect the network during check and download, reconnect, and retry.
- Corrupt a test asset and verify it never reaches `ready`.

## Gate

Phase 3 is complete when every updater event maps to one state, operations never overlap, the renderer cannot alter the feed, and a packaged test build downloads a valid test release without installing it.

## Principles

Model the Domain and Type System Discipline define the closed state union. Boundary Discipline limits renderer authority. Make Operations Idempotent prevents overlapping checks, downloads, and installs. Laziness Protocol keeps one service and one timer instead of a scheduler framework.
