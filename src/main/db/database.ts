/**
 * better-sqlite3-backed implementation of DailiesDB.
 */
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { constants as fsConstants, copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { SCHEMA_SQL } from "./schema";
import { cachedBetterSqlite3Binding, repairBetterSqlite3Binding } from "./native-binding";
import { usesFullContentHash } from "../file-hash";
import { comparablePath, pathIsWithin } from "../path-compare";
import { reconcileEpisodeMembership } from "../membership";
import type {
  AnswerHit,
  ChatModelStamp,
  ChatScope,
  ChatMessageRecord,
  ChatSummary,
  DocumentHit,
  DocumentInput,
  DocumentRecord,
  EmbeddingKind,
  Episode,
  EpisodeListEntry,
  FileLocation,
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
  StructuredAgentAnswer,
  TranscriptHit,
  TranscriptSegment,
  WordTiming,
  MembershipSource,
} from "../../shared/types";
import { CHAT_EFFORT_LEVELS, normalizeClipKey, normalizeClipName } from "../../shared/types";
import { sourceTcAtOffset } from "../../shared/timecode";
import type {
  DailiesDB,
  FileLocationRegistration,
  FileLocationRemoval,
  PipelineFileFacts,
  SemanticSearchScope,
} from "./types";

const fileStatusWriters = new WeakMap<
  DailiesDB,
  (id: number, status: FileStatus) => void
>();

/** Status is derived by pipeline reconciliation. No other caller may write it. */
export function setFileStatusInternal(
  db: DailiesDB,
  id: number,
  status: FileStatus,
): void {
  const writeStatus = fileStatusWriters.get(db);
  if (!writeStatus) throw new Error("Unknown DailiesDB instance");
  writeStatus(id, status);
}

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
  has_video: number | null;
  proxy_path: string | null;
  role: string;
  clip_name: string | null;
  media_kind: string;
  member_paths: string | null;
  clip_key: string | null;
  video_unplayable: number;
  discovery_failed: number;
  discovery_error: string | null;
  source_project: string | null;
}

interface EpisodeRow {
  id: number;
  code: string;
  created_at: string;
  membership_source: string;
  media_tag: string | null;
  title: string | null;
}

interface FolderRow {
  id: number;
  path: string;
  role: string;
  episode_id: number | null;
  last_scanned_at: string | null;
}

interface FileLocationRow {
  id: number;
  file_id: number;
  path: string;
  filename: string;
  clip_name: string | null;
  role: string;
  folder_id: number | null;
  member_paths: string | null;
}

/**
 * The innermost watched folder containing `path`, or null. Longest root wins,
 * measured on the comparison key so a case- or separator-only difference in
 * the stored strings cannot change which folder is "deeper".
 */
function folderIdForPath(
  path: string,
  folders: Array<Pick<FolderRow, "id" | "path">>,
): number | null {
  let best: { id: number; depth: number } | null = null;
  for (const folder of folders) {
    if (!pathIsWithin(path, folder.path)) continue;
    const depth = comparablePath(folder.path).length;
    if (!best || depth > best.depth) best = { id: folder.id, depth };
  }
  return best?.id ?? null;
}

interface EpisodeListEntryRow {
  episode_id: number;
  ordinal: number;
  raw_name: string;
  clip_name: string;
  clip_key: string | null;
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
  episode_id: number | null;
  /** Model of the chat's most recent stamped answer; present only on list/get queries. */
  model_id?: string | null;
  model_effort?: string | null;
}

interface ChatMessageRow {
  id: number;
  chat_id: number;
  role: string;
  content: string;
  hits: string | null;
  model_id: string | null;
  model_effort: string | null;
  created_at: string;
}

interface StoredStructuredAnswerEnvelope {
  v: 2;
  answer: StructuredAgentAnswer;
}

interface TranscriptSearchRow {
  segment_id: number;
  file_id: number;
  filename: string;
  role: string;
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

interface PipelineFactsRow extends FileRow {
  job_id: number | null;
  job_stage: string | null;
  job_status: string | null;
  job_attempts: number | null;
  job_error: string | null;
  job_updated_at: string | null;
}

interface ConsolidationRow extends FileRow {
  derived_count: number;
}

// ---------- row -> domain mapping helpers ----------

type CanonicalFile = Omit<MediaFile, "locations">;

function mapFile(row: FileRow): CanonicalFile {
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
    hasVideo: row.has_video === null ? null : row.has_video === 1,
    proxyPath: row.proxy_path,
    role: row.role as MediaRole,
    clipName: row.clip_name,
    mediaKind: row.media_kind as MediaKind,
    memberPaths: row.member_paths ? (JSON.parse(row.member_paths) as string[]) : null,
    clipKey: row.clip_key,
    videoUnplayable: row.video_unplayable === 1,
    discoveryFailed: row.discovery_failed === 1,
    sourceProject: row.source_project,
  };
}

function mapMembershipSource(value: string): MembershipSource {
  if (value === "folder" || value === "list" || value === "media-tag") return value;
  throw new Error(`Invalid membership source: ${value}`);
}

function mapEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    code: row.code,
    createdAt: row.created_at,
    membershipSource: mapMembershipSource(row.membership_source),
    mediaTag: row.media_tag,
    title: row.title,
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

function parseMemberPaths(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) {
    throw new Error("Invalid member_paths JSON");
  }
  return parsed;
}

function mapFileLocation(row: FileLocationRow): FileLocation {
  return {
    id: row.id,
    fileId: row.file_id,
    path: row.path,
    filename: row.filename,
    clipName: row.clip_name,
    role: row.role === "final" ? "final" : "raw",
    folderId: row.folder_id,
    memberPaths: parseMemberPaths(row.member_paths),
  };
}

function mapEpisodeListEntry(row: EpisodeListEntryRow): EpisodeListEntry {
  return {
    ordinal: row.ordinal,
    rawName: row.raw_name,
    clipName: row.clip_name,
    clipKey: row.clip_key,
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

/** Rebuilds a model stamp from stored columns, dropping any effort the catalog no longer knows. */
function modelStampFrom(modelId: string | null | undefined, modelEffort: string | null | undefined): ChatModelStamp | undefined {
  if (!modelId) return undefined;
  const effort = CHAT_EFFORT_LEVELS.find((level) => level === modelEffort) ?? null;
  return { id: modelId, effort };
}

function mapChat(row: ChatRow): ChatSummary {
  const model = modelStampFrom(row.model_id, row.model_effort);
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    episodeId: row.episode_id,
    ...(model ? { model } : {}),
  };
}

function mapChatMessage(row: ChatMessageRow): ChatMessageRecord {
  let hits: AnswerHit[] | null = null;
  let answer: StructuredAgentAnswer | undefined;
  if (row.hits) {
    const parsed: unknown = JSON.parse(row.hits);
    if (Array.isArray(parsed)) {
      hits = parsed as AnswerHit[];
    } else if (
      typeof parsed === "object" &&
      parsed !== null &&
      "v" in parsed &&
      parsed.v === 2 &&
      "answer" in parsed
    ) {
      answer = parsed.answer as StructuredAgentAnswer;
    }
  }
  const model = modelStampFrom(row.model_id, row.model_effort);
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as "user" | "assistant",
    content: row.content,
    hits,
    ...(answer ? { answer } : {}),
    ...(model ? { model } : {}),
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

function remapStoredFileIds(value: unknown, replacements: ReadonlyMap<number, number>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => remapStoredFileIds(entry, replacements));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "fileId" && typeof entry === "number") {
        return [key, replacements.get(entry) ?? entry];
      }
      return [key, remapStoredFileIds(entry, replacements)];
    }),
  );
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

type FileSizeResult =
  | { kind: "known"; size: number }
  | { kind: "unavailable"; path: string; reason: string };

type StandardConsolidationDecision =
  | { kind: "merge" }
  | { kind: "keep-separate" }
  | { kind: "size-unavailable"; reason: string };

function fileSize(path: string): FileSizeResult {
  try {
    return { kind: "known", size: statSync(path).size };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      kind: "unavailable",
      path,
      reason: detail.replace(/\s+/g, " "),
    };
  }
}

function filenameStem(filename: string): string {
  return normalizeClipName(parsePath(filename).name);
}

function standardFilesCanConsolidate(
  left: Pick<FileRow, "path" | "filename" | "file_hash">,
  right: Pick<FileRow, "path" | "filename" | "file_hash">,
): StandardConsolidationDecision {
  if (left.file_hash !== right.file_hash) return { kind: "keep-separate" };
  const leftSize = fileSize(left.path);
  const rightSize = fileSize(right.path);
  if (leftSize.kind === "unavailable" || rightSize.kind === "unavailable") {
    const failures: string[] = [];
    if (leftSize.kind === "unavailable") {
      failures.push(`${leftSize.path}: ${leftSize.reason}`);
    }
    if (rightSize.kind === "unavailable") {
      failures.push(`${rightSize.path}: ${rightSize.reason}`);
    }
    return { kind: "size-unavailable", reason: failures.join("; ") };
  }
  if (leftSize.size !== rightSize.size || leftSize.size === 0) {
    return { kind: "keep-separate" };
  }
  if (usesFullContentHash(leftSize.size)) return { kind: "merge" };
  return filenameStem(left.filename) === filenameStem(right.filename)
    ? { kind: "merge" }
    : { kind: "keep-separate" };
}

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

