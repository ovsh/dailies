import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join, parse as parsePath } from "node:path";

import type { DailiesDB, FileLocationRemoval } from "../db/types";
import type {
  FileInput,
  FileLocation,
  MediaFile,
  MediaRole,
  ProjectFolder,
} from "../../shared/types";
import { normalizeClipName } from "../../shared/types";
import { reconcileEpisodeMembership } from "../membership";
import { usesFullContentHash } from "../file-hash";
import { findFfprobeBinary } from "./binaries";
import { DOC_EXTENSIONS, extractDocument } from "./docs";
import { isSystemicSpawnError } from "./exec";
import { analyzeMxf, OpAtomGrouper, type MxfAtomInfo, type OpAtomClip } from "./opatom";
import { computeFileIdentity } from "./probe";
import { createWatcher, type Watcher } from "./watcher";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mxf", ".avi", ".m4v", ".mts"]);
const DOC_EXTENSIONS_SET = new Set(DOC_EXTENSIONS);
const SCAN_STABILITY_WINDOW_MS = 3000;
export const DISCOVERY_CLOSE_TIMEOUT_MS = 10_000;

export interface DiscoveryOptions {
  db: DailiesDB;
  embedDocChunks: () => Promise<void>;
  onUpdate: () => void;
  scheduleUpdate: () => void;
  reconcile: (fileId: number) => void;
  ensureWork: (fileId: number) => void;
  onFileDeleted: (fileId: number) => void;
  delay: (ms: number) => Promise<void>;
}

export interface Discovery {
  watchFolder(folder: ProjectFolder): void;
  unwatchFolder(path: string): void;
  scanFolder(folder: ProjectFolder): Promise<void>;
  ingestDocument(path: string, episodeId: number | null): Promise<boolean>;
  close(mode?: "drain" | "abort"): Promise<void>;
}

interface LocatedFile {
  file: MediaFile;
  location: FileLocation;
}

interface OpAtomBundle {
  key: string;
  folderId: number | null;
  root: string;
}

