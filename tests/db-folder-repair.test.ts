import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";
import { pathIsWithin } from "../src/main/path-compare";

const FOLDER_REPAIR_KEY = "folderAssignmentRepairV1";
const BACKUP_SUFFIX = ".pre-folder-repair.bak";
const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";

interface FolderIdRow {
  folder_id: number | null;
}

function folderIdFor(dbPath: string, locationPath: string): number | null {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare<[string], FolderIdRow>("SELECT folder_id FROM file_locations WHERE path = ?")
      .get(locationPath)?.folder_id ?? null;
  } finally {
    raw.close();
  }
}

/** Puts the database back into the state a v0.5.4 startup left behind. */
function breakFolderAssignment(
  dbPath: string,
  locationPath: string,
  wrongFolderId: number | null,
  clearMigrationKey: boolean,
): void {
  const raw = new Database(dbPath);
  try {
    raw.prepare<[number | null, string]>(
      "UPDATE file_locations SET folder_id = ? WHERE path = ?",
    ).run(wrongFolderId, locationPath);
    if (clearMigrationKey) {
      raw.prepare<[string]>("DELETE FROM settings WHERE key = ?").run(FOLDER_REPAIR_KEY);
      raw.exec("DELETE FROM episode_members");
    }
  } finally {
    raw.close();
  }
}

function clipInput(clipPath: string) {
  return {
    path: clipPath,
    filename: path.basename(clipPath),
    durationS: 12,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: `${clipPath}:h1`,
    hasVideo: true,
  };
}

describe("folder assignment repair migration", () => {
  it("corrects a wrong folder id and rebuilds folder-sourced membership", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-folder-repair-"));
    const dbPath = path.join(dir, "repair.db");

    const first = openDatabase(dbPath);
    const episode = first.createEpisode("EP01");
    const footage = first.addFolder("/Volumes/Drive/FOOTAGE", "raw", episode.id);
    const decoy = first.addFolder("/Volumes/Drive/OTHER", "raw", null);
    const clipPath = "/Volumes/Drive/FOOTAGE/clip.mov";
    const clip = first.registerFileLocation(clipInput(clipPath)).file;
    first.close();

    breakFolderAssignment(dbPath, clipPath, decoy.id, true);

    const second = openDatabase(dbPath);
    expect(folderIdFor(dbPath, clipPath)).toBe(footage.id);
    expect(second.getEpisodeMemberIds(episode.id)).toContain(clip.id);
    expect(existsSync(`${dbPath}${BACKUP_SUFFIX}`)).toBe(true);
    second.close();
  });

  it.skipIf(!FOLDS_CASE)(
    "reassigns a location whose folder differs only in case",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "dailies-folder-case-"));
      const dbPath = path.join(dir, "case.db");

      const first = openDatabase(dbPath);
      const episode = first.createEpisode("EP02");
      const footage = first.addFolder("/Volumes/Drive/FOOTAGE", "raw", episode.id);
      const decoy = first.addFolder("/Volumes/Drive/OTHER", "raw", null);
      // Stored with the volume and folder in a different case than the
      // watched folder — what a macOS scan of the same directory can hand
      // back, and what v0.5.4's case-sensitive comparison unassigned.
      const clipPath = "/Volumes/drive/footage/clip.mov";
      const clip = first.registerFileLocation(clipInput(clipPath)).file;
      first.close();

      breakFolderAssignment(dbPath, clipPath, decoy.id, true);

      const second = openDatabase(dbPath);
      expect(folderIdFor(dbPath, clipPath)).toBe(footage.id);
      expect(second.getEpisodeMemberIds(episode.id)).toContain(clip.id);
      second.close();
    },
  );

  it("runs only once and leaves the backup alone on later startups", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-folder-once-"));
    const dbPath = path.join(dir, "once.db");
    const backupPath = `${dbPath}${BACKUP_SUFFIX}`;

    const first = openDatabase(dbPath);
    const episode = first.createEpisode("EP03");
    const footage = first.addFolder("/Volumes/Drive/FOOTAGE", "raw", episode.id);
    const decoy = first.addFolder("/Volumes/Drive/OTHER", "raw", null);
    const clipPath = "/Volumes/Drive/FOOTAGE/clip.mov";
    first.registerFileLocation(clipInput(clipPath));
    first.close();

    breakFolderAssignment(dbPath, clipPath, decoy.id, true);
    openDatabase(dbPath).close();
    expect(folderIdFor(dbPath, clipPath)).toBe(footage.id);
    const backupAfterRepair = readFileSync(backupPath);

    // A second wrong value with the key in place: the migration is spent, so
    // nothing is recomputed and nothing is backed up again.
    breakFolderAssignment(dbPath, clipPath, decoy.id, false);
    openDatabase(dbPath).close();
    expect(folderIdFor(dbPath, clipPath)).toBe(decoy.id);
    expect(readFileSync(backupPath).equals(backupAfterRepair)).toBe(true);
  });
});

describe("shared path comparator", () => {
  it.skipIf(!FOLDS_CASE)("treats a case-only difference as containment", () => {
    expect(pathIsWithin("/Volumes/drive/footage/clip.mov", "/Volumes/Drive/FOOTAGE")).toBe(true);
  });

  it("still rejects a sibling directory", () => {
    expect(pathIsWithin("/Volumes/Drive/FOOTAGE2/clip.mov", "/Volumes/Drive/FOOTAGE")).toBe(false);
  });
});
