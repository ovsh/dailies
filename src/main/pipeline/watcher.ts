/**
 * Watches one or more folders for new/changed video files using chokidar,
 * and reports each stable file path back to the pipeline for enqueueing.
 */
import { basename, extname, sep } from "node:path";

import { watch, type FSWatcher } from "chokidar";

import { DOC_EXTENSIONS } from "./docs";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);
const DOC_EXTENSIONS_SET = new Set(DOC_EXTENSIONS);

// Avid MXF sidecar database files — not media, and not documents either.
const AVID_DB_FILENAMES = new Set(["msmMMOB.mdb", "msmFMID.pmr"]);

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
  onDocFound(path: string): void;
}

export interface Watcher {
  watchFolder(path: string): void;
  unwatchFolder(path: string): void;
  close(): Promise<void>;
}

export function createWatcher(opts: CreateWatcherOptions): Watcher {
  const fsWatcher: FSWatcher = watch([], {
    persistent: true,
    ignoreInitial: true,
    ignored: (path: string) => isIgnored(path),
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval: 100,
    },
  });

  fsWatcher.on("add", (path: string) => {
    if (isIgnored(path)) return;
    const ext = extname(path).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) {
      opts.onFileFound(path);
    } else if (DOC_EXTENSIONS_SET.has(ext)) {
      opts.onDocFound(path);
    }
  });

  return {
    watchFolder(path: string): void {
      fsWatcher.add(path);
    },
    unwatchFolder(path: string): void {
      fsWatcher.unwatch(path);
    },
    close(): Promise<void> {
      return fsWatcher.close();
    },
  };
}
