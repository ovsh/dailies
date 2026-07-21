# Dailies

Chat with your footage. Local transcription and semantic indexing, agent-powered search,
Avid-native export (markers + EDL). Built for documentary and reality editors.

- **Fully local media** — footage is indexed in place; nothing is moved or copied, and media
  files are never uploaded. Text excerpts and embedding inputs are sent to OpenRouter.
- **One key** — a single OpenRouter API key powers chat and semantic embeddings. Stored in
  the macOS Keychain.
- **Reads Avid media directly** — point it at an `Avid MediaFiles` folder; OP-Atom MXF atoms
  are grouped back into clips under their real Avid clip names. No exports needed.
- **Whisper on-device, built in** — the transcription engine ships inside the app
  (whisper.cpp, Metal). One-click speech-model download in Settings. Your audio never
  leaves the machine.

---

## User guide

### 1. Install

1. Open `Dailies-<version>-arm64.dmg` and drag **Dailies** to Applications.
2. First open only: macOS may say it can't verify the app (it is signed but not yet
   notarized). **Right-click the app → Open → Open.** After that it opens normally.
3. Requirements: Apple Silicon Mac, macOS 14+.

### 2. First run — three things

1. **OpenRouter API key.** Create one at
   [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), then paste it into the
   welcome screen. It powers chat and semantic embeddings.
2. **A footage folder.** Choose "raw footage" for camera media / dailies and "finals" for
   exported cuts. You can point directly at an **`Avid MediaFiles`** folder — Avid's MXF
   media is read in place, grouped into clips with their real names. New files dropped into
   a watched folder are picked up automatically.
3. **The speech model.** The Whisper engine is built into the app — nothing to install.
   The first time, go to **Settings & Jobs → Transcription → Download** to fetch the
   speech model (~1.6 GB, one time; a progress bar shows it downloading). Until it's
   downloaded, document import and chat still work, and any clips waiting on transcription
   pick it up automatically afterwards.

   *Advanced:* if you already use whisper.cpp, Dailies also honors a Homebrew install
   (`brew install whisper-cpp`) or a `DAILIES_WHISPER_BIN` override — but you never need
   a terminal.

### 3. Projects

A **project** is one show. Each project has its own isolated index — searches never leak
across shows. The projects screen appears at launch (and via the initials chip in the left
rail): click a project to open it, or type a name and **Create**.

### 4. Episodes

Inside a project, create episodes (e.g. `201`, `202`) with the **+** in the episode bar,
shown at the top of Chat and Library. Selecting an episode scopes everything — the clips
you see, and what the chat searches. **ALL** searches the whole project.

- Folders added while an episode is selected belong to that episode.
- The Library header shows when an episode's folders were last scanned —
  "Scanned 11 Jul, 02:14 — **Scan again**" re-indexes on demand (new files are also
  picked up automatically in the background).

### 5. Indexing — what happens to your footage

When a clip is found, Dailies runs an audio-first pipeline in the background, watchable
under **Settings & Jobs**:

1. reads its metadata and **source timecode** (frame-accurate, drop-frame aware),
2. builds a playback proxy and detects scene boundaries,
3. transcribes the audio locally with Whisper,
4. builds keyword + semantic search indexes over the transcript.

An hour of footage takes roughly 10 minutes on an M-series Mac, mostly transcription.
Drop a shoot day in a watched folder in the evening; it's searchable in the morning.

### 6. Import notes & documents

The **Import** button in the Library takes producer notes, scripts, story docs, and
stringouts — PDF, Word-exported text, Markdown, **Excel/CSV**. They're indexed into the
same project (and episode, if one is selected), and the chat can search them.

### 7. Chat — the main event

Ask in plain language:

> *Where do people talk about bears, and what do they say about them?*
> *The producer wants more tension in the storm scene — what do we have?*
> *Where in the final of 202 does Marsh mention the salmon run?*

Behind the scenes a supervisor agent runs specialist searches over spoken words and
imported notes, then answers with clip cards: thumbnail, filename, timecodes, a **SAID**
tag, and a confidence dot.
Click a card to open the clip at that exact moment, with the synced transcript beside it.

- Hits from finals carry a **FINAL** tag and their timecode is the timeline TC of the cut.
- "Model profile" selects the OpenRouter routes used by the supervisor and search agents.
  "Quality" switches the supervisor to that profile's higher-quality route, with automatic
  fallback when the route is unavailable. Embeddings use one fixed model.

### 8. Export to Avid

Under every answer:

- **Export markers** — a locator list (`.txt`). In Media Composer: select a sequence/clip →
  import the file → every hit lands as a colored marker with the agent's note.
- **Export EDL** — a CMX3600 cut list of the selects, ready to import as a selects sequence.

Files land in `~/Documents/Dailies Exports/` (the toast has a **Reveal in Finder** button).
All timecodes are source TC (or timeline TC for finals), drop-frame handled correctly.

### 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Can't verify the app" on first open | Right-click → Open → Open (one time). |
| Chat says a key is needed | Settings & Jobs → paste your OpenRouter key. |
| Clips stuck without transcripts | Download the speech model: Settings & Jobs → Transcription → Download. |
| Something looks stuck | Settings & Jobs shows every indexing job and any errors; "Scan again" is always safe. |

Your index lives in `~/Library/Application Support/Dailies/` — deleting it never touches
your media; everything can be re-indexed.

---

## Development

```sh
npm install
npm run dev            # vite + electron
npm run dev:renderer   # renderer only in a browser, with mock data
npm run typecheck
npm test
npm run dist           # signed macOS DMG into release/
npm run rebuild        # force a fresh Electron native rebuild (normally unnecessary)
```

### Releasing

`npm run dev`, `npm test`, and `npm run dist` automatically select the correct
better-sqlite3 binary. The first use of each ABI caches its compiled artifact under
`.native-cache`; switching between tests/Node harnesses and Electron
then copies or directly loads the matching cached file instead of rebuilding it. Direct
`npx tsx scripts/e2e-*.mts` runs use the same cache and repair a missing Node artifact
once if necessary. `npm run rebuild` remains available when a deliberately fresh
Electron rebuild is needed.

To **notarize** (required for friction-free installs on modern macOS), export before
`npm run dist`:

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com -> App-Specific Passwords
export APPLE_TEAM_ID="7Z82LSPAPP"
```

Un-notarized builds are blocked by Gatekeeper on current macOS ("damaged / move to
Trash"). Workaround for a machine you control: `xattr -d com.apple.quarantine /Applications/Dailies.app`.

## Architecture

See `docs/` and `src/shared/types.ts` (the cross-boundary contract). Modules:

| Path | What |
|---|---|
| `src/main/project-manager.ts` | Projects: one SQLite DB + pipeline per show, registry, legacy adoption |
| `src/main/db/` | SQLite index (better-sqlite3, FTS5 + embedding vectors), episodes, folders |
| `src/main/pipeline/` | watch → probe → audio/proxy/scenes → whisper → transcript embeddings; Avid OP-Atom MXF grouping; document (notes/script/xlsx) ingest |
| `src/main/agents/` | OpenRouter supervisor + transcript/document search agents, episode-scoped hybrid search |
| `src/main/export/` | Avid locator lists + CMX3600 EDL (frame-accurate, DF-aware) |
| `src/renderer/` | React UI ("screening room" design): projects, episodes, chat, library, clip view |
