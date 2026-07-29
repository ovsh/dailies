import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, vi } from "vitest";

import {
  parseTc,
  framesToTc,
  secondsToFrames,
  tcAddSeconds,
  tcToSeconds,
  compareTc,
  formatElapsedOffset,
  isValidTc,
} from "../src/shared/timecode";
import { buildEdl, EdlIncompatibleSourceError } from "../src/main/export/edl";
import { buildLocatorGroups, buildLocatorList } from "../src/main/export/locators";
import { writeExport, writeLocatorExport } from "../src/main/export";
import type { ExportItem, MediaFile } from "../src/shared/types";

describe("isValidTc", () => {
  it("accepts colon and semicolon separators", () => {
    expect(isValidTc("01:00:00:00")).toBe(true);
    expect(isValidTc("01:00:00;00")).toBe(true);
    expect(isValidTc("06:30:00;00")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidTc("not a tc")).toBe(false);
    expect(isValidTc("01:00:00")).toBe(false);
    expect(isValidTc("")).toBe(false);
  });
});

describe("NDF parse/format round-trips", () => {
  const cases: Array<{ fps: number; tc: string }> = [
    { fps: 24, tc: "00:00:00:00" },
    { fps: 24, tc: "01:23:45:12" },
    { fps: 24, tc: "00:00:59:23" },
    { fps: 25, tc: "00:00:00:00" },
    { fps: 25, tc: "01:23:45:24" },
    { fps: 25, tc: "00:00:59:24" },
    { fps: 30, tc: "00:00:00:00" },
    { fps: 30, tc: "01:23:45:29" },
    { fps: 30, tc: "00:00:59:29" },
  ];

  for (const { fps, tc } of cases) {
    it(`round-trips ${tc} @ ${fps}fps NDF`, () => {
      const frames = parseTc(tc, fps, false);
      expect(framesToTc(frames, fps, false)).toBe(tc);
    });
  }
});

describe("23.976 uses 24 nominal", () => {
  it("parses using rounded fps (24) for frame math", () => {
    // One second at nominal 24fps = 24 frames, regardless of the .976 fraction.
    expect(parseTc("00:00:01:00", 23.976, false)).toBe(24);
    expect(parseTc("00:01:00:00", 23.976, false)).toBe(1440);
  });

  it("round-trips at 23.976", () => {
    const tc = "01:00:10:05";
    const frames = parseTc(tc, 23.976, false);
    expect(framesToTc(frames, 23.976, false)).toBe(tc);
  });
});

describe("29.97 drop-frame algorithm", () => {
  it("00:00:59;29 + 1 frame -> 00:01:00;02 (2 frames dropped)", () => {
    const frames = parseTc("00:00:59;29", 29.97, true) + 1;
    expect(framesToTc(frames, 29.97, true)).toBe("00:01:00;02");
  });

  it("00:09:59;29 + 1 frame -> 00:10:00;00 (minute 10 is exempt, no drop)", () => {
    const frames = parseTc("00:09:59;29", 29.97, true) + 1;
    expect(framesToTc(frames, 29.97, true)).toBe("00:10:00;00");
  });

  it("00:01:59;29 + 1 frame -> 00:02:00;02 (drop applies again after minute 1)", () => {
    const frames = parseTc("00:01:59;29", 29.97, true) + 1;
    expect(framesToTc(frames, 29.97, true)).toBe("00:02:00;02");
  });

  it("00:10:59;29 + 1 frame -> 00:11:00;02 (drop resumes after exempt minute 10)", () => {
    const frames = parseTc("00:10:59;29", 29.97, true) + 1;
    expect(framesToTc(frames, 29.97, true)).toBe("00:11:00;02");
  });

  it("round-trips valid drop-frame timecodes across the first 10-minute boundary", () => {
    for (let m = 0; m < 12; m++) {
      const exempt = m % 10 === 0;
      for (const s of [0, 30, 59]) {
        for (const ff of [0, 1, 2, 15, 29]) {
          // Frame numbers 0 and 1 don't exist at :00 seconds of non-exempt minutes.
          if (!exempt && s === 0 && (ff === 0 || ff === 1)) continue;
          const mm = String(m).padStart(2, "0");
          const ss = String(s).padStart(2, "0");
          const fr = String(ff).padStart(2, "0");
          const tc = `00:${mm}:${ss};${fr}`;
          const frames = parseTc(tc, 29.97, true);
          expect(framesToTc(frames, 29.97, true)).toBe(tc);
        }
      }
    }
  });

  it("59.94 drops 4 frames per non-exempt minute", () => {
    const frames = parseTc("00:00:59;59", 59.94, true) + 1;
    expect(framesToTc(frames, 59.94, true)).toBe("00:01:00;04");
  });
});

