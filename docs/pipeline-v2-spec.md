# Pipeline v2 (src/main/pipeline/)

Read first: `src/shared/types.ts` (WatchedFolder, MediaRole, DocumentInput, TextEmbedder,
EMBEDDING_DIM, JobStage now includes "embed") and `src/main/db/types.ts` (new document +
embedding methods). TypeScript strict, no `any`, node imports as `node:*`. Do not run npm/node.
Touch ONLY files under `src/main/pipeline/` (listed below).

## 1. NEW `src/main/pipeline/opatom.ts` — Avid OP-Atom MXF support

Avid media (`Avid MediaFiles/MXF/1/*.mxf`) is OP-Atom: each .mxf holds ONE essence track
(audio or video) of a source clip; atoms of the same clip share a material package UMID.

Exports:
- `interface MxfAtomInfo { path: string; clipKey: string; clipName: string | null; essence: "video" | "audio"; durationS: number; fps: number; dropFrame: boolean; startTc: string; codec: string; }`
- `analyzeMxf(ffprobePath: string, path: string): Promise<MxfAtomInfo | null>` — run ffprobe
  (json, -show_format -show_streams). Return null when the file is not OP-Atom (e.g. it has
  both audio and video streams — treat as standard media). Extract:
  - clipKey: format tag `material_package_umid` (fallback: any stream tag ending in
    `package_umid`; if none, return null)
  - clipName: format tag `material_package_name` (nullable)
  - essence: "video" if any video stream with codec != "none" else "audio"
  - fps: video stream avg_frame_rate, or for audio atoms parse from tag or default 25 —
    prefer format tag `timecode` rate hints; keep simple: video atom wins later during merge.
  - startTc: `timecode` tag from format or stream tags, fallback "00:00:00:00".
- `class OpAtomGrouper` — collects atoms and emits complete clips after quiescence:
  `constructor(opts: { debounceMs?: number; onClip(clip: { clipKey; clipName; atoms: MxfAtomInfo[] }): void })`,
  method `addAtom(info: MxfAtomInfo): void`. Group by clipKey; (re)start a per-group timer
  (default 4000ms); on fire, emit the group and clear it. If a clip's atoms arrive later
  (re-scan), emitting again is fine — ingest is idempotent via clipKey.

## 2. NEW `src/main/pipeline/docs.ts` — document ingest

- `const DOC_EXTENSIONS = [".pdf", ".txt", ".md"]`
- `extractDocument(path: string): Promise<DocumentInput | null>`:
  txt/md → read utf8. pdf → `pdf-parse` (import defensively: `const pdfParse = (await import("pdf-parse")).default`)
  → `.text`. Normalize whitespace. `chunks`: split on blank lines, pack paragraphs into
  ~1200-char chunks (never split mid-paragraph unless a paragraph alone exceeds 2000 chars —
  then hard-split). Return null on extraction failure or empty text.

## 3. `src/main/pipeline/watcher.ts` — extend

- `createWatcher(opts: { onFileFound(path: string): void; onDocFound(path: string): void })`.
- Route video extensions (existing list, INCLUDING .mxf) to onFileFound and DOC_EXTENSIONS
  to onDocFound. Keep awaitWriteFinish + dot/.dailies filters. Also ignore Avid's
  `msmMMOB.mdb` / `msmFMID.pmr` database files (they're not media, and not docs).

## 4. `src/main/pipeline/index.ts` — orchestration changes

- `PipelineOptions` gains: `embedder: () => TextEmbedder | null` (late-bound like gemini).
- Signature changes: `watchFolder(folder: WatchedFolder): void`, `scanFolder(folder: WatchedFolder): Promise<void>`,
  `unwatchFolder(path: string): void` — track folder→role; a discovered file's role = the
  role of the watched folder whose path prefixes it (longest match wins; default "raw").
- File routing on discovery: if extension is .mxf → `analyzeMxf`; if OP-Atom → grouper.addAtom
  and STOP (no direct ingest). Grouper onClip → merge atoms into ONE FileInput:
  - path = video atom's path if present else first audio atom's path
  - memberPaths = all atom paths sorted; clipKey; clipName; mediaKind "opatom"
  - filename = clipName ?? basename(path)
  - fps/dropFrame/startTc/durationS/codec from the video atom when present, else the first
    audio atom (duration = max across atoms)
  - fileHash = existing partial-hash of the chosen primary path
  - skip if `db.getFileByClipKey` exists with same atom count and hash; else upsert + enqueue
    the probe chain as today (probe stage must NOT re-probe opatom clips into standard shape —
    for mediaKind "opatom" skip re-probing and go straight to fan-out audio/proxy/scenes).
  - audio stage for opatom: extract wav from the FIRST audio atom (a member path where
    analyze said essence audio — recompute cheaply by extension of stored order: store atoms
    audio-first? Simplest: keep memberPaths ordered [videoAtoms..., audioAtoms...] and also
    always put the primary path first; for audio extraction iterate memberPaths and use the
    first path whose ffprobe (cached from discovery is gone — just try extractAudio and fall
    back to the next member on failure).
  - proxy/scenes stages: only when a video atom exists (primary path is video); for audio-only
    clips mark proxy/scenes jobs done immediately (completeJob) with no output.
- Documents: `onDocFound` → if `db.getDocumentByPath` exists skip (v0: path-keyed; no hash) →
  `extractDocument` → `db.upsertDocument` → try embedding inline: e = embedder(); if e, embed
  `db.listUnembeddedDocChunks()` in batches of 64 → upsertEmbedding(kind "doc"). Never throw —
  log to console and continue. Call onUpdate().
- NEW stage handler "embed": e = embedder(); if !e → failJob("Gemini API key not set");
  else embed `listUnembeddedSegments(fileId)` + `listUnembeddedAnnotations(fileId)` in batches
  of 64 → upsertEmbedding with kinds "segment"/"scene". Enqueue "embed" at the END of the
  transcribe handler and END of the visual_index handler (idempotent — embeds only missing).
- scanFolder must also pick up documents.

Reply with: files changed + the exact new exported signatures of index.ts.
