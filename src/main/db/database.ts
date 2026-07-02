/**
 * better-sqlite3-backed implementation of DailiesDB.
 */
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";
import type {
  AnswerHit,
  ChatMessageRecord,
  ChatSummary,
  FileInput,
  FileStatus,
  Job,
  JobStage,
  JobStatus,
  MediaFile,
  Scene,
  SceneInput,
  SegmentInput,
  TranscriptHit,
  TranscriptSegment,
  VisualAnnotation,
  VisualAnnotationInput,
  VisualHit,
  VisualSearchFilters,
  WordTiming,
} from "../../shared/types";
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
  has_visual_index: number;
  proxy_path: string | null;
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

interface AnnotationRow {
  id: number;
  scene_id: number;
  file_id: number;
  description: string;
  objects: string;
  shot_type: string | null;
  time_of_day: string | null;
  people_count: number | null;
  actions: string;
  model: string;
  indexed_at: string;
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
  fps: number;
  drop_frame: number;
  start_tc: string;
  start_s: number;
  end_s: number;
  text: string;
  rank: number;
}

interface VisualSearchRow {
  ann_id: number;
  scene_id: number;
  file_id: number;
  filename: string;
  fps: number;
  drop_frame: number;
  start_tc: string;
  scene_start_s: number;
  scene_end_s: number;
  description: string;
  objects: string;
  shot_type: string | null;
  keyframe_path: string | null;
  rank: number;
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
    hasVisualIndex: row.has_visual_index === 1,
    proxyPath: row.proxy_path,
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

function mapAnnotation(row: AnnotationRow): VisualAnnotation {
  return {
    id: row.id,
    sceneId: row.scene_id,
    fileId: row.file_id,
    description: row.description,
    objects: JSON.parse(row.objects) as string[],
    shotType: row.shot_type,
    timeOfDay: row.time_of_day,
    peopleCount: row.people_count,
    actions: JSON.parse(row.actions) as string[],
    model: row.model,
    indexedAt: row.indexed_at,
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

// ---------- timecode helpers ----------

/**
 * Parses "HH:MM:SS:FF" into a total frame count using plain (non-drop) arithmetic.
 */
function tcToFrames(tc: string, nominalFps: number): number {
  const cleaned = tc.trim().replace(";", ":");
  const parts = cleaned.split(":").map((p) => parseInt(p, 10) || 0);
  const [hh, mm, ss, ff] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
  return (hh * 3600 + mm * 60 + ss) * nominalFps + ff;
}

/**
 * Standard SMPTE drop-frame timecode -> absolute (drop-frame) frame count.
 * Drops 2 frame labels/minute (29.97) or 4 (59.94), except every 10th minute.
 */
function standardDropFrameToFrames(
  hh: number,
  mm: number,
  ss: number,
  ff: number,
  nominalFps: number,
): number {
  const dropFramesPerMinute = nominalFps === 60 ? 4 : 2;
  const totalMinutes = hh * 60 + mm;
  const droppedMinutes = totalMinutes - Math.floor(totalMinutes / 10);
  return (
    nominalFps * 3600 * hh + nominalFps * 60 * mm + nominalFps * ss + ff - dropFramesPerMinute * droppedMinutes
  );
}

/** Standard SMPTE drop-frame frame count -> HH:MM:SS;FF (inverse of standardDropFrameToFrames). */
function framesToDropFrameTc(totalFrames: number, nominalFps: number): string {
  const dropFramesPerMinute = nominalFps === 60 ? 4 : 2;
  const minutesPerDay = 24 * 60;
  const framesPer24Hours =
    nominalFps * 3600 * 24 - dropFramesPerMinute * (minutesPerDay - Math.floor(minutesPerDay / 10));
  const frameNumber = ((totalFrames % framesPer24Hours) + framesPer24Hours) % framesPer24Hours;

  // standardDropFrameToFrames(hh, mm, 0, 0, fps) is monotonically increasing in
  // totalMinutes, so binary search for the containing minute.
  let lo = 0;
  let hi = minutesPerDay;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const framesAtStartOfMinute = standardDropFrameToFrames(
      Math.floor(mid / 60),
      mid % 60,
      0,
      0,
      nominalFps,
    );
    if (framesAtStartOfMinute <= frameNumber) lo = mid + 1;
    else hi = mid;
  }
  const totalMinutes = lo - 1;
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  const framesAtStartOfMinute = standardDropFrameToFrames(hh, mm, 0, 0, nominalFps);
  const remainder = frameNumber - framesAtStartOfMinute;
  const ss = Math.floor(remainder / nominalFps);
  const ff = remainder % nominalFps;

  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)};${pad(ff)}`;
}

function framesToNonDropTc(totalFrames: number, nominalFps: number): string {
  const safeFrames = ((totalFrames % (nominalFps * 3600 * 24)) + nominalFps * 3600 * 24) % (nominalFps * 3600 * 24);
  const ff = safeFrames % nominalFps;
  const totalSeconds = Math.floor(safeFrames / nominalFps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60) % 24;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * Computes a timecode string `offsetS` seconds after `fileStartTc`, at the
 * given fps/dropFrame. Self-contained SMPTE drop-frame handling for
 * 29.97 and 59.94 fps (drop 2 / 4 frames per minute, except every 10th minute).
 */
function secondsToTc(
  fileStartTc: string,
  fps: number,
  dropFrame: boolean,
  offsetS: number,
): string {
  const nominalFps = Math.round(fps);
  const offsetFrames = Math.round(offsetS * fps);

  if (dropFrame && (nominalFps === 30 || nominalFps === 60)) {
    const cleaned = fileStartTc.trim();
    const lastSepIndex = Math.max(cleaned.lastIndexOf(":"), cleaned.lastIndexOf(";"));
    const head = cleaned.slice(0, lastSepIndex);
    const ff = parseInt(cleaned.slice(lastSepIndex + 1), 10) || 0;
    const headParts = head.split(":").map((p) => parseInt(p, 10) || 0);
    const [hh, mm, ss] = [headParts[0] ?? 0, headParts[1] ?? 0, headParts[2] ?? 0];
    const startFrames = standardDropFrameToFrames(hh, mm, ss, ff, nominalFps);
    return framesToDropFrameTc(startFrames + offsetFrames, nominalFps);
  }

  const startFrames = tcToFrames(fileStartTc, nominalFps);
  return framesToNonDropTc(startFrames + offsetFrames, nominalFps);
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

// ---------- database implementation ----------

export function openDatabase(dbPath: string): DailiesDB {
  const db: BetterSqlite3Database = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // ---------- prepared statements ----------

  const stmtGetFileById = db.prepare<[number], FileRow>("SELECT * FROM files WHERE id = ?");
  const stmtGetFileByPath = db.prepare<[string], FileRow>("SELECT * FROM files WHERE path = ?");
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
    ],
    FileRow
  >(
    `INSERT INTO files (path, filename, duration_s, fps, drop_frame, start_tc, codec, audio_channels, file_hash, status, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     RETURNING *`,
  );
  const stmtUpdateFile = db.prepare<
    [string, number, number, number, string, string, number, string, number],
    FileRow
  >(
    `UPDATE files SET filename = ?, duration_s = ?, fps = ?, drop_frame = ?, start_tc = ?, codec = ?, audio_channels = ?, file_hash = ?
     WHERE id = ?
     RETURNING *`,
  );
  const stmtListFiles = db.prepare<[], FileRow>("SELECT * FROM files ORDER BY added_at DESC");
  const stmtSetFileStatus = db.prepare<[string, number]>("UPDATE files SET status = ? WHERE id = ?");
  const stmtSetFileProxy = db.prepare<[string, number]>("UPDATE files SET proxy_path = ? WHERE id = ?");
  const stmtMarkTranscribed = db.prepare<[number]>("UPDATE files SET has_transcript = 1 WHERE id = ?");
  const stmtMarkVisuallyIndexed = db.prepare<[number]>("UPDATE files SET has_visual_index = 1 WHERE id = ?");

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

  const stmtDeleteAnnotationsForScene = db.prepare<[number]>(
    "DELETE FROM visual_annotations WHERE scene_id = ?",
  );
  const stmtDeleteVisualFtsForScene = db.prepare<[number]>("DELETE FROM visual_fts WHERE scene_id = ?");
  const stmtInsertAnnotation = db.prepare<
    [number, number, string, string, string | null, string | null, number | null, string, string, string],
    AnnotationRow
  >(
    `INSERT INTO visual_annotations
       (scene_id, file_id, description, objects, shot_type, time_of_day, people_count, actions, model, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const stmtInsertVisualFts = db.prepare<[string, number, number]>(
    "INSERT INTO visual_fts (content, file_id, scene_id) VALUES (?, ?, ?)",
  );
  const stmtListAnnotations = db.prepare<[number], AnnotationRow>(
    "SELECT * FROM visual_annotations WHERE file_id = ? ORDER BY id ASC",
  );

  const stmtEnqueueJob = db.prepare<[number, string, string]>(
    "INSERT INTO jobs (file_id, stage, status, attempts, updated_at) VALUES (?, ?, 'queued', 0, ?)",
  );
  const stmtClaimNextJobId = db.prepare<[], { id: number }>(
    "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1",
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
    "UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?",
  );
  const stmtFailJob = db.prepare<[string, string, number]>(
    "UPDATE jobs SET status = 'error', error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
  );
  const stmtResetRunningJobs = db.prepare<[string]>(
    "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
  );
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

  const stmtSearchTranscripts = db.prepare<[string, number], TranscriptSearchRow>(
    `SELECT
       transcript_fts.segment_id AS segment_id,
       transcript_fts.file_id AS file_id,
       files.filename AS filename,
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
     WHERE transcript_fts MATCH ?
     ORDER BY rank ASC
     LIMIT ?`,
  );

  function buildVisualSearchStmt(filters?: VisualSearchFilters) {
    const clauses: string[] = ["visual_fts MATCH ?"];
    if (filters?.shotType) clauses.push("visual_annotations.shot_type = ?");
    if (filters?.timeOfDay) clauses.push("visual_annotations.time_of_day = ?");
    const sql = `SELECT
        visual_annotations.id AS ann_id,
        visual_fts.scene_id AS scene_id,
        visual_fts.file_id AS file_id,
        files.filename AS filename,
        files.fps AS fps,
        files.drop_frame AS drop_frame,
        files.start_tc AS start_tc,
        scenes.start_s AS scene_start_s,
        scenes.end_s AS scene_end_s,
        visual_annotations.description AS description,
        visual_annotations.objects AS objects,
        visual_annotations.shot_type AS shot_type,
        scenes.keyframe_path AS keyframe_path,
        bm25(visual_fts) AS rank
      FROM visual_fts
      JOIN visual_annotations ON visual_annotations.scene_id = visual_fts.scene_id
      JOIN scenes ON scenes.id = visual_fts.scene_id
      JOIN files ON files.id = visual_fts.file_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?`;
    return db.prepare<unknown[], VisualSearchRow>(sql);
  }

  // ---------- transactional helpers ----------

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

  const upsertAnnotationTx = db.transaction((sceneId: number, ann: VisualAnnotationInput): void => {
    const scene = stmtGetScene.get(sceneId);
    if (!scene) throw new Error(`upsertAnnotation: scene ${sceneId} not found`);
    stmtDeleteAnnotationsForScene.run(sceneId);
    stmtDeleteVisualFtsForScene.run(sceneId);
    const objectsJson = JSON.stringify(ann.objects);
    const actionsJson = JSON.stringify(ann.actions ?? []);
    stmtInsertAnnotation.get(
      sceneId,
      scene.file_id,
      ann.description,
      objectsJson,
      ann.shotType ?? null,
      ann.timeOfDay ?? null,
      ann.peopleCount ?? null,
      actionsJson,
      ann.model,
      new Date().toISOString(),
    );
    const ftsContent = `${ann.description} ${ann.objects.join(" ")}`;
    stmtInsertVisualFts.run(ftsContent, scene.file_id, sceneId);
  });

  const claimNextJobTx = db.transaction((): Job | null => {
    const next = stmtClaimNextJobId.get();
    if (!next) return null;
    const claimed = stmtClaimJob.get(new Date().toISOString(), next.id);
    if (!claimed) return null;
    const withFilename = stmtGetJobWithFilename.get(claimed.id);
    return withFilename ? mapJob(withFilename) : null;
  });

  // ---------- DailiesDB implementation ----------

  return {
    // files
    upsertFile(input: FileInput): MediaFile {
      const existing = stmtGetFileByPath.get(input.path);
      if (existing) {
        const updated = stmtUpdateFile.get(
          input.filename,
          input.durationS,
          input.fps,
          input.dropFrame ? 1 : 0,
          input.startTc,
          input.codec,
          input.audioChannels,
          input.fileHash,
          existing.id,
        );
        return mapFile(updated ?? existing);
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
      );
      if (!row) throw new Error("upsertFile: insert failed");
      return mapFile(row);
    },

    getFile(id: number): MediaFile | null {
      const row = stmtGetFileById.get(id);
      return row ? mapFile(row) : null;
    },

    getFileByPath(path: string): MediaFile | null {
      const row = stmtGetFileByPath.get(path);
      return row ? mapFile(row) : null;
    },

    listFiles(): MediaFile[] {
      return stmtListFiles.all().map(mapFile);
    },

    setFileStatus(id: number, status: FileStatus): void {
      stmtSetFileStatus.run(status, id);
    },

    setFileProxy(id: number, proxyPath: string): void {
      stmtSetFileProxy.run(proxyPath, id);
    },

    markTranscribed(id: number): void {
      stmtMarkTranscribed.run(id);
    },

    markVisuallyIndexed(id: number): void {
      stmtMarkVisuallyIndexed.run(id);
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

    // visual annotations
    upsertAnnotation(sceneId: number, ann: VisualAnnotationInput): void {
      upsertAnnotationTx(sceneId, ann);
    },

    listAnnotations(fileId: number): VisualAnnotation[] {
      return stmtListAnnotations.all(fileId).map(mapAnnotation);
    },

    // search
    searchTranscripts(terms: string[], limit = 40): TranscriptHit[] {
      const query = buildFtsQuery(terms);
      if (!query) return [];
      const rows = stmtSearchTranscripts.all(query, limit);
      const scores = normalizeScores(rows);
      return rows.map((row, i) => ({
        fileId: row.file_id,
        filename: row.filename,
        segmentId: row.segment_id,
        startS: row.start_s,
        endS: row.end_s,
        startTc: secondsToTc(row.start_tc, row.fps, row.drop_frame === 1, row.start_s),
        endTc: secondsToTc(row.start_tc, row.fps, row.drop_frame === 1, row.end_s),
        text: row.text,
        score: scores[i] ?? 0,
      }));
    },

    searchVisuals(terms: string[], filters?: VisualSearchFilters, limit = 40): VisualHit[] {
      const query = buildFtsQuery(terms);
      if (!query) return [];
      const stmt = buildVisualSearchStmt(filters);
      const params: unknown[] = [query];
      if (filters?.shotType) params.push(filters.shotType);
      if (filters?.timeOfDay) params.push(filters.timeOfDay);
      params.push(limit);
      const rows = stmt.all(...params);
      const scores = normalizeScores(rows);
      return rows.map((row, i) => ({
        fileId: row.file_id,
        filename: row.filename,
        sceneId: row.scene_id,
        startS: row.scene_start_s,
        endS: row.scene_end_s,
        startTc: secondsToTc(row.start_tc, row.fps, row.drop_frame === 1, row.scene_start_s),
        endTc: secondsToTc(row.start_tc, row.fps, row.drop_frame === 1, row.scene_end_s),
        description: row.description,
        objects: JSON.parse(row.objects) as string[],
        shotType: row.shot_type,
        keyframePath: row.keyframe_path,
        score: scores[i] ?? 0,
      }));
    },

    // job queue
    enqueueJob(fileId: number, stage: JobStage): void {
      stmtEnqueueJob.run(fileId, stage, new Date().toISOString());
    },

    claimNextJob(): Job | null {
      return claimNextJobTx();
    },

    completeJob(jobId: number): void {
      stmtCompleteJob.run(new Date().toISOString(), jobId);
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
