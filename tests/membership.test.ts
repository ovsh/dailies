import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/main/db/database";
import {
  readEpisodeMembershipReport,
  reconcileEpisodeMembership,
  replaceEpisodeClipList,
  setEpisodeMembershipSource,
} from "../src/main/membership";
import type { DailiesDB } from "../src/main/db/types";

function addFile(
  db: DailiesDB,
  input: {
    path: string;
    filename: string;
    clipName?: string | null;
    clipKey?: string | null;
  },
) {
  return db.upsertFile({
    path: input.path,
    filename: input.filename,
    durationS: 10,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: `hash:${input.path}`,
    clipName: input.clipName,
    clipKey: input.clipKey,
    mediaKind: input.clipKey ? "opatom" : "standard",
  });
}

describe("episode membership", () => {
  it("uses UMID precedence, exact clip names, then exact filename stems", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-membership-match-"));
    const db = openDatabase(path.join(dir, "membership.db"));
    const episode = db.createEpisode("201");
    const umid = addFile(db, {
      path: "/pool/umid.mxf",
      filename: "umid.mxf",
      clipName: "UMID CLIP",
      clipKey: " UMID-ONE ",
    });
    const uniqueName = addFile(db, {
      path: "/pool/unique.mov",
      filename: "unique.mov",
      clipName: " Café Clip ",
    });
    const ambiguousNameA = addFile(db, {
      path: "/pool/ambiguous-a.mov",
      filename: "ambiguous-a.mov",
      clipName: "AMBIGUOUS CLIP",
    });
    const ambiguousNameB = addFile(db, {
      path: "/pool/ambiguous-b.mov",
      filename: "ambiguous-b.mov",
      clipName: "ambiguous clip",
    });
    const stem = addFile(db, {
      path: "/pool/stem.mov",
      filename: "Stem Only.MOV",
    });
    const ambiguousStemA = addFile(db, {
      path: "/pool/a/DUP.mov",
      filename: "DUP.mov",
    });
    const ambiguousStemB = addFile(db, {
      path: "/pool/b/dup.MOV",
      filename: "dup.MOV",
    });

    const report = replaceEpisodeClipList(db, episode.id, [
      { ordinal: 0, rawName: "wrong name", clipName: "wrong name", clipKey: "umid-one" },
      { ordinal: 1, rawName: "Café Clip", clipName: "Café Clip", clipKey: "missing-umid" },
      { ordinal: 2, rawName: "café clip", clipName: "café clip", clipKey: null },
      { ordinal: 3, rawName: "ambiguous clip", clipName: "ambiguous clip", clipKey: null },
      { ordinal: 4, rawName: "stem only", clipName: "stem only", clipKey: null },
      { ordinal: 5, rawName: "dup", clipName: "dup", clipKey: null },
      { ordinal: 6, rawName: "missing", clipName: "missing", clipKey: null },
      { ordinal: 7, rawName: "Café Clip", clipName: "Café Clip", clipKey: null },
    ]);

    expect(report).toMatchObject({
      source: "list",
      memberCount: 3,
      matchedCount: 4,
      ambiguousCount: 2,
      unmatchedCount: 2,
      unresolvedCount: 4,
    });
    expect(report.resolutions).toEqual([
      expect.objectContaining({ kind: "matched", ordinal: 0, fileId: umid.id }),
      expect.objectContaining({ kind: "unmatched", ordinal: 1 }),
      expect.objectContaining({ kind: "matched", ordinal: 2, fileId: uniqueName.id }),
      expect.objectContaining({
        kind: "ambiguous",
        ordinal: 3,
        candidates: [
          expect.objectContaining({ fileId: ambiguousNameA.id }),
          expect.objectContaining({ fileId: ambiguousNameB.id }),
        ],
      }),
      expect.objectContaining({ kind: "matched", ordinal: 4, fileId: stem.id }),
      expect.objectContaining({
        kind: "ambiguous",
        ordinal: 5,
        candidates: [
          expect.objectContaining({ fileId: ambiguousStemA.id }),
          expect.objectContaining({ fileId: ambiguousStemB.id }),
        ],
      }),
      expect.objectContaining({ kind: "unmatched", ordinal: 6 }),
      expect.objectContaining({ kind: "matched", ordinal: 7, fileId: uniqueName.id }),
    ]);
    expect(db.getEpisodeMemberIds(episode.id)).toEqual([umid.id, uniqueName.id, stem.id]);
    expect(readEpisodeMembershipReport(db, episode.id)).toEqual(report);
    db.close();
  });

  it("re-resolves stored misses and switches sources without deleting list input", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-membership-source-"));
    const db = openDatabase(path.join(dir, "membership.db"));
    const folderEpisode = db.createEpisode("301");
    db.addFolder("/show/301", "raw", folderEpisode.id);
    const folderFile = addFile(db, {
      path: "/show/301/folder.mov",
      filename: "folder.mov",
    });

    const initial = replaceEpisodeClipList(db, folderEpisode.id, [
      { ordinal: 0, rawName: "late clip", clipName: "late clip", clipKey: null },
    ]);
    expect(initial.unmatchedCount).toBe(1);
    expect(initial.memberCount).toBe(0);

    const lateFile = addFile(db, {
      path: "/pool/late clip.mov",
      filename: "late clip.mov",
    });
    const resolved = reconcileEpisodeMembership(db, folderEpisode.id);
    expect(resolved).toMatchObject({
      memberCount: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(db.getEpisodeMemberIds(folderEpisode.id)).toEqual([lateFile.id]);

    const folderReport = setEpisodeMembershipSource(db, folderEpisode.id, "folder");
    expect(folderReport.source).toBe("folder");
    expect(db.getEpisodeMemberIds(folderEpisode.id)).toEqual([folderFile.id]);
    expect(db.getEpisodeListEntries(folderEpisode.id)).toHaveLength(1);
    expect(setEpisodeMembershipSource(db, folderEpisode.id, "folder")).toEqual(folderReport);

    const listReport = setEpisodeMembershipSource(db, folderEpisode.id, "list");
    expect(listReport.source).toBe("list");
    expect(db.getEpisodeMemberIds(folderEpisode.id)).toEqual([lateFile.id]);
    expect(setEpisodeMembershipSource(db, folderEpisode.id, "list")).toEqual(listReport);

    const secondEpisode = db.createEpisode("302");
    const secondReport = replaceEpisodeClipList(db, secondEpisode.id, [
      { ordinal: 0, rawName: "late clip", clipName: "late clip", clipKey: null },
    ]);
    expect(secondReport.memberCount).toBe(1);
    expect(db.getEpisodeMemberIds(folderEpisode.id)).toEqual([lateFile.id]);
    expect(db.getEpisodeMemberIds(secondEpisode.id)).toEqual([lateFile.id]);

    const previousEntries = db.getEpisodeListEntries(folderEpisode.id);
    expect(() => replaceEpisodeClipList(db, folderEpisode.id, [
      { ordinal: 0, rawName: "first", clipName: "first", clipKey: null },
      { ordinal: 0, rawName: "duplicate ordinal", clipName: "duplicate ordinal", clipKey: null },
    ])).toThrow();
    expect(db.getEpisodeListEntries(folderEpisode.id)).toEqual(previousEntries);
    expect(db.getEpisodeMemberIds(folderEpisode.id)).toEqual([lateFile.id]);
    db.close();
  });

  it("reports the fresh resolved member count when stored membership is stale", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-membership-report-"));
    const db = openDatabase(path.join(dir, "membership.db"));
    const episode = db.createEpisode("401");
    const file = addFile(db, {
      path: "/pool/fresh.mov",
      filename: "fresh.mov",
    });
    replaceEpisodeClipList(db, episode.id, [{
      ordinal: 0,
      rawName: "fresh",
      clipName: "fresh",
      clipKey: null,
    }]);
    db.replaceEpisodeMembers(episode.id, []);

    const report = readEpisodeMembershipReport(db, episode.id);

    expect(report.memberCount).toBe(1);
    expect(report.resolutions).toEqual([
      expect.objectContaining({ kind: "matched", fileId: file.id }),
    ]);
    db.close();
  });
});
