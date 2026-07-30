import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));
vi.mock("../src/main/pipeline/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/pipeline/exec")>()),
  run: mockRun,
}));

import { analyzeMxf, OpAtomGrouper, type MxfAtomInfo } from "../src/main/pipeline/opatom";

function audioProbe(tags: Record<string, string> = {}) {
  return JSON.stringify({
    streams: [{
      codec_type: "audio",
      codec_name: "pcm_s24le",
      avg_frame_rate: "0/0",
      r_frame_rate: "0/0",
      tags: { timecode: "11:51:48:00" },
    }],
    format: {
      duration: "10",
      tags: {
        material_package_umid: "umid-audio",
        material_package_name: "06252025/01",
        ...tags,
      },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  mockRun.mockReset();
});

describe("OP-Atom metadata and grouping", () => {
  it("uses an exposed audio package edit rate and otherwise keeps rate unknown", async () => {
    mockRun
      .mockResolvedValueOnce({ stdout: audioProbe({ material_package_track_edit_rate: "24000/1001" }), code: 0 })
      .mockResolvedValueOnce({ stdout: audioProbe(), code: 0 });

    expect((await analyzeMxf("ffprobe", "/avid/rated.mxf"))?.fps).toBeCloseTo(23.976, 3);
    expect((await analyzeMxf("ffprobe", "/avid/unknown.mxf"))?.fps).toBe(0);
  });

  it("emits a late atom in a fresh batch and releases fired group state", async () => {
    vi.useFakeTimers();
    const emitted: Array<{ atoms: MxfAtomInfo[] }> = [];
    const grouper = new OpAtomGrouper({ debounceMs: 20, onClip: (clip) => emitted.push(clip) });
    const internals = grouper as unknown as {
      groups: Map<string, MxfAtomInfo[]>;
      timers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const base = {
      clipKey: "umid-late",
      clipName: "Late Clip",
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
    };
    grouper.addAtom({ ...base, path: "/avid/A01.mxf", essence: "audio", codec: "pcm" });
    await vi.advanceTimersByTimeAsync(20);
    expect(emitted[0]?.atoms.map((atom) => atom.path)).toEqual(["/avid/A01.mxf"]);
    expect(internals.groups.size).toBe(0);
    expect(internals.timers.size).toBe(0);

    grouper.addAtom({ ...base, path: "/avid/V01.mxf", essence: "video", codec: "dnx" });
    await vi.advanceTimersByTimeAsync(20);
    expect(emitted[1]?.atoms.map((atom) => atom.path)).toEqual(["/avid/V01.mxf"]);
    expect(internals.groups.size).toBe(0);
    expect(internals.timers.size).toBe(0);
  });
});
