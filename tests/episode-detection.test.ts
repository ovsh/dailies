import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../src/main/db/database";
import {
  applyEpisodeProposal,
  buildEpisodeProposal,
  deriveEpisodeCodes,
} from "../src/main/episode-detection";
import { readEpisodeMembershipReport, reconcileEpisodeMembership } from "../src/main/membership";
import type { DailiesDB } from "../src/main/db/types";

function freshDb(label: string): DailiesDB {
  const dir = mkdtempSync(path.join(tmpdir(), `dailies-${label}-`));
  return openDatabase(path.join(dir, "detect.db"));
}

function addClip(db: DailiesDB, name: string, sourceProject: string | null) {
  return db.upsertFile({
    path: `/pool/${name}.mxf`,
    filename: `${name}.mxf`,
    durationS: 10,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "dnxhd",
    audioChannels: 2,
    fileHash: `hash:${name}`,
    clipName: name,
    clipKey: `umid-${name}`,
    mediaKind: "opatom",
    sourceProject,
  });
}

describe("episode code derivation", () => {
  it("uses trailing digits when every project reduces to a distinct code", () => {
    const codes = deriveEpisodeCodes(["RWAR_EDIT_02", "RWAR_EDIT_03", "RWAR 10"]);
    expect(Object.fromEntries(codes)).toEqual({
      RWAR_EDIT_02: "02",
      RWAR_EDIT_03: "03",
      "RWAR 10": "10",
    });
  });

  it("falls back to full project names when the digits collide", () => {
    const codes = deriveEpisodeCodes(["SHOW_A_02", "SHOW_B_02"]);
    expect(Object.fromEntries(codes)).toEqual({
      SHOW_A_02: "SHOW_A_02",
      SHOW_B_02: "SHOW_B_02",
    });
  });

  it("falls back for every row when one project has no trailing digits", () => {
    const codes = deriveEpisodeCodes(["RWAR_EDIT_02", "RWAR_PICKUPS"]);
    expect(Object.fromEntries(codes)).toEqual({
      RWAR_EDIT_02: "RWAR_EDIT_02",
      RWAR_PICKUPS: "RWAR_PICKUPS",
    });
  });

  it("has nothing to derive from an empty set", () => {
    expect(deriveEpisodeCodes([]).size).toBe(0);
  });
});