describe("secondsToFrames", () => {
  it("rounds to nearest frame at nominal fps", () => {
    expect(secondsToFrames(1, 24)).toBe(24);
    expect(secondsToFrames(1, 29.97)).toBe(30);
    expect(secondsToFrames(0.5, 24)).toBe(12);
  });
});

describe("tcAddSeconds", () => {
  it("adds whole seconds at NDF 24fps", () => {
    expect(tcAddSeconds("01:00:00:00", 10, 23.976, false)).toBe("01:00:10:00");
  });

  it("adds seconds using actual fps for accurate drop-frame results", () => {
    // 60 real seconds at 29.97fps is ~1798.2 frames (rounds to 1798), which
    // lands one frame short of drop-frame minute 1 (frame 1800).
    expect(tcAddSeconds("00:00:00;00", 60, 29.97, true)).toBe("00:00:59;28");
  });

  it("adding exactly one nominal-frame's worth of real time advances by one frame", () => {
    expect(tcAddSeconds("00:00:00;00", 1 / 29.97, 29.97, true)).toBe("00:00:00;01");
  });
});

describe("formatElapsedOffset", () => {
  it("keeps unknown-rate media explicit instead of fabricating frame timecode", () => {
    expect(formatElapsedOffset(61.2345)).toBe("+00:01:01.235");
  });
});

describe("tcToSeconds", () => {
  it("uses actual fps, not nominal, for real elapsed seconds", () => {
    // 240 frames @ 23.976fps (10s of nominal 24fps timecode) is slightly
    // more than 10 real seconds.
    const seconds = tcToSeconds("00:00:10:00", 23.976, false);
    expect(seconds).toBeCloseTo(10.01001, 4);
  });

  it("matches frame/fps for NDF", () => {
    expect(tcToSeconds("00:00:01:00", 24, false)).toBeCloseTo(1, 6);
  });
});

describe("compareTc", () => {
  it("orders timecodes ascending", () => {
    expect(compareTc("00:00:01:00", "00:00:02:00", 24, false)).toBeLessThan(0);
    expect(compareTc("00:00:02:00", "00:00:01:00", 24, false)).toBeGreaterThan(0);
    expect(compareTc("00:00:01:00", "00:00:01:00", 24, false)).toBe(0);
  });
});

// ---------- Avid export builders ----------

const fileA: MediaFile = {
  id: 1,
  path: "/media/A001.mov",
  filename: "A001.mov",
  durationS: 120,
  fps: 23.976,
  dropFrame: false,
  startTc: "01:00:00:00",
  codec: "prores",
  audioChannels: 2,
  fileHash: "hashA",
  status: "ready",
  addedAt: "2026-01-01T00:00:00.000Z",
  hasTranscript: false,
  hasVideo: true,
  proxyPath: null,
  episodeId: null,
  role: "raw" as const,
  clipName: null,
  mediaKind: "standard" as const,
  memberPaths: null,
  clipKey: null,
  videoUnplayable: false,
  discoveryFailed: false,
};

const fileB: MediaFile = {
  id: 2,
  path: "/media/B001.mov",
  filename: "B001.mov",
  durationS: 300,
  fps: 29.97,
  dropFrame: true,
  startTc: "06:30:00;00",
  codec: "prores",
  audioChannels: 2,
  fileHash: "hashB",
  status: "ready",
  addedAt: "2026-01-01T00:00:00.000Z",
  hasTranscript: false,
  hasVideo: true,
  proxyPath: null,
  episodeId: null,
  role: "raw" as const,
  clipName: null,
  mediaKind: "standard" as const,
  memberPaths: null,
  clipKey: null,
  videoUnplayable: false,
  discoveryFailed: false,
};

function getFile(id: number): MediaFile | null {
  if (id === fileA.id) return fileA;
  if (id === fileB.id) return fileB;
  return null;
}

