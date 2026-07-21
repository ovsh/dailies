/**
 * better-sqlite3-backed implementation of DailiesDB.
 */
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";
import { cachedBetterSqlite3Binding, repairBetterSqlite3Binding } from "./native-binding";
import type {
  AnswerHit,
  ChatMessageRecord,
  ChatSummary,
  DocumentHit,
  DocumentInput,
  DocumentRecord,
  EmbeddingKind,
  Episode,
  FileInput,
  FileStatus,
  Job,
  JobStage,
  JobStatus,
  MediaFile,
  MediaKind,
  MediaRole,
  ProjectFolder,
  Scene,
  SceneInput,
  SegmentInput,
  TranscriptHit,
  TranscriptSegment,
  WordTiming,
} from "../../shared/types";
import { sourceTcAtOffset } from "../../shared/timecode";
import type { DailiesDB } from "./types";

// ---------- raw row shapes (snake_case, as returned by better-sqlite3) ----------

interface FileRow {
  id: number;
  path: string;
  filename: string;
  duration_s: number;
  fps: number;
  drop_frame: number;
  start_tc: string;
  codec: string;
  audio_channels: number;
  file_hash: string;
  status: string;
  added_at: string;
  has_transcript: number;
  proxy_path: string | null;
  role: string;
  clip_name: string | null;
  media_kind: string;
  member_paths: string | null;
  clip_key: string | null;
  video_unplayable: number;
  episode_id: number | null;
}

interface EpisodeRow {
  id: number;
  code: string;
  created_at: string;
}

interface FolderRow {
  id: number;
  path: string;
  role: string;
  episode_id: number | null;
  last_scanned_at: string | null;
}

interface SceneRow {
  id: number;
  file_id: number;
  start_s: number;
  end_s: number;
  start_tc: string;
  end_tc: string;
  keyframe_path: string | null;
}

interface SegmentRow {
  id: number;
  file_id: number;
  start_s: number;
  end_s: number;
  text: string;
  speaker: string | null;
  avg_conf: number;
}

interface WordRow {
  id: number;
  segment_id: number;
  word: string;
  start_s: number;
  end_s: number;
}

interface JobRow {
  id: number;
  file_id: number;
  filename: string;
  stage: string;
  status: string;
  attempts: number;
  error: string | null;
  updated_at: string;
}

interface ChatRow {
  id: number;
  title: string;
  created_at: string;
}

interface ChatMessageRow {
  id: number;
  chat_id: number;
  role: string;
  content: string;
  hits: string | null;
  created_at: string;
}

interface TranscriptSearchRow {
  segment_id: number;
  file_id: number;
  filename: string;
  role: string;
  episode_id: number | null;
  fps: number;
  drop_frame: number;
  start_tc: string;
  start_s: number;
  end_s: number;
  text: string;
  rank: number;
}

interface DocumentRow {
  id: number;
  path: string;
  filename: string;
  kind: string;
  content: string;
  added_at: string;
  episode_id: number | null;
}

interface DocChunkRow {
  id: number;
  doc_id: number;
  seq: number;
  text: string;
}

interface DocumentSearchRow {
  chunk_id: number;
  doc_id: number;
  filename: string;
  episode_id: number | null;
  text: string;
  rank: number;
}

interface EmbeddingRow {
  kind: string;
  ref_id: number;
  vector: Buffer;
}

// ---------- row -> domain mapping helpers ----------

function mapFile(row: FileRow): MediaFile {
  return {
    id: row.id,
    path: row.path,
    filename: row.filename,
    durationS: row.duration_s,
    fps: row.fps,
    dropFrame: row.drop_frame === 1,
    startTc: row.start_tc,
    codec: row.codec,
    audioChannels: row.audio_channels,
    fileHash: row.file_hash,
    status: row.status as FileStatus,
    addedAt: row.added_at,
    hasTranscript: row.has_transcript === 1,
    proxyPath: row.proxy_path,
    role: row.role as MediaRole,
    clipName: row.clip_name,
    mediaKind: row.media_kind as MediaKind,
    memberPaths: row.member_paths ? (JSON.parse(row.member_paths) as string[]) : null,
    clipKey: row.clip_key,
    videoUnplayable: row.video_unplayable === 1,
    episodeId: row.episode_id,
  };
}

function mapEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    code: row.code,
    createdAt: row.created_at,
  };
}

function mapFolder(row: FolderRow): ProjectFolder {
  return {
    id: row.id,
    path: row.path,
    role: row.role as MediaRole,
    episodeId: row.episode_id,
    lastScannedAt: row.last_scanned_at,
  };
}

function mapScene(row: SceneRow): Scene {
  return {
    id: row.id,
    fileId: row.file_id,
    startS: row.start_s,
    endS: row.end_s,
    startTc: row.start_tc,
    endTc: row.end_tc,
    keyframePath: row.keyframe_path,
  };
}

function mapSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    fileId: row.file_id,
    startS: row.start_s,
    endS: row.end_s,
    text: row.text,
    speaker: row.speaker,
    avgConf: row.avg_conf,
  };
}

function mapWord(row: WordRow): WordTiming {
  return {
    word: row.word,
    startS: row.start_s,
    endS: row.end_s,
  };
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    fileId: row.file_id,
    filename: row.filename,
    stage: row.stage as JobStage,
    status: row.status as JobStatus,
    attempts: row.attempts,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

function mapChat(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  };
}

function mapChatMessage(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as "user" | "assistant",
    content: row.content,
    hits: row.hits ? (JSON.parse(row.hits) as AnswerHit[]) : null,
    createdAt: row.created_at,
  };
}

