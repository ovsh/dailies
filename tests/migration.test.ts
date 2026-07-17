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
});