interface PendingOpAtomClip {
  bundle: OpAtomBundle;
  clip: OpAtomClip;
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
    onFileDeleted,
    delay,
  } = opts;

  const watchedFolders: ProjectFolder[] = [];
  const discoveryTasks = new Set<Promise<void>>();
  const opAtomClipTails = new Map<string, Promise<void>>();
  const pendingOpAtomClips = new Map<string, PendingOpAtomClip>();
  const groupers = new Map<string, OpAtomGrouper>();
  let lifecycle: "open" | "closing" | "closed" = "open";
  let closeMode: "drain" | "abort" = "drain";
  let watcher: Watcher | null = null;
  let closeTask: Promise<void> | null = null;

  function openTaskIntake(): boolean {
    if (lifecycle === "closing") return false;
    if (lifecycle === "closed") {
      lifecycle = "open";
      closeTask = null;
    }
    return true;
  }

  function trackTask<T>(task: Promise<T>): Promise<T> {
    const owned = task.then(
      () => undefined,
      () => undefined,
    );
    discoveryTasks.add(owned);
    void owned.then(() => discoveryTasks.delete(owned));
    return task;
  }

  function pathIsWithin(path: string, root: string): boolean {
    const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
    return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
  }

  function folderForPath(path: string): ProjectFolder | null {
    let best: ProjectFolder | null = null;
    for (const folder of watchedFolders) {
      if (!pathIsWithin(path, folder.path)) continue;
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

  function locationForPath(path: string): LocatedFile | null {
    for (const file of db.listFiles()) {
      const location = file.locations?.find((candidate) => candidate.path === path);
      if (location) return { file, location };
    }
    return null;
  }

  function locationContainingMember(path: string): LocatedFile | null {
    for (const file of db.listFiles()) {
      const location = file.locations?.find((candidate) =>
        candidate.memberPaths?.includes(path) ?? false
      );
      if (location) return { file, location };
    }
    return null;
  }

  function reconcileMemberships(
    paths: string[],
    additionalFolderEpisodes: Iterable<number> = [],
  ): void {
    const episodeIds = new Set(additionalFolderEpisodes);
    for (const folder of db.listFolders()) {
      if (
        folder.episodeId !== null &&
        paths.some((path) => pathIsWithin(path, folder.path))
      ) {
        episodeIds.add(folder.episodeId);
      }
    }
    for (const episode of db.listEpisodes()) {
      if (db.getEpisodeMembershipSource(episode.id) === "list") {
        episodeIds.add(episode.id);
      }
    }
    for (const episodeId of episodeIds) {
      reconcileEpisodeMembership(db, episodeId);
    }
  }

  function removeLocation(path: string): FileLocationRemoval | null {
    const removal = db.removeFileLocation(path);
    if (removal?.kind === "deleted") onFileDeleted(removal.file.id);
    return removal;
  }

  function bundleForPath(path: string): OpAtomBundle {
    const folder = folderForPath(path);
    if (folder) {
      return {
        key: `folder:${folder.id}`,
        folderId: folder.id,
        root: folder.path,
      };
    }
    const root = dirname(path);
    return {
      key: `path:${root}`,
      folderId: null,
      root,
    };
  }

  function bundleForLocation(location: FileLocation): OpAtomBundle {
    const folder = location.folderId === null
      ? null
      : db.listFolders().find((candidate) => candidate.id === location.folderId) ?? null;
    if (folder) {
      return {
        key: `folder:${folder.id}`,
        folderId: folder.id,
        root: folder.path,
      };
    }
    const root = dirname(location.path);
    return {
      key: `path:${root}`,
      folderId: null,
      root,
    };
  }

  function locationForBundle(
    file: MediaFile | null,
    bundle: OpAtomBundle,
  ): FileLocation | null {
    if (!file) return null;
    return file.locations?.find((location) =>
      bundle.folderId === null
        ? pathIsWithin(location.path, bundle.root)
        : location.folderId === bundle.folderId ||
          (location.folderId === null && pathIsWithin(location.path, bundle.root))
    ) ?? null;
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
  async function ingestDocumentTask(path: string, episodeId: number | null): Promise<boolean> {
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

  function pendingClipKey(bundle: OpAtomBundle, clipKey: string): string {
    return `${bundle.key}\u0000${clipKey}`;
  }

  function ensureGrouper(bundle: OpAtomBundle): OpAtomGrouper {
    const existing = groupers.get(bundle.key);
    if (existing) return existing;
    const created = new OpAtomGrouper({
      onClip: (clip) => {
        pendingOpAtomClips.delete(pendingClipKey(bundle, clip.clipKey));
        queueOpAtomClip(bundle, clip);
      },
    });
    groupers.set(bundle.key, created);
    return created;
  }

  function addOpAtom(atom: MxfAtomInfo): void {
    const bundle = bundleForPath(atom.path);
    const key = pendingClipKey(bundle, atom.clipKey);
    const pending = pendingOpAtomClips.get(key);
    const atoms = pending ? [...pending.clip.atoms] : [];
    const matchingIndex = atoms.findIndex((candidate) => candidate.path === atom.path);
    if (matchingIndex >= 0) atoms[matchingIndex] = atom;
    else atoms.push(atom);
    pendingOpAtomClips.set(key, {
      bundle,
      clip: {
        clipKey: atom.clipKey,
        clipName: atoms.find((candidate) => candidate.clipName)?.clipName ?? null,
        atoms,
      },
    });
    ensureGrouper(bundle).addAtom(atom);
  }

  function queueOpAtomClip(bundle: OpAtomBundle, clip: OpAtomClip): void {
    // During an abort close (project switch, quit) no new clip updates may
    // start: each one re-probes members and writes to a database that is
    // about to close. The clips are rediscovered by the next scan.
    if (lifecycle === "closed" || (lifecycle === "closing" && closeMode === "abort")) {
      return;
    }
    const previous = opAtomClipTails.get(clip.clipKey) ?? Promise.resolve();
    const current = previous
      .then(() => onOpAtomClip(bundle, clip))
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

  async function onOpAtomClip(bundle: OpAtomBundle, clip: OpAtomClip): Promise<void> {
    const existing = db.getFileByClipKey(clip.clipKey);
    const existingLocation = locationForBundle(existing, bundle);
    const atomByPath = new Map(clip.atoms.map((atom) => [atom.path, atom]));
    for (const path of existingLocation?.memberPaths ?? []) {
      if (atomByPath.has(path)) continue;
      const restored = await analyzeMxf(findFfprobeBinary(), path).catch(() => null);
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
      clipName: atoms.find((atom) => atom.clipName)?.clipName ?? clip.clipName,
      mediaKind: "opatom",
      memberPaths,
      clipKey: clip.clipKey,
      hasVideo: videoAtoms.length > 0,
    };

    const locationHash = existingLocation
      ? existingLocation.memberPaths
        ?.map((path) => `${path}:${parseMemberHashMap(existing?.fileHash ?? "").get(path) ?? ""}`)
        .join("|") ?? ""
      : "";
    const exactMatch =
      existing !== null &&
      existingLocation?.memberPaths !== null &&
      existingLocation?.memberPaths.length === memberPaths.length &&
      existingLocation.memberPaths.every((path, index) => path === memberPaths[index]) &&
      locationHash === fileHash;
    const unchangedSuperset = existing !== null &&
      existingLocation !== null &&
      isUnchangedSuperset(locationHash, newHashMap);

    if (exactMatch) {
      const registered = db.registerFileLocation(input);
      reconcile(registered.file.id);
      ensureWork(registered.file.id);
      reconcileMemberships(memberPaths);
      return;
    }

    if (existing && existingLocation && unchangedSuperset) {
      const updated = db.updateOpAtomMembers(existing.id, input);
      reconcile(updated.id);
      ensureWork(updated.id);
      reconcileMemberships([...memberPaths, existingLocation.path]);
      scheduleUpdate();
      return;
    }

    if (existing && existingLocation) db.clearDerivedState(existing.id);
    const registered = existing && existingLocation
      ? {
        file: db.updateOpAtomMembers(existing.id, input),
        canonicalFileCreated: false,
      }
      : db.registerFileLocation(input);
    if (registered.canonicalFileCreated || existingLocation !== null) {
      db.enqueueJob(registered.file.id, "probe");
    }
    reconcile(registered.file.id);
    reconcileMemberships([
      ...memberPaths,
      ...(existingLocation ? [existingLocation.path] : []),
    ]);
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

  /**
   * Unreadable media (corrupt file, unsupported MXF variant) must remain
   * VISIBLE as an error rather than silently disappearing — otherwise the
   * clip count doesn't match what the editor put in the folder and it
   * looks like the app "lost" a file. Record a stub in error state; a later
   * successful discovery of the same path clears it.
   */
  function recordUnreadable(
    path: string,
    err: unknown,
    located: ReturnType<typeof locationForPath>,
    existing: MediaFile | null,
  ): void {
    let unreadable = existing;
    const unreadableHash = `unreadable:${path}`;
    if (located && located.file.fileHash !== unreadableHash) {
      removeLocation(located.location.path);
      unreadable = null;
    }
    if (!unreadable) {
      unreadable = db.registerFileLocation({
        path,
        filename: basenameOf(path),
        durationS: 0,
        fps: 0,
        dropFrame: false,
        startTc: "00:00:00:00",
        codec: "unknown",
        audioChannels: 0,
        fileHash: unreadableHash,
        role: roleForPath(path),
      }).file;
    }
    const message = err instanceof Error ? err.message : String(err);
    db.setDiscoveryFailure(unreadable.id, message);
    reconcile(unreadable.id);
    reconcileMemberships([path]);
    scheduleUpdate();
    console.warn(`onFileFound: unreadable media ${path}:`, err);
  }

  async function onFileFound(path: string): Promise<void> {
    const ext = extname(path).toLowerCase();
    const located = locationForPath(path);
    const existing = located?.file ?? db.getFileByPath(path);

    if (ext === ".mxf") {
      const ffprobeBin = findFfprobeBinary();
      let atomInfo: MxfAtomInfo | null;
      try {
        atomInfo = await analyzeMxf(ffprobeBin, path);
      } catch (err) {
        // Out-of-descriptors is the process's problem, not the file's:
        // never record it against the path — surface it to the caller and
        // let the next scan retry.
        if (isSystemicSpawnError(err)) throw err;
        recordUnreadable(path, err, located, existing);
        return;
      }
      if (atomInfo) {
        if (existing?.discoveryFailed) db.setDiscoveryFailure(existing.id, null);
        addOpAtom(atomInfo);
        return;
      }
      // Probed cleanly and not OP-Atom (e.g. carries both audio and video)
      // — fall through to standard ingest below.
    }

    let identity: Awaited<ReturnType<typeof computeFileIdentity>>;
    try {
      identity = await computeFileIdentity(path);
    } catch (err) {
      recordUnreadable(path, err, located, existing);
      return;
    }
    if (existing?.discoveryFailed) db.setDiscoveryFailure(existing.id, null);

    const input: FileInput = {
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
    };

    if (located && existing?.fileHash === identity.fileHash) {
      const registered = db.registerFileLocation(input);
      reconcile(registered.file.id);
      ensureWork(registered.file.id);
      reconcileMemberships([path]);
      return;
    }

    if (located) removeLocation(located.location.path);

    if (!located) {
      const missingCandidate = db.listFiles().find((candidate) =>
        candidate.mediaKind === "standard" &&
        candidate.fileHash === identity.fileHash &&
        candidate.path !== path &&
        !existsSync(candidate.path) &&
        identity.size > 0 &&
        (
          usesFullContentHash(identity.size) ||
          normalizeClipName(parsePath(candidate.filename).name) ===
            normalizeClipName(parsePath(identity.filename).name)
        )
      );
      if (missingCandidate) {
        const oldPath = missingCandidate.path;
        db.repointFilePath(missingCandidate.id, path, identity.filename);
        const registered = db.registerFileLocation({
          ...input,
          durationS: missingCandidate.durationS,
          fps: missingCandidate.fps,
          dropFrame: missingCandidate.dropFrame,
          startTc: missingCandidate.startTc,
          codec: missingCandidate.codec,
          audioChannels: missingCandidate.audioChannels,
        });
        removeLocation(oldPath);
        reconcile(registered.file.id);
        ensureWork(registered.file.id);
        reconcileMemberships([oldPath, path]);
        scheduleUpdate();
        return;
      }
    }

    const registered = db.registerFileLocation(input);
    if (registered.canonicalFileCreated) {
      db.setFileHasVideo(registered.file.id, null);
      db.enqueueJob(registered.file.id, "probe");
    } else {
      ensureWork(registered.file.id);
    }
    reconcile(registered.file.id);
    reconcileMemberships([path]);
    scheduleUpdate();
  }

  async function onFileRemoved(path: string): Promise<void> {
    const located = locationForPath(path) ?? locationContainingMember(path);
    if (!located) return;
    if (located.file.mediaKind !== "opatom") {
      removeLocation(located.location.path);
      reconcileMemberships([path]);
      scheduleUpdate();
      return;
    }

    const remainingPaths = (located.location.memberPaths ?? [])
      .filter((memberPath) => memberPath !== path && existsSync(memberPath));
    if (remainingPaths.length === 0) {
      removeLocation(located.location.path);
      reconcileMemberships([path]);
      scheduleUpdate();
      return;
    }

    const analyzed = await Promise.all(
      remainingPaths.map((memberPath) =>
        analyzeMxf(findFfprobeBinary(), memberPath).catch(() => null)
      ),
    );
    const atoms = analyzed.filter((atom): atom is MxfAtomInfo => atom !== null);
    if (atoms.length === 0) {
      removeLocation(located.location.path);
      reconcileMemberships([path]);
      scheduleUpdate();
      return;
    }
    const bundle = bundleForLocation(located.location);
    queueOpAtomClip(bundle, {
      clipKey: located.file.clipKey ?? atoms[0].clipKey,
      clipName: atoms.find((atom) => atom.clipName)?.clipName ?? located.file.clipName,
      atoms,
    });
  }

  function ensureWatcher(): Watcher {
    if (watcher) return watcher;
    watcher = createWatcher({
      onFileFound: (path) => {
        if (lifecycle !== "open") return;
        void trackTask(onFileFound(path)).catch((err: unknown) => {
          console.warn(`onFileFound: failed on ${path}:`, err);
        });
      },
      onFileRemoved: (path) => {
        if (lifecycle !== "open") return;
        void trackTask(onFileRemoved(path)).catch((err: unknown) => {
          console.warn(`onFileRemoved: failed on ${path}:`, err);
        });
      },
      onDocFound: (path) => {
        if (lifecycle !== "open") return;
        void trackTask(onDocFound(path));
      },
    });
    for (const folder of watchedFolders) watcher.watchFolder(folder.path);
    return watcher;
  }

  function watchFolder(folder: ProjectFolder): void {
    if (!openTaskIntake()) return;
    const existingIndex = watchedFolders.findIndex((candidate) =>
      candidate.path === folder.path);
    if (existingIndex >= 0) watchedFolders[existingIndex] = folder;
    else watchedFolders.push(folder);
    const existingWatcher = watcher;
    const activeWatcher = ensureWatcher();
    if (existingWatcher) activeWatcher.watchFolder(folder.path);
  }

  function unwatchFolder(path: string): void {
    const idx = watchedFolders.findIndex((f) => f.path === path);
    if (idx >= 0) watchedFolders.splice(idx, 1);
    watcher?.unwatchFolder(path);
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

  async function scanFolderTask(folder: ProjectFolder): Promise<void> {
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
    reconcileMemberships(
      [],
      folder.episodeId === null ? [] : [folder.episodeId],
    );
  }

  function scanFolder(folder: ProjectFolder): Promise<void> {
    if (!openTaskIntake()) return Promise.resolve();
    return trackTask(scanFolderTask(folder));
  }

  function ingestDocument(path: string, episodeId: number | null): Promise<boolean> {
    if (!openTaskIntake()) return Promise.resolve(false);
    return trackTask(ingestDocumentTask(path, episodeId));
  }

  async function waitForCloseTasks(
    tasks: Promise<unknown>[],
    label: string,
    deadline: number,
  ): Promise<void> {
    if (tasks.length === 0) return;
    const remainingMs = Math.max(0, deadline - Date.now());
    const settled = Promise.all(tasks).then(
      () => ({ kind: "done" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const result = await Promise.race([
      settled,
      new Promise<{ kind: "timed-out" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timed-out" }), remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (result.kind === "timed-out") {
      console.warn(`[pipeline] discovery close timed out waiting for ${label}`);
      return;
    }
    if (result.kind === "failed") throw result.error;
  }

  function close(mode: "drain" | "abort" = "drain"): Promise<void> {
    if (lifecycle === "closing" && closeTask) return closeTask;
    if (lifecycle === "closed") return Promise.resolve();
    lifecycle = "closing";
    closeMode = mode;
    const activeWatcher = watcher;
    watcher = null;
    closeTask = (async () => {
      const deadline = Date.now() + DISCOVERY_CLOSE_TIMEOUT_MS;
      let closeError: unknown;
      try {
        await waitForCloseTasks(
          activeWatcher ? [activeWatcher.close()] : [],
          "folder watcher",
          deadline,
        );
      } catch (err) {
        closeError = err;
      }
      try {
        await waitForCloseTasks([...discoveryTasks], "folder scans", deadline);
      } catch (err) {
        closeError ??= err;
      }

      // Drain mode finishes the clip updates already in hand. Abort mode
      // drops them: each update re-probes members with ffprobe, and with
      // thousands of pending clips the flush cannot beat the deadline — the
      // database would close underneath the stragglers. A dropped clip is
      // rediscovered by the next scan of its folder.
      if (mode === "drain") {
        for (const pending of pendingOpAtomClips.values()) {
          queueOpAtomClip(pending.bundle, pending.clip);
        }
      }
      pendingOpAtomClips.clear();
      for (const activeGrouper of groupers.values()) activeGrouper.close();
      groupers.clear();
      try {
        await waitForCloseTasks([...opAtomClipTails.values()], "OP-Atom updates", deadline);
      } catch (err) {
        closeError ??= err;
      }
      lifecycle = "closed";
      if (closeError !== undefined) throw closeError;
    })();
    return closeTask;
  }

  return {
    watchFolder,
    unwatchFolder,
    scanFolder,
    ingestDocument,
    close,
  };
}
