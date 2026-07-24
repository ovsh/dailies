# Phase 4: Add the update experience

[Back to the plan](README.md)

## Goal

Make an available update easy to notice and install without blinking, modal interruption, or surprise restarts.

## Files

Change:

- `src/renderer/App.tsx`
- `src/renderer/components/Rail.tsx`
- `src/renderer/components/Toast.tsx`, only if it can accept an action without becoming a general notification system
- `src/renderer/screens/JobsSettingsScreen.tsx`
- `src/renderer/hooks/useUpdateState.ts`
- `src/renderer/theme/global.css`
- `src/renderer/mock/api.ts`
- existing renderer tests near these components

If the existing toast cannot support progress and actions cleanly, add one focused `src/renderer/components/UpdateBanner.tsx`. Do not generalize all application notifications in this phase.

## Presentation

### Rail

- Add a small amber dot to the Settings and Jobs item when the state is `available`, `downloading`, or `ready`.
- Use a static dot. No flash, pulse, bounce, or repeated animation.
- Give the indicator an accessible label that includes the target version.

### Global banner

- Show once per session when an update first becomes available.
- Keep it compact and non-modal near the existing toast area.
- Dismissal hides only the banner. It does not cancel a download or remove the rail dot.
- Do not show background check failures globally.

### Settings card

Place an `Application update` card above destructive settings actions. It is the persistent source of truth.

| State | Primary copy | Action |
| --- | --- | --- |
| `idle` or `current` | `Dailies 0.3.0 is up to date` plus last check time | `Check for updates` |
| `checking` | `Checking for updates` | disabled button |
| `available` | `Dailies 0.4.0 is available` | `Download update` |
| `downloading` | `Downloading Dailies 0.4.0` plus progress | disabled progress action |
| `ready` | `Dailies 0.4.0 is ready` | `Restart to update` |
| `installing` | `Finishing current work` | no additional action |
| manual `error` | fixed application copy selected by `UpdateErrorCode` | `Try again` when the state permits it |

The version examples are illustrative. Render the installed and target versions from validated state.

## Interaction rules

- Manual checking remains available even if the background timer has not run.
- One click starts the download. A second explicit click restarts because restart is disruptive.
- If active work is draining, explain what is happening without showing internal job details.
- If draining times out, return to `ready` and show `Dailies could not finish current work. Try again after jobs stop.` Do not force installation.
- After relaunch, reopen the last project through the existing path and show a one-time `Dailies was updated to X` message.
- Use a semantic live region for state text. Move focus only after the user initiates an action and an error needs attention.

## Mock and failure states

Add deterministic mock controls for every `UpdateState`. This lets design and accessibility review happen without publishing releases.

Review these widths and conditions:

- minimum supported window width
- long semantic versions
- offline check failure
- download with unknown total size
- 0 percent, partial, and 100 percent progress
- reduced motion and keyboard-only navigation
- active indexing when restart is clicked

## Tests

### Component

- Assert each state renders the correct action and accessible label.
- Assert background errors are not shown as a global banner.
- Assert banner dismissal preserves Settings state and rail dot.
- Assert clicks call only their matching typed API method once.
- Assert `Restart to update` is unreachable before the `ready` state.

### Packaged application

- Use the existing CDP harness or Computer Use against a packaged build.
- Trigger an update, dismiss the banner, find the update in Settings, download it, and restart.
- Start a job before restart and verify the UI waits for safe drain.
- Relaunch and confirm the reported version and last project.

## Gate

Phase 4 is complete when a keyboard-only user can discover, download, defer, and restart into an update; background failures do not interrupt work; and no state uses attention-seeking animation.

## Principles

Experience First chooses visibility without interruption. Exhaust the Design Space compares rail, banner, modal, and Settings placements, then uses the smallest combination that covers discovery and persistence. Minimize Reader Load keeps one primary action per state.
