/**
 * Watches folders for new/changed video files and reports each stable path
 * back to the pipeline for enqueueing.
 *
 * Built on fs.watch(root, { recursive: true }) — FSEvents on macOS and
 * ReadDirectoryChangesW on Windows — which costs O(1) handles per watched root. A per-file
 * watcher backend (chokidar v4+ uses kqueue, one fd per file) exhausts the
 * process fd table on a real Avid MediaFiles tree (tens of thousands of
 * atoms), after which every child_process spawn in the app fails with EBADF.
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";

import { DOC_EXTENSIONS } from "./docs";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);
const DOC_EXTENSIONS_SET = new Set(DOC_EXTENSIONS);

// Avid MXF sidecar database files — not media, and not documents either.
const AVID_DB_FILENAMES = new Set(["msmMMOB.mdb", "msmFMID.pmr"]);

const DEFAULT_STABILITY_WINDOW_MS = 3000;

function isDotfile(path: string): boolean {
  return basename(path).startsWith(".");
}

function isInsideDailiesDir(path: string): boolean {
  return path.split(sep).includes(".dailies");
}

function isAvidDbFile(path: string): boolean {
  return AVID_DB_FILENAMES.has(basename(path));
}

function isIgnored(path: string): boolean {
  return isDotfile(path) || isInsideDailiesDir(path) || isAvidDbFile(path);
}

export interface CreateWatcherOptions {
  onFileFound(path: string): void;
  onFileRemoved(path: string): void;
  onDocFound(path: string): void;
  /** Quiet period a file must hold size+mtime before it is reported. */
  stabilityWindowMs?: number;
}

export interface Watcher {
  /**
   * Events that occur before the underlying OS stream goes live (an async
   * startup after fs.watch returns) are silently lost — callers must pair
   * this with a scan of the folder, as the pipeline's scanFolder does.
   */
  watchFolder(path: string): void;
  unwatchFolder(path: string): void;
  close(): Promise<void>;
}

interface PendingPath {
  timer: NodeJS.Timeout;
  size: number;
  mtimeMs: number;
}

export function createWatcher(opts: CreateWatcherOptions): Watcher {
  const stabilityWindowMs = opts.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
  const roots = new Map<string, FSWatcher>();
  const pending = new Map<string, PendingPath>();
  let closed = false;

  function classify(path: string): "video" | "doc" | null {
    if (isIgnored(path)) return null;
    const ext = extname(path).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (DOC_EXTENSIONS_SET.has(ext)) return "doc";
    return null;
  }

  function emit(path: string, kind: "video" | "doc", exists: boolean): void {
    if (closed) return;
    if (!exists) {
      if (kind === "video") opts.onFileRemoved(path);
      return;
    }
    if (kind === "video") opts.onFileFound(path);
    else opts.onDocFound(path);
  }

  /**
   * Settle a path: after the stability window, re-stat. A file still growing
   * (copy in progress) re-arms the window with the newer size/mtime; a file
   * unchanged across the whole window is reported.
   */
  async function settle(path: string, kind: "video" | "doc"): Promise<void> {
    const entry = pending.get(path);
    if (!entry || closed) return;
    let current: { size: number; mtimeMs: number } | null;
    try {
      const s = await stat(path);
      current = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      current = null;
    }
    if (closed || pending.get(path) !== entry) return;
    if (current === null) {
      pending.delete(path);
      emit(path, kind, false);
      return;
    }
    if (current.size !== entry.size || current.mtimeMs !== entry.mtimeMs) {
      entry.size = current.size;
      entry.mtimeMs = current.mtimeMs;
      entry.timer.refresh();
      return;
    }
    pending.delete(path);
    emit(path, kind, true);
  }

  function schedule(path: string, kind: "video" | "doc"): void {
    const existing = pending.get(path);
    if (existing) {
      existing.timer.refresh();
      return;
    }
    const entry: PendingPath = {
      timer: setTimeout(() => void settle(path, kind), stabilityWindowMs),
      size: -1,
      mtimeMs: -1,
    };
    entry.timer.unref?.();
    pending.set(path, entry);
  }

  function onEvent(root: string, filename: string | Buffer | null): void {
    if (closed || filename === null) return;
    const relative = typeof filename === "string" ? filename : filename.toString("utf8");
    const path = join(root, relative);
    const kind = classify(path);
    if (kind) schedule(path, kind);
  }

  return {
    watchFolder(path: string): void {
      if (closed || roots.has(path)) return;
      try {
        const fsWatcher = watch(path, { recursive: true, persistent: true }, (_event, filename) =>
          onEvent(path, filename),
        );
        fsWatcher.on("error", (err) => {
          console.warn(`[watcher] error on ${path}:`, err);
        });
        roots.set(path, fsWatcher);
      } catch (err) {
        // An unmounted drive or deleted folder must never take the app down;
        // the next watchFolder call (folder re-added, project reopened)
        // retries.
        console.warn(`[watcher] cannot watch ${path}:`, err);
      }
    },

    unwatchFolder(path: string): void {
      const fsWatcher = roots.get(path);
      if (!fsWatcher) return;
      roots.delete(path);
      fsWatcher.close();
      for (const [pendingPath, entry] of pending) {
        if (pendingPath === path || pendingPath.startsWith(`${path}${sep}`)) {
          clearTimeout(entry.timer);
          pending.delete(pendingPath);
        }
      }
    },

    close(): Promise<void> {
      closed = true;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      for (const fsWatcher of roots.values()) fsWatcher.close();
      roots.clear();
      return Promise.resolve();
    },
  };
}