function mapDocument(row: DocumentRow, chunkCount: number): DocumentRecord {
  return {
    id: row.id,
    path: row.path,
    filename: row.filename,
    kind: row.kind as DocumentRecord["kind"],
    addedAt: row.added_at,
    chunkCount,
    episodeId: row.episode_id,
  };
}

// ---------- embedding helpers ----------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Reject weak nearest-neighbour guesses instead of always returning a top hit. */
const SEMANTIC_RELEVANCE_FLOOR = 0.35;

// ---------- FTS helpers ----------

/** Builds an FTS5 MATCH expression OR-ing sanitized terms. */
function buildFtsQuery(terms: string[]): string {
  const sanitized = terms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, "")}"`);
  return sanitized.join(" OR ");
}

/** Normalizes bm25 scores (more negative = better match in SQLite) to 0..1, best = 1. */
function normalizeScores<T extends { rank: number }>(rows: T[]): number[] {
  if (rows.length === 0) return [];
  const ranks = rows.map((r) => r.rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  if (min === max) {
    return rows.map(() => 1);
  }
  // bm25() is more negative for better matches; invert so best match -> 1.
  return rows.map((r) => (max - r.rank) / (max - min));
}

// ---------- migration ----------

interface TableInfoRow {
  name: string;
}

/** Adds any missing columns from `wantedColumns` to `table`, reading PRAGMA table_info. */
function addMissingColumns(
  db: BetterSqlite3Database,
  table: string,
  wantedColumns: Array<[string, string]>,
): void {
  const existingColumns = new Set(
    (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name),
  );
  for (const [name, ddl] of wantedColumns) {
    if (!existingColumns.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  }
}

interface LegacyWatchedFolder {
  path: string;
  role?: string;
}

/**
 * Migrates the legacy `watchedFolders` settings KV row (JSON array of {path, role}
 * or plain path strings) into the `folders` table, then deletes the KV row.
 */
function migrateWatchedFoldersKv(db: BetterSqlite3Database): void {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get("watchedFolders");
  if (!row) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = null;
  }

  if (Array.isArray(parsed)) {
    const insert = db.prepare<[string, string]>(
      "INSERT OR IGNORE INTO folders (path, role, episode_id, last_scanned_at) VALUES (?, ?, NULL, NULL)",
    );
    for (const entry of parsed as unknown[]) {
      if (typeof entry === "string") {
        insert.run(entry, "raw");
      } else if (entry && typeof entry === "object" && "path" in entry) {
        const legacy = entry as LegacyWatchedFolder;
        if (typeof legacy.path === "string") {
          insert.run(legacy.path, legacy.role ?? "raw");
        }
      }
    }
  }

  db.prepare("DELETE FROM settings WHERE key = ?").run("watchedFolders");
}

/**
 * Brings a database created by an earlier schema version up to date.
 * CREATE TABLE IF NOT EXISTS leaves existing tables untouched, so older databases
 * are missing columns added later; ALTER them in when absent. Idempotent.
 */
function migrate(db: BetterSqlite3Database): void {
  addMissingColumns(db, "files", [
    ["role", "TEXT NOT NULL DEFAULT 'raw'"],
    ["clip_name", "TEXT"],
    ["media_kind", "TEXT NOT NULL DEFAULT 'standard'"],
    ["member_paths", "TEXT"],
    ["clip_key", "TEXT"],
    ["video_unplayable", "INTEGER NOT NULL DEFAULT 0"],
    ["episode_id", "INTEGER REFERENCES episodes(id) ON DELETE SET NULL"],
  ]);
  addMissingColumns(db, "documents", [
    ["episode_id", "INTEGER REFERENCES episodes(id) ON DELETE SET NULL"],
  ]);
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_clip_key ON files(clip_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_file_hash ON files(file_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_episode_id ON files(episode_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_episode_id ON documents(episode_id)");
  db.exec(`
    DROP TABLE IF EXISTS visual_fts;
    DROP TABLE IF EXISTS visual_annotations;
    DELETE FROM embeddings WHERE kind = 'scene';
    DELETE FROM jobs WHERE stage = 'visual_index';
  `);
  migrateWatchedFoldersKv(db);
}

// ---------- database implementation ----------

export function openDatabase(dbPath: string): DailiesDB {
  let db: BetterSqlite3Database;
  const cachedBinding = cachedBetterSqlite3Binding();
  try {
    db = new Database(dbPath, cachedBinding ? { nativeBinding: cachedBinding } : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("NODE_MODULE_VERSION")) throw error;

    const repairedBinding = repairBetterSqlite3Binding();
    db = new Database(dbPath, repairedBinding ? { nativeBinding: repairedBinding } : undefined);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrate(db);

  // ---------- prepared statements ----------

  const stmtGetFileById = db.prepare<[number], FileRow>("SELECT * FROM files WHERE id = ?");
  const stmtGetFileByPath = db.prepare<[string], FileRow>("SELECT * FROM files WHERE path = ?");
  const stmtGetFileByHash = db.prepare<[string], FileRow>(
    "SELECT * FROM files WHERE file_hash = ? LIMIT 1",
  );
  const stmtGetFileByClipKey = db.prepare<[string], FileRow>(
    "SELECT * FROM files WHERE clip_key = ?",
  );
  const stmtInsertFile = db.prepare<
    [
      string,
      string,
      number,
      number,
      number,
      string,
      string,
      number,
      string,
      string,
      string,
      string | null,
      string,
      string | null,
      string | null,
      number | null,
    ],
    FileRow
  >(
    `INSERT INTO files (
       path, filename, duration_s, fps, drop_frame, start_tc, codec, audio_channels, file_hash,
       status, added_at, role, clip_name, media_kind, member_paths, clip_key, episode_id
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtUpdateFile = db.prepare<
    [
      string,
      string,
      number,
      number,
      number,
      string,
      string,
      number,
      string,
      string,
      string | null,
      string,
      string | null,
      string | null,
      number | null,
      number,
    ],
    FileRow
  >(
    `UPDATE files SET path = ?, filename = ?, duration_s = ?, fps = ?, drop_frame = ?, start_tc = ?, codec = ?, audio_channels = ?, file_hash = ?,
       role = ?, clip_name = ?, media_kind = ?, member_paths = ?, clip_key = ?, episode_id = ?
     WHERE id = ?
     RETURNING *`,
  );
  const stmtRepointFilePath = db.prepare<[string, string, number], FileRow>(
    "UPDATE files SET path = ?, filename = ? WHERE id = ? RETURNING *",
  );
  const stmtListFiles = db.prepare<[], FileRow>("SELECT * FROM files ORDER BY added_at DESC");
  const stmtDeleteFile = db.prepare<[number]>("DELETE FROM files WHERE id = ?");
  const stmtListFilesByEpisode = db.prepare<[number], FileRow>(
    "SELECT * FROM files WHERE episode_id = ? ORDER BY added_at DESC",
  );
  const stmtSetFileStatus = db.prepare<[string, number]>("UPDATE files SET status = ? WHERE id = ?");
  const stmtSetFileProxy = db.prepare<[string, number]>("UPDATE files SET proxy_path = ? WHERE id = ?");
  const stmtSetVideoUnplayable = db.prepare<[number, number]>(
    "UPDATE files SET video_unplayable = ? WHERE id = ?",
  );
  const stmtClearDerivedFileState = db.prepare<[number]>(
    `UPDATE files SET status = 'pending', has_transcript = 0,
       proxy_path = NULL, video_unplayable = 0 WHERE id = ?`,
  );
  const stmtMarkTranscribed = db.prepare<[number]>("UPDATE files SET has_transcript = 1 WHERE id = ?");

  // ---------- episodes ----------

  const stmtInsertEpisode = db.prepare<[string, string], EpisodeRow>(
    "INSERT INTO episodes (code, created_at) VALUES (?, ?) RETURNING *",
  );
  const stmtGetEpisodeByCode = db.prepare<[string], EpisodeRow>(
    "SELECT * FROM episodes WHERE code = ?",
  );
  const stmtListEpisodes = db.prepare<[], EpisodeRow>("SELECT * FROM episodes ORDER BY code ASC");

  // ---------- folders ----------

  const stmtInsertFolder = db.prepare<[string, string, number | null], FolderRow>(
    `INSERT OR IGNORE INTO folders (path, role, episode_id, last_scanned_at)
     VALUES (?, ?, ?, NULL)`,
  );
  const stmtGetFolderByPath = db.prepare<[string], FolderRow>(
    "SELECT * FROM folders WHERE path = ?",
  );
  const stmtListFolders = db.prepare<[], FolderRow>("SELECT * FROM folders ORDER BY path ASC");
  const stmtRemoveFolder = db.prepare<[number]>("DELETE FROM folders WHERE id = ?");
  const stmtSetFolderScanned = db.prepare<[string, number]>(
    "UPDATE folders SET last_scanned_at = ? WHERE id = ?",
  );

  const stmtDeleteScenes = db.prepare<[number]>("DELETE FROM scenes WHERE file_id = ?");
  const stmtInsertScene = db.prepare<[number, number, number, string, string, string | null], SceneRow>(
    `INSERT INTO scenes (file_id, start_s, end_s, start_tc, end_tc, keyframe_path)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtListScenes = db.prepare<[number], SceneRow>(
    "SELECT * FROM scenes WHERE file_id = ? ORDER BY start_s ASC",
  );
  const stmtGetScene = db.prepare<[number], SceneRow>("SELECT * FROM scenes WHERE id = ?");

  const stmtDeleteSegments = db.prepare<[number]>("DELETE FROM transcript_segments WHERE file_id = ?");
  const stmtDeleteTranscriptFts = db.prepare<[number]>("DELETE FROM transcript_fts WHERE file_id = ?");
  const stmtInsertSegment = db.prepare<
    [number, number, number, string, string | null, number],
    SegmentRow
  >(
    `INSERT INTO transcript_segments (file_id, start_s, end_s, text, speaker, avg_conf)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtInsertWord = db.prepare<[number, string, number, number]>(
    "INSERT INTO words (segment_id, word, start_s, end_s) VALUES (?, ?, ?, ?)",
  );
  const stmtInsertTranscriptFts = db.prepare<[string, number, number]>(
    "INSERT INTO transcript_fts (text, file_id, segment_id) VALUES (?, ?, ?)",
  );
  const stmtListSegments = db.prepare<[number], SegmentRow>(
    "SELECT * FROM transcript_segments WHERE file_id = ? ORDER BY start_s ASC",
  );
  const stmtGetWords = db.prepare<[number], WordRow>(
    "SELECT * FROM words WHERE segment_id = ? ORDER BY start_s ASC",
  );
  const stmtGetTranscriptWindow = db.prepare<[number, number, number], SegmentRow>(
    `SELECT * FROM transcript_segments
     WHERE file_id = ? AND end_s >= ? AND start_s <= ?
     ORDER BY start_s ASC`,
  );

  // ---------- documents ----------

  const stmtGetDocumentByPath = db.prepare<[string], DocumentRow>(
    "SELECT * FROM documents WHERE path = ?",
  );
  const stmtGetDocumentById = db.prepare<[number], DocumentRow>(
    "SELECT * FROM documents WHERE id = ?",
  );
  const stmtInsertDocument = db.prepare<
    [string, string, string, string, string, number | null],
    DocumentRow
  >(
    `INSERT INTO documents (path, filename, kind, content, added_at, episode_id)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtUpdateDocument = db.prepare<
    [string, string, string, number | null, number],
    DocumentRow
  >(
    `UPDATE documents SET filename = ?, kind = ?, content = ?, episode_id = ?
     WHERE id = ?
     RETURNING *`,
  );
  const stmtListDocuments = db.prepare<[], DocumentRow>(
    "SELECT * FROM documents ORDER BY added_at DESC",
  );
  const stmtCountDocChunks = db.prepare<[number], { count: number }>(
    "SELECT COUNT(*) AS count FROM doc_chunks WHERE doc_id = ?",
  );
  const stmtGetDocChunkIds = db.prepare<[number], { id: number }>(
    "SELECT id FROM doc_chunks WHERE doc_id = ?",
  );
  const stmtDeleteDocChunks = db.prepare<[number]>("DELETE FROM doc_chunks WHERE doc_id = ?");
  const stmtDeleteDocFts = db.prepare<[number]>("DELETE FROM doc_fts WHERE doc_id = ?");
  const stmtInsertDocChunk = db.prepare<[number, number, string], DocChunkRow>(
    `INSERT INTO doc_chunks (doc_id, seq, text)
     VALUES (?, ?, ?)
     RETURNING *`,
  );
  const stmtInsertDocFts = db.prepare<[string, number, number]>(
    "INSERT INTO doc_fts (text, doc_id, chunk_id) VALUES (?, ?, ?)",
  );
  const stmtGetDocChunkById = db.prepare<[number], DocChunkRow>(
    "SELECT * FROM doc_chunks WHERE id = ?",
  );

  function buildSearchDocumentsStmt(episodeId?: number) {
    const clauses: string[] = ["doc_fts MATCH ?"];
    if (episodeId !== undefined) clauses.push("documents.episode_id = ?");
    const sql = `SELECT
        doc_fts.chunk_id AS chunk_id,
        doc_fts.doc_id AS doc_id,
        documents.filename AS filename,
        documents.episode_id AS episode_id,
        doc_chunks.text AS text,
        bm25(doc_fts) AS rank
      FROM doc_fts
      JOIN doc_chunks ON doc_chunks.id = doc_fts.chunk_id
      JOIN documents ON documents.id = doc_fts.doc_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?`;
    return db.prepare<unknown[], DocumentSearchRow>(sql);
  }

  // ---------- embeddings ----------

  const stmtUpsertEmbedding = db.prepare<[string, number, Buffer]>(
    `INSERT INTO embeddings (kind, ref_id, vector) VALUES (?, ?, ?)
     ON CONFLICT(kind, ref_id) DO UPDATE SET vector = excluded.vector`,
  );
  const stmtDeleteEmbedding = db.prepare<[string, number]>(
    "DELETE FROM embeddings WHERE kind = ? AND ref_id = ?",
  );
  const stmtDeleteSegmentEmbeddingsForFile = db.prepare<[number]>(
    `DELETE FROM embeddings WHERE kind = 'segment'
     AND ref_id IN (SELECT id FROM transcript_segments WHERE file_id = ?)`,
  );
  const stmtListUnembeddedSegments = db.prepare<[number], { ref_id: number; text: string }>(
    `SELECT transcript_segments.id AS ref_id, transcript_segments.text AS text
     FROM transcript_segments
     WHERE transcript_segments.file_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM embeddings
         WHERE embeddings.kind = 'segment' AND embeddings.ref_id = transcript_segments.id
       )`,
  );
  const stmtListUnembeddedDocChunks = db.prepare<[number], { ref_id: number; text: string }>(
    `SELECT doc_chunks.id AS ref_id, doc_chunks.text AS text
     FROM doc_chunks
     WHERE NOT EXISTS (
       SELECT 1 FROM embeddings
       WHERE embeddings.kind = 'doc' AND embeddings.ref_id = doc_chunks.id
     )
     LIMIT ?`,
  );
  const stmtListEmbeddingsByKind = db.prepare<[string], EmbeddingRow>(
    "SELECT kind, ref_id, vector FROM embeddings WHERE kind = ?",
  );
  const stmtDeleteAllEmbeddings = db.prepare("DELETE FROM embeddings");

  const stmtEnqueueJob = db.prepare<[{ fileId: number; stage: string; now: string }]>(
    `INSERT INTO jobs (file_id, stage, status, attempts, updated_at)
     SELECT @fileId, @stage, 'queued', 0, @now
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs
       WHERE file_id = @fileId AND stage = @stage AND status IN ('queued', 'running', 'waiting')
     )`,
  );
  const stmtClaimNextJobId = db.prepare<[], { id: number }>(
    "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1",
  );
  const stmtHasActiveJob = db.prepare<[number, string], { count: number }>(
    `SELECT COUNT(*) AS count FROM jobs
     WHERE file_id = ? AND stage = ? AND status IN ('queued', 'running', 'waiting')`,
  );
  const stmtClaimJob = db.prepare<[string, number], JobRow>(
    `UPDATE jobs SET status = 'running', updated_at = ?
     WHERE id = ? AND status = 'queued'
     RETURNING *`,
  );
  const stmtGetJobWithFilename = db.prepare<[number], JobRow>(
    `SELECT jobs.id, jobs.file_id, files.filename, jobs.stage, jobs.status, jobs.attempts, jobs.error, jobs.updated_at
     FROM jobs JOIN files ON files.id = jobs.file_id
     WHERE jobs.id = ?`,
  );
  const stmtCompleteJob = db.prepare<[string, number]>(
    "UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?",
  );
  const stmtWaitJob = db.prepare<[string, string, number]>(
    "UPDATE jobs SET status = 'waiting', error = ?, updated_at = ? WHERE id = ?",
  );
  const stmtRequeueWaitingStage = db.prepare<[string, string]>(
    `UPDATE jobs SET status = 'queued', error = NULL, updated_at = ?
     WHERE status = 'waiting' AND stage = ?`,
  );
  const stmtRetryJob = db.prepare<[string, string, number]>(
    `UPDATE jobs SET status = 'queued', error = ?, attempts = attempts + 1,
       updated_at = ? WHERE id = ?`,
  );
  const stmtFailJob = db.prepare<[string, string, number]>(
    "UPDATE jobs SET status = 'error', error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
  );
  const stmtResetRunningJobs = db.prepare<[string]>(
    "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
  );
  const stmtDeleteJobsForFile = db.prepare<[number]>("DELETE FROM jobs WHERE file_id = ?");
  const stmtListJobs = db.prepare<[number], JobRow>(
    `SELECT jobs.id, jobs.file_id, files.filename, jobs.stage, jobs.status, jobs.attempts, jobs.error, jobs.updated_at
     FROM jobs JOIN files ON files.id = jobs.file_id
     ORDER BY jobs.id DESC
     LIMIT ?`,
  );

  const stmtInsertChat = db.prepare<[string, string], ChatRow>(
    "INSERT INTO chats (title, created_at) VALUES (?, ?) RETURNING *",
  );
  const stmtListChats = db.prepare<[], ChatRow>("SELECT * FROM chats ORDER BY created_at DESC");
  const stmtInsertChatMessage = db.prepare<
    [number, string, string, string | null, string],
    ChatMessageRow
  >(
    `INSERT INTO chat_messages (chat_id, role, content, hits, created_at)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtGetChatMessages = db.prepare<[number], ChatMessageRow>(
    "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id ASC",
  );

  const stmtGetSetting = db.prepare<[string], { value: string }>(
    "SELECT value FROM settings WHERE key = ?",
  );
  const stmtSetSetting = db.prepare<[string, string]>(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  function buildSearchTranscriptsStmt(episodeId?: number) {
    const clauses: string[] = ["transcript_fts MATCH ?"];
    if (episodeId !== undefined) clauses.push("files.episode_id = ?");
    const sql = `SELECT
        transcript_fts.segment_id AS segment_id,
        transcript_fts.file_id AS file_id,
        files.filename AS filename,
        files.role AS role,
        files.episode_id AS episode_id,
        files.fps AS fps,
        files.drop_frame AS drop_frame,
        files.start_tc AS start_tc,
        transcript_segments.start_s AS start_s,
        transcript_segments.end_s AS end_s,
        transcript_segments.text AS text,
        bm25(transcript_fts) AS rank
      FROM transcript_fts
      JOIN transcript_segments ON transcript_segments.id = transcript_fts.segment_id
      JOIN files ON files.id = transcript_fts.file_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?`;
    return db.prepare<unknown[], TranscriptSearchRow>(sql);
  }

  const stmtGetTranscriptHit = db.prepare<[number], TranscriptSearchRow>(
    `SELECT
       transcript_segments.id AS segment_id,
       transcript_segments.file_id AS file_id,
       files.filename AS filename,
       files.role AS role,
       files.episode_id AS episode_id,
       files.fps AS fps,
       files.drop_frame AS drop_frame,
       files.start_tc AS start_tc,
       transcript_segments.start_s AS start_s,
       transcript_segments.end_s AS end_s,
       transcript_segments.text AS text,
       0 AS rank
     FROM transcript_segments
     JOIN files ON files.id = transcript_segments.file_id
     WHERE transcript_segments.id = ?`,
  );

  // ---------- transactional helpers ----------

  const stmtGetSegmentIdsForFile = db.prepare<[number], { id: number }>(
    "SELECT id FROM transcript_segments WHERE file_id = ?",
  );

  const replaceScenesTx = db.transaction((fileId: number, scenes: SceneInput[]): Scene[] => {
    stmtDeleteScenes.run(fileId);
    const inserted: Scene[] = [];
    for (const s of scenes) {
      const row = stmtInsertScene.get(
        fileId,
        s.startS,
        s.endS,
        s.startTc,
        s.endTc,
        s.keyframePath ?? null,
      );
      if (row) inserted.push(mapScene(row));
    }
    return inserted;
  });

  const replaceTranscriptTx = db.transaction((fileId: number, segments: SegmentInput[]): void => {
    const staleSegmentIds = stmtGetSegmentIdsForFile.all(fileId);
    for (const { id } of staleSegmentIds) {
      stmtDeleteEmbedding.run("segment", id);
    }
    stmtDeleteSegments.run(fileId);
    stmtDeleteTranscriptFts.run(fileId);
    for (const seg of segments) {
      const row = stmtInsertSegment.get(
        fileId,
        seg.startS,
        seg.endS,
        seg.text,
        seg.speaker ?? null,
        seg.avgConf,
      );
      if (!row) continue;
      for (const w of seg.words) {
        stmtInsertWord.run(row.id, w.word, w.startS, w.endS);
      }
      stmtInsertTranscriptFts.run(seg.text, fileId, row.id);
    }
  });

  const claimNextJobTx = db.transaction((): Job | null => {
    const next = stmtClaimNextJobId.get();
    if (!next) return null;
    const claimed = stmtClaimJob.get(new Date().toISOString(), next.id);
    if (!claimed) return null;
    const withFilename = stmtGetJobWithFilename.get(claimed.id);
    return withFilename ? mapJob(withFilename) : null;
  });

  const reopenErroredJobsTx = db.transaction((
    fileId: number | undefined,
    stages: JobStage[] | undefined,
  ): number => {
    if (stages?.length === 0) return 0;
    const filters = ["status = 'error'"];
    const params: Array<string | number> = [new Date().toISOString()];
    if (fileId !== undefined) {
      filters.push("file_id = ?");
      params.push(fileId);
    }
    if (stages !== undefined) {
      filters.push(`stage IN (${stages.map(() => "?").join(", ")})`);
      params.push(...stages);
    }
    const statement = db.prepare(
      `UPDATE jobs
       SET status = 'queued', attempts = 0, error = NULL, updated_at = ?
       WHERE ${filters.join(" AND ")}`,
    );
    return statement.run(...params).changes;
  });

  const clearDerivedStateTx = db.transaction((fileId: number): void => {
    stmtDeleteSegmentEmbeddingsForFile.run(fileId);
    stmtDeleteTranscriptFts.run(fileId);
    stmtDeleteSegments.run(fileId);
    stmtDeleteScenes.run(fileId);
    stmtDeleteJobsForFile.run(fileId);
    stmtClearDerivedFileState.run(fileId);
  });

  function updateExistingFile(existing: FileRow, input: FileInput): MediaFile {
    const updated = stmtUpdateFile.get(
      input.path,
      input.filename,
      input.durationS,
      input.fps,
      input.dropFrame ? 1 : 0,
      input.startTc,
      input.codec,
      input.audioChannels,
      input.fileHash,
      input.role ?? "raw",
      input.clipName ?? null,
      input.mediaKind ?? "standard",
      input.memberPaths ? JSON.stringify(input.memberPaths) : null,
      input.clipKey ?? null,
      input.episodeId ?? null,
      existing.id,
    );
    if (!updated) throw new Error(`updateFile: file ${existing.id} not found`);
    return mapFile(updated);
  }

  const upsertFileTx = db.transaction((input: FileInput): MediaFile => {
    const role = input.role ?? "raw";
    const mediaKind = input.mediaKind ?? "standard";
    const clipName = input.clipName ?? null;
    const memberPaths = input.memberPaths ? JSON.stringify(input.memberPaths) : null;
    const clipKey = input.clipKey ?? null;
    const episodeId = input.episodeId ?? null;
    const existing = (clipKey ? stmtGetFileByClipKey.get(clipKey) : undefined) ??
      stmtGetFileByPath.get(input.path);

    if (existing) {
      if (existing.file_hash !== input.fileHash) {
        // Clear every searchable/derived representation before exposing the
        // new hash. This transaction prevents stale transcript, proxy, and
        // embedding state from masquerading as current content.
        clearDerivedStateTx(existing.id);
      }
      return updateExistingFile(existing, input);
    }

    const row = stmtInsertFile.get(
      input.path,
      input.filename,
      input.durationS,
      input.fps,
      input.dropFrame ? 1 : 0,
      input.startTc,
      input.codec,
      input.audioChannels,
      input.fileHash,
      new Date().toISOString(),
      role,
      clipName,
      mediaKind,
      memberPaths,
      clipKey,
      episodeId,
    );
    if (!row) throw new Error("upsertFile: insert failed");
    return mapFile(row);
  });

  const deleteFilesUnderPathTx = db.transaction((pathPrefix: string): MediaFile[] => {
    const rows = stmtListFiles.all().filter((row) =>
      row.path.startsWith(pathPrefix) &&
      (row.path.length === pathPrefix.length ||
        pathPrefix.endsWith("/") ||
        row.path[pathPrefix.length] === "/")
    );
    for (const row of rows) {
      clearDerivedStateTx(row.id);
      stmtDeleteFile.run(row.id);
    }
    return rows.map(mapFile);
  });

  const upsertDocumentTx = db.transaction((input: DocumentInput): DocumentRecord => {
    const episodeId = input.episodeId ?? null;
    const existing = stmtGetDocumentByPath.get(input.path);
    let doc: DocumentRow;
    if (existing) {
      const staleChunkIds = stmtGetDocChunkIds.all(existing.id);
      for (const { id } of staleChunkIds) {
        stmtDeleteEmbedding.run("doc", id);
      }
      stmtDeleteDocFts.run(existing.id);
      stmtDeleteDocChunks.run(existing.id);
      const updated = stmtUpdateDocument.get(
        input.filename,
        input.kind,
        input.content,
        episodeId,
        existing.id,
      );
      doc = updated ?? existing;
    } else {
      const inserted = stmtInsertDocument.get(
        input.path,
        input.filename,
        input.kind,
        input.content,
        new Date().toISOString(),
        episodeId,
      );
      if (!inserted) throw new Error("upsertDocument: insert failed");
      doc = inserted;
    }
    input.chunks.forEach((text, seq) => {
      const chunk = stmtInsertDocChunk.get(doc.id, seq, text);
      if (!chunk) return;
      stmtInsertDocFts.run(text, doc.id, chunk.id);
    });
    const { count } = stmtCountDocChunks.get(doc.id) ?? { count: 0 };
    return mapDocument(doc, count);
  });

  // ---------- DailiesDB implementation ----------

  return {
    // files
    upsertFile(input: FileInput): MediaFile {
      return upsertFileTx(input);
    },

    getFile(id: number): MediaFile | null {
      const row = stmtGetFileById.get(id);
      return row ? mapFile(row) : null;
    },

    getFileByPath(path: string): MediaFile | null {
      const row = stmtGetFileByPath.get(path);
      return row ? mapFile(row) : null;
    },

    getFileByHash(hash: string): MediaFile | null {
      const row = stmtGetFileByHash.get(hash);
      return row ? mapFile(row) : null;
    },

    repointFilePath(fileId: number, newPath: string, newFilename: string): MediaFile {
      const row = stmtRepointFilePath.get(newPath, newFilename, fileId);
      if (!row) throw new Error(`repointFilePath: file ${fileId} not found`);
      return mapFile(row);
    },

    getFileByClipKey(clipKey: string): MediaFile | null {
      const row = stmtGetFileByClipKey.get(clipKey);
      return row ? mapFile(row) : null;
    },

    updateOpAtomMembers(fileId: number, input: FileInput): MediaFile {
      const existing = stmtGetFileById.get(fileId);
      if (!existing) throw new Error(`updateOpAtomMembers: file ${fileId} not found`);
      return updateExistingFile(existing, input);
    },

    deleteFilesUnderPath(pathPrefix: string): MediaFile[] {
      return deleteFilesUnderPathTx(pathPrefix);
    },

    listFiles(episodeId?: number): MediaFile[] {
      if (episodeId === undefined) return stmtListFiles.all().map(mapFile);
      return stmtListFilesByEpisode.all(episodeId).map(mapFile);
    },

    setFileStatus(id: number, status: FileStatus): void {
      stmtSetFileStatus.run(status, id);
    },

    setFileProxy(id: number, proxyPath: string): void {
      stmtSetFileProxy.run(proxyPath, id);
    },

    clearDerivedState(fileId: number): void {
      clearDerivedStateTx(fileId);
    },

    setVideoUnplayable(id: number, value: boolean): void {
      stmtSetVideoUnplayable.run(value ? 1 : 0, id);
    },

    markTranscribed(id: number): void {
      stmtMarkTranscribed.run(id);
    },

    // episodes
    createEpisode(code: string): Episode {
      const trimmed = code.trim();
      if (!trimmed) throw new Error("createEpisode: code must not be empty");
      const existing = stmtGetEpisodeByCode.get(trimmed);
      if (existing) return mapEpisode(existing);
      try {
        const row = stmtInsertEpisode.get(trimmed, new Date().toISOString());
        if (!row) throw new Error("createEpisode: insert failed");
        return mapEpisode(row);
      } catch (err) {
        // UNIQUE violation (race with another insert) -> return the existing row.
        const raced = stmtGetEpisodeByCode.get(trimmed);
        if (raced) return mapEpisode(raced);
        throw err;
      }
    },

    listEpisodes(): Episode[] {
      return stmtListEpisodes.all().map(mapEpisode);
    },

    // folders
    addFolder(path: string, role: MediaRole, episodeId: number | null): ProjectFolder {
      stmtInsertFolder.run(path, role, episodeId);
      const row = stmtGetFolderByPath.get(path);
      if (!row) throw new Error("addFolder: insert failed");
      return mapFolder(row);
    },

    listFolders(): ProjectFolder[] {
      return stmtListFolders.all().map(mapFolder);
    },

    removeFolder(folderId: number): void {
      stmtRemoveFolder.run(folderId);
    },

    setFolderScanned(folderId: number, at: string): void {
      stmtSetFolderScanned.run(at, folderId);
    },

    // scenes
    replaceScenes(fileId: number, scenes: SceneInput[]): Scene[] {
      return replaceScenesTx(fileId, scenes);
    },

    listScenes(fileId: number): Scene[] {
      return stmtListScenes.all(fileId).map(mapScene);
    },

    getScene(sceneId: number): Scene | null {
      const row = stmtGetScene.get(sceneId);
      return row ? mapScene(row) : null;
    },

    // transcript
    replaceTranscript(fileId: number, segments: SegmentInput[]): void {
      replaceTranscriptTx(fileId, segments);
    },

    listSegments(fileId: number): TranscriptSegment[] {
      return stmtListSegments.all(fileId).map(mapSegment);
    },

    getWords(segmentId: number): WordTiming[] {
      return stmtGetWords.all(segmentId).map(mapWord);
    },

    getTranscriptWindow(fileId: number, centerS: number, windowS: number): TranscriptSegment[] {
      const lo = centerS - windowS;
      const hi = centerS + windowS;
      return stmtGetTranscriptWindow.all(fileId, lo, hi).map(mapSegment);
    },

    // search
    searchTranscripts(terms: string[], limit = 40, episodeId?: number): TranscriptHit[] {
      const query = buildFtsQuery(terms);
      if (!query) return [];
      const stmt = buildSearchTranscriptsStmt(episodeId);
      const params: unknown[] = [query];
      if (episodeId !== undefined) params.push(episodeId);
      params.push(limit);
      const rows = stmt.all(...params);
      const scores = normalizeScores(rows);
      return rows.map((row, i) => ({
        fileId: row.file_id,
        filename: row.filename,
        role: row.role as MediaRole,
        episodeId: row.episode_id,
        segmentId: row.segment_id,
        startS: row.start_s,
        endS: row.end_s,
        startTc: sourceTcAtOffset(row.start_tc, row.start_s, row.fps, row.drop_frame === 1),
        endTc: sourceTcAtOffset(row.start_tc, row.end_s, row.fps, row.drop_frame === 1),
        text: row.text,
        score: scores[i] ?? 0,
      }));
    },

    getTranscriptHit(segmentId: number): TranscriptHit | null {
      const row = stmtGetTranscriptHit.get(segmentId);
      if (!row) return null;
      return {
        fileId: row.file_id,
        filename: row.filename,
        role: row.role as MediaRole,
        episodeId: row.episode_id,
        segmentId: row.segment_id,
        startS: row.start_s,
        endS: row.end_s,
        startTc: sourceTcAtOffset(row.start_tc, row.start_s, row.fps, row.drop_frame === 1),
        endTc: sourceTcAtOffset(row.start_tc, row.end_s, row.fps, row.drop_frame === 1),
        text: row.text,
        score: 0,
      };
    },

    // documents
    upsertDocument(input: DocumentInput): DocumentRecord {
      return upsertDocumentTx(input);
    },

    getDocumentByPath(path: string): DocumentRecord | null {
      const row = stmtGetDocumentByPath.get(path);
      if (!row) return null;
      const { count } = stmtCountDocChunks.get(row.id) ?? { count: 0 };
      return mapDocument(row, count);
    },

    listDocuments(): DocumentRecord[] {
      return stmtListDocuments.all().map((row) => {
        const { count } = stmtCountDocChunks.get(row.id) ?? { count: 0 };
        return mapDocument(row, count);
      });
    },

    searchDocuments(terms: string[], limit = 20, episodeId?: number): DocumentHit[] {
      const query = buildFtsQuery(terms);
      if (!query) return [];
      const stmt = buildSearchDocumentsStmt(episodeId);
      const params: unknown[] = [query];
      if (episodeId !== undefined) params.push(episodeId);
      params.push(limit);
      const rows = stmt.all(...params);
      const scores = normalizeScores(rows);
      return rows.map((row, i) => ({
        docId: row.doc_id,
        chunkId: row.chunk_id,
        filename: row.filename,
        episodeId: row.episode_id,
        text: row.text,
        score: scores[i] ?? 0,
      }));
    },

    getDocChunk(chunkId: number): DocumentHit | null {
      const row = stmtGetDocChunkById.get(chunkId);
      if (!row) return null;
      const doc = stmtGetDocumentById.get(row.doc_id);
      return {
        docId: row.doc_id,
        chunkId: row.id,
        filename: doc?.filename ?? "",
        episodeId: doc?.episode_id ?? null,
        text: row.text,
        score: 0,
      };
    },

    // embeddings
    upsertEmbedding(kind: EmbeddingKind, refId: number, vector: Float32Array): void {
      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      stmtUpsertEmbedding.run(kind, refId, buffer);
    },

    listUnembeddedSegments(fileId: number): Array<{ refId: number; text: string }> {
      return stmtListUnembeddedSegments
        .all(fileId)
        .map((row) => ({ refId: row.ref_id, text: row.text }));
    },

    listUnembeddedDocChunks(limit = 500): Array<{ refId: number; text: string }> {
      return stmtListUnembeddedDocChunks
        .all(limit)
        .map((row) => ({ refId: row.ref_id, text: row.text }));
    },

    semanticSearch(
      kind: EmbeddingKind,
      query: Float32Array,
      limit = 40,
    ): Array<{ refId: number; score: number }> {
      const rows = stmtListEmbeddingsByKind.all(kind);
      const scored = rows.map((row) => {
        const vector = new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
        return { refId: row.ref_id, similarity: cosineSimilarity(query, vector) };
      });
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored
        .filter((row) => row.similarity >= SEMANTIC_RELEVANCE_FLOOR)
        .slice(0, limit)
        .map((row) => ({ refId: row.refId, score: row.similarity }));
    },

    deleteAllEmbeddings(): void {
      stmtDeleteAllEmbeddings.run();
    },

    // project metadata
    getMeta(key: string): string | null {
      const row = stmtGetSetting.get(key);
      return row ? row.value : null;
    },

    setMeta(key: string, value: string): void {
      stmtSetSetting.run(key, value);
    },

    // job queue
    enqueueJob(fileId: number, stage: JobStage): void {
      stmtEnqueueJob.run({ fileId, stage, now: new Date().toISOString() });
    },

    hasActiveJob(fileId: number, stage: JobStage): boolean {
      return (stmtHasActiveJob.get(fileId, stage)?.count ?? 0) > 0;
    },

    claimNextJob(): Job | null {
      return claimNextJobTx();
    },

    completeJob(jobId: number): void {
      stmtCompleteJob.run(new Date().toISOString(), jobId);
    },

    waitJob(jobId: number, reason: string): void {
      stmtWaitJob.run(reason, new Date().toISOString(), jobId);
    },

    requeueWaitingJobs(stages: JobStage[]): number {
      let changed = 0;
      const now = new Date().toISOString();
      for (const stage of stages) {
        changed += stmtRequeueWaitingStage.run(now, stage).changes;
      }
      return changed;
    },

    reopenErroredJobs(fileId?: number, stages?: JobStage[]): number {
      return reopenErroredJobsTx(fileId, stages);
    },

    retryJob(jobId: number, error: string): void {
      stmtRetryJob.run(error, new Date().toISOString(), jobId);
    },

    failJob(jobId: number, error: string): void {
      stmtFailJob.run(error, new Date().toISOString(), jobId);
    },

    resetRunningJobs(): void {
      stmtResetRunningJobs.run(new Date().toISOString());
    },

    listJobs(limit = 100): Job[] {
      return stmtListJobs.all(limit).map(mapJob);
    },

    // chats
    createChat(title: string): ChatSummary {
      const row = stmtInsertChat.get(title, new Date().toISOString());
      if (!row) throw new Error("createChat: insert failed");
      return mapChat(row);
    },

    listChats(): ChatSummary[] {
      return stmtListChats.all().map(mapChat);
    },

    addChatMessage(
      chatId: number,
      role: "user" | "assistant",
      content: string,
      hits?: AnswerHit[] | null,
    ): ChatMessageRecord {
      const row = stmtInsertChatMessage.get(
        chatId,
        role,
        content,
        hits ? JSON.stringify(hits) : null,
        new Date().toISOString(),
      );
      if (!row) throw new Error("addChatMessage: insert failed");
      return mapChatMessage(row);
    },

    getChatMessages(chatId: number): ChatMessageRecord[] {
      return stmtGetChatMessages.all(chatId).map(mapChatMessage);
    },

    // settings
    getSetting(key: string): string | null {
      const row = stmtGetSetting.get(key);
      return row ? row.value : null;
    },

    setSetting(key: string, value: string): void {
      stmtSetSetting.run(key, value);
    },

    close(): void {
      db.close();
    },
  };
}