const VISUAL_CLEANUP_MIGRATION_KEY = "migration_visual_cleanup_done";
const FOLDER_REPAIR_MIGRATION_KEY = "folderAssignmentRepairV1";
const PRE_V05_BACKUP_FILENAME = "dailies-pre-0.5.bak";
const PRE_FOLDER_REPAIR_BACKUP_SUFFIX = ".pre-folder-repair.bak";

function tableInfo(db: BetterSqlite3Database, table: string): TableInfoRow[] {
  const rows: unknown = db.pragma(`table_info(${table})`);
  if (!Array.isArray(rows)) throw new Error(`Could not read ${table} columns`);
  return rows.map((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("name" in row) ||
      typeof row.name !== "string"
    ) {
      throw new Error(`Invalid ${table} column metadata`);
    }
    return { name: row.name };
  });
}

function tableHasColumn(
  db: BetterSqlite3Database,
  table: string,
  column: string,
): boolean {
  return tableInfo(db, table).some(({ name }) => name === column);
}

function createFinalFileIndexes(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_file_hash ON files(file_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_files_clip_key
      ON files(clip_key)
      WHERE media_kind = 'opatom' AND clip_key IS NOT NULL;
  `);
}

/**
 * Flushes the WAL into the main database file so a plain file copy is a
 * complete snapshot. Throws when another connection holds the WAL open.
 */
function checkpointForBackup(db: BetterSqlite3Database, purpose: string): void {
  const checkpoint: unknown = db.pragma("wal_checkpoint(TRUNCATE)");
  if (
    !Array.isArray(checkpoint) ||
    checkpoint.length !== 1 ||
    typeof checkpoint[0] !== "object" ||
    checkpoint[0] === null ||
    !("busy" in checkpoint[0]) ||
    checkpoint[0].busy !== 0
  ) {
    throw new Error(`Could not checkpoint the database before creating the ${purpose} backup`);
  }
}

function copyPreV05Backup(db: BetterSqlite3Database, dbPath: string): void {
  checkpointForBackup(db, "v0.5");
  const backupPath = join(dirname(dbPath), PRE_V05_BACKUP_FILENAME);
  try {
    copyFileSync(dbPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return;
    }
    throw error;
  }
}

/** Adds any missing columns from `wantedColumns` to `table`, reading PRAGMA table_info. */
function addMissingColumns(
  db: BetterSqlite3Database,
  table: string,
  wantedColumns: Array<[string, string]>,
): void {
  const existingColumns = new Set(tableInfo(db, table).map((column) => column.name));
  for (const [name, ddl] of wantedColumns) {
    if (!existingColumns.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  }
}

/**
 * Widens the `episodes.membership_source` CHECK to admit 'media-tag'.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt the same way
 * `migrateLegacyFileScope` rebuilds `files`. The guard is structural, not a
 * settings key: a table whose DDL already names 'media-tag' is done, which
 * makes this exactly-once by construction and correct on a fresh database
 * (SCHEMA_SQL already writes the wide CHECK). Existing rows keep their source
 * and every foreign key into `episodes` survives, so behaviour is unchanged
 * until an episode is actually given a media tag.
 */
function widenEpisodeMembershipCheck(db: BetterSqlite3Database): void {
  const ddl = db
    .prepare<[string], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get("episodes")?.sql ?? "";
  if (ddl.includes("'media-tag'")) return;

  const before = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM episodes")
    .get()?.count ?? 0;

  const migration = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS episodes_v056;
      CREATE TABLE episodes_v056 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        membership_source TEXT NOT NULL DEFAULT 'folder'
          CHECK (membership_source IN ('folder', 'list', 'media-tag')),
        media_tag TEXT
      );
      INSERT INTO episodes_v056 (id, code, created_at, membership_source, media_tag)
      SELECT id, code, created_at, membership_source, media_tag FROM episodes;
      DROP TABLE episodes;
      ALTER TABLE episodes_v056 RENAME TO episodes;
    `);
    const after = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM episodes")
      .get()?.count ?? 0;
    if (after !== before) {
      throw new Error(
        `episodes rebuild aborted: ${before} episode(s) before, ${after} after`,
      );
    }
  });

  db.pragma("foreign_keys = OFF");
  try {
    migration();
  } finally {
    db.pragma("foreign_keys = ON");
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
 * One-time repair of `file_locations.folder_id`.
 *
 * Folder assignment was written three different ways over the app's life:
 * SQLite `LIKE` (ASCII case-insensitive), raw `startsWith`, and — in v0.5.4 —
 * a case-SENSITIVE JS comparison that ran over every row at every startup.
 * On macOS and Windows that last one cleared assignments that were correct,
 * which empties every episode-scoped view, and a wrong non-NULL id is worse
 * than NULL because `folderMembershipSource` only falls back to path
 * containment when the id is NULL.
 *
 * So this is corrective, not additive: every row is recomputed with the one
 * shared comparator and every stored value that disagrees is rewritten, in
 * both directions. It must run AFTER `migrateWatchedFoldersKv` — legacy
 * folders have to exist in `folders` before assignment means anything.
 *
 * Returns true only on the run that actually performed the repair; the caller
 * uses that to rebuild folder-sourced episode membership.
 */
function repairFolderAssignments(db: BetterSqlite3Database, dbPath: string): boolean {
  const alreadyDone = db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(FOLDER_REPAIR_MIGRATION_KEY);
  if (alreadyDone) return false;

  const folderRows = db
    .prepare<[], Pick<FolderRow, "id" | "path">>("SELECT id, path FROM folders")
    .all();
  const locationRows = db
    .prepare<[], Pick<FileLocationRow, "id" | "path" | "folder_id">>(
      "SELECT id, path, folder_id FROM file_locations",
    )
    .all();
  const corrections: Array<{ id: number; folderId: number | null }> = [];
  for (const location of locationRows) {
    const folderId = folderIdForPath(location.path, folderRows);
    if (folderId !== location.folder_id) corrections.push({ id: location.id, folderId });
  }

  if (corrections.length > 0) {
    // A fresh snapshot every attempt: a backup left behind by a run that
    // failed part-way is older than the state we are about to rewrite.
    checkpointForBackup(db, "folder repair");
    copyFileSync(dbPath, `${dbPath}${PRE_FOLDER_REPAIR_BACKUP_SUFFIX}`);
    const updateLocationFolder = db.prepare<[number | null, number]>(
      "UPDATE file_locations SET folder_id = ? WHERE id = ?",
    );
    db.transaction(() => {
      for (const correction of corrections) {
        updateLocationFolder.run(correction.folderId, correction.id);
      }
    })();
  }

  db.prepare<[string, string]>("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(FOLDER_REPAIR_MIGRATION_KEY, "1");
  const cleared = corrections.filter((correction) => correction.folderId === null).length;
  console.warn(
    `folder assignment repair: examined ${locationRows.length} location(s), ` +
      `corrected ${corrections.length}, cleared ${cleared}`,
  );
  return corrections.length > 0;
}

/**
 * Brings a database created by an earlier schema version up to date.
 * CREATE TABLE IF NOT EXISTS leaves existing tables untouched, so older databases
 * are missing columns added later; ALTER them in when absent. Idempotent.
 */
function migrate(db: BetterSqlite3Database, dbPath: string): boolean {
  addMissingColumns(db, "episodes", [
    [
      "membership_source",
      "TEXT NOT NULL DEFAULT 'folder' CHECK (membership_source IN ('folder', 'list', 'media-tag'))",
    ],
    ["media_tag", "TEXT"],
  ]);
  widenEpisodeMembershipCheck(db);
  // After the rebuild: widenEpisodeMembershipCheck recreates the table without
  // title, so adding it earlier would lose the column on pre-0.5.6 databases.
  addMissingColumns(db, "episodes", [["title", "TEXT"]]);
  addMissingColumns(db, "files", [
    ["role", "TEXT NOT NULL DEFAULT 'raw'"],
    ["clip_name", "TEXT"],
    ["media_kind", "TEXT NOT NULL DEFAULT 'standard'"],
    ["member_paths", "TEXT"],
    ["clip_key", "TEXT"],
    ["has_video", "INTEGER"],
    ["video_unplayable", "INTEGER NOT NULL DEFAULT 0"],
    ["discovery_failed", "INTEGER NOT NULL DEFAULT 0"],
    ["discovery_error", "TEXT"],
    ["source_project", "TEXT"],
  ]);
  addMissingColumns(db, "chats", [
    ["episode_id", "INTEGER REFERENCES episodes(id) ON DELETE SET NULL"],
  ]);
  addMissingColumns(db, "documents", [
    ["episode_id", "INTEGER REFERENCES episodes(id) ON DELETE SET NULL"],
  ]);
  addMissingColumns(db, "chat_messages", [
    ["model_id", "TEXT"],
    ["model_effort", "TEXT"],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_members (
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      PRIMARY KEY (episode_id, file_id)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_members_file_id
      ON episode_members(file_id);
    CREATE TABLE IF NOT EXISTS episode_list_entries (
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      raw_name TEXT NOT NULL,
      clip_name TEXT NOT NULL,
      clip_key TEXT,
      PRIMARY KEY (episode_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS file_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      clip_name TEXT,
      role TEXT NOT NULL DEFAULT 'raw' CHECK (role IN ('raw', 'final')),
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      member_paths TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_file_locations_file_id
      ON file_locations(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_locations_folder_id
      ON file_locations(folder_id);
  `);
  db.exec(`
    INSERT OR IGNORE INTO file_locations (
      file_id, path, filename, clip_name, role, folder_id, member_paths
    )
    SELECT
      files.id,
      files.path,
      files.filename,
      files.clip_name,
      files.role,
      NULL,
      files.member_paths
    FROM files;
  `);
  if (!tableHasColumn(db, "files", "episode_id")) createFinalFileIndexes(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_episode_id ON documents(episode_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chats_episode_id ON chats(episode_id)");
  const visualCleanupDone = db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(VISUAL_CLEANUP_MIGRATION_KEY);
  if (!visualCleanupDone) {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS visual_fts;
        DROP TABLE IF EXISTS visual_annotations;
        DELETE FROM embeddings WHERE kind = 'scene';
        DELETE FROM jobs WHERE stage = 'visual_index';
      `);
      db.prepare<[string, string]>("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run(VISUAL_CLEANUP_MIGRATION_KEY, "1");
    })();
  }
  migrateWatchedFoldersKv(db);
  return repairFolderAssignments(db, dbPath);
}

function migrateLegacyFileScope(
  db: BetterSqlite3Database,
  consolidateDuplicateFiles: () => number,
): void {
  if (!tableHasColumn(db, "files", "episode_id")) return;

  const migration = db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO episode_members (episode_id, file_id)
      SELECT legacy.episode_id, legacy.id
      FROM files AS legacy
      JOIN episodes ON episodes.id = legacy.episode_id
      WHERE legacy.episode_id IS NOT NULL;
    `);
    const missing = db.prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM files AS legacy
       WHERE legacy.episode_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM episode_members
           WHERE episode_members.episode_id = legacy.episode_id
             AND episode_members.file_id = legacy.id
         )`,
    ).get()?.count ?? 0;
    if (missing > 0) {
      throw new Error(
        `v0.5 migration aborted: ${missing} legacy file episode assignment(s) were not backfilled`,
      );
    }

    consolidateDuplicateFiles();
    db.exec(`
      DROP TABLE IF EXISTS files_v05;
      CREATE TABLE files_v05 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        duration_s REAL NOT NULL,
        fps REAL NOT NULL,
        drop_frame INTEGER NOT NULL,
        start_tc TEXT NOT NULL,
        codec TEXT NOT NULL,
        audio_channels INTEGER NOT NULL,
        file_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        added_at TEXT NOT NULL,
        has_transcript INTEGER NOT NULL DEFAULT 0,
        proxy_path TEXT,
        role TEXT NOT NULL DEFAULT 'raw',
        clip_name TEXT,
        media_kind TEXT NOT NULL DEFAULT 'standard',
        member_paths TEXT,
        clip_key TEXT,
        has_video INTEGER,
        video_unplayable INTEGER NOT NULL DEFAULT 0,
        discovery_failed INTEGER NOT NULL DEFAULT 0,
        discovery_error TEXT,
        source_project TEXT
      );
      INSERT INTO files_v05 (
        id, path, filename, duration_s, fps, drop_frame, start_tc, codec,
        audio_channels, file_hash, status, added_at, has_transcript, proxy_path,
        role, clip_name, media_kind, member_paths, clip_key, has_video,
        video_unplayable, discovery_failed, discovery_error, source_project
      )
      SELECT
        id, path, filename, duration_s, fps, drop_frame, start_tc, codec,
        audio_channels, file_hash, status, added_at, has_transcript, proxy_path,
        role, clip_name, media_kind, member_paths, clip_key, has_video,
        video_unplayable, discovery_failed, discovery_error, source_project
      FROM files;
      DROP TABLE files;
      ALTER TABLE files_v05 RENAME TO files;
    `);
    createFinalFileIndexes(db);

    const violations: unknown = db.pragma("foreign_key_check");
    if (!Array.isArray(violations)) {
      throw new Error("v0.5 migration aborted: foreign key check returned invalid data");
    }
    const first = violations[0];
    if (first !== undefined) {
      if (
        typeof first !== "object" ||
        first === null ||
        !("table" in first) ||
        typeof first.table !== "string" ||
        !("rowid" in first) ||
        (typeof first.rowid !== "number" && first.rowid !== null) ||
        !("parent" in first) ||
        typeof first.parent !== "string"
      ) {
        throw new Error("v0.5 migration aborted: foreign key check returned invalid data");
      }
      throw new Error(
        `v0.5 migration aborted: foreign key check failed for ${first.table} row ${first.rowid ?? "unknown"} referencing ${first.parent}`,
      );
    }
  });

  db.pragma("foreign_keys = OFF");
  try {
    migration();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function fileScopePredicate(fileIdExpression: string): string {
  return `EXISTS (
    SELECT 1
    FROM episode_members
    WHERE episode_members.file_id = ${fileIdExpression}
      AND episode_members.episode_id = ?
  )`;
}

// ---------- database implementation ----------

export function openDatabase(dbPath: string): DailiesDB {
  const databaseExisted = existsSync(dbPath);
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
  if (databaseExisted) copyPreV05Backup(db, dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const folderAssignmentsRepaired = migrate(db, dbPath);

  // ---------- prepared statements ----------

  const stmtGetFileById = db.prepare<[number], FileRow>("SELECT * FROM files WHERE id = ?");
  const stmtGetFileByPath = db.prepare<[string], FileRow>("SELECT * FROM files WHERE path = ?");
  const stmtGetFileByHash = db.prepare<[string], FileRow>(
    "SELECT * FROM files WHERE file_hash = ? LIMIT 1",
  );
  const stmtGetFilesByHash = db.prepare<[string], FileRow>(
    "SELECT * FROM files WHERE file_hash = ? ORDER BY id ASC",
  );
  const stmtGetFileByClipKey = db.prepare<[string], FileRow>(
    "SELECT * FROM files WHERE clip_key = ?",
  );
  const stmtGetFileByNormalizedClipKey = db.prepare<[string], FileRow>(
    "SELECT * FROM files WHERE lower(trim(clip_key)) = ? ORDER BY id ASC LIMIT 1",
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
      string | null,
    ],
    FileRow
  >(
    `INSERT INTO files (
       path, filename, duration_s, fps, drop_frame, start_tc, codec, audio_channels, file_hash,
       status, added_at, role, clip_name, media_kind, member_paths, clip_key, has_video,
       source_project
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
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
      string | null,
      number,
    ],
    FileRow
  >(
    `UPDATE files SET path = ?, filename = ?, duration_s = ?, fps = ?, drop_frame = ?, start_tc = ?, codec = ?, audio_channels = ?, file_hash = ?,
       role = ?, clip_name = ?, media_kind = ?, member_paths = ?, clip_key = ?, has_video = ?,
       source_project = ?, discovery_failed = 0, discovery_error = NULL
     WHERE id = ?
     RETURNING *`,
  );
  const stmtRepointFilePath = db.prepare<[string, string, number], FileRow>(
    "UPDATE files SET path = ?, filename = ? WHERE id = ? RETURNING *",
  );
  const stmtListFiles = db.prepare<[], FileRow>("SELECT * FROM files ORDER BY added_at DESC");
  const stmtDeleteFile = db.prepare<[number]>("DELETE FROM files WHERE id = ?");
  const stmtListFilesByEpisode = db.prepare<[number], FileRow>(
    `SELECT * FROM files
     WHERE ${fileScopePredicate("files.id")}
     ORDER BY added_at DESC`,
  );
  const stmtSetFileStatus = db.prepare<[string, number]>("UPDATE files SET status = ? WHERE id = ?");
  const stmtSetFileHasVideo = db.prepare<[number | null, number]>(
    "UPDATE files SET has_video = ? WHERE id = ?",
  );
  const stmtSetDiscoveryFailed = db.prepare<[number, number, number]>(
    `UPDATE files
     SET discovery_failed = ?, discovery_error = CASE WHEN ? = 0 THEN NULL ELSE discovery_error END
     WHERE id = ?`,
  );
  const stmtSetDiscoveryFailure = db.prepare<[number, string | null, number]>(
    "UPDATE files SET discovery_failed = ?, discovery_error = ? WHERE id = ?",
  );
  const stmtBackfillDiscoveryFailures = db.prepare(
    `UPDATE files SET discovery_failed = 1
     WHERE discovery_failed = 0
       AND status = 'error'
       AND duration_s = 0
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.file_id = files.id)`,
  );
  const stmtSetFileSourceProject = db.prepare<[string | null, number]>(
    "UPDATE files SET source_project = ? WHERE id = ?",
  );
  // Backfill candidates: MXF clips with no tag that were never looked at.
  // OP-Atom rows carry the logical clip filename, which need not end in .mxf;
  // standard MXF rows retain the physical .mxf filename.
  // A finished 'media-tag' job is the "already read, genuinely untagged"
  // record, so a second detection run does not re-probe the same media.
  const stmtListFilesMissingSourceProject = db.prepare<[], FileRow>(
    `SELECT * FROM files
     WHERE (media_kind = 'opatom' OR lower(filename) LIKE '%.mxf')
       AND source_project IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE jobs.file_id = files.id AND jobs.stage = 'media-tag' AND jobs.status = 'done'
       )
     ORDER BY id ASC`,
  );
  const stmtTallySourceProjects = db.prepare<[], { source_project: string; count: number }>(
    `SELECT source_project, COUNT(*) AS count
     FROM files
     WHERE source_project IS NOT NULL
     GROUP BY source_project
     ORDER BY source_project ASC`,
  );
  const stmtCountUntaggedFiles = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM files WHERE source_project IS NULL",
  );
  const stmtListFileIdsBySourceProject = db.prepare<[string], { id: number }>(
    "SELECT id FROM files WHERE source_project = ? ORDER BY id ASC",
  );
  const stmtSetFileProxy = db.prepare<[string, number]>("UPDATE files SET proxy_path = ? WHERE id = ?");
  const stmtClearFileProxy = db.prepare<[number]>("UPDATE files SET proxy_path = NULL WHERE id = ?");
  const stmtSetVideoUnplayable = db.prepare<[number, number]>(
    "UPDATE files SET video_unplayable = ? WHERE id = ?",
  );
  const stmtClearDerivedFileState = db.prepare<[number]>(
    `UPDATE files SET has_transcript = 0, proxy_path = NULL,
       video_unplayable = 0 WHERE id = ?`,
  );
  const stmtMarkTranscribed = db.prepare<[number]>("UPDATE files SET has_transcript = 1 WHERE id = ?");
  const stmtGetLocationByPath = db.prepare<[string], FileLocationRow>(
    "SELECT * FROM file_locations WHERE path = ?",
  );
  const stmtGetLocationById = db.prepare<[number], FileLocationRow>(
    "SELECT * FROM file_locations WHERE id = ?",
  );
  const stmtListLocationsByFile = db.prepare<[number], FileLocationRow>(
    "SELECT * FROM file_locations WHERE file_id = ? ORDER BY id ASC",
  );
  const stmtDeleteLocation = db.prepare<[number]>(
    "DELETE FROM file_locations WHERE id = ?",
  );
  const stmtUpdateOpAtomLocation = db.prepare<
    [string, string, string | null, string, string | null, number],
    FileLocationRow
  >(
    `UPDATE file_locations
     SET path = ?, filename = ?, clip_name = ?, role = ?, member_paths = ?
     WHERE id = ?
     RETURNING *`,
  );
  const stmtUpdateCanonicalFromLocation = db.prepare<
    [string, string, string | null, string | null, string, number],
    FileRow
  >(
    `UPDATE files
     SET path = ?, filename = ?, clip_name = ?, member_paths = ?, role = ?
     WHERE id = ?
     RETURNING *`,
  );
  const stmtSetCanonicalRole = db.prepare<[string, number], FileRow>(
    "UPDATE files SET role = ? WHERE id = ? RETURNING *",
  );
  const stmtFileIsInEpisode = db.prepare<[number, number], { found: number }>(
    `SELECT 1 AS found
     WHERE ${fileScopePredicate("?")}`,
  );

  function mapStoredFile(row: FileRow): MediaFile {
    return {
      ...mapFile(row),
      locations: stmtListLocationsByFile.all(row.id).map(mapFileLocation),
    };
  }
  const stmtUpsertCompatibilityLocation = db.prepare<
    [number, string, string, string | null, string, number | null, string | null]
  >(
    `INSERT INTO file_locations (
       file_id, path, filename, clip_name, role, folder_id, member_paths
     )
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       file_id = excluded.file_id,
       filename = excluded.filename,
       clip_name = excluded.clip_name,
       role = excluded.role,
       folder_id = excluded.folder_id,
       member_paths = excluded.member_paths`,
  );
  // ---------- episodes ----------

  const stmtInsertEpisode = db.prepare<[string, string], EpisodeRow>(
    "INSERT INTO episodes (code, created_at) VALUES (?, ?) RETURNING *",
  );
  const stmtGetEpisodeByCode = db.prepare<[string], EpisodeRow>(
    "SELECT * FROM episodes WHERE code = ?",
  );
  const stmtListEpisodes = db.prepare<[], EpisodeRow>("SELECT * FROM episodes ORDER BY code ASC");
  const stmtGetEpisodeById = db.prepare<[number], EpisodeRow>(
    "SELECT * FROM episodes WHERE id = ?",
  );
  const stmtSetEpisodeMembershipSource = db.prepare<[string, number]>(
    "UPDATE episodes SET membership_source = ? WHERE id = ?",
  );
  const stmtSetEpisodeMediaTag = db.prepare<[string | null, number]>(
    "UPDATE episodes SET media_tag = ? WHERE id = ?",
  );
  const stmtSetEpisodeTitle = db.prepare<[string | null, number]>(
    "UPDATE episodes SET title = ? WHERE id = ?",
  );
  const stmtCountEpisodeMembers = db.prepare<[], { episode_id: number; clip_count: number }>(
    `SELECT episode_id, COUNT(*) AS clip_count
     FROM episode_members
     GROUP BY episode_id`,
  );
  const stmtCountAllFiles = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM files",
  );
  const stmtListEpisodeEntries = db.prepare<[number], EpisodeListEntryRow>(
    `SELECT episode_id, ordinal, raw_name, clip_name, clip_key
     FROM episode_list_entries
     WHERE episode_id = ?
     ORDER BY ordinal ASC`,
  );
  const stmtDeleteEpisodeEntries = db.prepare<[number]>(
    "DELETE FROM episode_list_entries WHERE episode_id = ?",
  );
  const stmtInsertEpisodeEntry = db.prepare<
    [number, number, string, string, string | null]
  >(
    `INSERT INTO episode_list_entries (
       episode_id, ordinal, raw_name, clip_name, clip_key
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  const stmtListEpisodeMemberIds = db.prepare<[number], { file_id: number }>(
    `SELECT file_id FROM episode_members
     WHERE episode_id = ?
     ORDER BY file_id ASC`,
  );
  const stmtDeleteEpisodeMembers = db.prepare<[number]>(
    "DELETE FROM episode_members WHERE episode_id = ?",
  );
  const stmtInsertEpisodeMember = db.prepare<[number, number]>(
    "INSERT OR IGNORE INTO episode_members (episode_id, file_id) VALUES (?, ?)",
  );

  // ---------- folders ----------

  const stmtInsertFolder = db.prepare<[string, string, number | null], FolderRow>(
    `INSERT OR IGNORE INTO folders (path, role, episode_id, last_scanned_at)
     VALUES (?, ?, ?, NULL)`,
  );
  const stmtGetFolderByPath = db.prepare<[string], FolderRow>(
    "SELECT * FROM folders WHERE path = ?",
  );
  const stmtListFolders = db.prepare<[], FolderRow>("SELECT * FROM folders ORDER BY path ASC");

  function storedFolderIdForPath(path: string): number | null {
    return folderIdForPath(path, stmtListFolders.all());
  }
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
  const stmtDeleteWordsForFile = db.prepare<[number]>(
    `DELETE FROM words
     WHERE segment_id IN (SELECT id FROM transcript_segments WHERE file_id = ?)`,
  );
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
  const stmtCountDocuments = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM documents",
  );
  const stmtCountDocumentsByEpisode = db.prepare<[number], { count: number }>(
    "SELECT COUNT(*) AS count FROM documents WHERE episode_id = ?",
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
  const stmtDeleteAllEmbeddings = db.prepare("DELETE FROM embeddings");

  const stmtEnqueueJob = db.prepare<[{ fileId: number; stage: string; now: string }]>(
    `INSERT INTO jobs (file_id, stage, status, attempts, updated_at)
     SELECT @fileId, @stage, 'queued', 0, @now
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs
       WHERE file_id = @fileId AND stage = @stage AND status IN ('queued', 'running', 'waiting')
     )`,
  );
  // Search-first claim order: the cheap stages that end in a searchable
  // transcript (probe → audio → transcribe → embed) always outrank the heavy
  // playback stages (proxy → scenes); FIFO by id within a stage. The
  // excluding-stage variant lets the queue skip past transcribe jobs while
  // the transcribe concurrency cap is full instead of idling every slot.
  const claimOrderSql = `ORDER BY CASE stage
       WHEN 'probe' THEN 0
       WHEN 'audio' THEN 1
       WHEN 'transcribe' THEN 2
       WHEN 'embed' THEN 3
       WHEN 'proxy' THEN 4
       ELSE 5
     END, id ASC LIMIT 1`;
  const stmtClaimNextJobId = db.prepare<[], { id: number }>(
    `SELECT id FROM jobs WHERE status = 'queued' ${claimOrderSql}`,
  );
  const stmtClaimNextJobIdExcludingStage = db.prepare<[string], { id: number }>(
    `SELECT id FROM jobs WHERE status = 'queued' AND stage <> ? ${claimOrderSql}`,
  );
  const stmtHasActiveJob = db.prepare<[number, string], { count: number }>(
    `SELECT COUNT(*) AS count FROM jobs
     WHERE file_id = ? AND stage = ? AND status IN ('queued', 'running', 'waiting')`,
  );
  const stmtCountActiveJobsForStage = db.prepare<[string], { count: number }>(
    `SELECT COUNT(*) AS count FROM jobs
     WHERE stage = ? AND status IN ('queued', 'running', 'waiting')`,
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
  const stmtReleaseClaimedJob = db.prepare<[string, number]>(
    "UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'running'",
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
  const stmtListJobsForFile = db.prepare<[number], JobRow>(
    `SELECT jobs.id, jobs.file_id, files.filename, jobs.stage, jobs.status, jobs.attempts, jobs.error, jobs.updated_at
     FROM jobs JOIN files ON files.id = jobs.file_id
     WHERE jobs.file_id = ?
     ORDER BY jobs.id DESC`,
  );
  const stmtListPipelineFacts = db.prepare<[], PipelineFactsRow>(
    `SELECT
       files.*,
       jobs.id AS job_id,
       jobs.stage AS job_stage,
       jobs.status AS job_status,
       jobs.attempts AS job_attempts,
       jobs.error AS job_error,
       jobs.updated_at AS job_updated_at
     FROM files
     LEFT JOIN jobs ON jobs.file_id = files.id
       AND NOT EXISTS (
         SELECT 1 FROM jobs AS newer
         WHERE newer.file_id = jobs.file_id
           AND newer.stage = jobs.stage
           AND newer.id > jobs.id
       )
     ORDER BY files.id ASC, jobs.stage ASC`,
  );
  const stmtListPipelineFactsByEpisode = db.prepare<[number], PipelineFactsRow>(
    `SELECT
       files.*,
       jobs.id AS job_id,
       jobs.stage AS job_stage,
       jobs.status AS job_status,
       jobs.attempts AS job_attempts,
       jobs.error AS job_error,
       jobs.updated_at AS job_updated_at
     FROM files
     LEFT JOIN jobs ON jobs.file_id = files.id
       AND NOT EXISTS (
         SELECT 1 FROM jobs AS newer
         WHERE newer.file_id = jobs.file_id
           AND newer.stage = jobs.stage
           AND newer.id > jobs.id
       )
     WHERE ${fileScopePredicate("files.id")}
     ORDER BY files.id ASC, jobs.stage ASC`,
  );

  // Each chat row carries its most recent stamped model, so the rail can label a
  // whole conversation by the model that last answered in it.
  const chatWithModel = `
    SELECT
      chats.*,
      (SELECT model_id FROM chat_messages WHERE chat_id = chats.id AND model_id IS NOT NULL ORDER BY id DESC LIMIT 1) AS model_id,
      (SELECT model_effort FROM chat_messages WHERE chat_id = chats.id AND model_id IS NOT NULL ORDER BY id DESC LIMIT 1) AS model_effort
    FROM chats`;

  const stmtInsertChat = db.prepare<[string, string, number | null], ChatRow>(
    "INSERT INTO chats (title, created_at, episode_id) VALUES (?, ?, ?) RETURNING *",
  );
  const stmtGetChat = db.prepare<[number], ChatRow>(`${chatWithModel} WHERE chats.id = ?`);
  const stmtListChats = db.prepare<[], ChatRow>(`${chatWithModel} ORDER BY chats.created_at DESC`);
  const stmtListChatsByEpisode = db.prepare<[number], ChatRow>(
    `${chatWithModel} WHERE chats.episode_id = ? ORDER BY chats.created_at DESC`,
  );
  const stmtListChatsWithoutEpisode = db.prepare<[], ChatRow>(
    `${chatWithModel} WHERE chats.episode_id IS NULL ORDER BY chats.created_at DESC`,
  );
  const stmtInsertChatMessage = db.prepare<
    [number, string, string, string | null, string | null, string | null, string],
    ChatMessageRow
  >(
    `INSERT INTO chat_messages (chat_id, role, content, hits, model_id, model_effort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtGetChatMessages = db.prepare<[number], ChatMessageRow>(
    "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id ASC",
  );
  const stmtListStoredChatHits = db.prepare<[], { id: number; hits: string }>(
    "SELECT id, hits FROM chat_messages WHERE hits IS NOT NULL",
  );
  const stmtUpdateStoredChatHits = db.prepare<[string, number]>(
    "UPDATE chat_messages SET hits = ? WHERE id = ?",
  );

  const stmtGetSetting = db.prepare<[string], { value: string }>(
    "SELECT value FROM settings WHERE key = ?",
  );
  const stmtSetSetting = db.prepare<[string, string]>(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  function buildSearchTranscriptsStmt(episodeId?: number) {
    const clauses: string[] = ["transcript_fts MATCH ?"];
    if (episodeId !== undefined) clauses.push(fileScopePredicate("files.id"));
    const sql = `SELECT
        transcript_fts.segment_id AS segment_id,
        transcript_fts.file_id AS file_id,
        files.filename AS filename,
        files.role AS role,
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
  const stmtNormalizeClipKeys = db.prepare(
    `UPDATE files
     SET clip_key = NULLIF(lower(trim(clip_key)), '')
     WHERE clip_key IS NOT NULL`,
  );
  const stmtListFilesForConsolidation = db.prepare<[], ConsolidationRow>(
    `SELECT
       files.*,
       (
         (SELECT COUNT(*) FROM scenes WHERE scenes.file_id = files.id) +
         (SELECT COUNT(*) FROM transcript_segments WHERE transcript_segments.file_id = files.id) +
         (
           SELECT COUNT(*)
           FROM words
           JOIN transcript_segments ON transcript_segments.id = words.segment_id
           WHERE transcript_segments.file_id = files.id
         ) +
         (
           SELECT COUNT(*)
           FROM embeddings
           JOIN transcript_segments ON transcript_segments.id = embeddings.ref_id
           WHERE embeddings.kind = 'segment'
             AND transcript_segments.file_id = files.id
         ) +
         (SELECT COUNT(*) FROM jobs WHERE jobs.file_id = files.id)
       ) AS derived_count
     FROM files
     ORDER BY files.id ASC`,
  );
  const stmtMoveMemberships = db.prepare<[number, number]>(
    `INSERT OR IGNORE INTO episode_members (episode_id, file_id)
     SELECT episode_id, ?
     FROM episode_members
     WHERE file_id = ?`,
  );
  const stmtDeleteMembershipsByFile = db.prepare<[number]>(
    "DELETE FROM episode_members WHERE file_id = ?",
  );
  const stmtMoveLocations = db.prepare<[number, number]>(
    "UPDATE file_locations SET file_id = ? WHERE file_id = ?",
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

  function listPipelineFileFacts(scope?: SemanticSearchScope): PipelineFileFacts[] {
    const rows = scope?.episodeId === null || scope === undefined
      ? stmtListPipelineFacts.all()
      : stmtListPipelineFactsByEpisode.all(scope.episodeId);
    const factsByFile = new Map<number, PipelineFileFacts>();

    for (const row of rows) {
      let facts = factsByFile.get(row.id);
      if (!facts) {
        facts = {
          file: mapStoredFile(row),
          latestJobsByStage: new Map(),
          discoveryError: row.discovery_error,
        };
        factsByFile.set(row.id, facts);
      }
      if (
        row.job_id !== null &&
        row.job_stage !== null &&
        row.job_status !== null &&
        row.job_attempts !== null &&
        row.job_updated_at !== null
      ) {
        const job = mapJob({
          id: row.job_id,
          file_id: row.id,
          filename: row.filename,
          stage: row.job_stage,
          status: row.job_status,
          attempts: row.job_attempts,
          error: row.job_error,
          updated_at: row.job_updated_at,
        } satisfies JobRow);
        facts.latestJobsByStage.set(job.stage, job);
      }
    }

    return [...factsByFile.values()];
  }

  function buildSemanticSearchStmt(kind: EmbeddingKind, scope?: SemanticSearchScope) {
    const joins = kind === "segment"
      ? "JOIN transcript_segments ON transcript_segments.id = embeddings.ref_id JOIN files ON files.id = transcript_segments.file_id"
      : "JOIN doc_chunks ON doc_chunks.id = embeddings.ref_id JOIN documents ON documents.id = doc_chunks.doc_id";
    const clauses = ["embeddings.kind = ?"];
    if (scope?.episodeId !== null && scope !== undefined) {
      clauses.push(
        kind === "segment"
          ? fileScopePredicate("files.id")
          : "documents.episode_id = ?",
      );
    }
    return db.prepare<unknown[], EmbeddingRow>(
      `SELECT embeddings.kind, embeddings.ref_id, embeddings.vector
       FROM embeddings
       ${joins}
       WHERE ${clauses.join(" AND ")}`,
    );
  }

  const claimNextJobTx = db.transaction((excludeStage?: JobStage): Job | null => {
    const next = excludeStage
      ? stmtClaimNextJobIdExcludingStage.get(excludeStage)
      : stmtClaimNextJobId.get();
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

  function clearDerivedState(fileId: number): void {
    stmtDeleteSegmentEmbeddingsForFile.run(fileId);
    stmtDeleteWordsForFile.run(fileId);
    stmtDeleteTranscriptFts.run(fileId);
    stmtDeleteSegments.run(fileId);
    stmtDeleteScenes.run(fileId);
    stmtDeleteJobsForFile.run(fileId);
    stmtClearDerivedFileState.run(fileId);
  }
  const clearDerivedStateTx = db.transaction(clearDerivedState);

  function updateExistingFile(existing: FileRow, input: FileInput): CanonicalFile {
    if (input.path !== existing.path) {
      const squatter = stmtGetFileByPath.get(input.path);
      if (squatter && squatter.id !== existing.id) {
        // A different row already claims this path — a stale registration
        // (e.g. an atom once mis-ingested as standalone media, or a
        // pre-membership row without a location). A path holds exactly one
        // file on disk, so the live claim wins: absorb the stale row instead
        // of failing the whole update with a UNIQUE constraint error.
        clearDerivedStateTx(squatter.id);
        stmtDeleteFile.run(squatter.id);
      }
    }
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
      input.hasVideo === undefined ? existing.has_video : input.hasVideo ? 1 : 0,
      input.sourceProject === undefined ? existing.source_project : input.sourceProject,
      existing.id,
    );
    if (!updated) throw new Error(`updateFile: file ${existing.id} not found`);
    return mapFile(updated);
  }

  const upsertFileTx = db.transaction((input: FileInput): CanonicalFile => {
    const role = input.role ?? "raw";
    const mediaKind = input.mediaKind ?? "standard";
    const clipName = input.clipName ?? null;
    const memberPaths = input.memberPaths ? JSON.stringify(input.memberPaths) : null;
    const clipKey = input.clipKey ?? null;
    const existing = (clipKey ? stmtGetFileByClipKey.get(clipKey) : undefined) ??
      stmtGetFileByPath.get(input.path);

    if (existing) {
      if (existing.file_hash !== input.fileHash) {
        // Clear every searchable/derived representation before exposing the
        // new hash. This transaction prevents stale transcript, proxy, and
        // embedding state from masquerading as current content.
        clearDerivedStateTx(existing.id);
      }
      const updated = updateExistingFile(existing, input);
      stmtUpsertCompatibilityLocation.run(
        updated.id,
        input.path,
        input.filename,
        clipName,
        role,
        storedFolderIdForPath(input.path),
        memberPaths,
      );
      return updated;
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
      input.hasVideo === undefined ? null : input.hasVideo ? 1 : 0,
      input.sourceProject ?? null,
    );
    if (!row) throw new Error("upsertFile: insert failed");
    stmtUpsertCompatibilityLocation.run(
      row.id,
      input.path,
      input.filename,
      clipName,
      role,
      storedFolderIdForPath(input.path),
      memberPaths,
    );
    return mapFile(row);
  });

  const deleteFilesUnderPathTx = db.transaction((pathPrefix: string): MediaFile[] => {
    const rows = stmtListFiles.all().filter((row) => pathIsWithin(row.path, pathPrefix));
    const files = rows.map(mapStoredFile);
    for (const row of rows) {
      clearDerivedStateTx(row.id);
      stmtDeleteFile.run(row.id);
    }
    return files;
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

  const replaceEpisodeListEntriesTx = db.transaction((
    episodeId: number,
    entries: EpisodeListEntry[],
  ): void => {
    stmtDeleteEpisodeEntries.run(episodeId);
    for (const entry of entries) {
      stmtInsertEpisodeEntry.run(
        episodeId,
        entry.ordinal,
        entry.rawName,
        entry.clipName,
        entry.clipKey,
      );
    }
  });

  const replaceEpisodeMembersTx = db.transaction((
    episodeId: number,
    fileIds: number[],
  ): void => {
    stmtDeleteEpisodeMembers.run(episodeId);
    for (const fileId of new Set(fileIds)) {
      stmtInsertEpisodeMember.run(episodeId, fileId);
    }
  });

  const setEpisodeMembershipSourceAndMembersTx = db.transaction((
    episodeId: number,
    source: MembershipSource,
    fileIds: number[],
  ): void => {
    const result = stmtSetEpisodeMembershipSource.run(source, episodeId);
    if (result.changes === 0) throw new Error(`Episode ${episodeId} not found`);
    replaceEpisodeMembersTx(episodeId, fileIds);
  });

  const replaceEpisodeListMembershipTx = db.transaction((
    episodeId: number,
    entries: EpisodeListEntry[],
    fileIds: number[],
  ): void => {
    replaceEpisodeListEntriesTx(episodeId, entries);
    setEpisodeMembershipSourceAndMembersTx(episodeId, "list", fileIds);
  });

  function storedLocationForPath(path: string): FileLocation {
    const location = stmtGetLocationByPath.get(path);
    if (!location) throw new Error(`File location not found: ${path}`);
    return mapFileLocation(location);
  }

  function recomputeCanonicalRole(fileId: number): MediaFile {
    const locations = stmtListLocationsByFile.all(fileId);
    const role = locations.some((location) => location.role === "final") ? "final" : "raw";
    const row = stmtSetCanonicalRole.get(role, fileId);
    if (!row) throw new Error(`File ${fileId} not found`);
    return mapStoredFile(row);
  }

  const promoteFileLocationTx = db.transaction((
    fileId: number,
    locationId: number,
  ): MediaFile => {
    const location = stmtGetLocationById.get(locationId);
    if (!location || location.file_id !== fileId) {
      throw new Error(`Location ${locationId} does not belong to file ${fileId}`);
    }
    const locations = stmtListLocationsByFile.all(fileId);
    const role = locations.some((candidate) => candidate.role === "final") ? "final" : "raw";
    const row = stmtUpdateCanonicalFromLocation.get(
      location.path,
      location.filename,
      location.clip_name,
      location.member_paths,
      role,
      fileId,
    );
    if (!row) throw new Error(`File ${fileId} not found`);
    return mapStoredFile(row);
  });

  const registerFileLocationTx = db.transaction((
    input: FileInput,
  ): FileLocationRegistration => {
    const normalizedClipKey = input.clipKey ? normalizeClipKey(input.clipKey) : null;
    const normalizedInput: FileInput = {
      ...input,
      clipKey: normalizedClipKey || null,
    };
    let existingLocation = stmtGetLocationByPath.get(input.path);
    if (existingLocation && normalizedInput.mediaKind === "opatom" && normalizedInput.clipKey) {
      const clipOwner = stmtGetFileByNormalizedClipKey.get(normalizedInput.clipKey);
      if (clipOwner && clipOwner.id !== existingLocation.file_id) {
        // The clip key (UMID) is the identity of OP-Atom media; a different
        // row occupying this path is a stale registration (e.g. an atom once
        // mis-ingested as standalone media). Detach it from the path — which
        // deletes the row when this was its last location — so the clip can
        // claim the path instead of failing with a UNIQUE constraint error.
        removeFileLocationTx(input.path);
        existingLocation = stmtGetLocationByPath.get(input.path);
      }
    }
    if (existingLocation) {
      const existingFile = stmtGetFileById.get(existingLocation.file_id);
      if (!existingFile) throw new Error(`File ${existingLocation.file_id} not found`);
      const file = updateExistingFile(existingFile, normalizedInput);
      stmtUpsertCompatibilityLocation.run(
        file.id,
        input.path,
        input.filename,
        input.clipName ?? null,
        input.role ?? "raw",
        storedFolderIdForPath(input.path),
        input.memberPaths ? JSON.stringify(input.memberPaths) : null,
      );
      return {
        file: recomputeCanonicalRole(file.id),
        location: storedLocationForPath(input.path),
        canonicalFileCreated: false,
      };
    }

    let canonical: FileRow | undefined;
    if (normalizedInput.mediaKind === "opatom" && normalizedInput.clipKey) {
      canonical = stmtGetFileByNormalizedClipKey.get(normalizedInput.clipKey);
    } else if (normalizedInput.mediaKind !== "opatom") {
      const inputIdentity = {
        path: normalizedInput.path,
        filename: normalizedInput.filename,
        file_hash: normalizedInput.fileHash,
      };
      canonical = stmtGetFilesByHash
        .all(normalizedInput.fileHash)
        .find((candidate) =>
          standardFilesCanConsolidate(candidate, inputIdentity).kind === "merge"
        );
    }

    if (!canonical) {
      const file = upsertFileTx(normalizedInput);
      return {
        file: recomputeCanonicalRole(file.id),
        location: storedLocationForPath(input.path),
        canonicalFileCreated: true,
      };
    }

    stmtUpsertCompatibilityLocation.run(
      canonical.id,
      input.path,
      input.filename,
      input.clipName ?? null,
      input.role ?? "raw",
      storedFolderIdForPath(input.path),
      input.memberPaths ? JSON.stringify(input.memberPaths) : null,
    );
    return {
      file: recomputeCanonicalRole(canonical.id),
      location: storedLocationForPath(input.path),
      canonicalFileCreated: false,
    };
  });

  const updateOpAtomMembersTx = db.transaction((
    fileId: number,
    input: FileInput,
  ): MediaFile => {
    const existing = stmtGetFileById.get(fileId);
    if (!existing) throw new Error(`updateOpAtomMembers: file ${fileId} not found`);
    if (!input.memberPaths || input.memberPaths.length === 0) {
      throw new Error("updateOpAtomMembers: member paths are required");
    }

    const inputMembers = new Set(input.memberPaths);
    const matchingLocations = stmtListLocationsByFile.all(fileId).filter((location) => {
      const storedMembers = parseMemberPaths(location.member_paths);
      if (storedMembers === null || storedMembers.length === 0) return false;
      const storedMemberSet = new Set(storedMembers);
      return storedMembers.every((path) => inputMembers.has(path)) ||
        input.memberPaths?.every((path) => storedMemberSet.has(path)) === true;
    });
    if (matchingLocations.length !== 1) {
      throw new Error(
        `updateOpAtomMembers: expected one matching location, found ${matchingLocations.length}`,
      );
    }

    const location = matchingLocations[0];
    if (!location) throw new Error("updateOpAtomMembers: matching location not found");

    // The path move below runs under UNIQUE(file_locations.path). When a
    // stale row already holds the target path — an unreadable stub, or an
    // atom once registered on its own — the plain UPDATE threw on every
    // scan and the clip could never re-register. A path holds exactly one
    // file on disk, so absorb the stale claim the way registerFileLocation
    // does instead of failing forever.
    const pathOwner = stmtGetLocationByPath.get(input.path);
    if (pathOwner && pathOwner.id !== location.id) {
      const ownerFile = stmtGetFileById.get(pathOwner.file_id);
      const ownerMembers = parseMemberPaths(pathOwner.member_paths) ?? [];
      const stale = ownerFile?.file_hash.startsWith("unreadable:") === true ||
        ownerMembers.length === 0 ||
        ownerMembers.every((path) => inputMembers.has(path));
      if (!stale) {
        throw new Error(
          `updateOpAtomMembers: ${input.path} is held by file ${pathOwner.file_id} ` +
            `with unrelated members`,
        );
      }
      removeFileLocationTx(input.path);
    }

    const canonical = stmtGetFileById.get(fileId);
    if (!canonical) throw new Error(`updateOpAtomMembers: file ${fileId} not found`);

    const updatedLocation = stmtUpdateOpAtomLocation.get(
      input.path,
      input.filename,
      input.clipName ?? null,
      input.role ?? "raw",
      JSON.stringify(input.memberPaths),
      location.id,
    );
    if (!updatedLocation) {
      throw new Error(`updateOpAtomMembers: location ${location.id} not found`);
    }

    updateExistingFile(canonical, input);
    return recomputeCanonicalRole(fileId);
  });

  const removeFileLocationTx = db.transaction((path: string): FileLocationRemoval | null => {
    const locationRow = stmtGetLocationByPath.get(path);
    if (!locationRow) return null;
    const fileRow = stmtGetFileById.get(locationRow.file_id);
    if (!fileRow) return null;
    const removed = mapFileLocation(locationRow);
    const deletedFile: MediaFile = {
      ...mapFile(fileRow),
      locations: stmtListLocationsByFile.all(fileRow.id).map(mapFileLocation),
    };
    stmtDeleteLocation.run(locationRow.id);
    const remaining = stmtListLocationsByFile.all(locationRow.file_id);
    if (remaining.length === 0) {
      clearDerivedStateTx(locationRow.file_id);
      stmtDeleteFile.run(locationRow.file_id);
      return { kind: "deleted", file: deletedFile, removed };
    }
    if (fileRow.path === path) {
      return {
        kind: "promoted",
        file: promoteFileLocationTx(locationRow.file_id, remaining[0].id),
        removed,
      };
    }
    return {
      kind: "retained",
      file: recomputeCanonicalRole(locationRow.file_id),
      removed,
    };
  });

  function consolidateDuplicateFiles(logUnavailableSizes = false): number {
    stmtNormalizeClipKeys.run();
    const rows = stmtListFilesForConsolidation.all();
    const opAtomGroups = new Map<string, ConsolidationRow[]>();
    const standardGroups: ConsolidationRow[][] = [];
    let unavailableSizePairCount = 0;
    for (const row of rows) {
      if (row.media_kind === "opatom" && row.clip_key) {
        const key = normalizeClipKey(row.clip_key);
        const group = opAtomGroups.get(key) ?? [];
        group.push(row);
        opAtomGroups.set(key, group);
        continue;
      }
      if (row.media_kind === "opatom") continue;
      const group = standardGroups.find((candidate) => {
        const decision = standardFilesCanConsolidate(candidate[0], row);
        if (decision.kind === "size-unavailable" && logUnavailableSizes) {
          unavailableSizePairCount += 1;
          console.warn(
            `[db] v0.5 migration skipped standard consolidation pair ${candidate[0].path} <> ${row.path}: ${decision.reason}`,
          );
        }
        return decision.kind === "merge";
      });
      if (group) group.push(row);
      else standardGroups.push([row]);
    }
    if (unavailableSizePairCount > 0 && logUnavailableSizes) {
      const pairLabel = unavailableSizePairCount === 1 ? "pair" : "pairs";
      console.warn(
        `[db] v0.5 migration skipped ${unavailableSizePairCount} standard consolidation ${pairLabel} because file size was unavailable`,
      );
    }

    const replacements = new Map<number, number>();
    const groups = [...opAtomGroups.values(), ...standardGroups];
    for (const group of groups) {
      if (group.length < 2) continue;
      group.sort((left, right) =>
        Number(right.has_transcript === 1) - Number(left.has_transcript === 1) ||
        right.derived_count - left.derived_count ||
        left.id - right.id
      );
      const survivor = group[0];
      for (const loser of group.slice(1)) {
        stmtMoveMemberships.run(survivor.id, loser.id);
        stmtDeleteMembershipsByFile.run(loser.id);
        stmtMoveLocations.run(survivor.id, loser.id);
        replacements.set(loser.id, survivor.id);
        clearDerivedState(loser.id);
        stmtDeleteFile.run(loser.id);
      }
      recomputeCanonicalRole(survivor.id);
    }

    if (replacements.size > 0) {
      for (const row of stmtListStoredChatHits.all()) {
        const parsed: unknown = JSON.parse(row.hits);
        stmtUpdateStoredChatHits.run(
          JSON.stringify(remapStoredFileIds(parsed, replacements)),
          row.id,
        );
      }
    }
    return replacements.size;
  }
  const consolidateDuplicateFilesTx = db.transaction(() => consolidateDuplicateFiles());
  try {
    migrateLegacyFileScope(db, () => consolidateDuplicateFiles(true));
  } catch (error) {
    db.close();
    throw error;
  }

  // ---------- DailiesDB implementation ----------

  const api: DailiesDB = {
    runInTransaction<T>(operation: () => T): T {
      return db.transaction(operation)();
    },

    // files
    upsertFile(input: FileInput): MediaFile {
      const file = upsertFileTx(input);
      const row = stmtGetFileById.get(file.id);
      if (!row) throw new Error(`File ${file.id} not found`);
      return mapStoredFile(row);
    },

    getFile(id: number): MediaFile | null {
      const row = stmtGetFileById.get(id);
      return row ? mapStoredFile(row) : null;
    },

    getFileByPath(path: string): MediaFile | null {
      const row = stmtGetFileByPath.get(path);
      return row ? mapStoredFile(row) : null;
    },

    getFileByHash(hash: string): MediaFile | null {
      const row = stmtGetFileByHash.get(hash);
      return row ? mapStoredFile(row) : null;
    },

    repointFilePath(fileId: number, newPath: string, newFilename: string): MediaFile {
      const row = stmtRepointFilePath.get(newPath, newFilename, fileId);
      if (!row) throw new Error(`repointFilePath: file ${fileId} not found`);
      return mapStoredFile(row);
    },

    getFileByClipKey(clipKey: string): MediaFile | null {
      const row = stmtGetFileByNormalizedClipKey.get(normalizeClipKey(clipKey));
      return row ? mapStoredFile(row) : null;
    },

    registerFileLocation(input: FileInput): FileLocationRegistration {
      return registerFileLocationTx(input);
    },

    listFileLocations(fileId: number): FileLocation[] {
      return stmtListLocationsByFile.all(fileId).map(mapFileLocation);
    },

    promoteFileLocation(fileId: number, locationId: number): MediaFile {
      return promoteFileLocationTx(fileId, locationId);
    },

    removeFileLocation(path: string): FileLocationRemoval | null {
      return removeFileLocationTx(path);
    },

    consolidateDuplicateFiles(): number {
      return consolidateDuplicateFilesTx();
    },

    fileIsInScope(fileId: number, scope: SemanticSearchScope): boolean {
      if (scope.episodeId === null) return stmtGetFileById.get(fileId) !== undefined;
      return stmtFileIsInEpisode.get(fileId, scope.episodeId) !== undefined;
    },

    updateOpAtomMembers(fileId: number, input: FileInput): MediaFile {
      return updateOpAtomMembersTx(fileId, input);
    },

    deleteFilesUnderPath(pathPrefix: string): MediaFile[] {
      return deleteFilesUnderPathTx(pathPrefix);
    },

    listFiles(episodeId?: number): MediaFile[] {
      if (episodeId === undefined) return stmtListFiles.all().map(mapStoredFile);
      return stmtListFilesByEpisode.all(episodeId).map(mapStoredFile);
    },

    setFileHasVideo(id: number, hasVideo: boolean | null): void {
      stmtSetFileHasVideo.run(hasVideo === null ? null : hasVideo ? 1 : 0, id);
    },

    setFileSourceProject(id: number, sourceProject: string | null): void {
      stmtSetFileSourceProject.run(sourceProject, id);
    },

    listFilesMissingSourceProject(): MediaFile[] {
      return stmtListFilesMissingSourceProject.all().map(mapStoredFile);
    },

    tallySourceProjects(): Array<{ sourceProject: string; clipCount: number }> {
      return stmtTallySourceProjects.all().map((row) => ({
        sourceProject: row.source_project,
        clipCount: row.count,
      }));
    },

    countFilesWithoutSourceProject(): number {
      return stmtCountUntaggedFiles.get()?.count ?? 0;
    },

    listFileIdsBySourceProject(sourceProject: string): number[] {
      return stmtListFileIdsBySourceProject.all(sourceProject).map((row) => row.id);
    },

    setDiscoveryFailed(id: number, failed: boolean): void {
      stmtSetDiscoveryFailed.run(failed ? 1 : 0, failed ? 1 : 0, id);
    },

    setDiscoveryFailure(id: number, reason: string | null): void {
      stmtSetDiscoveryFailure.run(reason === null ? 0 : 1, reason, id);
    },

    backfillDiscoveryFailures(): number {
      return stmtBackfillDiscoveryFailures.run().changes;
    },

    setFileProxy(id: number, proxyPath: string): void {
      stmtSetFileProxy.run(proxyPath, id);
    },

    clearFileProxy(id: number): void {
      stmtClearFileProxy.run(id);
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

    getEpisodeMembershipSource(episodeId: number): MembershipSource {
      const row = stmtGetEpisodeById.get(episodeId);
      if (!row) throw new Error(`Episode ${episodeId} not found`);
      return mapMembershipSource(row.membership_source);
    },

    setEpisodeMembershipSource(episodeId: number, source: MembershipSource): void {
      const result = stmtSetEpisodeMembershipSource.run(source, episodeId);
      if (result.changes === 0) throw new Error(`Episode ${episodeId} not found`);
    },

    getEpisodeMediaTag(episodeId: number): string | null {
      const row = stmtGetEpisodeById.get(episodeId);
      if (!row) throw new Error(`Episode ${episodeId} not found`);
      return row.media_tag;
    },

    setEpisodeMediaTag(episodeId: number, mediaTag: string | null): void {
      const result = stmtSetEpisodeMediaTag.run(mediaTag, episodeId);
      if (result.changes === 0) throw new Error(`Episode ${episodeId} not found`);
    },

    renameEpisode(episodeId: number, title: string | null): Episode {
      const trimmed = title?.trim() ?? "";
      const result = stmtSetEpisodeTitle.run(trimmed === "" ? null : trimmed, episodeId);
      if (result.changes === 0) throw new Error(`Episode ${episodeId} not found`);
      const row = stmtGetEpisodeById.get(episodeId);
      if (!row) throw new Error(`Episode ${episodeId} not found`);
      return mapEpisode(row);
    },

    tallyEpisodeClipCounts(): { totalFiles: number; rows: Array<{ episodeId: number; clipCount: number }> } {
      return {
        totalFiles: stmtCountAllFiles.get()?.count ?? 0,
        rows: stmtCountEpisodeMembers.all().map((row) => ({
          episodeId: row.episode_id,
          clipCount: row.clip_count,
        })),
      };
    },

    getEpisodeListEntries(episodeId: number): EpisodeListEntry[] {
      return stmtListEpisodeEntries.all(episodeId).map(mapEpisodeListEntry);
    },

    replaceEpisodeListEntries(episodeId: number, entries: EpisodeListEntry[]): void {
      replaceEpisodeListEntriesTx(episodeId, entries);
    },

    getEpisodeMemberIds(episodeId: number): number[] {
      return stmtListEpisodeMemberIds.all(episodeId).map((row) => row.file_id);
    },

    replaceEpisodeMembers(episodeId: number, fileIds: number[]): void {
      replaceEpisodeMembersTx(episodeId, fileIds);
    },

    setEpisodeMembershipSourceAndMembers(
      episodeId: number,
      source: MembershipSource,
      fileIds: number[],
    ): void {
      setEpisodeMembershipSourceAndMembersTx(episodeId, source, fileIds);
    },

    replaceEpisodeListMembership(
      episodeId: number,
      entries: EpisodeListEntry[],
      fileIds: number[],
    ): void {
      replaceEpisodeListMembershipTx(episodeId, entries, fileIds);
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
      const startedAt = Date.now();
      replaceTranscriptTx(fileId, segments);
      const wordCount = segments.reduce((count, segment) => count + segment.words.length, 0);
      console.warn("[db] transcript replacement", {
        fileId,
        segmentCount: segments.length,
        wordCount,
        durationMs: Date.now() - startedAt,
      });
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

    countDocuments(scope: SemanticSearchScope): number {
      if (scope.episodeId === null) return stmtCountDocuments.get()?.count ?? 0;
      return stmtCountDocumentsByEpisode.get(scope.episodeId)?.count ?? 0;
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
      scope?: SemanticSearchScope,
    ): Array<{ refId: number; score: number }> {
      const startedAt = Date.now();
      const stmt = buildSemanticSearchStmt(kind, scope);
      const params: unknown[] = [kind];
      if (scope?.episodeId !== null && scope !== undefined) params.push(scope.episodeId);
      const rows = stmt.all(...params);
      const scored = rows.map((row) => {
        const vector = new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
        return { refId: row.ref_id, similarity: cosineSimilarity(query, vector) };
      });
      scored.sort((a, b) => b.similarity - a.similarity);
      const results = scored
        .filter((row) => row.similarity >= SEMANTIC_RELEVANCE_FLOOR)
        .slice(0, limit)
        .map((row) => ({ refId: row.refId, score: row.similarity }));
      console.warn("[db] semantic search", {
        kind,
        vectorCount: rows.length,
        resultCount: results.length,
        durationMs: Date.now() - startedAt,
      });
      return results;
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

    countActiveJobsForStage(stage: JobStage): number {
      return stmtCountActiveJobsForStage.get(stage)?.count ?? 0;
    },

    claimNextJob(excludeStage?: JobStage): Job | null {
      return claimNextJobTx(excludeStage);
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

    releaseClaimedJob(jobId: number): void {
      stmtReleaseClaimedJob.run(new Date().toISOString(), jobId);
    },

    resetRunningJobs(): void {
      stmtResetRunningJobs.run(new Date().toISOString());
    },

    requeueSystemicFailures(): number {
      // "No member path … yielded audio" is the pre-0.5.1 audio stage
      // masking spawn failures behind a per-clip message — reopen those too
      // so the corrected classification gets a chance to run.
      return db.prepare(
        `UPDATE jobs
         SET status = 'queued', attempts = 0, error = NULL, updated_at = ?
         WHERE status = 'error'
           AND (error LIKE '%EBADF%'
             OR error LIKE '%EMFILE%'
             OR error LIKE '%ENFILE%'
             OR error LIKE '%No member path of opatom clip%')`,
      ).run(new Date().toISOString()).changes;
    },

    listJobs(limit = 100): Job[] {
      return stmtListJobs.all(limit).map(mapJob);
    },

    listJobsForFile(fileId: number): Job[] {
      return stmtListJobsForFile.all(fileId).map(mapJob);
    },

    listPipelineFileFacts(scope?: SemanticSearchScope): PipelineFileFacts[] {
      return listPipelineFileFacts(scope);
    },

    // chats
    createChat(title: string, scope?: ChatScope): ChatSummary {
      const row = stmtInsertChat.get(title, new Date().toISOString(), scope?.episodeId ?? null);
      if (!row) throw new Error("createChat: insert failed");
      return mapChat(row);
    },

    getChat(chatId: number): ChatSummary | null {
      const row = stmtGetChat.get(chatId);
      return row ? mapChat(row) : null;
    },

    listChats(scope?: ChatScope): ChatSummary[] {
      if (scope === undefined) return stmtListChats.all().map(mapChat);
      if (scope.episodeId === null) return stmtListChatsWithoutEpisode.all().map(mapChat);
      return stmtListChatsByEpisode.all(scope.episodeId).map(mapChat);
    },

    addChatMessage(
      chatId: number,
      role: "user" | "assistant",
      content: string,
      answer?: AnswerHit[] | StructuredAgentAnswer | null,
      model?: ChatModelStamp | null,
    ): ChatMessageRecord {
      const storedPayload: AnswerHit[] | StoredStructuredAnswerEnvelope | null =
        answer === null || answer === undefined
          ? null
          : Array.isArray(answer)
            ? answer
            : { v: 2, answer };
      const row = stmtInsertChatMessage.get(
        chatId,
        role,
        content,
        storedPayload ? JSON.stringify(storedPayload) : null,
        model?.id ?? null,
        model?.effort ?? null,
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
  fileStatusWriters.set(api, (id, status) => {
    stmtSetFileStatus.run(status, id);
  });
  // Stored `episode_members` rows for folder-sourced episodes were derived
  // from the folder ids the repair just rewrote, so they are stale until
  // rebuilt. Deferred to here because reconciliation needs the finished
  // DailiesDB surface, the same reason `migrateLegacyFileScope` runs late.
  if (folderAssignmentsRepaired) {
    for (const episode of api.listEpisodes()) {
      if (episode.membershipSource !== "folder") continue;
      reconcileEpisodeMembership(api, episode.id);
    }
  }
  return api;
}