describe("buildEdl", () => {
  it("produces a global FCM line and numbered events for compatible sources", () => {
    const items: ExportItem[] = [
      { fileId: fileA.id, inTc: "01:00:05:00", outTc: "01:00:10:00", comment: "clean take" },
      { fileId: fileA.id, inTc: "01:00:20:00", outTc: "01:00:22:00", comment: "second take" },
    ];

    const edl = buildEdl("My Show Reel", items, getFile);
    const lines = edl.split("\n");

    expect(lines[0]).toBe("TITLE: My Show Reel");
    expect(lines[1]).toBe("FCM: NON-DROP FRAME");

    expect(lines[2]).toMatch(/^001\s+AX\s+V\s+C\s+01:00:05:00 01:00:10:00 01:00:00:00 01:00:05:00$/);
    expect(lines[3]).toBe("* FROM CLIP NAME: A001.mov");
    expect(lines[4]).toBe("* COMMENT: clean take");

    expect(lines[5]).toMatch(/^002\s+AX\s+V\s+C\s+01:00:20:00 01:00:22:00 01:00:05:00 01:00:07:00$/);
    expect(lines[6]).toBe("* FROM CLIP NAME: A001.mov");
    expect(lines[7]).toBe("* COMMENT: second take");
  });

  it("uses DROP FRAME FCM when the first file is drop-frame", () => {
    const items: ExportItem[] = [
      { fileId: fileB.id, inTc: "06:30:01;00", outTc: "06:30:03;00", comment: "take" },
    ];
    const edl = buildEdl("Reel 2", items, getFile);
    expect(edl.split("\n")[1]).toBe("FCM: DROP FRAME");
    expect(edl.split("\n")[2]).toMatch(/01:00:00;00 01:00:02;00$/);
  });

  it("rejects incompatible mixed source rates with a typed error listing the clips", () => {
    const items: ExportItem[] = [
      { fileId: fileA.id, inTc: "01:00:05:00", outTc: "01:00:10:00", comment: "24-rate" },
      { fileId: fileB.id, inTc: "06:30:01;00", outTc: "06:30:03;00", comment: "30-rate" },
    ];

    try {
      buildEdl("Mixed", items, getFile);
      expect.fail("expected incompatible source formats to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(EdlIncompatibleSourceError);
      const typed = error as EdlIncompatibleSourceError;
      expect(typed.code).toBe("EDL_INCOMPATIBLE_SOURCE_FORMAT");
      expect(typed.recordFps).toBe(fileA.fps);
      expect(typed.offendingClips).toEqual([{
        fileId: fileB.id,
        filename: fileB.filename,
        fps: fileB.fps,
        dropFrame: true,
      }]);
    }
  });

  it("rejects mixed DF and NDF sources even when their numeric rates match", () => {
    const ndfAt2997: MediaFile = {
      ...fileB,
      id: 4,
      filename: "B002.mov",
      path: "/media/B002.mov",
      dropFrame: false,
      startTc: "06:30:00:00",
      fileHash: "hashB2",
    };
    const items: ExportItem[] = [
      { fileId: fileB.id, inTc: "06:30:01;00", outTc: "06:30:03;00", comment: "DF" },
      { fileId: ndfAt2997.id, inTc: "06:30:01:00", outTc: "06:30:03:00", comment: "NDF" },
    ];

    expect(() => buildEdl("Mixed FCM", items, (id) => (
      id === fileB.id ? fileB : id === ndfAt2997.id ? ndfAt2997 : null
    ))).toThrow(EdlIncompatibleSourceError);
  });

  it("round-trips event rows with monotonic record TC and one event per hit", () => {
    const items: ExportItem[] = [
      { fileId: fileB.id, inTc: "06:30:01;00", outTc: "06:30:03;00", comment: "first" },
      { fileId: fileB.id, inTc: "06:31:00;02", outTc: "06:31:04;02", comment: "second" },
      { fileId: fileB.id, inTc: "06:39:59;29", outTc: "06:40:01;00", comment: "third" },
    ];
    const eventPattern = /^(\d{3})\s+AX\s+V\s+C\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
    const events = buildEdl("Round Trip", items, getFile)
      .split("\n")
      .map((line) => eventPattern.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        event: Number(match[1]),
        recordIn: parseTc(match[4]!, fileB.fps, true),
        recordOut: parseTc(match[5]!, fileB.fps, true),
      }));

    expect(events).toHaveLength(items.length);
    expect(events.map((event) => event.event)).toEqual([1, 2, 3]);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.recordOut).toBeGreaterThan(events[i]!.recordIn);
      if (i > 0) expect(events[i]!.recordIn).toBe(events[i - 1]!.recordOut);
    }
  });

  it("skips items whose file is missing", () => {
    const items: ExportItem[] = [
      { fileId: 999, inTc: "01:00:00:00", outTc: "01:00:01:00", comment: "orphan" },
      { fileId: fileA.id, inTc: "01:00:05:00", outTc: "01:00:10:00", comment: "present" },
    ];
    const edl = buildEdl("Reel 3", items, getFile);
    expect(edl).not.toContain("orphan");
    expect(edl).toContain("A001.mov");
    expect(edl.split("\n")[2]).toMatch(/^001\s+AX/);
  });
});

