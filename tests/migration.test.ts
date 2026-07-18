import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
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
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

describe("legacy database migration", () => {
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
    raw.close();

    // Opening through the real code path must NOT throw "no such column: clip_key".
    const db = openDatabase(dbPath);

    // The pre-existing row survives and is readable through the new schema.
    const files = db.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("old.mov");
    expect(files[0].role).toBe("raw"); // new column defaulted
    expect(files[0].mediaKind).toBe("standard");

    // New tables exist and the new query surface works.
    expect(db.searchTranscripts(["anything"])).toEqual([]);
    expect(db.listDocuments()).toEqual([]);

    // The legacy watchedFolders setting migrated into the folders table.
    const folders = db.listFolders();
    expect(folders.map((f) => f.path)).toContain("/footage/raw");

    db.close();
    const verify = new Database(dbPath);
    const indexes = verify.pragma("index_list(files)") as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_files_file_hash");
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
    verify.close();
  });
});
