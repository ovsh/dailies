# Dailies

Chat with your footage. Local transcription and visual indexing, agent-powered search,
Avid-native export (markers + EDL).

- **Fully local media** — footage is indexed in place; only text excerpts, keyframes, and
  low-res proxy frames are sent to the AI API.
- **One key** — paste a Gemini API key in Settings (powers the chat agents, frame
  verification, and visual indexing). Stored in the macOS Keychain.
- **Whisper on-device** — transcription via `whisper-cli` (whisper.cpp, Metal).

## Development

```sh
npm install
npm run rebuild        # native better-sqlite3 for Electron
npm run dev            # vite + electron
npm run dev:renderer   # renderer only in a browser, with mock data
npm run typecheck
npm test
```

Note: better-sqlite3 is native and single-ABI. `npm run rebuild` compiles it for
Electron (required for `npm run dev`); `npm rebuild better-sqlite3` compiles it for
plain Node (required for the DB test in `npm test`). Switch as needed.

## Architecture

See `docs/` and `src/shared/types.ts` (the cross-boundary contract). Modules:

| Path | What |
|---|---|
| `src/main/db/` | SQLite index (better-sqlite3, FTS5) |
| `src/main/pipeline/` | watch → probe → audio/proxy/scenes → whisper → Gemini visual index |
| `src/main/agents/` | Gemini 3.5 Flash supervisor + scouts/verifier (3.5 Pro optional), Gemini indexer |
| `src/main/export/` | Avid locator lists + CMX3600 EDL (frame-accurate, DF-aware) |
| `src/renderer/` | React UI ("screening room" design) |
