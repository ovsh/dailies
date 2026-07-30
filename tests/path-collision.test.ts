import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";

const UMID =
  "0x060A2B340101010501010F1013000000AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("files.path collision self-heal", () => {
  it("an opatom clip claiming a path absorbs a stale standalone row there", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-collision-"));
    const db = openDatabase(path.join(dir, "collision.db"));

    // A clip registered under its clip key at its first primary path.
    const clip = db.registerFileLocation({
      path: "/mxf/1/CLIP.A1.mxf",
      filename: "CLIP.A1.mxf",
      durationS: 30,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "dnxhd",
      audioChannels: 0,
      fileHash: "/mxf/1/CLIP.A1.mxf:h1",
      mediaKind: "opatom",
      memberPaths: ["/mxf/1/CLIP.A1.mxf"],
      clipKey: UMID,
      clipName: "CLIP",
      hasVideo: true,
    }).file;

    // A stale standalone row squatting on the video atom's path — the state
    // an EBADF-era mis-ingest (atom analyzed as "standard media") leaves
    // behind.
    const squatter = db.upsertFile({
      path: "/mxf/1/CLIP.V1.mxf",
      filename: "CLIP.V1.mxf",
      durationS: 30,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "dnxhd",
      audioChannels: 0,
      fileHash: "squatter-hash",
      hasVideo: true,
    });
    expect(squatter.id).not.toBe(clip.id);

    // The clip re-registers with the video atom discovered — it claims the
    // squatter's path. Previously: UNIQUE constraint failed (files.path /
    // files.clip_key), every rescan, forever.
    const registration = db.registerFileLocation({
      path: "/mxf/1/CLIP.V1.mxf",
      filename: "CLIP.V1.mxf",
      durationS: 30,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "dnxhd",
      audioChannels: 1,
      fileHash: "/mxf/1/CLIP.V1.mxf:h2|/mxf/1/CLIP.A1.mxf:h1",
      mediaKind: "opatom",
      memberPaths: ["/mxf/1/CLIP.V1.mxf", "/mxf/1/CLIP.A1.mxf"],
      clipKey: UMID,
      clipName: "CLIP",
      hasVideo: true,
    });

    expect(registration.file.id).toBe(clip.id);
    expect(registration.location?.path).toBe("/mxf/1/CLIP.V1.mxf");
    expect(db.getFile(squatter.id)).toBeNull();
    db.close();
  });
});
