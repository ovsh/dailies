# DB v2 (src/main/db/schema.ts + database.ts)

Extend the existing better-sqlite3 implementation to cover the enlarged `DailiesDB` interface.
Read first: `src/shared/types.ts` (new: MediaRole, MediaKind, WatchedFolder, Document*,
EmbeddingKind, EMBEDDING_DIM; MediaFile/FileInput/TranscriptHit/VisualHit gained fields) and
`src/main/db/types.ts` (new methods). TypeScript strict, no `any`. Do not run npm/node.
Touch ONLY `src/main/db/schema.ts` and `src/main/db/database.ts`.

## Schema changes

1. `files` gains columns: `role TEXT NOT NULL DEFAULT 'raw'`, `clip_name TEXT`,
   `media_kind TEXT NOT NULL DEFAULT 'standard'`, `member_paths TEXT` (JSON array or NULL),
   `clip_key TEXT` (+ index on clip_key).
2. New tables:
   - `documents(id INTEGER PK, path TEXT UNIQUE, filename TEXT, kind TEXT, content TEXT, added_at TEXT)`
   - `doc_chunks(id INTEGER PK, doc_id INTEGER REFERENCES documents ON DELETE CASCADE, seq INTEGER, text TEXT)`
   - `doc_fts` — FTS5 over doc_chunks.text (manual sync, like the others)
   - `embeddings(kind TEXT, ref_id INTEGER, vector BLOB, PRIMARY KEY (kind, ref_id))`
3. **Migration**: existing databases were created without the new files columns and
   `CREATE TABLE IF NOT EXISTS` won't add them. In `openDatabase`, after executing SCHEMA_SQL,
   run a small `migrate()` that reads `PRAGMA table_info(files)` and issues
   `ALTER TABLE files ADD COLUMN ...` for each missing column. Idempotent, no version counter.

## Method changes / additions (implement exactly per db/types.ts)

- `upsertFile`: persist the new optional FileInput fields (defaults: role 'raw',
  mediaKind 'standard', nulls elsewhere); update them on upsert; mapFile returns them
  (member_paths JSON-parsed).
- `getFileByClipKey(clipKey)`.
- `searchTranscripts` / `searchVisuals`: include `role` in hits (join already selects from files).
- `getTranscriptHit(segmentId)` / `getVisualHitByScene(sceneId)`: hydrate one hit with the
  same shape/TC math as the search queries; `score` = 0 (caller re-scores).
- Documents: `upsertDocument` (transaction: upsert by path; delete old chunks + their fts rows
  + their `embeddings` rows (kind 'doc'); insert chunks + fts), `getDocumentByPath`,
  `listDocuments` (chunkCount via subquery), `searchDocuments(terms, limit=20)` over doc_fts
  (same OR/quote/bm25-normalize pattern as the other searches, join filename),
  `getDocChunk(chunkId)` → DocumentHit with score 0.
- Embeddings:
  - `upsertEmbedding(kind, refId, vector)` — store `Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)`.
  - `listUnembeddedSegments(fileId)` → segments of that file with no `embeddings` row
    (kind 'segment'), `{refId: segment id, text}`.
  - `listUnembeddedAnnotations(fileId)` → annotations of that file with no row (kind 'scene',
    refId = scene_id, text = description + objects joined).
  - `listUnembeddedDocChunks(limit=500)` → doc chunks with no row (kind 'doc').
  - `semanticSearch(kind, query, limit=40)`: load all `(ref_id, vector)` rows for kind,
    reinterpret BLOB as Float32Array (`new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4)`),
    cosine similarity vs query, sort desc, take limit, normalize scores to 0..1 (top = 1,
    guard divide-by-zero). Pure JS loop is fine.
- `replaceTranscript` must also delete stale `embeddings` rows (kind 'segment') for the file's
  old segment ids; `replaceScenes` likewise for kind 'scene'.

Reply with: files changed + any interface deviations (should be none).
