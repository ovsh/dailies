# Dailies

Chat with your footage. Local transcription and semantic indexing, agent-powered search,
Avid-native export (markers + EDL). Built for documentary and reality editors.

- **Fully local media** — footage is indexed in place; nothing is moved or copied, and media
  files are never uploaded. Text excerpts and embedding inputs are sent to OpenRouter.
- **One key** — a single OpenRouter API key powers chat and semantic embeddings. Electron
  protects it with Keychain on macOS or DPAPI on Windows when secure storage is available.
- **Reads Avid media directly** — point it at an `Avid MediaFiles` folder; OP-Atom MXF atoms
  are grouped back into clips under their real Avid clip names. No exports needed.
- **Whisper on-device, built in** — the transcription engine ships inside the app.
  Apple Silicon uses Metal; Windows uses the local CPU. One-click speech-model download
  in Settings. Your audio never leaves the machine.

---

## User guide

### 1. Install

1. Download the installer from [Releases](https://github.com/ovsh/dailies/releases):
   - macOS: open `Dailies-<version>-arm64.dmg` and drag **Dailies** to Applications.
     The app is signed and notarized.
   - Windows beta: run `Dailies-0.5.4-Setup-x64.exe`. This beta is unsigned, so Windows shows "Unknown publisher."
2. Requirements: Apple Silicon with macOS 14+, or 64-bit Windows 10/11.
3. The installer is only for the first install. Dailies checks
   GitHub Releases at launch, hourly, and whenever the window comes to
   front, downloading updates in the background. A banner appears under
   the title bar once one is ready ("Restart now" or "Later"); the same
   status lives in Settings & Jobs and in the application menu.

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
   speech model (~0.9 GB, one time; a progress bar shows it downloading). Until it's
   downloaded, document import and chat still work, and any clips waiting on transcription
   pick it up automatically afterwards.

   *Advanced:* Dailies honors a `DAILIES_WHISPER_BIN` override on both platforms. On
   macOS, it also finds a Homebrew install from `brew install whisper-cpp`.

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
- Chat runs on Gemini 3.6 Flash via OpenRouter. Embeddings use one fixed model.

### 8. Export to Avid

Under every answer:

- **Export markers** — a locator list (`.txt`). In Media Composer: select a sequence/clip →
  import the file → every hit lands as a colored marker with the agent's note.
- **Export EDL** — a CMX3600 cut list of the selects, ready to import as a selects sequence.

Files land in the `Dailies Exports` folder under Documents. The toast has a
**Show in folder** button.
All timecodes are source TC (or timeline TC for finals), drop-frame handled correctly.

### 9. Troubleshooting

| Symptom | Fix |
|---|---|
| macOS says it cannot verify the app | Download the current notarized DMG from Releases. |
| Windows warns about an unknown publisher | Version 0.5.4 is an unsigned beta. Confirm that the file came from the official Dailies release before you select **More info** and **Run anyway**. |
| Update banner never appears | It only shows once a download finishes. Check status any time in Settings & Jobs, or **Dailies ▸ Check for Updates…**. |
| Chat says a key is needed | Settings & Jobs → paste your OpenRouter key. |
| Clips stuck without transcripts | Download the speech model: Settings & Jobs → Transcription → Download. |
| Something looks stuck | Settings & Jobs shows every indexing job and any errors; "Scan again" is always safe. |

The index lives in the Dailies application-data folder: `~/Library/Application Support/Dailies/`
on macOS or `%APPDATA%\Dailies\` on Windows. Deleting it never touches your media.

---

## Development

```sh
npm install
npm run dev            # vite + electron
npm run dev:renderer   # renderer only in a browser, with mock data
npm run typecheck
npm test
npm run dist:mac       # macOS arm64 DMG + ZIP + latest-mac.yml into release/
npm run dist:win       # signed Windows x64 NSIS installer + latest.yml into release/
npm run rebuild        # force a fresh Electron native rebuild (normally unnecessary)
```

### Releasing

`npm run dev`, `npm test`, `npm run dist:mac`, and `npm run dist:win` select the correct
better-sqlite3 binary. The first use of each ABI caches its compiled artifact under
`.native-cache`; switching between tests/Node harnesses and Electron
then copies or directly loads the matching cached file instead of rebuilding it. Direct
`npx tsx scripts/e2e-*.mts` runs use the same cache and repair a missing Node artifact
once if necessary. `npm run rebuild` remains available when a deliberately fresh
Electron rebuild is needed.

To **notarize** (required for friction-free installs on modern macOS), build with the
stored notarytool keychain profile:

```sh
APPLE_KEYCHAIN_PROFILE=digital-lane npm run dist:mac
```

This produces the DMG, the ZIP, and `latest-mac.yml` in `release/`. Notarize
and staple the DMG itself and verify with Gatekeeper; the global
`apple-sign` skill (`~/.claude/skills/apple-sign/SKILL.md`) has the full flow.
The `digital-lane` notarytool profile is shared across all Digital Lane apps
and is already set up — no per-repo credential step.

The ZIP and `latest-mac.yml` are what `electron-updater` reads to serve
auto-updates — both must be uploaded to the GitHub release alongside the DMG,
or existing installs won't see the new version.

Un-notarized builds are blocked by Gatekeeper on current macOS ("damaged / move to
Trash"). Workaround for a machine you control: `xattr -d com.apple.quarantine /Applications/Dailies.app`.

The Windows build runs in `.github/workflows/windows-release.yml` from the exact
`v0.5.4` tag. It requires `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and both telemetry
secrets. The workflow downloads the SHA-256-pinned whisper.cpp `v1.9.1` archive,
runs the checks, verifies Authenticode and `latest.yml`, then adds these files to
an existing draft release:

```text
Dailies-0.5.4-Setup-x64.exe
Dailies-0.5.4-Setup-x64.exe.blockmap
latest.yml
```

It does not publish the release. Add the notarized Mac files, verify the full draft,
then publish it by hand. The workflow refuses to replace a draft asset with different
bytes.

## Architecture

See `docs/` and `src/shared/types.ts` (the cross-boundary contract). Modules:

| Path | What |
|---|---|
| `src/main/project-manager.ts` | Projects: one SQLite DB + pipeline per show, registry, legacy adoption |
| `src/main/db/` | SQLite index (better-sqlite3, FTS5 + embedding vectors), episodes, folders |
| `src/main/pipeline/` | watch → probe → audio/proxy/scenes → whisper → transcript embeddings; Avid OP-Atom MXF grouping; document (notes/script/xlsx) ingest |
| `src/main/agents/` | OpenRouter supervisor + transcript/document search agents, episode-scoped hybrid search |
| `src/main/export/` | Avid locator lists + CMX3600 EDL (frame-accurate, DF-aware) |
| `src/renderer/` | React UI ("The Bin" design): projects, episodes, chat, library, clip view |
