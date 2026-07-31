import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWatcher, type Watcher } from "../src/main/pipeline/watcher";

const STABILITY_MS = 60;

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("watcher", () => {
  let dir: string;
  let watcher: Watcher | null = null;

  afterEach(async () => {
    await watcher?.close();
    watcher = null;
    rmSync(dir, { recursive: true, force: true });
  });

  interface Sinks {
    found: string[];
    removed: string[];
    docs: string[];
  }

  function setup(): Sinks {
    dir = mkdtempSync(join(tmpdir(), "dailies-watcher-"));
    const found: string[] = [];
    const removed: string[] = [];
    const docs: string[] = [];
    watcher = createWatcher({
      onFileFound: (path) => found.push(path),
      onFileRemoved: (path) => removed.push(path),
      onDocFound: (path) => docs.push(path),
      stabilityWindowMs: STABILITY_MS,
    });
    return { found, removed, docs };
  }

  /**
   * fs.watch() returns before the underlying FSEvents stream is live, and
   * events raised in that startup window are silently lost (the stream only
   * reports from the moment it starts). Under full-suite load the window
   * stretches to tens of milliseconds — long enough to swallow a test's only
   * write. Production is immune because every watchFolder is paired with a
   * scanFolder sweep; the tests instead prove the stream is live by touching
   * a probe file until the watcher reports it, then reset the sinks.
   */
  async function watchUntilLive(sinks: Sinks): Promise<void> {
    watcher!.watchFolder(dir);
    const probe = join(dir, "probe-live.mxf");
    writeFileSync(probe, "probe");
    const startedAt = Date.now();
    let lastTouch = Date.now();
    while (!sinks.found.includes(probe)) {
      if (Date.now() - startedAt > 10_000) {
        throw new Error("watcher never became live");
      }
      await new Promise((r) => setTimeout(r, 20));
      // Re-touch only after a full settle cycle has had room to run, so the
      // stability window is never starved by the probe writes themselves.
      if (!sinks.found.includes(probe) && Date.now() - lastTouch >= STABILITY_MS * 3) {
        writeFileSync(probe, "probe", { flag: "a" });
        lastTouch = Date.now();
      }
    }
    sinks.found.length = 0;
    sinks.removed.length = 0;
    sinks.docs.length = 0;
  }

  it("reports a new video file once it is stable", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    const file = join(dir, "clip.mxf");
    writeFileSync(file, "atom");
    await waitFor(() => sinks.found.includes(file));
    expect(sinks.found).toContain(file);
  });

  it("reports files created in nested directories", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    const nested = join(dir, "Avid MediaFiles", "MXF", "1");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "a01.mxf");
    writeFileSync(file, "atom");
    await waitFor(() => sinks.found.includes(file));
    expect(sinks.found).toContain(file);
  });

  it("reports documents through onDocFound", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    const file = join(dir, "notes.pdf");
    writeFileSync(file, "pdf");
    await waitFor(() => sinks.docs.includes(file));
    expect(sinks.docs).toContain(file);
  });

  it("ignores dotfiles and Avid sidecar databases", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    writeFileSync(join(dir, ".hidden.mxf"), "x");
    writeFileSync(join(dir, "msmMMOB.mdb"), "x");
    const marker = join(dir, "real.mxf");
    writeFileSync(marker, "x");
    await waitFor(() => sinks.found.includes(marker));
    expect(sinks.found).toEqual([marker]);
    expect(sinks.docs).toEqual([]);
  });

  it("reports a deleted video file as removed", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    await waitFor(() => sinks.found.includes(file));
    unlinkSync(file);
    await waitFor(() => sinks.removed.includes(file));
    expect(sinks.removed).toContain(file);
  });

  it("waits for a growing file to stop changing", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    const file = join(dir, "copying.mxf");
    writeFileSync(file, "start");
    // Keep appending within the stability window; the watcher must not
    // report the path until writes stop.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, STABILITY_MS / 3));
      writeFileSync(file, `more-${i}`, { flag: "a" });
      expect(sinks.found).not.toContain(file);
    }
    await waitFor(() => sinks.found.includes(file));
    expect(sinks.found).toContain(file);
  });

  it("stops reporting after unwatchFolder and close", async () => {
    const sinks = setup();
    await watchUntilLive(sinks);
    const first = join(dir, "a.mxf");
    writeFileSync(first, "x");
    await waitFor(() => sinks.found.includes(first));
    watcher!.unwatchFolder(dir);
    writeFileSync(join(dir, "b.mxf"), "x");
    await new Promise((r) => setTimeout(r, STABILITY_MS * 3));
    expect(sinks.found).toEqual([first]);
  });

  it("survives watching a missing folder", () => {
    setup();
    expect(() => watcher!.watchFolder(join(dir, "does-not-exist"))).not.toThrow();
  });
});