describe("episode detection from media tags", () => {
  it("tallies stored tags and counts the clips that have none", () => {
    const db = freshDb("proposal");
    addClip(db, "a01", "RWAR_EDIT_02");
    addClip(db, "a02", "RWAR_EDIT_02");
    addClip(db, "b01", "RWAR_EDIT_03");
    addClip(db, "c01", null);

    const proposal = buildEpisodeProposal(db);
    expect(proposal.rows).toEqual([
      { sourceProject: "RWAR_EDIT_02", code: "02", clipCount: 2, alreadyExists: false },
      { sourceProject: "RWAR_EDIT_03", code: "03", clipCount: 1, alreadyExists: false },
    ]);
    expect(proposal.untaggedClipCount).toBe(1);
    expect(proposal.pendingClipCount).toBe(0);
  });

  it("gives an episode the clips carrying its tag, and reports the untagged rest", () => {
    const db = freshDb("membership");
    const first = addClip(db, "a01", "RWAR_EDIT_02");
    const second = addClip(db, "a02", "RWAR_EDIT_02");
    addClip(db, "b01", "RWAR_EDIT_03");
    addClip(db, "c01", null);

    const [episode] = applyEpisodeProposal(db, [{ sourceProject: "RWAR_EDIT_02", code: "02" }]);
    expect(episode.membershipSource).toBe("media-tag");
    expect(episode.mediaTag).toBe("RWAR_EDIT_02");

    // Membership is written through the normal path, so the scoped query sees it.
    expect(db.getEpisodeMemberIds(episode.id).sort()).toEqual([first.id, second.id].sort());
    expect(db.listFiles(episode.id).map((file) => file.filename).sort()).toEqual([
      "a01.mxf",
      "a02.mxf",
    ]);

    const report = readEpisodeMembershipReport(db, episode.id);
    expect(report.source).toBe("media-tag");
    expect(report.memberCount).toBe(2);
    expect(report.matchedCount).toBe(2);
    expect(report.untaggedClipCount).toBe(1);
  });

  it("follows the tag when new clips arrive, and marks a claimed project as taken", () => {
    const db = freshDb("reproposal");
    addClip(db, "a01", "RWAR_EDIT_02");
    addClip(db, "b01", "RWAR_EDIT_03");

    const [episode] = applyEpisodeProposal(db, [{ sourceProject: "RWAR_EDIT_02", code: "02" }]);
    const late = addClip(db, "a09", "RWAR_EDIT_02");

    // The source resolves live, so a report sees the new clip at once.
    expect(readEpisodeMembershipReport(db, episode.id).memberCount).toBe(2);
    // Stored members follow on the next reconcile, the same as the list source.
    expect(db.getEpisodeMemberIds(episode.id)).not.toContain(late.id);
    reconcileEpisodeMembership(db, episode.id);
    expect(db.getEpisodeMemberIds(episode.id)).toContain(late.id);

    const proposal = buildEpisodeProposal(db);
    expect(proposal.rows.map((row) => [row.sourceProject, row.alreadyExists])).toEqual([
      ["RWAR_EDIT_02", true],
      ["RWAR_EDIT_03", false],
    ]);
  });

  it("keeps an episode empty and honest when its tag matches nothing", () => {
    const db = freshDb("empty");
    addClip(db, "a01", "RWAR_EDIT_02");
    const episode = db.createEpisode("99");
    db.setEpisodeMediaTag(episode.id, "NOT_A_PROJECT");
    const report = readEpisodeMembershipReport(db, episode.id);
    expect(report.source).toBe("folder");

    const [applied] = applyEpisodeProposal(db, [{ sourceProject: "NOT_A_PROJECT", code: "99" }]);
    const after = readEpisodeMembershipReport(db, applied.id);
    expect(after.source).toBe("media-tag");
    expect(after.memberCount).toBe(0);
    expect(after.untaggedClipCount).toBe(0);
  });

  it("rejects duplicate or occupied codes before creating any episode", () => {
    const db = freshDb("proposal-code-conflicts");
    addClip(db, "a01", "RWAR_EDIT_02");
    addClip(db, "b01", "RWAR_EDIT_03");

    expect(() => applyEpisodeProposal(db, [
      { sourceProject: "RWAR_EDIT_02", code: "02" },
      { sourceProject: "RWAR_EDIT_03", code: "02" },
    ])).toThrow("Episode code 02 is used more than once");
    expect(db.listEpisodes()).toEqual([]);

    db.createEpisode("02");
    expect(() => applyEpisodeProposal(db, [
      { sourceProject: "RWAR_EDIT_02", code: "02" },
    ])).toThrow("Episode code 02 is already in use");
    expect(db.listEpisodes()).toHaveLength(1);
  });

  it("rolls back every episode when one accepted row fails to apply", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-proposal-rollback-"));
    const dbPath = path.join(dir, "detect.db");
    const db = openDatabase(dbPath);
    addClip(db, "a01", "RWAR_EDIT_02");
    addClip(db, "b01", "RWAR_EDIT_03");

    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TRIGGER fail_second_media_tag
      BEFORE UPDATE OF media_tag ON episodes
      WHEN NEW.media_tag = 'RWAR_EDIT_03'
      BEGIN
        SELECT RAISE(ABORT, 'forced media tag failure');
      END;
    `);
    raw.close();

    expect(() => applyEpisodeProposal(db, [
      { sourceProject: "RWAR_EDIT_02", code: "02" },
      { sourceProject: "RWAR_EDIT_03", code: "03" },
    ])).toThrow("forced media tag failure");
    expect(db.listEpisodes()).toEqual([]);
  });
});
