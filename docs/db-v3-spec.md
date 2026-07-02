# DB v3 — episodes + project folders + episode scoping

Extend `src/main/db/schema.ts` + `src/main/db/database.ts` (touch ONLY these two).
Read first: `src/shared/types.ts` (Episode, ProjectFolder, MediaRole; MediaFile/FileInput/
TranscriptHit/VisualHit/DocumentInput/DocumentRecord/DocumentHit gained `episodeId`;
VisualSearchFilters gained `episodeId`) and `src/main/db/types.ts` (new/changed methods).
TypeScript strict, no `any`. Do not run npm/node.

## Schema

1. New tables:
   - `episodes(id INTEGER PK, code TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)`
   - `folders(id INTEGER PK, path TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'raw', episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL, last_scanned_at TEXT)`
2. `files` gains `episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL` (+ index);
   `documents` gains the same.
3. Extend the existing `migrate()`: ALTER-add `episode_id` to files and documents when missing
   (same PRAGMA table_info pattern). The new tables are CREATE IF NOT EXISTS, no ALTER needed.
4. **Folder KV migration**: after migrate(), if the settings KV contains `watchedFolders`
   (legacy JSON array of {path, role} or plain strings), insert each into the `folders` table
   (INSERT OR IGNORE by path, episode_id NULL) and DELETE the KV row.

## Methods

- `createEpisode(code)` (trim; throw on empty; UNIQUE violation → return the existing row
  instead of throwing), `listEpisodes()` ordered by code.
- `addFolder(path, role, episodeId)` (INSERT OR IGNORE by path; return the row),
  `listFolders()`, `removeFolder(folderId)`, `setFolderScanned(folderId, at)`.
- `upsertFile`: persist `episode_id` from FileInput (nullable, default null); update on upsert;
  mapFile returns it.
- `listFiles(episodeId?)`: undefined → all; number → WHERE episode_id = ?.
- `searchTranscripts(terms, limit?, episodeId?)` / `searchVisuals(terms, filters?, limit?)`
  (episodeId now inside VisualSearchFilters) / `searchDocuments(terms, limit?, episodeId?)`:
  add `AND files.episode_id = ?` / `AND documents.episode_id = ?` when set; include
  `episodeId` in every hit row (TranscriptHit/VisualHit/DocumentHit gained it).
- `getTranscriptHit` / `getVisualHitByScene` / `getDocChunk`: include episodeId.
- `upsertDocument`: persist episode_id; DocumentRecord returns it; listDocuments includes it.

Reply with: files changed + deviations (should be none).
