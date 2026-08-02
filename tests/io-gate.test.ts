/**
 * Per-volume read gate: concurrency cap, isolation between volumes, slot
 * release on failure, and volume-key derivation per platform.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetVolumeGatesForTests,
  EXTERNAL_VOLUME_READ_LIMIT,
  INTERNAL_VOLUME_READ_LIMIT,
  limitForVolumeKey,
  volumeKeyForPath,
  withVolumeRead,
} from "../src/main/pipeline/io-gate";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(err: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-queued microtask run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  __resetVolumeGatesForTests();
});

describe("withVolumeRead", () => {
  it("never runs more than the external limit at once on one volume", async () => {
    const gates = Array.from({ length: 5 }, () => deferred());
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];

    const runs = gates.map((gate, i) =>
      withVolumeRead(
        `/Volumes/X/clip-${i}.mxf`,
        async () => {
          started.push(i);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await gate.promise;
          inFlight -= 1;
        },
        { platform: "darwin" },
      ),
    );

    await settle();
    expect(inFlight).toBe(EXTERNAL_VOLUME_READ_LIMIT);
    expect(started).toEqual([0, 1]);

    // FIFO: releasing the first slot admits the next waiter in order.
    gates[0].resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);

    expect(peak).toBe(EXTERNAL_VOLUME_READ_LIMIT);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not let one volume block another", async () => {
    const blockers = [deferred(), deferred()];
    const other = deferred();
    let otherStarted = false;

    const busy = blockers.map((gate) =>
      withVolumeRead("/Volumes/Busy/a.mxf", () => gate.promise, { platform: "darwin" }),
    );
    const free = withVolumeRead(
      "/Volumes/Free/b.mxf",
      async () => {
        otherStarted = true;
        await other.promise;
      },
      { platform: "darwin" },
    );

    await settle();
    expect(otherStarted).toBe(true);

    other.resolve();
    await free;
    for (const gate of blockers) gate.resolve();
    await Promise.all(busy);
  });

  it("releases the slot when the gated function rejects", async () => {
    const failing = Array.from({ length: 2 }, () => deferred());
    let laterStarted = false;

    const rejected = failing.map((gate) =>
      withVolumeRead("/Volumes/X/bad.mxf", () => gate.promise, { platform: "darwin" }).catch(
        (err: unknown) => (err as Error).message,
      ),
    );
    const waiter = withVolumeRead(
      "/Volumes/X/good.mxf",
      async () => {
        laterStarted = true;
      },
      { platform: "darwin" },
    );

    await settle();
    expect(laterStarted).toBe(false);

    failing[0].reject(new Error("read failed"));
    await settle();
    expect(laterStarted).toBe(true);

    failing[1].resolve();
    expect(await rejected[0]).toBe("read failed");
    await Promise.all([...rejected, waiter]);
  });
});

describe("volumeKeyForPath", () => {
  it("keys darwin paths by mounted volume", () => {
    expect(volumeKeyForPath("/Volumes/Drive/a/b", "darwin")).toBe("/Volumes/Drive");
    expect(volumeKeyForPath("/Volumes/G-DRIVE mob/Avid MediaFiles/MXF/1/x.mxf", "darwin")).toBe(
      "/Volumes/G-DRIVE mob",
    );
    expect(volumeKeyForPath("/Volumes/Drive", "darwin")).toBe("/Volumes/Drive");
    expect(volumeKeyForPath("/Users/x/Movies/a.mov", "darwin")).toBe("internal");
    expect(volumeKeyForPath("/Volumes/", "darwin")).toBe("internal");
  });

  it("keys win32 paths by drive letter or UNC share", () => {
    expect(volumeKeyForPath("E:\\media\\a.mxf", "win32")).toBe("E:");
    expect(volumeKeyForPath("e:/media/a.mxf", "win32")).toBe("E:");
    expect(volumeKeyForPath("C:\\Users\\x\\a.mov", "win32")).toBe("C:");
    expect(volumeKeyForPath("\\\\server\\share\\a\\b.mxf", "win32")).toBe("\\\\server\\share");
    expect(volumeKeyForPath("media\\a.mxf", "win32")).toBe("internal");
  });

  it("treats every other platform as internal", () => {
    expect(volumeKeyForPath("/mnt/drive/a.mxf", "linux")).toBe("internal");
  });
});

describe("limitForVolumeKey", () => {
  it("gives external volumes the conservative limit and internal the wider one", () => {
    expect(limitForVolumeKey("internal", "darwin")).toBe(INTERNAL_VOLUME_READ_LIMIT);
    expect(limitForVolumeKey("/Volumes/G-DRIVE mob", "darwin")).toBe(EXTERNAL_VOLUME_READ_LIMIT);
    expect(limitForVolumeKey("C:", "win32")).toBe(INTERNAL_VOLUME_READ_LIMIT);
    expect(limitForVolumeKey("E:", "win32")).toBe(EXTERNAL_VOLUME_READ_LIMIT);
    expect(limitForVolumeKey("\\\\server\\share", "win32")).toBe(EXTERNAL_VOLUME_READ_LIMIT);
  });
});
