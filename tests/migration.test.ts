import { describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../src/main/db/database";

/**
 * A legacy v1 database — the schema Dailies shipped before projects, roles,
 * OP-Atom, episodes, documents, and embeddings existed. This is exactly the
 * shape of an adopted pre-projects "My Footage" database on a real user's disk.
 */
const V1_SCHEMA = `
CREATE TABLE files (
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
  has_visual_index INTEGER NOT NULL DEFAULT 0,
  proxy_path TEXT
);
CREATE TABLE scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  start_s REAL NOT NULL, end_s REAL NOT NULL,
  start_tc TEXT NOT NULL, end_tc TEXT NOT NULL, keyframe_path TEXT
);
CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  start_s REAL NOT NULL, end_s REAL NOT NULL,
  text TEXT NOT NULL, speaker TEXT, avg_conf REAL NOT NULL
);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL, stage TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const V04_SCHEMA = `
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'raw',
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  last_scanned_at TEXT
);
CREATE TABLE files (
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
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL
);
CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function insertV04File(
  db: Database.Database,
  input: {
    path: string;
    filename: string;
    fileHash: string;
    episodeId: number | null;
  },
): number {
  return Number(db.prepare(
    `INSERT INTO files (
       path, filename, duration_s, fps, drop_frame, start_tc, codec,
       audio_channels, file_hash, status, added_at, episode_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.path,
    input.filename,
    10,
    24,
    0,
    "01:00:00:00",
    "prores",
    2,
    input.fileHash,
    "ready",
    new Date(0).toISOString(),
    input.episodeId,
  ).lastInsertRowid);
}

describe("legacy database migration", () => {
  it("omits the retired visual index column from new databases", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-new-"));
    const dbPath = path.join(dir, "new.db");

    openDatabase(dbPath).close();

    const verify = new Database(dbPath);
    const columns = verify.pragma("table_info(files)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("has_visual_index");
    const chatColumns = verify.pragma("table_info(chats)") as Array<{ name: string }>;
    const chatIndexes = verify.pragma("index_list(chats)") as Array<{ name: string }>;
    expect(chatColumns.map((column) => column.name)).toContain("episode_id");
    expect(chatIndexes.map((index) => index.name)).toContain("idx_chats_episode_id");
    verify.close();
  });

  it("opens a v1 database and migrates it in place (regression: clip_key)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-"));
    const dbPath = path.join(dir, "legacy.db");

    // Build a real v1 database with a row of footage in it.
    const raw = new Database(dbPath);
    raw.exec(V1_SCHEMA);
    raw
      .prepare(
        "INSERT INTO files (path, filename, duration_s, fps, drop_frame, start_tc, codec, audio_channels, file_hash, status, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("/x/old.mov", "old.mov", 10, 24, 0, "01:00:00:00", "prores", 2, "h", "ready", new Date(0).toISOString());
    // A pre-projects watched-folders setting that should migrate into `folders`.
    raw
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("watchedFolders", JSON.stringify(["/footage/raw"]));
    raw
      .prepare("INSERT INTO chats (title, created_at) VALUES (?, ?)")
      .run("old chat", new Date(0).toISOString());
    raw.close();

    // Opening through the real code path must NOT throw "no such column: clip_key".
    const db = openDatabase(dbPath);

    // The pre-existing row survives and is readable through the new schema.
    const files = db.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("old.mov");
    expect(files[0].role).toBe("raw"); // new column defaulted
    expect(files[0].mediaKind).toBe("standard");
    expect(files[0].hasVideo).toBeNull();
    expect(files[0].discoveryFailed).toBe(false);
    expect(db.listChats({ episodeId: null })).toEqual([
      expect.objectContaining({ title: "old chat", episodeId: null }),
    ]);

    // New tables exist and the new query surface works.
    expect(db.searchTranscripts(["anything"])).toEqual([]);
    expect(db.listDocuments()).toEqual([]);

    // The legacy watchedFolders setting migrated into the folders table.
    const folders = db.listFolders();
    expect(folders.map((f) => f.path)).toContain("/footage/raw");

    db.close();
    const verify = new Database(dbPath);
    const columns = verify.pragma("table_info(files)") as Array<{ name: string }>;
    const indexes = verify.pragma("index_list(files)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["has_video", "discovery_failed", "discovery_error"]),
    );
    expect(columns.map((column) => column.name)).toContain("has_visual_index");
    expect(indexes.map((index) => index.name)).toContain("idx_files_file_hash");
    const chatColumns = verify.pragma("table_info(chats)") as Array<{ name: string }>;
    const chatIndexes = verify.pragma("index_list(chats)") as Array<{ name: string }>;
    expect(chatColumns.map((column) => column.name)).toContain("episode_id");
    expect(chatIndexes.map((index) => index.name)).toContain("idx_chats_episode_id");
    verify.close();
  });

  it("opens the pre-episodes documents schema before creating its episode index", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-docs-"));
    const dbPath = path.join(dir, "pre-episodes.db");
    const raw = new Database(dbPath);
    raw.exec(`${V1_SCHEMA}
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO documents (path, filename, kind, content, added_at) VALUES (?, ?, ?, ?, ?)",
    ).run("/notes/old.txt", "old.txt", "txt", "legacy notes", new Date(0).toISOString());
    raw.close();

    const db = openDatabase(dbPath);
    expect(db.listDocuments()).toHaveLength(1);

    const verify = new Database(dbPath);
    const columns = verify.pragma("table_info(documents)") as Array<{ name: string }>;
    const indexes = verify.pragma("index_list(documents)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("episode_id");
    expect(indexes.map((index) => index.name)).toContain("idx_documents_episode_id");
    verify.close();
    db.close();
  });

  it("migrates copied v0.4 membership and creates one recovery backup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-v04-"));
    const sourcePath = path.join(dir, "v04-source.db");
    const dbPath = path.join(dir, "dailies.db");
    const backupPath = path.join(dir, "dailies-pre-0.5.bak");
    const folder201 = path.join(dir, "episode-201");
    const folder202 = path.join(dir, "episode-202");
    mkdirSync(folder201);
    mkdirSync(folder202);

    const shared201Path = path.join(folder201, "shared.mov");
    const shared202Path = path.join(folder202, "shared.mov");
    const empty201Path = path.join(folder201, "empty-a.mov");
    const empty202Path = path.join(folder202, "empty-b.mov");
    const large201Path = path.join(folder201, "large-a.mov");
    const large202Path = path.join(folder202, "large-b.mov");
    writeFileSync(shared201Path, "shared duplicate content");
    writeFileSync(shared202Path, "shared duplicate content");
    writeFileSync(empty201Path, "");
    writeFileSync(empty202Path, "");
    const largeContent = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    writeFileSync(large201Path, largeContent);
    writeFileSync(large202Path, largeContent);

    const raw = new Database(sourcePath);
    raw.exec(V04_SCHEMA);
    const episode201 = Number(raw.prepare(
      "INSERT INTO episodes (code, created_at) VALUES (?, ?)",
    ).run("201", new Date(0).toISOString()).lastInsertRowid);
    const episode202 = Number(raw.prepare(
      "INSERT INTO episodes (code, created_at) VALUES (?, ?)",
    ).run("202", new Date(0).toISOString()).lastInsertRowid);
    raw.prepare(
      "INSERT INTO folders (path, role, episode_id, last_scanned_at) VALUES (?, ?, ?, NULL)",
    ).run(folder201, "raw", episode201);
    raw.prepare(
      "INSERT INTO folders (path, role, episode_id, last_scanned_at) VALUES (?, ?, ?, NULL)",
    ).run(folder202, "raw", episode202);

    const shared201 = insertV04File(raw, {
      path: shared201Path,
      filename: "shared.mov",
      fileHash: "shared-hash",
      episodeId: episode201,
    });
    const shared202 = insertV04File(raw, {
      path: shared202Path,
      filename: "shared.mov",
      fileHash: "shared-hash",
      episodeId: episode202,
    });
    const empty201 = insertV04File(raw, {
      path: empty201Path,
      filename: "empty-a.mov",
      fileHash: "empty-hash",
      episodeId: episode201,
    });
    const empty202 = insertV04File(raw, {
      path: empty202Path,
      filename: "empty-b.mov",
      fileHash: "empty-hash",
      episodeId: episode202,
    });
    const large201 = insertV04File(raw, {
      path: large201Path,
      filename: "large-a.mov",
      fileHash: "large-edge-hash",
      episodeId: episode201,
    });
    const large202 = insertV04File(raw, {
      path: large202Path,
      filename: "large-b.mov",
      fileHash: "large-edge-hash",
      episodeId: episode202,
    });
    raw.prepare(
      "INSERT INTO chats (title, created_at, episode_id) VALUES (?, ?, ?)",
    ).run("episode chat", new Date(0).toISOString(), episode201);
    raw.prepare(
      "INSERT INTO chats (title, created_at, episode_id) VALUES (?, ?, NULL)",
    ).run("project chat", new Date(0).toISOString());
    const baselineEpisodeHashes = raw.prepare<[], {
      episode_id: number;
      file_hash: string;
    }>(
      `SELECT episode_id, file_hash
       FROM files
       WHERE episode_id IS NOT NULL
       ORDER BY episode_id, file_hash`,
    ).all();
    raw.close();
    copyFileSync(sourcePath, dbPath);
    const originalDatabase = readFileSync(dbPath);

    const firstOpen = openDatabase(dbPath);
    expect(firstOpen.listFiles()).toHaveLength(5);
    expect(firstOpen.getEpisodeMemberIds(episode201).sort((a, b) => a - b)).toEqual([
      shared201,
      empty201,
      large201,
    ].sort((a, b) => a - b));
    expect(firstOpen.getEpisodeMemberIds(episode202).sort((a, b) => a - b)).toEqual([
      shared201,
      empty202,
      large202,
    ].sort((a, b) => a - b));
    expect(firstOpen.getFile(shared202)).toBeNull();
    expect(firstOpen.listFileLocations(shared201).map(({ path: locationPath }) => locationPath))
      .toEqual([shared201Path, shared202Path]);
    expect(firstOpen.getFile(empty201)).not.toBeNull();
    expect(firstOpen.getFile(empty202)).not.toBeNull();
    expect(firstOpen.getFile(large201)).not.toBeNull();
    expect(firstOpen.getFile(large202)).not.toBeNull();
    firstOpen.close();

    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath)).toEqual(originalDatabase);

    const verify = new Database(dbPath);
    const episodeRows = verify.prepare<[], {
      id: number;
      code: string;
      membership_source: string;
    }>(
      "SELECT id, code, membership_source FROM episodes ORDER BY id",
    ).all();
    expect(episodeRows).toEqual([
      { id: episode201, code: "201", membership_source: "folder" },
      { id: episode202, code: "202", membership_source: "folder" },
    ]);
    expect(verify.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episode_list_entries'",
    ).get()).toEqual({ name: "episode_list_entries" });
    expect(verify.prepare<[], { name: string }>(
      "PRAGMA table_info(files)",
    ).all().map(({ name }) => name)).not.toContain("episode_id");
    expect(verify.prepare<[], { episode_id: number; file_hash: string }>(
      `SELECT episode_members.episode_id, files.file_hash
       FROM episode_members
       JOIN files ON files.id = episode_members.file_id
       ORDER BY episode_members.episode_id, files.file_hash`,
    ).all()).toEqual(baselineEpisodeHashes);
    const fileIndexes = verify.prepare<[], {
      name: string;
      unique: number;
    }>("PRAGMA index_list(files)").all();
    expect(fileIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_files_file_hash", unique: 0 }),
      expect.objectContaining({ name: "idx_files_clip_key", unique: 1 }),
    ]));
    expect(verify.prepare<[], { title: string; episode_id: number | null }>(
      "SELECT title, episode_id FROM chats ORDER BY id",
    ).all()).toEqual([
      { title: "episode chat", episode_id: episode201 },
      { title: "project chat", episode_id: null },
    ]);
    verify.close();

    writeFileSync(backupPath, "do not overwrite");
    openDatabase(dbPath).close();
    expect(readFileSync(backupPath, "utf8")).toBe("do not overwrite");
  });

  it("logs every migration pair skipped because file sizes are unavailable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-missing-files-"));
    const dbPath = path.join(dir, "dailies.db");
    const firstPath = path.join(dir, "missing-a", "same.mov");
    const secondPath = path.join(dir, "missing-b", "same.mov");
    const raw = new Database(dbPath);
    raw.exec(V04_SCHEMA);
    insertV04File(raw, {
      path: firstPath,
      filename: "same.mov",
      fileHash: "missing-file-hash",
      episodeId: null,
    });
    insertV04File(raw, {
      path: secondPath,
      filename: "same.mov",
      fileHash: "missing-file-hash",
      episodeId: null,
    });
    raw.close();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = openDatabase(dbPath);

    expect(db.listFiles()).toHaveLength(2);
    const messages = warning.mock.calls.map((args) => args.map(String).join(" "));
    const pairMessages = messages.filter((message) =>
      message.includes("v0.5 migration skipped standard consolidation pair")
    );
    expect(pairMessages).toHaveLength(1);
    expect(pairMessages[0]).toContain(firstPath);
    expect(pairMessages[0]).toContain(secondPath);
    expect(pairMessages[0]).toContain("ENOENT");
    expect(messages).toContain(
      "[db] v0.5 migration skipped 1 standard consolidation pair because file size was unavailable",
    );
    db.close();
    warning.mockRestore();
  });

  it("checkpoints committed WAL pages before copying the recovery backup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-wal-backup-"));
    const dbPath = path.join(dir, "dailies.db");
    const backupPath = path.join(dir, "dailies-pre-0.5.bak");
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("wal_autocheckpoint = 0");
    raw.exec(V04_SCHEMA);
    raw.pragma("wal_checkpoint(TRUNCATE)");
    raw.prepare(
      "INSERT INTO chats (title, created_at, episode_id) VALUES (?, ?, NULL)",
    ).run("committed in WAL", new Date(0).toISOString());
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const migrated = openDatabase(dbPath);
    migrated.close();

    const backup = new Database(backupPath, { readonly: true });
    expect(backup.prepare("SELECT title FROM chats").all()).toEqual([
      { title: "committed in WAL" },
    ]);
    backup.close();
    raw.close();
  });

  it("removes every dependent row for consolidated transcript segments", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-dependents-"));
    const dbPath = path.join(dir, "dailies.db");
    const firstPath = path.join(dir, "first.mov");
    const secondPath = path.join(dir, "second.mov");
    writeFileSync(firstPath, "same content");
    writeFileSync(secondPath, "same content");

    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    raw.exec(`${V04_SCHEMA}
      CREATE TABLE scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        start_s REAL NOT NULL,
        end_s REAL NOT NULL,
        start_tc TEXT NOT NULL,
        end_tc TEXT NOT NULL,
        keyframe_path TEXT
      );
      CREATE TABLE transcript_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        start_s REAL NOT NULL,
        end_s REAL NOT NULL,
        text TEXT NOT NULL,
        speaker TEXT,
        avg_conf REAL NOT NULL
      );
      CREATE TABLE words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id INTEGER NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
        word TEXT NOT NULL,
        start_s REAL NOT NULL,
        end_s REAL NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE transcript_fts USING fts5(
        text,
        file_id UNINDEXED,
        segment_id UNINDEXED
      );
      CREATE TABLE embeddings (
        kind TEXT NOT NULL,
        ref_id INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (kind, ref_id)
      );
    `);
    const firstFileId = insertV04File(raw, {
      path: firstPath,
      filename: "duplicate.mov",
      fileHash: "same-hash",
      episodeId: null,
    });
    const secondFileId = insertV04File(raw, {
      path: secondPath,
      filename: "duplicate.mov",
      fileHash: "same-hash",
      episodeId: null,
    });
    raw.prepare("UPDATE files SET has_transcript = 1 WHERE id IN (?, ?)")
      .run(firstFileId, secondFileId);

    const insertSegment = raw.prepare(
      `INSERT INTO transcript_segments (
         file_id, start_s, end_s, text, speaker, avg_conf
       ) VALUES (?, ?, ?, ?, NULL, ?)`,
    );
    const insertWord = raw.prepare(
      "INSERT INTO words (segment_id, word, start_s, end_s) VALUES (?, ?, ?, ?)",
    );
    const insertFts = raw.prepare(
      "INSERT INTO transcript_fts (text, file_id, segment_id) VALUES (?, ?, ?)",
    );
    const insertEmbedding = raw.prepare(
      "INSERT INTO embeddings (kind, ref_id, vector) VALUES ('segment', ?, ?)",
    );
    const insertScene = raw.prepare(
      `INSERT INTO scenes (
         file_id, start_s, end_s, start_tc, end_tc, keyframe_path
       ) VALUES (?, 0, 1, '01:00:00:00', '01:00:01:00', NULL)`,
    );
    const insertJob = raw.prepare(
      `INSERT INTO jobs (
         file_id, stage, status, attempts, error, updated_at
       ) VALUES (?, 'transcribe', 'done', 0, NULL, ?)`,
    );
    for (const transcript of [
      { fileId: firstFileId, text: "survivorneedle remains searchable" },
      { fileId: secondFileId, text: "loserneedle is discarded" },
    ]) {
      const segmentId = Number(insertSegment.run(
        transcript.fileId,
        0,
        1,
        transcript.text,
        1,
      ).lastInsertRowid);
      insertWord.run(segmentId, transcript.text.split(" ")[0], 0, 0.5);
      insertFts.run(transcript.text, transcript.fileId, segmentId);
      insertEmbedding.run(segmentId, Buffer.alloc(4));
      insertScene.run(transcript.fileId);
      insertJob.run(transcript.fileId, new Date(0).toISOString());
    }
    raw.close();

    const migrated = openDatabase(dbPath);
    expect(migrated.getFile(firstFileId)).not.toBeNull();
    expect(migrated.getFile(secondFileId)).toBeNull();
    expect(migrated.searchTranscripts(["survivorneedle"])).toEqual([
      expect.objectContaining({ fileId: firstFileId, text: "survivorneedle remains searchable" }),
    ]);
    expect(migrated.searchTranscripts(["loserneedle"])).toEqual([]);
    migrated.close();

    const verify = new Database(dbPath);
    expect(verify.pragma("foreign_key_check")).toEqual([]);
    expect(verify.prepare(
      `SELECT COUNT(*) AS count
       FROM transcript_fts
       LEFT JOIN transcript_segments
         ON transcript_segments.id = transcript_fts.segment_id
       LEFT JOIN files
         ON files.id = transcript_fts.file_id
       WHERE transcript_segments.id IS NULL
          OR files.id IS NULL`,
    ).get()).toEqual({ count: 0 });
    expect(verify.prepare(
      `SELECT COUNT(*) AS count
       FROM embeddings
       LEFT JOIN transcript_segments
         ON transcript_segments.id = embeddings.ref_id
       WHERE embeddings.kind = 'segment'
         AND transcript_segments.id IS NULL`,
    ).get()).toEqual({ count: 0 });
    verify.close();
  });

  it("rolls back duplicate consolidation when the final integrity assertion fails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-rollback-"));
    const dbPath = path.join(dir, "dailies.db");
    const firstPath = path.join(dir, "first.mov");
    const secondPath = path.join(dir, "second.mov");
    writeFileSync(firstPath, "same content");
    writeFileSync(secondPath, "same content");

    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = OFF");
    raw.exec(`${V04_SCHEMA}
      CREATE TABLE episode_members (
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        PRIMARY KEY (episode_id, file_id)
      );
    `);
    const episodeId = Number(raw.prepare(
      "INSERT INTO episodes (code, created_at) VALUES (?, ?)",
    ).run("201", new Date(0).toISOString()).lastInsertRowid);
    insertV04File(raw, {
      path: firstPath,
      filename: "same.mov",
      fileHash: "same-hash",
      episodeId,
    });
    insertV04File(raw, {
      path: secondPath,
      filename: "same.mov",
      fileHash: "same-hash",
      episodeId,
    });
    raw.prepare(
      "INSERT INTO episode_members (episode_id, file_id) VALUES (?, ?)",
    ).run(episodeId, 999_999);
    raw.close();

    expect(() => openDatabase(dbPath)).toThrow(/foreign key check failed/);

    const verify = new Database(dbPath);
    expect(verify.prepare("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 2 });
    expect(
      verify.prepare<[], { name: string }>("PRAGMA table_info(files)")
        .all()
        .map(({ name }) => name),
    ).toContain("episode_id");
    expect(verify.prepare<[], { episode_id: number; file_id: number }>(
      "SELECT episode_id, file_id FROM episode_members ORDER BY file_id",
    ).all()).toEqual([{ episode_id: episodeId, file_id: 999_999 }]);
    verify.close();
  });

  it("removes legacy visual index data without disturbing files or transcripts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-mig-visual-"));
    const dbPath = path.join(dir, "visual-index.db");
    const raw = new Database(dbPath);
    raw.exec(`${V1_SCHEMA}
      CREATE TABLE visual_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        objects TEXT NOT NULL,
        shot_type TEXT,
        time_of_day TEXT,
        people_count INTEGER,
        actions TEXT NOT NULL,
        model TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE visual_fts USING fts5(
        content,
        file_id UNINDEXED,
        scene_id UNINDEXED
      );
      CREATE TABLE embeddings (
        kind TEXT NOT NULL,
        ref_id INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (kind, ref_id)
      );
    `);
    const fileId = Number(raw.prepare(
      "INSERT INTO files (path, filename, duration_s, fps, drop_frame, start_tc, codec, audio_channels, file_hash, status, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("/x/visual.mov", "visual.mov", 10, 24, 0, "01:00:00:00", "prores", 2, "vh", "ready", new Date(0).toISOString()).lastInsertRowid);
    const sceneId = Number(raw.prepare(
      "INSERT INTO scenes (file_id, start_s, end_s, start_tc, end_tc, keyframe_path) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(fileId, 0, 5, "01:00:00:00", "01:00:05:00", "/cache/frame.jpg").lastInsertRowid);
    raw.prepare(
      "INSERT INTO transcript_segments (file_id, start_s, end_s, text, speaker, avg_conf) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(fileId, 1, 2, "keep this transcript", null, 1);
    raw.prepare(
      "INSERT INTO visual_annotations (scene_id, file_id, description, objects, shot_type, time_of_day, people_count, actions, model, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(sceneId, fileId, "legacy visual", "[]", null, null, null, "[]", "old-model", new Date(0).toISOString());
    raw.prepare("INSERT INTO visual_fts (content, file_id, scene_id) VALUES (?, ?, ?)")
      .run("legacy visual", fileId, sceneId);
    raw.prepare("INSERT INTO embeddings (kind, ref_id, vector) VALUES (?, ?, ?)")
      .run("scene", sceneId, Buffer.alloc(4));
    raw.prepare(
      "INSERT INTO jobs (file_id, stage, status, attempts, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(fileId, "visual_index", "queued", 0, null, new Date(0).toISOString());
    raw.close();

    const db = openDatabase(dbPath);
    expect(db.listFiles()).toHaveLength(1);
    expect(db.listSegments(fileId)[0]?.text).toBe("keep this transcript");
    expect(db.listJobs()).toEqual([]);
    db.close();

    const verify = new Database(dbPath);
    const tables = verify.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name);
    expect(tables).not.toContain("visual_annotations");
    expect(tables).not.toContain("visual_fts");
    expect(verify.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE kind = 'scene'").get())
      .toEqual({ count: 0 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM jobs WHERE stage = 'visual_index'").get())
      .toEqual({ count: 0 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 1 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM transcript_segments").get()).toEqual({ count: 1 });
    expect(verify.prepare("SELECT value FROM settings WHERE key = ?").get("migration_visual_cleanup_done"))
      .toEqual({ value: "1" });

    verify.exec(`
      CREATE TABLE visual_annotations (id INTEGER PRIMARY KEY);
      CREATE VIRTUAL TABLE visual_fts USING fts5(content);
      INSERT INTO visual_annotations DEFAULT VALUES;
      INSERT INTO visual_fts (content) VALUES ('created after migration');
    `);
    verify.prepare("INSERT INTO embeddings (kind, ref_id, vector) VALUES (?, ?, ?)")
      .run("scene", sceneId, Buffer.alloc(4));
    verify.prepare(
      "INSERT INTO jobs (file_id, stage, status, attempts, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(fileId, "visual_index", "queued", 0, null, new Date(0).toISOString());
    verify.close();

    openDatabase(dbPath).close();

    const reopened = new Database(dbPath);
    const tablesAfterSecondOpen = reopened.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name);
    expect(tablesAfterSecondOpen).toContain("visual_annotations");
    expect(tablesAfterSecondOpen).toContain("visual_fts");
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE kind = 'scene'").get())
      .toEqual({ count: 1 });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM jobs WHERE stage = 'visual_index'").get())
      .toEqual({ count: 1 });
    reopened.close();
  });
});
