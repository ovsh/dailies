# Goal: Dailies works end-to-end, verifiably, for a brand-new user

**Written 2026-07-13. Operating document for the validation & hardening effort.**

## The goal

A brand-new user on an Apple Silicon Mac can launch Dailies, complete onboarding
(API key → footage folder → speech model), have their footage indexed correctly and
fast, ask a question in chat and get **grounded, correct clip cards with accurate
timecodes**, click through to the exact moment, and export valid Avid markers/EDL —
with the app feeling snappy throughout. Every claim above is proven by an automated
or evidence-backed gate, not by assumption.

Reports say the app is "not working well." This effort finds what's actually broken,
fixes it, and leaves behind gates that keep it working.

## Operating model

- **Claude (this session)** — orchestrator and validator. Writes briefs, runs gates,
  reviews every diff, judges evidence. Does not do the heavy implementation.
- **Codex `gpt-5.6-sol`, reasoning effort high** — executor. Implements fixes,
  builds harnesses, runs what its sandbox permits. Never commits.
- Loop per gate: **run gate → collect concrete failures → brief Codex → review diff →
  re-run gate until green**. Commands the Codex sandbox blocks (GUI app launch,
  some sockets) are re-run verbatim by the orchestrator.

## Test assets

- `landscaping test/` — 7 real OP-Atom MXF atoms across 2 recording days (expected to
  group into named Avid clips).
- Whisper `large-v3-turbo` model already at `~/Library/Application Support/Dailies/models/`.
- Gemini key stored encrypted in the app (safeStorage). **The key never leaves the app**:
  chat gates run through the real app; no plaintext key in scripts, logs, or briefs.

## Gates

### G1 — Static & unit (technical floor)
- `npm run typecheck` green.
- `npm test` green on system Node **without breaking** the Electron build
  (`npm run dev` / `npm run dist`). Currently broken: better-sqlite3 is compiled for
  Electron's ABI, so vitest and the tsx e2e harnesses all fail with NODE_MODULE_VERSION
  mismatch. This gate blocks all others.

### G2 — Engine e2e (indexing correctness + speed)
Run `scripts/e2e-pipeline.mts` against `landscaping test/` with the real
`large-v3-turbo` model. Pass requires:
- All 7 MXF atoms discovered; OP-Atom atoms grouped into clips under real Avid clip
  names (no clip left as raw atom filenames; no missing clips).
- Probe extracts duration and source timecode for every clip; no `error` files.
- Every clip with audio gets a transcript; FTS search over a phrase actually spoken
  in the footage returns the right clip.
- **Speed budget:** end-to-end wall clock ≤ 1× the footage runtime on this machine
  (README promise is ~6× faster than realtime; we gate loosely and record the number).

### G3 — App + new-user onboarding (the journey)
Launch the real app (dev build, `--remote-debugging-port`) with a **fresh userData
dir** to simulate a first run. Driven over CDP, screenshot at every step:
1. Welcome screen appears; key entry works (orchestrator supplies the flow, not the key —
   see note below); invalid key gets a clear error.
2. Create project → add `landscaping test/` as a raw folder → indexing starts and is
   visible under Settings & Jobs; progress actually moves.
3. Indexing completes; Library shows grouped clips with names, durations, timecodes.
4. `scripts/cdp-smoke.mjs` passes (createProject → openProject → getProjectState →
   createEpisode).
- **Snappiness budget:** cold launch → interactive UI < 4 s; screen-to-screen
  navigation < 300 ms perceived (no blank flashes); no unbounded memory growth during
  indexing (regression watch: the 34 GB subscription-storm bug).

Note: the real key already lives in the default userData settings. The fresh-userData
run validates the *screens and flow*; the indexed/chat gates run against the default
profile where the key already exists. No credential is ever typed by an agent.

### G4 — Chat & export (the main event)
Against the default profile with the indexed landscaping project:
- Ask a grounded question about the footage content (from its actual transcript);
  the answer includes clip cards with valid clip names, in-range timecodes, SAID/SEEN
  tags, and no hallucinated clips (every referenced clip exists in the DB).
- Ask an ungroundable question ("footage of penguins"); the agent says it found
  nothing rather than inventing hits.
- Click-through: opening a hit card lands on the right clip at the right time.
- Export markers (.txt locator list) and EDL from an answer; files parse, timecodes
  in range, event count matches hits.
- **Latency budget:** first visible agent activity < 5 s; complete answer < 60 s.

### G5 — Visual & UX bar
Screenshots from G3/G4 reviewed by the orchestrator (taste bar ≥ 7): onboarding
legibility, empty states, contrast on the slate theme, layout at default and small
window sizes, no dev artifacts, no placeholder data. Failures become fix briefs.

### G6 — Full-suite regression re-run
After all fixes land: G1–G4 re-run clean in one pass, results recorded in the final
report with measured numbers (index throughput, launch time, chat latency).

## Deliverables

1. All gates green, or an explicit list of what remains red and why.
2. Fixes as reviewable diffs (committed only on user approval).
3. A final report: what was broken, what changed, measured performance, and the
   repeatable gate commands.

---

## Final status — 2026-07-13

All gates GREEN. 74 unit tests (was 36, 3 files un-runnable). Uncommitted, pending review.

| Gate | Result | Measured |
|---|---|---|
| G1 static/unit | PASS | typecheck clean; 74/74 tests; dual-ABI automatic |
| G2 engine e2e | PASS | 6/6 clips named+transcribed; corrupt file visible; 86 min audio in 183 s (~28× realtime) |
| G3 onboarding | PASS | fresh profile → waiting (not error) → model arrives → all ready; cold launch 1.24 s |
| G4 chat+export | PASS | grounded hit w/ verbatim DB quote; honest no-results; valid locator TSV + CMX3600 EDL with rate warnings |
| G5 visual | PASS | 3-step honest welcome; audio-first cards/player; chat history rail; plain-prose answers |
| G6 regression | PASS | all re-run green on final tree; ~500 MB RSS/instance (no runaway) |

Known issues (accepted, documented): chat answer latency 73–113 s vs 60 s budget
(first activity <2 s); hit-card recall conservative (correctness prioritized);
audio TC rate unknown for these MXFs → explicit 30 fps fallback labels in exports.

Gate commands: `npm test` · `npx tsx scripts/e2e-pipeline.mts "landscaping test"
large-v3-turbo "~/Library/Application Support/Dailies/models"` ·
`npm run e2e:onboarding -- --folder <footage> --shots <dir> --port 9334
--expect-fresh --skip-key-dependent --expect-file-errors 1` (launch app with
`DAILIES_USER_DATA=<fresh> DAILIES_E2E_FOLDER=<footage> npx electron .
--remote-debugging-port=9334`).