describe("buildLocatorList", () => {
  it("emits one TAB-separated line per marker, sorted by filename then TC", () => {
    const items: ExportItem[] = [
      { fileId: fileB.id, inTc: "06:30:02;00", outTc: "06:30:03;00", comment: "second B take" },
      { fileId: fileA.id, inTc: "01:00:05:00", outTc: "01:00:06:00", comment: "A take" },
      { fileId: fileB.id, inTc: "06:30:01;00", outTc: "06:30:02;00", comment: "first B take" },
    ];

    const list = buildLocatorList(items, getFile);
    const lines = list.split("\n");

    expect(lines).toHaveLength(3);

    // A001.mov sorts before B001.mov.
    const [line1, line2, line3] = lines as [string, string, string];
    expect(line1.startsWith("Dailies\t01:00:05:00\tV1\tred\t")).toBe(true);
    expect(line1).toContain("[A001.mov 01:00:05:00-01:00:06:00] A take");

    // Within B001.mov, earlier TC (06:30:01;00) sorts first.
    expect(line2.startsWith("Dailies\t06:30:01;00\tV1\tred\t")).toBe(true);
    expect(line2).toContain("[B001.mov 06:30:01;00-06:30:02;00] first B take");

    expect(line3.startsWith("Dailies\t06:30:02;00\tV1\tred\t")).toBe(true);
    expect(line3).toContain("[B001.mov 06:30:02;00-06:30:03;00] second B take");

    for (const line of lines) {
      expect(line.split("\t")).toHaveLength(6);
      expect(line.endsWith("\t1")).toBe(true);
    }
  });

  it("respects a custom color and sanitizes comments", () => {
    const items: ExportItem[] = [
      {
        fileId: fileA.id,
        inTc: "01:00:00:00",
        outTc: "01:00:01:00",
        comment: "line1\tline2\nline3",
        color: "cyan",
      },
    ];
    const list = buildLocatorList(items, getFile);
    const fields = list.split("\t");
    expect(fields[3]).toBe("cyan");
    const comment = fields[4]!;
    expect(comment).not.toContain("\t");
    expect(comment).not.toContain("\n");
  });

  it("clamps comments to 256 characters", () => {
    const longComment = "x".repeat(500);
    const items: ExportItem[] = [
      { fileId: fileA.id, inTc: "01:00:00:00", outTc: "01:00:01:00", comment: longComment },
    ];
    const list = buildLocatorList(items, getFile);
    const comment = list.split("\t")[4]!;
    expect(comment.length).toBeLessThanOrEqual(256);
  });

  it("skips items whose file is missing", () => {
    const items: ExportItem[] = [
      { fileId: 999, inTc: "01:00:00:00", outTc: "01:00:01:00", comment: "orphan" },
    ];
    expect(buildLocatorList(items, getFile)).toBe("");
  });
});

