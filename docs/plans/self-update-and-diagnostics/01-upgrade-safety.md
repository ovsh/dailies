# Phase 1: Make upgrades safe and shrink the package

[Back to the plan](README.md)

## Goal

Make an application restart and database migration predictable before adding an updater. Remove packaged binaries that the Apple Silicon build cannot use.

## Why this comes first

- `before-quit` currently starts `manager.closeCurrent()` but does not await it.
- Active ffmpeg, ffprobe, Whisper, or model requests may still be running when Electron exits.
- Database setup performs in-place migrations, including destructive table drops, without a version ledger or pre-migration backup.
- The unpacked app is about 682 MiB. `ffprobe-static` contributes about 233 MiB and includes macOS x64 and Linux binaries that this build cannot execute.

## Changes

### 1. Add one shutdown coordinator

Create `src/main/shutdown.ts` with one idempotent operation:

```ts
type ShutdownReason = "user-quit" | "update-install";

interface ShutdownCoordinator {
  prepare(reason: ShutdownReason): Promise<"ready" | "timed-out">;
}
```

- On the first `before-quit`, prevent the quit, call `prepare("user-quit")`, then quit again with an internal one-shot `readyToQuit` flag.
- The updater calls the same operation with `update-install` before `quitAndInstall`.
- Only a successful drain sets `readyToQuit`. A timeout leaves it false, so no later quit or installer path can bypass the drain accidentally.
- Stop accepting new chat, indexing, export, and model work as soon as draining starts.
- Update the pipeline process wrapper so an abort terminates its child process, waits a short grace period, then kills it if needed.
- Give normal quit a bounded wait and show no UI. Give an update restart a visible `Finishing current work` state. If the drain times out, return to the ready state instead of forcing installation.
- Flush diagnostics after project and database closure with a short best-effort deadline.

Primary files:

- `src/main/index.ts`
- `src/main/project-manager.ts`
- `src/main/pipeline/queue.ts`
- `src/main/pipeline/exec.ts`
- `src/main/agents/openrouter-client.ts`

### 2. Version database migrations

Use SQLite `PRAGMA user_version` as the single schema ledger. Do not add a second migration framework.

Create:

- `src/main/db/migrations.ts` for ordered, named migrations
- `src/main/db/backup.ts` for pre-upgrade backups and integrity checks

Before the first migration for a newer app version:

1. Close work against the project database and checkpoint its WAL.
2. Create a SQLite backup in the project data directory using the database backup API.
3. Open the backup read-only and run `PRAGMA integrity_check`.
4. Atomically write an upgrade marker with `prepared`, source version, target version, and the relative backup name.
5. Apply each pending migration and its `user_version` change in one transaction. Do not permit a non-transactional in-place migration.
6. Close and reopen the migrated database, run `PRAGMA integrity_check`, and verify the target version.
7. Atomically remove the upgrade marker only after verification.
8. Keep the two newest verified pre-upgrade backups and prune older ones.

Both an empty database and the shipped 0.2.0 database currently report user version 0. Add one explicit bootstrap detector that identifies the known 0.2.0 schema by its required tables and columns, records that baseline, and never replays destructive setup against it. An unknown unversioned schema fails closed and keeps its backup.

If migration throws, close the database, move the failed database and any WAL or SHM files into a quarantine directory, copy the verified backup to a temporary file on the same volume, fsync it, then atomically rename it into the original location. Reopen it read-only and verify integrity before clearing the marker.

At startup, inspect a leftover `prepared` marker before opening the project normally:

- If the current database is integral and already reports the target version, the commit completed. Clear the marker.
- Otherwise restore the verified backup through the same atomic replacement path.
- If neither current nor backup is integral, stop opening the project and show a support code. Never continue into another migration attempt.

The backup manifest contains only schema version, app version, timestamp, database checksum, and a relative backup filename. It is not diagnostic telemetry.

Move existing setup logic out of `src/main/db/database.ts` without changing the resulting schema. Add fixture databases for the last shipped version and the current version.

### 3. Make settings changes versioned

Add a `settingsVersion` field to `src/main/app-settings.ts`. Parse settings through a narrow schema, apply ordered migrations, and write atomically through a temporary file plus rename. Preserve the existing encrypted API-key behavior.

### 4. Package only runnable native resources

Update `package.json` and add `scripts/verify-package.mjs`.

- Keep only the Darwin arm64 ffprobe executable in a macOS arm64 build.
- Keep the existing Darwin arm64 Whisper resources.
- Fail packaging if a Linux or x64 ffprobe binary appears in the app.
- Record unpacked app, DMG, and ZIP sizes as build outputs.
- Report size changes against the first verified updater-capable release. Set a blocking growth budget only after that durable baseline and an exception policy exist.

Do not change media behavior or replace ffmpeg in this phase.

## Tests

### Static

- Unit-test every migration from the 0.2.0 fixture and from an empty database.
- Assert a failed migration leaves the original database intact and its verified backup readable.
- Inject process exits after marker creation, during a migration, after the transaction commits, and before marker removal. Verify deterministic startup recovery at each point.
- Assert repeated shutdown calls share one promise and close each owner once.
- Assert new work is rejected after draining begins.
- Assert abort terminates fake child processes and a stuck child reaches the forced-kill branch.

### Runtime

- Start indexing and chat in an isolated profile, request quit, and verify both stop before the database closes.
- Repeat with `update-install` and verify the app does not invoke installation before draining completes.
- Open a copied 0.2.0 project, migrate it, run `PRAGMA integrity_check`, and execute a normal search and export.
- Inspect the packaged app and prove that no Linux or x64 ffprobe binary exists.

## Gate

Phase 1 is complete when:

1. The 0.2.0 database fixture upgrades without data loss.
2. A forced migration failure restores a readable pre-upgrade copy.
3. Quit and update restart both use the same idempotent drain path.
4. Active native child processes cannot outlive the drain deadline.
5. The arm64 package contains only arm64 native resources and its size budget is recorded.

## Principles

Foundational Thinking makes data compatibility and shutdown the prerequisite. Make Operations Idempotent governs repeated quit and install requests. Sequence Verifiable Units keeps database, shutdown, and package trimming independently testable. Prove It Works requires a real old-project upgrade, not only a new empty database.
