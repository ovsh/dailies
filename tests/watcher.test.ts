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

  function setup() {
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

  it("reports a new video file once it is stable", async () => {
    const { found } = setup();
    watcher!.watchFolder(dir);
    const file = join(dir, "clip.mxf");
    writeFileSync(file, "atom");
    await waitFor(() => found.includes(file));
    expect(found).toContain(file);
  });

  it("reports files created in nested directories", async () => {
    const { found } = setup();
    watcher!.watchFolder(dir);
    const nested = join(dir, "Avid MediaFiles", "MXF", "1");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "a01.mxf");
    writeFileSync(file, "atom");
    await waitFor(() => found.includes(file));
    expect(found).toContain(file);
  });

  it("reports documents through onDocFound", async () => {
    const { docs } = setup();
    watcher!.watchFolder(dir);
    const file = join(dir, "notes.pdf");
    writeFileSync(file, "pdf");
    await waitFor(() => docs.includes(file));
    expect(docs).toContain(file);
  });

  it("ignores dotfiles and Avid sidecar databases", async () => {
    const { found, docs } = setup();
    watcher!.watchFolder(dir);
    writeFileSync(join(dir, ".hidden.mxf"), "x");
    writeFileSync(join(dir, "msmMMOB.mdb"), "x");
    const marker = join(dir, "real.mxf");
    writeFileSync(marker, "x");
    await waitFor(() => found.includes(marker));
    expect(found).toEqual([marker]);
    expect(docs).toEqual([]);
  });

  it("reports a deleted video file as removed", async () => {
    const { found, removed } = setup();
    watcher!.watchFolder(dir);
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    await waitFor(() => found.includes(file));
    unlinkSync(file);
    await waitFor(() => removed.includes(file));
    expect(removed).toContain(file);
  });

  it("waits for a growing file to stop changing", async () => {
    const { found } = setup();
    watcher!.watchFolder(dir);
    const file = join(dir, "copying.mxf");
    writeFileSync(file, "start");
    // Keep appending within the stability window; the watcher must not
    // report the path until writes stop.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, STABILITY_MS / 3));
      writeFileSync(file, `more-${i}`, { flag: "a" });
      expect(found).not.toContain(file);
    }
    await waitFor(() => found.includes(file));
    expect(found).toContain(file);
  });

  it("stops reporting after unwatchFolder and close", async () => {
    const { found } = setup();
    watcher!.watchFolder(dir);
    const first = join(dir, "a.mxf");
    writeFileSync(first, "x");
    await waitFor(() => found.includes(first));
    watcher!.unwatchFolder(dir);
    writeFileSync(join(dir, "b.mxf"), "x");
    await new Promise((r) => setTimeout(r, STABILITY_MS * 3));
    expect(found).toEqual([first]);
  });

  it("survives watching a missing folder", () => {
    setup();
    expect(() => watcher!.watchFolder(join(dir, "does-not-exist"))).not.toThrow();
  });
});
