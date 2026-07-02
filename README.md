# Dailies

Chat with your footage. Local transcription and visual indexing, agent-powered search,
Avid-native export (markers + EDL). Built for documentary and reality editors.

- **Fully local media** — footage is indexed in place; nothing is moved, copied, or uploaded.
  Only text excerpts and small keyframes are sent to the AI API.
- **One key** — a single Gemini API key powers the chat agents, frame verification, visual
  indexing, and semantic search. Stored in the macOS Keychain.
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

1. **Gemini API key.** Get one free at [aistudio.google.com](https://aistudio.google.com)
   → "Get API key" → paste it into the welcome screen. This one key powers everything.
2. **A footage folder.** Choose "raw footage" for camera media / dailies and "finals" for
   exported cuts. You can point directly at an **`Avid MediaFiles`** folder — Avid's MXF
   media is read in place, grouped into clips with their real names. New files dropped into
   a watched folder are picked up automatically.
3. **The speech model.** The Whisper engine is built into the app — nothing to install.
   The first time, go to **Settings & Jobs → Transcription → Download** to fetch the
   speech model (~1.6 GB, one time; a progress bar shows it downloading). Until it's
   downloaded, everything else still works (visual search, chat, export) and any clips
   waiting on transcription pick it up automatically afterwards.

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

When a clip is found, Dailies (in the background, watchable under **Settings & Jobs**):

1. reads its metadata and **source timecode** (frame-accurate, drop-frame aware),
2. transcribes the audio locally (Whisper),
3. detects scenes and asks Gemini to describe what's *on screen* per scene,
4. builds keyword + semantic search indexes over all of it.

An hour of footage takes roughly 10 minutes on an M-series Mac, mostly transcription.
Drop a shoot day in a watched folder in the evening; it's searchable in the morning.

### 6. Import notes & documents

The **Import** button in the Library takes producer notes, scripts, story docs, and
stringouts — PDF, Word-exported text, Markdown, **Excel/CSV**. They're indexed into the
same project (and episode, if one is selected), and the chat can search them.

### 7. Chat — the main event

Ask in plain language:

> *Where can I find footage of bears, and what do people say about them?*
> *The producer wants more tension in the storm scene — what do we have?*
> *Where in the final of 202 does Marsh mention the salmon run?*

Behind the scenes a supervisor agent runs specialist searches (spoken words, visuals,
notes), **verifies visual hits against actual frames**, and answers with clip cards:
thumbnail, filename, timecodes, a **SEEN** or **SAID** tag, and a confidence dot.
Click a card to open the clip at that exact moment, with the synced transcript beside it.

- Hits from finals carry a **FINAL** tag and their timecode is the timeline TC of the cut.
- "Quality" in Settings routes the supervisor to Gemini 3.5 Pro when your key has access.

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
| Chat says a key is needed | Settings & Jobs → paste your Gemini key. |
| Clips stuck without transcripts | Download the speech model: Settings & Jobs → Transcription → Download. |
| A clip shows "media offline" | Its drive is unmounted; remount and it recovers. |
| Visual search finds nothing | Visual indexing needs the Gemini key at scan time — re-scan after adding the key. |
| Something looks stuck | Settings & Jobs shows every indexing job and any errors; "Scan again" is always safe. |

Your index lives in `~/Library/Application Support/Dailies/` — deleting it never touches
your media; everything can be re-indexed.

---

## Development

```sh
npm install
npm run rebuild        # native better-sqlite3 for Electron
npm run dev            # vite + electron
npm run dev:renderer   # renderer only in a browser, with mock data
npm run typecheck
npm test
npm run dist           # signed macOS DMG into release/
```

### Releasing

`npm run dist` forces the Electron-ABI native rebuild first (never package after running
tests without it — a Node-ABI better-sqlite3 makes every database call fail in the
packaged app). To **notarize** (required for friction-free installs on modern macOS),
export before `npm run dist`:

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com -> App-Specific Passwords
export APPLE_TEAM_ID="7Z82LSPAPP"
```

Un-notarized builds are blocked by Gatekeeper on current macOS ("damaged / move to
Trash"). Workaround for a machine you control: `xattr -d com.apple.quarantine /Applications/Dailies.app`.

Note: better-sqlite3 is native and single-ABI. `npm run rebuild` compiles it for
Electron (required for `npm run dev` / `npm run dist`); `npm rebuild better-sqlite3`
compiles it for plain Node (required for the DB test in `npm test`). Switch as needed.

## Architecture

See `docs/` and `src/shared/types.ts` (the cross-boundary contract). Modules:

| Path | What |
|---|---|
| `src/main/project-manager.ts` | Projects: one SQLite DB + pipeline per show, registry, legacy adoption |
| `src/main/db/` | SQLite index (better-sqlite3, FTS5 + embedding vectors), episodes, folders |
| `src/main/pipeline/` | watch → probe → audio/proxy/scenes → whisper → Gemini visual index → embeddings; Avid OP-Atom MXF grouping; document (notes/script/xlsx) ingest |
| `src/main/agents/` | Gemini 3.5 Flash supervisor + scouts/verifier (3.5 Pro optional), episode-scoped hybrid search |
| `src/main/export/` | Avid locator lists + CMX3600 EDL (frame-accurate, DF-aware) |
| `src/renderer/` | React UI ("screening room" design): projects, episodes, chat, library, clip view |
