import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/main/db/database";

function makeDb(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-resilience-"));
  return openDatabase(path.join(dir, `${name}.db`));
}

function fileInput(filePath: string, hash: string) {
  return {
    path: filePath,
    filename: path.basename(filePath),
    durationS: 10,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: hash,
  };
}

describe("database pipeline resilience", () => {
  it("keeps missing prerequisites waiting and requeues them", () => {
    const db = makeDb("waiting");
    const file = db.upsertFile(fileInput("/media/waiting.mov", "a"));
    db.enqueueJob(file.id, "transcribe");
    const job = db.claimNextJob()!;

    db.waitJob(job.id, "model missing");
    expect(db.listJobs()[0]?.status).toBe("waiting");
    expect(db.requeueWaitingJobs(["transcribe"])).toBe(1);
    expect(db.claimNextJob()?.id).toBe(job.id);
    db.close();
  });

  it("updates a late OP-Atom member by clip_key instead of creating a duplicate", () => {
    const db = makeDb("clip-key");
    const first = db.upsertFile({
      ...fileInput("/avid/CLIPA01.mxf", "audio-hash"),
      fps: 0,
      codec: "pcm_s24le",
      audioChannels: 1,
      mediaKind: "opatom",
      memberPaths: ["/avid/CLIPA01.mxf"],
      clipKey: "umid-clip-a",
    });
    const joined = db.upsertFile({
      ...fileInput("/avid/CLIPV01.mxf", "video-and-audio-hash"),
      audioChannels: 1,
      mediaKind: "opatom",
      memberPaths: ["/avid/CLIPV01.mxf", "/avid/CLIPA01.mxf"],
      clipKey: "umid-clip-a",
    });

    expect(joined.id).toBe(first.id);
    expect(db.listFiles()).toHaveLength(1);
    expect(joined.path).toBe("/avid/CLIPV01.mxf");
    expect(joined.memberPaths).toEqual(["/avid/CLIPV01.mxf", "/avid/CLIPA01.mxf"]);
    db.close();
  });

  it("uses explicit seconds offsets for transcript hits when edit rate is unknown", () => {
    const db = makeDb("unknown-rate");
    const file = db.upsertFile({
      ...fileInput("/avid/AUDIO01.mxf", "audio"),
      fps: 0,
      codec: "pcm_s24le",
      audioChannels: 1,
    });
    db.replaceTranscript(file.id, [{
      startS: 1.25,
      endS: 2.5,
      text: "unknown rate transcript",
      avgConf: 1,
      words: [],
    }]);
    const [hit] = db.searchTranscripts(["unknown"]);
    expect(hit?.startTc).toBe("+00:00:01.250");
    expect(hit?.endTc).toBe("+00:00:02.500");
    db.close();
  });

  it("transactionally invalidates all derived state when content changes", () => {
    const db = makeDb("invalidate");
    const file = db.upsertFile(fileInput("/media/changed.mov", "old-hash"));
    db.setFileProxy(file.id, "/cache/proxy.mp4");
    db.replaceTranscript(file.id, [{
      startS: 1,
      endS: 2,
      text: "stale spoken content",
      avgConf: 1,
      words: [],
    }]);
    db.markTranscribed(file.id);
    const [scene] = db.replaceScenes(file.id, [{
      startS: 0,
      endS: 10,
      startTc: "01:00:00:00",
      endTc: "01:00:10:00",
      keyframePath: "/cache/frame.jpg",
    }]);
    db.upsertAnnotation(scene!.id, {
      description: "stale visual content",
      objects: ["stale"],
      model: "test",
    });
    db.markVisuallyIndexed(file.id);
    const segmentId = db.listSegments(file.id)[0]!.id;
    db.upsertEmbedding("segment", segmentId, new Float32Array(768).fill(1));
    db.upsertEmbedding("scene", scene!.id, new Float32Array(768).fill(1));
    db.enqueueJob(file.id, "embed");

    const updated = db.upsertFile(fileInput("/media/changed.mov", "new-hash"));

    expect(updated.status).toBe("pending");
    expect(updated.hasTranscript).toBe(false);
    expect(updated.hasVisualIndex).toBe(false);
    expect(updated.proxyPath).toBeNull();
    expect(db.listSegments(file.id)).toEqual([]);
    expect(db.listScenes(file.id)).toEqual([]);
    expect(db.listAnnotations(file.id)).toEqual([]);
    expect(db.searchTranscripts(["stale"])).toEqual([]);
    expect(db.searchVisuals(["stale"])).toEqual([]);
    expect(db.semanticSearch("segment", new Float32Array(768).fill(1))).toEqual([]);
    expect(db.semanticSearch("scene", new Float32Array(768).fill(1))).toEqual([]);
    expect(db.listJobs()).toEqual([]);
    db.close();
  });
});
