# Dailies — agent guide

Electron (macOS arm64) app: chat with your footage. Local indexing + Whisper
transcription, OpenRouter-powered chat/embeddings, Avid-native export.
`README.md` has the user guide and architecture; `GOAL.md` is the current
validation effort's operating doc.

## Commands

```sh
npm run dev            # vite + electron (rebuilds native deps for Electron)
npm run dev:renderer   # renderer alone in a browser, mock data
npm run typecheck      # tsc --noEmit — keep green
npm test               # vitest (rebuilds better-sqlite3 for system Node)
npm run dist           # signed + notarized DMG and update zip into release/
npm run release        # dist + publish the auto-update feed (docs/releasing.md)
```

`npm test` and Electron need different better-sqlite3 ABIs;
`scripts/manage-better-sqlite3.mjs` swaps cached builds automatically via the
pre-scripts — don't fight it by hand.

## Skills

- **/apple-sign** (`.claude/skills/apple-sign/SKILL.md`) — signing & notarizing
  with the Digital Lane LLC Developer ID: per-machine credential setup,
  post-build verification, and Apple-error triage. Use it for any
  `npm run dist` / `npm run release` work, Gatekeeper complaints, or when
  codesign/notarytool fails. Critical rule inside: every release must use the
  same signing identity or installed apps stop self-updating.

## Layout

- `src/main/` — Electron main: pipeline (`pipeline/`), agents (`agents/`),
  db (`db/`), plus `log.ts` (session log), `telemetry.ts` (Sentry),
  `updater.ts` (self-update)
- `src/renderer/` — React UI; `src/renderer/mock/` keeps the browser preview
  working — every `DailiesAPI` addition needs a mock implementation
- `src/shared/ipc.ts` — the typed renderer↔main contract; `src/preload/` wires it
- `docs/releasing.md` — release runbook; `docs/errors.md` — error catalog
  (add a row whenever a new failure class is diagnosed)

## Conventions

- Log through `src/main/log.ts` (`log.info(scope, event, fields)`), not
  `console.*`. Event names are stable dot-names (`pipeline.stage.failed`).
  Never log API keys, transcript text, prompts, or document contents; full
  file paths are local-log-only.
- The renderer must never assume `window.dailies` exists (browser preview).
- Renderer↔main changes touch four places: `shared/ipc.ts`, `preload/index.ts`,
  `main/ipc-handlers.ts`, `renderer/mock/api.ts`.