describe("grouped locator export", () => {
  function makeOutDir(): string {
    return mkdtempSync(path.join(tmpdir(), "dailies-locators-"));
  }

  const opAtom: MediaFile = {
    ...fileA,
    id: 10,
    path: "/avid/06252025T0A01.E4E58D765A30A.mxf",
    filename: "06252025T0A01.E4E58D765A30A.mxf",
    clipName: "06252025/05",
    fileHash: "opatom-10",
    mediaKind: "opatom",
  };
  const thirdFile: MediaFile = {
    ...fileA,
    id: 11,
    path: "/media/C001.mov",
    filename: "C001.mov",
    clipName: "C DISPLAY",
    fileHash: "third-11",
  };
  const groupedFiles = new Map([
    [fileA.id, fileA],
    [fileB.id, fileB],
    [opAtom.id, opAtom],
    [thirdFile.id, thirdFile],
  ]);
  const resolveGroupedFile = (id: number): MediaFile | null => groupedFiles.get(id) ?? null;

  it("blocks zero items without creating a filesystem entry", () => {
    const outDir = makeOutDir();
    const getFile = vi.fn(resolveGroupedFile);

    expect(writeLocatorExport([], getFile, outDir)).toEqual({
      kind: "blocked",
      reason: "no-hits",
    });
    expect(getFile).not.toHaveBeenCalled();
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("blocks all missing sources without creating a filesystem entry", () => {
    const outDir = makeOutDir();
    const items: ExportItem[] = [{
      fileId: 999,
      inTc: "01:00:00:00",
      outTc: "01:00:01:00",
      comment: "missing",
    }];

    expect(writeLocatorExport(items, () => null, outDir)).toEqual({
      kind: "blocked",
      reason: "no-valid-sources",
    });
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("writes one clip with exact marker and clip counts", () => {
    const outDir = makeOutDir();
    const items: ExportItem[] = [
      {
        fileId: fileA.id,
        inTc: "01:00:05:00",
        outTc: "01:00:06:00",
        comment: "first",
      },
      {
        fileId: fileA.id,
        inTc: "01:00:10:00",
        outTc: "01:00:11:00",
        comment: "second",
      },
    ];

    const outcome = writeLocatorExport(items, resolveGroupedFile, outDir);

    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") throw new Error("expected written locator export");
    expect(outcome.markerCount).toBe(2);
    expect(outcome.clipCount).toBe(1);
    expect(outcome.paths).toHaveLength(1);
    expect(outcome.revealPath).toBe(outcome.paths[0]);
    expect(readFileSync(outcome.paths[0]!, "utf8").split("\n")).toHaveLength(2);
  });

  it("writes three source clips into one directory with stable group order", () => {
    const outDir = makeOutDir();
    const items: ExportItem[] = [
      {
        fileId: thirdFile.id,
        inTc: "01:00:20:00",
        outTc: "01:00:21:00",
        comment: "third",
      },
      {
        fileId: fileB.id,
        inTc: "06:30:01;00",
        outTc: "06:30:02;00",
        comment: "second",
      },
      {
        fileId: fileA.id,
        inTc: "01:00:05:00",
        outTc: "01:00:06:00",
        comment: "first",
      },
    ];

    const outcome = writeLocatorExport(items, resolveGroupedFile, outDir);

    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") throw new Error("expected written locator export");
    expect(outcome.markerCount).toBe(3);
    expect(outcome.clipCount).toBe(3);
    expect(outcome.paths.map((filePath) => path.basename(filePath))).toEqual([
      "A001.mov.txt",
      "B001.mov.txt",
      "C DISPLAY.txt",
    ]);
    expect(new Set(outcome.paths.map((filePath) => path.dirname(filePath))).size).toBe(1);
  });

  it("uses deterministic suffixes for sanitized display-name collisions", () => {
    const outDir = makeOutDir();
    const first: MediaFile = {
      ...fileA,
      id: 20,
      path: "/media/first.mov",
      filename: "first.mov",
      clipName: "DUP/NAME",
      fileHash: "duplicate-20",
    };
    const second: MediaFile = {
      ...fileA,
      id: 21,
      path: "/media/second.mov",
      filename: "second.mov",
      clipName: "DUP:NAME",
      fileHash: "duplicate-21",
    };
    const files = new Map([[first.id, first], [second.id, second]]);
    const items: ExportItem[] = [
      {
        fileId: second.id,
        inTc: "01:00:02:00",
        outTc: "01:00:03:00",
        comment: "second",
      },
      {
        fileId: first.id,
        inTc: "01:00:01:00",
        outTc: "01:00:02:00",
        comment: "first",
      },
    ];

    const firstRun = writeLocatorExport(items, (id) => files.get(id) ?? null, outDir);
    const secondRun = writeLocatorExport(items, (id) => files.get(id) ?? null, outDir);

    expect(firstRun.kind).toBe("written");
    expect(secondRun.kind).toBe("written");
    if (firstRun.kind !== "written" || secondRun.kind !== "written") {
      throw new Error("expected written locator exports");
    }
    expect(firstRun.paths.map((filePath) => path.basename(filePath))).toEqual([
      "DUP-NAME.txt",
      "DUP-NAME-2.txt",
    ]);
    expect(secondRun.paths.map((filePath) => path.basename(filePath))).toEqual([
      "DUP-NAME.txt",
      "DUP-NAME-2.txt",
    ]);
  });

  it("uses the OP-Atom clip name in filenames and marker comments", () => {
    const outDir = makeOutDir();
    const item: ExportItem = {
      fileId: opAtom.id,
      inTc: "01:00:05:00",
      outTc: "01:00:06:00",
      comment: "pond",
    };

    const outcome = writeLocatorExport([item], resolveGroupedFile, outDir);

    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") throw new Error("expected written locator export");
    expect(path.basename(outcome.paths[0]!)).toBe("06252025-05.txt");
    expect(readFileSync(outcome.paths[0]!, "utf8")).toContain(
      "[06252025/05 01:00:05:00-01:00:06:00] pond",
    );
  });

  it("sorts source timecodes within each file and resolves each file once", () => {
    const items: ExportItem[] = [
      {
        fileId: fileA.id,
        inTc: "01:00:10:00",
        outTc: "01:00:11:00",
        comment: "later",
      },
      {
        fileId: fileA.id,
        inTc: "01:00:02:00",
        outTc: "01:00:03:00",
        comment: "earlier",
      },
    ];
    const getFile = vi.fn(resolveGroupedFile);

    const groups = buildLocatorGroups(items, getFile);

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.markerCount).toBe(2);
    expect(groups[0]?.content.split("\n").map((line) => line.split("\t")[1])).toEqual([
      "01:00:02:00",
      "01:00:10:00",
    ]);
  });
});

describe("legacy flat export", () => {
  it("blocks zero items without creating the output directory", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "dailies-legacy-empty-"));
    const outDir = path.join(parent, "exports");

    expect(writeExport("locators", [], () => fileA, outDir)).toEqual({
      kind: "blocked",
      reason: "no-hits",
    });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("blocks the full export when any source file is missing", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "dailies-legacy-missing-"));
    const outDir = path.join(parent, "exports");
    const items: ExportItem[] = [
      {
        fileId: fileA.id,
        inTc: "01:00:05:00",
        outTc: "01:00:06:00",
        comment: "valid",
      },
      {
        fileId: 999,
        inTc: "01:00:10:00",
        outTc: "01:00:11:00",
        comment: "missing",
      },
    ];

    expect(writeExport("locators", items, (fileId) => fileId === fileA.id ? fileA : null, outDir))
      .toEqual({ kind: "blocked", reason: "no-valid-sources" });
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("unknown source edit rate exports", () => {
  const audioOnly: MediaFile = {
    ...fileA,
    id: 3,
    path: "/avid/AUDIO01.mxf",
    filename: "AUDIO01.mxf",
    fps: 0,
    startTc: "11:51:48:00",
    codec: "pcm_s24le",
    audioChannels: 1,
    fileHash: "audio",
    mediaKind: "opatom",
  };
  const item: ExportItem = {
    fileId: audioOnly.id,
    inTc: "+00:00:01.000",
    outTc: "+00:00:03.500",
    inS: 1,
    outS: 3.5,
    comment: "audio select",
  };

  it("uses seconds and labels the explicit EDL fallback instead of claiming 25 fps", () => {
    const edl = buildEdl("Audio", [item], () => audioOnly);
    expect(edl).toContain("11:51:49:00 11:51:51:15");
    expect(edl).toContain("SOURCE EDIT RATE UNKNOWN; 30 FPS FALLBACK");
    expect(edl).not.toContain("25 FPS");
  });

  it("labels the explicit locator fallback", () => {
    const locator = buildLocatorList([item], () => audioOnly);
    expect(locator).toContain("SOURCE RATE UNKNOWN; 30 FPS FALLBACK");
    expect(locator).toContain("\t11:51:49:00\t");
  });
});
