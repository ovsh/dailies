import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

import type { DailiesDB } from "../db/types";
import type {
  FileInput,
  MediaRole,
  ProjectFolder,
} from "../../shared/types";
import { findFfprobeBinary } from "./binaries";
import { DOC_EXTENSIONS, extractDocument } from "./docs";
import { analyzeMxf, OpAtomGrouper, type MxfAtomInfo, type OpAtomClip } from "./opatom";
import { computeFileIdentity } from "./probe";
import { createWatcher } from "./watcher";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);
const DOC_EXTENSIONS_SET = new Set(DOC_EXTENSIONS);
const SCAN_STABILITY_WINDOW_MS = 3000;

export interface DiscoveryOptions {
  db: DailiesDB;
  embedDocChunks: () => Promise<void>;
  onUpdate: () => void;
  scheduleUpdate: () => void;
  reconcile: (fileId: number) => void;
  ensureWork: (fileId: number) => void;
  delay: (ms: number) => Promise<void>;
}

export interface Discovery {
  watchFolder(folder: ProjectFolder): void;
  unwatchFolder(path: string): void;
  scanFolder(folder: ProjectFolder): Promise<void>;
  ingestDocument(path: string, episodeId: number | null): Promise<boolean>;
  close(): Promise<void>;
}

function parseMemberHashMap(fileHash: string): Map<string, string> {
  const members = new Map<string, string>();
  if (!fileHash) return members;
  for (const entry of fileHash.split("|")) {
    const separator = entry.lastIndexOf(":");
    const path = entry.slice(0, separator);
    const hash = entry.slice(separator + 1);
    if (separator <= 0 || !path || !/^[a-f0-9]{40}$/i.test(hash)) return new Map();
    members.set(path, hash);
  }
  return members;
}

