# Dailies

Chat with your footage. Local transcription and visual indexing, agent-powered search,
Avid-native export (markers + EDL).

- **Fully local media** — footage is indexed in place; only text excerpts, keyframes, and
  low-res proxy frames are sent to AI APIs.
- **Two keys, one screen** — paste an Anthropic key (chat agents) and a Gemini key
  (visual indexing) in Settings. Stored in the macOS Keychain.
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

## Architecture

See `docs/` and `src/shared/types.ts` (the cross-boundary contract). Modules:

| Path | What |
|---|---|
| `src/main/db/` | SQLite index (better-sqlite3, FTS5) |
| `src/main/pipeline/` | watch → probe → audio/proxy/scenes → whisper → Gemini visual index |
| `src/main/agents/` | Opus 4.8 supervisor + Sonnet 5 scouts/verifier, Gemini indexer |
| `src/main/export/` | Avid locator lists + CMX3600 EDL (frame-accurate, DF-aware) |
| `src/renderer/` | React UI ("screening room" design) |
