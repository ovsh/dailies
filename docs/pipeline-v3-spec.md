# Pipeline v3 — ProjectFolder routing, spreadsheet ingest, direct import

Touch ONLY files under `src/main/pipeline/` (docs.ts, index.ts; watcher.ts only if needed).
Read first: `src/shared/types.ts` (ProjectFolder now carries episodeId; DocumentKind gained
"xlsx" | "csv"; DocumentInput/FileInput gained episodeId) and `src/main/db/types.ts`
(addFolder/listFolders/setFolderScanned exist but are NOT the pipeline's job — the caller
passes ProjectFolder objects in). TypeScript strict, no `any`. Do not run npm/node.

## 1. src/main/pipeline/docs.ts

- `DOC_EXTENSIONS` gains ".xlsx" and ".csv".
- `extractDocument(path)`:
  - csv → read utf8, treat as text (kind "csv"); chunk as today.
  - xlsx → `import * as XLSX from "xlsx"` (verify against node_modules/xlsx types; the
    classic API: `XLSX.read(buffer)`, iterate `wb.SheetNames`, `XLSX.utils.sheet_to_csv(ws)`).
    content = sheets joined as `## {sheetName}\n{csv}` blocks; kind "xlsx". Cap content at
    ~200k chars. Wrap in try/catch → null on failure.
  - `extractDocument` gains an optional second param `episodeId: number | null = null` and
    sets DocumentInput.episodeId.

## 2. src/main/pipeline/index.ts

- Replace the WatchedFolder-based folder tracking with ProjectFolder:
  `watchFolder(folder: ProjectFolder)`, `scanFolder(folder: ProjectFolder)`,
  `unwatchFolder(path: string)` unchanged. A discovered media file OR document inherits BOTH
  `role` and `episodeId` from its longest-prefix-matching folder.
- `FileInput.episodeId` set at ingest (standard and OP-Atom paths both).
- Document ingest sets episodeId the same way.
- NEW exported Pipeline method: `ingestDocument(path: string, episodeId: number | null): Promise<boolean>`
  — direct entry for the Import button: extractDocument(path, episodeId) → db.upsertDocument →
  inline embedding attempt (same as watched-doc flow) → onUpdate(); returns false when
  extraction fails or the extension is unsupported. Re-ingest of an existing path is allowed
  (upsertDocument replaces).
- Keep everything else identical.

Reply with: files changed + the updated exported signatures of index.ts.
