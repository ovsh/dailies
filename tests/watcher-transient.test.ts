/**
 * The watcher used to read ANY stat() error as "the file is gone" and report
 * a removal, which deletes the location and everything derived from it. On a
 * failing USB volume that turns an EIO or an unmount race into data loss.
 * Only the errors that mean the name no longer exists are removals.
 *
 * fs.watch is faked here so events can be driven directly — the real FSEvents
 * stream goes live asynchronously and would make the timing untestable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  emitEvent: null as null | ((event: string, filename: string) => void),
  closedWatchers: 0,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (
    _path: string,
    _options: unknown,
    listener: (event: string, filename: string) => void,
  ) => {
    mocks.emitEvent = listener;
    return {
      on: () => {},
      close: () => {
        mocks.closedWatchers += 1;
      },
    };
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: mocks.stat,
}));

import { createWatcher, type Watcher } from "../src/main/pipeline/watcher";

const STABILITY_MS = 20;
const ROOT = "/Volumes/USB DRIVE";

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: stat failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Long enough for the settle timer to fire twice over. */
function settleWindows(count = 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, STABILITY_MS * count + 20));
}

describe("watcher stat failures", () => {
  let watcher: Watcher | null = null;
  let found: string[] = [];
  let removed: string[] = [];
  let warn: ReturnType<typeof vi.spyOn>;

  function setup(): void {
    found = [];
    removed = [];
    watcher = createWatcher({
      onFileFound: (path) => found.push(path),
      onFileRemoved: (path) => removed.push(path),
      onDocFound: () => {},
      stabilityWindowMs: STABILITY_MS,
    });
    watcher.watchFolder(ROOT);
  }

  beforeEach(() => {
    mocks.stat.mockReset();
    mocks.emitEvent = null;
    mocks.closedWatchers = 0;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = null;
    vi.restoreAllMocks();
  });

  it("does not report a removal when stat fails with EIO", async () => {
    setup();
    mocks.stat.mockRejectedValue(errno("EIO"));

    mocks.emitEvent!("rename", "clip.mov");
    await settleWindows();

    expect(removed).toEqual([]);
    expect(found).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(join(ROOT, "clip.mov")),
    );
    expect(warn.mock.calls[0]?.[0]).toContain("EIO");
  });

  it.each(["EBUSY", "EACCES", "EPERM", "EMFILE"])(
    "does not report a removal when stat fails with %s",
    async (code) => {
      setup();
      mocks.stat.mockRejectedValue(errno(code));

      mocks.emitEvent!("rename", "clip.mov");
      await settleWindows();

      expect(removed).toEqual([]);
    },
  );

  it("reports a removal when stat fails with ENOENT", async () => {
    setup();
    mocks.stat.mockRejectedValue(errno("ENOENT"));

    mocks.emitEvent!("rename", "clip.mov");
    await waitFor(() => removed.length > 0);

    expect(removed).toEqual([join(ROOT, "clip.mov")]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a removal when stat fails with ENOTDIR", async () => {
    setup();
    mocks.stat.mockRejectedValue(errno("ENOTDIR"));

    mocks.emitEvent!("rename", "clip.mov");
    await waitFor(() => removed.length > 0);

    expect(removed).toEqual([join(ROOT, "clip.mov")]);
  });

  it("re-observes the path after a transient failure clears", async () => {
    setup();
    const clip = join(ROOT, "clip.mov");
    mocks.stat.mockRejectedValue(errno("EIO"));

    mocks.emitEvent!("rename", "clip.mov");
    await settleWindows();
    expect(removed).toEqual([]);

    // The drive comes back: a later watch event settles normally, proving the
    // dropped pending entry did not wedge the path.
    mocks.stat.mockReset().mockResolvedValue({ size: 42, mtimeMs: 1000 });
    mocks.emitEvent!("change", "clip.mov");
    await waitFor(() => found.includes(clip));

    expect(found).toEqual([clip]);
    expect(removed).toEqual([]);
  });
});
