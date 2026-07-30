import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";

interface CountRow {
  count: number;
}

interface PreFileRow {
  id: number;
  path: string;
  filename: string;
  file_hash: string;
  media_kind: string;
  clip_key: string | null;
  has_transcript: number;
  derived_count: number;
  segment_count: number;
}

interface LocationRow {
  file_id: number;
  path: string;
}

function count(db: Database.Database, table: string): number {
  return db.prepare<[], CountRow>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
}

function tableColumnNames(db: Database.Database, table: string): string[] {
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
    return row.name;
  });
}

function fileSize(pathname: string): number | null {
  try {
    return statSync(pathname).size;
  } catch {
    return null;
  }
}

function expectedDuplicateSegmentLoss(files: PreFileRow[]): number {
  const groups = new Map<string, PreFileRow[]>();
  for (const file of files) {
    let key: string | null = null;
    if (file.media_kind === "opatom" && file.clip_key !== null) {
      const normalizedClipKey = file.clip_key.trim().toLowerCase();
      if (normalizedClipKey !== "") key = `opatom\0${normalizedClipKey}`;
    } else if (file.media_kind !== "opatom" && (fileSize(file.path) ?? 0) > 0) {
      key = `standard\0${file.file_hash}\0${file.filename}`;
    }
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  let loss = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) =>
      Number(right.has_transcript === 1) - Number(left.has_transcript === 1) ||
      right.derived_count - left.derived_count ||
      left.id - right.id
    );
    for (const duplicate of group.slice(1)) loss += duplicate.segment_count;
  }
  return loss;
}

function logicalSnapshot(dbPath: string): unknown {
  const db = new Database(dbPath, { readonly: true });
  const snapshot = {
    files: db.prepare("SELECT * FROM files ORDER BY id").all(),
    locations: db.prepare("SELECT * FROM file_locations ORDER BY id").all(),
    members: db.prepare(
      "SELECT * FROM episode_members ORDER BY episode_id, file_id",
    ).all(),
    listEntries: db.prepare(
      "SELECT * FROM episode_list_entries ORDER BY episode_id, ordinal",
    ).all(),
    chats: db.prepare("SELECT * FROM chats ORDER BY id").all(),
    segmentCount: count(db, "transcript_segments"),
    foreignKeyCheck: db.pragma("foreign_key_check"),
  };
  db.close();
  return snapshot;
}

const sourcePath = process.env["DAILIES_V04_DB"];
if (!sourcePath) {
  process.stderr.write(
    "[REAL MIGRATION TEST SKIPPED] DAILIES_V04_DB is not set. Set it to the absolute path of a real pre-0.5 database.\n",
  );
}

describe("real v0.4 database migration", () => {
  it.skipIf(!sourcePath)(
    "preserves the copied database and is idempotent",
    () => {
      if (!sourcePath) throw new Error("DAILIES_V04_DB is required");
      expect(
        path.isAbsolute(sourcePath),
        "DAILIES_V04_DB must be an absolute path",
      ).toBe(true);
      expect(existsSync(sourcePath), `DAILIES_V04_DB does not exist: ${sourcePath}`).toBe(true);

      const workDir = mkdtempSync(path.join(tmpdir(), "dailies-real-migration-"));
      const dbPath = path.join(workDir, "dailies.db");
      const backupPath = path.join(workDir, "dailies-pre-0.5.bak");
      copyFileSync(sourcePath, dbPath);

      const before = new Database(dbPath, { readonly: true });
      expect(tableColumnNames(before, "files")).toContain("episode_id");
      const chatCountBefore = count(before, "chats");
      const segmentCountBefore = count(before, "transcript_segments");
      const files = before.prepare<[], PreFileRow>(
        `SELECT
           files.id,
           files.path,
           files.filename,
           files.file_hash,
           files.media_kind,
           files.clip_key,
           files.has_transcript,
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
           ) AS derived_count,
           (SELECT COUNT(*) FROM transcript_segments WHERE transcript_segments.file_id = files.id)
             AS segment_count
         FROM files
         ORDER BY files.id`,
      ).all();
      const expectedSegmentLoss = expectedDuplicateSegmentLoss(files);
      before.close();

      const firstOpen = openDatabase(dbPath);
      firstOpen.close();

      expect(existsSync(backupPath)).toBe(true);
      const backupBytes = readFileSync(backupPath);
      const backupMtime = statSync(backupPath).mtimeMs;
      const migrated = new Database(dbPath, { readonly: true });
      expect(tableColumnNames(migrated, "files")).not.toContain("episode_id");
      expect(count(migrated, "chats")).toBe(chatCountBefore);
      expect(count(migrated, "transcript_segments")).toBe(
        segmentCountBefore - expectedSegmentLoss,
      );
      expect(migrated.pragma("foreign_key_check")).toEqual([]);

      const locations = migrated.prepare<[], LocationRow>(
        "SELECT file_id, path FROM file_locations ORDER BY file_id, id",
      ).all();
      const locationsByFile = new Map<number, LocationRow[]>();
      for (const location of locations) {
        const group = locationsByFile.get(location.file_id) ?? [];
        group.push(location);
        locationsByFile.set(location.file_id, group);
      }
      const zeroByteMultiLocationFiles = [...locationsByFile]
        .filter(([, group]) =>
          group.length > 1 && group.some((location) => fileSize(location.path) === 0)
        )
        .map(([fileId]) => fileId);
      expect(zeroByteMultiLocationFiles).toEqual([]);
      migrated.close();

      const firstSnapshot = logicalSnapshot(dbPath);
      const secondOpen = openDatabase(dbPath);
      secondOpen.close();

      expect(logicalSnapshot(dbPath)).toEqual(firstSnapshot);
      expect(readFileSync(backupPath).equals(backupBytes)).toBe(true);
      expect(statSync(backupPath).mtimeMs).toBe(backupMtime);
    },
  );
});
