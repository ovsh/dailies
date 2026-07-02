/**
 * Watches one or more folders for new/changed video files using chokidar,
 * and reports each stable file path back to the pipeline for enqueueing.
 */
import { basename, extname, sep } from "node:path";

import { watch, type FSWatcher } from "chokidar";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);

function isDotfile(path: string): boolean {
  return basename(path).startsWith(".");
}

function isInsideDailiesDir(path: string): boolean {
  return path.split(sep).includes(".dailies");
}

function isIgnored(path: string): boolean {
  return isDotfile(path) || isInsideDailiesDir(path);
}

export interface CreateWatcherOptions {
  onFileFound(path: string): void;
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
    const ext = extname(path).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) return;
    if (isIgnored(path)) return;
    opts.onFileFound(path);
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