function isUnchangedSuperset(oldFileHash: string, newMap: Map<string, string>): boolean {
  const oldMap = parseMemberHashMap(oldFileHash);
  if (oldMap.size === 0) return false;
  for (const [path, hash] of oldMap) {
    if (newMap.get(path) !== hash) return false;
  }
  return true;
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".dailies") continue;
      found.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function createDiscovery(opts: DiscoveryOptions): Discovery {
  const {
    db,
    embedDocChunks,
    onUpdate,
    scheduleUpdate,
    reconcile,
    ensureWork,
    delay,
  } = opts;

  // Watched project folders, used to resolve a discovered file's/document's
  // role and episodeId by longest-prefix match. Default role "raw",
  // default episodeId null.
  const watchedFolders: ProjectFolder[] = [];
  const opAtomClipTails = new Map<string, Promise<void>>();

  /** Longest-prefix-matching watched folder for `path`, if any. */
  function folderForPath(path: string): ProjectFolder | null {
    let best: ProjectFolder | null = null;
    for (const folder of watchedFolders) {
      if (!path.startsWith(folder.path)) continue;
      if (!best || folder.path.length > best.path.length) {
        best = folder;
      }
    }
    return best;
  }

  function roleForPath(path: string): MediaRole {
    return folderForPath(path)?.role ?? "raw";
  }

  function episodeIdForPath(path: string): number | null {
    return folderForPath(path)?.episodeId ?? null;
  }

  async function onDocFound(path: string): Promise<void> {
    try {
      if (db.getDocumentByPath(path)) return;

      const doc = await extractDocument(path, episodeIdForPath(path));
      if (!doc) return;

      db.upsertDocument(doc);
      await embedDocChunks();
      onUpdate();
    } catch (err) {
      console.error(`[pipeline] failed to ingest document ${path}:`, err);
    }
  }

  /**
   * Direct entry for the Import button. Unlike onDocFound (the watcher/scan
   * path), this always (re-)ingests: upsertDocument replaces any existing
   * record at the same path.
   */
  async function ingestDocument(path: string, episodeId: number | null): Promise<boolean> {
    try {
      const doc = await extractDocument(path, episodeId);
      if (!doc) return false;

      db.upsertDocument(doc);
      await embedDocChunks();
      onUpdate();
      return true;
    } catch (err) {
      console.error(`[pipeline] failed to ingest document ${path}:`, err);
      return false;
    }
  }

  const grouper = new OpAtomGrouper({
    onClip: (clip) => {
      queueOpAtomClip(clip);
    },
  });

  function queueOpAtomClip(clip: OpAtomClip): void {
    const previous = opAtomClipTails.get(clip.clipKey) ?? Promise.resolve();
    const current = previous
      .then(() => onOpAtomClip(clip))
      .catch((err: unknown) => {
        console.error(`[pipeline] failed to update OP-Atom clip ${clip.clipKey}:`, err);
      });
    opAtomClipTails.set(clip.clipKey, current);
    void current.then(() => {
      if (opAtomClipTails.get(clip.clipKey) === current) {
        opAtomClipTails.delete(clip.clipKey);
      }
    });
  }

  async function onOpAtomClip(clip: OpAtomClip): Promise<void> {
    const existing = db.getFileByClipKey(clip.clipKey);
    const atomByPath = new Map(clip.atoms.map((atom) => [atom.path, atom]));
    for (const path of existing?.memberPaths ?? []) {
      if (atomByPath.has(path)) continue;
      const restored = await analyzeMxf(findFfprobeBinary(), path);
      if (restored?.clipKey === clip.clipKey) atomByPath.set(path, restored);
    }

    const atoms = [...atomByPath.values()];
    const byPath = (a: MxfAtomInfo, b: MxfAtomInfo) => a.path.localeCompare(b.path);
    const videoAtoms = atoms.filter((a) => a.essence === "video").sort(byPath);
    const audioAtoms = atoms.filter((a) => a.essence === "audio").sort(byPath);
    const primaryAtom = videoAtoms[0] ?? audioAtoms[0];
    if (!primaryAtom) return;

    // Ordered [videoAtoms..., audioAtoms...] with the primary path always
    // first, so the audio stage can iterate in a predictable order and the
    // proxy/scenes stages can tell a video atom exists via memberPaths[0].
    const memberPaths = [...videoAtoms, ...audioAtoms].map((a) => a.path);

    const memberHashes = await Promise.all(
      memberPaths.map(async (path) => `${path}:${await computePartialHashSafe(path)}`),
    );
    const fileHash = memberHashes.join("|");
    const newHashMap = parseMemberHashMap(fileHash);
    if (
      existing &&
      existing.memberPaths &&
      existing.memberPaths.length === memberPaths.length &&
      existing.memberPaths.every((path, index) => path === memberPaths[index]) &&
      existing.fileHash === fileHash
    ) {
      reconcile(existing.id);
      ensureWork(existing.id);
      return;
    }

    const input: FileInput = {
      path: primaryAtom.path,
      filename: clip.clipName ?? basenameOf(primaryAtom.path),
      durationS: Math.max(...atoms.map((a) => a.durationS)),
      fps: videoAtoms[0]?.fps ?? audioAtoms.find((atom) => atom.fps > 0)?.fps ?? 0,
      dropFrame: (videoAtoms[0] ?? audioAtoms[0])?.dropFrame ?? false,
      startTc: (videoAtoms[0] ?? audioAtoms[0])?.startTc ?? "00:00:00:00",
      codec: primaryAtom.codec,
      audioChannels: audioAtoms.length > 0 ? 1 : 0,
      fileHash,
      role: roleForPath(primaryAtom.path),
      episodeId: episodeIdForPath(primaryAtom.path),
      clipName: atoms.find((atom) => atom.clipName)?.clipName ?? clip.clipName,
      mediaKind: "opatom",
      memberPaths,
      clipKey: clip.clipKey,
      hasVideo: videoAtoms.length > 0,
    };

    if (existing && isUnchangedSuperset(existing.fileHash, newHashMap)) {
      // Member set grew (e.g. video atom finally landed) but every
      // previously-known atom is byte-identical — preserve finished work.
      const updated = db.updateOpAtomMembers(existing.id, input);
      reconcile(updated.id);
      ensureWork(updated.id);
      scheduleUpdate();
      return;
    }

    const file = db.upsertFile(input);
    db.enqueueJob(file.id, "probe");
    reconcile(file.id);
    scheduleUpdate();
  }

  /** Hash one member without probing its media streams again. */
  async function computePartialHashSafe(path: string): Promise<string> {
    try {
      return (await computeFileIdentity(path)).fileHash;
    } catch {
      return "";
    }
  }

  async function onFileFound(path: string): Promise<void> {
    const ext = extname(path).toLowerCase();

    if (ext === ".mxf") {
      const ffprobeBin = findFfprobeBinary();
      const atomInfo: MxfAtomInfo | null = await analyzeMxf(ffprobeBin, path);
      if (atomInfo) {
        grouper.addAtom(atomInfo);
        return;
      }
      // Not OP-Atom (e.g. carries both audio and video) — fall through to
      // standard ingest below.
    }

    const existing = db.getFileByPath(path);

    let identity: Awaited<ReturnType<typeof computeFileIdentity>>;
    try {
      identity = await computeFileIdentity(path);
    } catch (err) {
      // Unreadable media (corrupt file, unsupported MXF variant) must remain
      // VISIBLE as an error rather than silently disappearing — otherwise the
      // clip count doesn't match what the editor put in the folder and it
      // looks like the app "lost" a file. Record a stub in error state.
      let unreadable = existing;
      if (!unreadable) {
        unreadable = db.upsertFile({
          path,
          filename: basenameOf(path),
          durationS: 0,
          fps: 0,
          dropFrame: false,
          startTc: "00:00:00:00",
          codec: "unknown",
          audioChannels: 0,
          fileHash: `unreadable:${path}`,
          role: roleForPath(path),
          episodeId: episodeIdForPath(path),
        });
      }
      db.setDiscoveryFailed(unreadable.id, true);
      reconcile(unreadable.id);
      scheduleUpdate();
      console.warn(`onFileFound: unreadable media ${path}:`, err);
      return;
    }
    if (existing?.discoveryFailed) db.setDiscoveryFailed(existing.id, false);

    if (!existing) {
      const byHash = db.getFileByHash(identity.fileHash);
      if (
        byHash?.mediaKind === "standard" &&
        byHash.path !== path &&
        !existsSync(byHash.path)
      ) {
        // A remounted drive or renamed folder changes the absolute path but
        // not the content hash, so keep the existing clip's derived state.
        const repointed = db.repointFilePath(byHash.id, path, identity.filename);
        reconcile(repointed.id);
        ensureWork(repointed.id);
        scheduleUpdate();
        return;
      }
    }

    if (existing && existing.fileHash === identity.fileHash) {
      // File identity is unchanged, but derived processing may be incomplete.
      reconcile(existing.id);
      ensureWork(existing.id);
      return;
    }

    const file = db.upsertFile({
      path: identity.path,
      filename: identity.filename,
      durationS: existing?.durationS ?? 0,
      fps: existing?.fps ?? 0,
      dropFrame: existing?.dropFrame ?? false,
      startTc: existing?.startTc ?? "00:00:00:00",
      codec: existing?.codec ?? "unknown",
      audioChannels: existing?.audioChannels ?? 0,
      fileHash: identity.fileHash,
      role: roleForPath(path),
      episodeId: episodeIdForPath(path),
    });
    db.setFileHasVideo(file.id, null);
    db.enqueueJob(file.id, "probe");
    reconcile(file.id);
    scheduleUpdate();
  }

  const watcher = createWatcher({
    onFileFound: (path) => {
      void onFileFound(path);
    },
    onDocFound: (path) => {
      void onDocFound(path);
    },
  });

  function watchFolder(folder: ProjectFolder): void {
    watchedFolders.push(folder);
    watcher.watchFolder(folder.path);
  }

  function unwatchFolder(path: string): void {
    const idx = watchedFolders.findIndex((f) => f.path === path);
    if (idx >= 0) watchedFolders.splice(idx, 1);
    watcher.unwatchFolder(path);
  }

  async function isStableForScan(path: string): Promise<boolean> {
    try {
      const first = await stat(path);
      if (Date.now() - first.mtimeMs >= SCAN_STABILITY_WINDOW_MS) return true;
      await delay(SCAN_STABILITY_WINDOW_MS);
      const second = await stat(path);
      return first.size === second.size && first.mtimeMs === second.mtimeMs;
    } catch {
      return false;
    }
  }

  async function scanFolder(folder: ProjectFolder): Promise<void> {
    // A missing folder (unmounted drive, deleted path) must never take the
    // app down — skip quietly; the watcher recovers when it reappears.
    let files: string[];
    try {
      files = await walkFiles(folder.path);
    } catch (err) {
      console.warn(`scanFolder: cannot read ${folder.path}:`, err);
      return;
    }
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      try {
        if (VIDEO_EXTENSIONS.has(ext)) {
          if (!(await isStableForScan(file))) {
            console.warn(
              `scanFolder: ${file} is still being written; the watcher will pick it up`,
            );
            continue;
          }
          await onFileFound(file);
        } else if (DOC_EXTENSIONS_SET.has(ext)) {
          await onDocFound(file);
        }
      } catch (err) {
        console.warn(`scanFolder: failed on ${file}:`, err);
      }
    }
  }

  async function close(): Promise<void> {
    grouper.close();
    await watcher.close();
    await Promise.all(opAtomClipTails.values());
  }

  return {
    watchFolder,
    unwatchFolder,
    scanFolder,
    ingestDocument,
    close,
  };
}
