import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";
import type { FileInput } from "../src/shared/types";

const CLIP_UMID =
  "0x060A2B340101010501010F1013000000AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_UMID =
  "0x060A2B340101010501010F1013000000BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function atomInput(
  primaryPath: string,
  memberPaths: string[],
  clipKey: string,
  clipName: string,
): FileInput {
  return {
    path: primaryPath,
    filename: path.basename(primaryPath),
    durationS: 30,
    fps: 23.976,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "dnxhd",
    audioChannels: 1,
    fileHash: memberPaths.map((member) => `${member}:h1`).join("|"),
    mediaKind: "opatom",
    memberPaths,
    clipKey,
    clipName,
    hasVideo: true,
  };
}

function freshDb(label: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `dailies-${label}-`));
  return openDatabase(path.join(dir, `${label}.db`));
}

describe("updateOpAtomMembers path upsert", () => {
  it("absorbs an unreadable stub squatting the new primary path", () => {
    const db = freshDb("opatom-stub");
    const clip = db.registerFileLocation(
      atomInput("/mxf/CLIP.A1.mxf", ["/mxf/CLIP.A1.mxf"], CLIP_UMID, "CLIP"),
    ).file;
    db.setFileProxy(clip.id, "/proxies/clip.mp4");
    db.markTranscribed(clip.id);

    // The stub discovery writes for a file it could not probe. Production
    // telemetry showed one of these parked on the video atom's path,
    // failing the members UPDATE with a UNIQUE constraint on every scan.
    const stub = db.upsertFile({
      path: "/mxf/CLIP.V1.mxf",
      filename: "CLIP.V1.mxf",
      durationS: 0,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "",
      audioChannels: 0,
      fileHash: "unreadable:/mxf/CLIP.V1.mxf",
    });
    expect(stub.id).not.toBe(clip.id);

    const updated = db.updateOpAtomMembers(
      clip.id,
      atomInput(
        "/mxf/CLIP.V1.mxf",
        ["/mxf/CLIP.V1.mxf", "/mxf/CLIP.A1.mxf"],
        CLIP_UMID,
        "CLIP",
      ),
    );

    expect(updated.id).toBe(clip.id);
    expect(db.getFile(stub.id)).toBeNull();
    expect(db.getFileByPath("/mxf/CLIP.V1.mxf")?.id).toBe(clip.id);
    expect(db.listFileLocations(clip.id).map((location) => location.path))
      .toEqual(["/mxf/CLIP.V1.mxf"]);
    // The bytes did not change, so the transcript and proxy must survive.
    expect(updated.proxyPath).toBe("/proxies/clip.mp4");
    expect(updated.hasTranscript).toBe(true);
    db.close();
  });

  it("absorbs a location whose members are a subset of the new member set", () => {
    const db = freshDb("opatom-subset");
    const clip = db.registerFileLocation(
      atomInput("/mxf/CLIP.A1.mxf", ["/mxf/CLIP.A1.mxf"], CLIP_UMID, "CLIP"),
    ).file;
    const orphan = db.registerFileLocation(
      atomInput("/mxf/CLIP.V1.mxf", ["/mxf/CLIP.V1.mxf"], OTHER_UMID, "ORPHAN"),
    ).file;
    expect(orphan.id).not.toBe(clip.id);

    const updated = db.updateOpAtomMembers(
      clip.id,
      atomInput(
        "/mxf/CLIP.V1.mxf",
        ["/mxf/CLIP.V1.mxf", "/mxf/CLIP.A1.mxf"],
        CLIP_UMID,
        "CLIP",
      ),
    );

    expect(updated.id).toBe(clip.id);
    expect(db.getFile(orphan.id)).toBeNull();
    db.close();
  });

  it("refuses to take a path held by a different live clip", () => {
    const db = freshDb("opatom-live");
    const clip = db.registerFileLocation(
      atomInput("/mxf/CLIP.A1.mxf", ["/mxf/CLIP.A1.mxf"], CLIP_UMID, "CLIP"),
    ).file;
    const other = db.registerFileLocation(
      atomInput(
        "/mxf/OTHER.A1.mxf",
        ["/mxf/OTHER.A1.mxf", "/mxf/OTHER.V1.mxf"],
        OTHER_UMID,
        "OTHER",
      ),
    ).file;

    expect(() =>
      db.updateOpAtomMembers(
        clip.id,
        atomInput(
          "/mxf/OTHER.A1.mxf",
          ["/mxf/OTHER.A1.mxf", "/mxf/CLIP.A1.mxf"],
          CLIP_UMID,
          "CLIP",
        ),
      )
    ).toThrow(/unrelated members/);
    expect(db.getFile(other.id)?.id).toBe(other.id);
    db.close();
  });
});
