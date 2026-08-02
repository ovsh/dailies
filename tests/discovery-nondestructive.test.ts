/**
 * A probe failure is not proof the media is bad. On a slow USB volume
 * ffprobe hits its timeout purely from I/O contention, and discovery used to
 * answer that by removing the location — which deletes the file row on the
 * last location and cascades away transcripts, embeddings and episode
 * membership. These tests pin the invariant: a discovery failure only ever
 * ANNOTATES a row that already exists.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identifyFile: vi.fn(),
}));

vi.mock("../src/main/pipeline/probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/pipeline/probe")>()),
  computeFileIdentity: mocks.identifyFile,
}));

import { openDatabase } from "../src/main/db/database";
import { createDiscovery, type Discovery } from "../src/main/pipeline/discovery";
import type { DailiesDB } from "../src/main/db/types";
import type { ProjectFolder } from "../src/shared/types";

const PROBE_TIMEOUT = "ffprobe timed out after 20000ms";

const openDbs: DailiesDB[] = [];
const tempDirs: string[] = [];
const discoveries: Discovery[] = [];

function makeStable(filePath: string): void {
  const old = new Date(Date.now() - 10_000);
  utimesSync(filePath, old, old);
}

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-discovery-"));
  tempDirs.push(dataDir);
  const scanDir = path.join(dataDir, "usb-volume");
  mkdirSync(scanDir);
  const db = openDatabase(path.join(dataDir, "test.db"));
  openDbs.push(db);
  const onFileDeleted = vi.fn();
  const discovery = createDiscovery({
    db,
    embedDocChunks: async () => {},
    onUpdate: () => {},
    scheduleUpdate: () => {},
    reconcile: () => {},
    ensureWork: () => {},
    onFileDeleted,
    delay: async () => {},
  });
  discoveries.push(discovery);
  const folder: ProjectFolder = {
    id: 1,
    path: scanDir,
    role: "raw",
    episodeId: null,
    lastScannedAt: null,
  };
  return { dataDir, scanDir, db, discovery, folder, onFileDeleted };
}

/** A file on disk that the library has already indexed, with derived state. */
function indexExistingClip(db: DailiesDB, mediaPath: string) {
  writeFileSync(mediaPath, "real bytes");
  makeStable(mediaPath);
  const registered = db.registerFileLocation({
    path: mediaPath,
    filename: path.basename(mediaPath),
    durationS: 12,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: "indexed-hash",
    hasVideo: true,
    role: "raw",
  });
  db.replaceTranscript(registered.file.id, [{
    startS: 0,
    endS: 1,
    text: "hours of transcription work",
    avgConf: 1,
    words: [],
  }]);
  db.markTranscribed(registered.file.id);
  db.setFileProxy(registered.file.id, "/cache/proxy.mp4");
  return registered.file;
}

beforeEach(() => {
  mocks.identifyFile.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  while (discoveries.length > 0) await discoveries.pop()!.close("abort");
  while (openDbs.length > 0) openDbs.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("discovery keeps indexed media through a probe failure", () => {
  it("keeps the file row and its derived state when ffprobe times out", async () => {
    const { scanDir, db, discovery, folder, onFileDeleted } = setup();
    const mediaPath = path.join(scanDir, "usb-clip.mov");
    const file = indexExistingClip(db, mediaPath);
    mocks.identifyFile.mockRejectedValue(new Error(PROBE_TIMEOUT));

    await discovery.scanFolder(folder);

    expect(db.listFiles()).toHaveLength(1);
    expect(db.getFile(file.id)).toMatchObject({
      id: file.id,
      path: mediaPath,
      fileHash: "indexed-hash",
      durationS: 12,
      hasTranscript: true,
      proxyPath: "/cache/proxy.mp4",
      discoveryFailed: true,
    });
    expect(db.listSegments(file.id)[0]?.text).toBe("hours of transcription work");
    expect(
      db.listPipelineFileFacts().find((facts) => facts.file.id === file.id)?.discoveryError,
    ).toBe(PROBE_TIMEOUT);
    expect(onFileDeleted).not.toHaveBeenCalled();
  });

  it("keeps every location of a duplicated clip when ffprobe times out", async () => {
    const { dataDir, scanDir, db, discovery, folder, onFileDeleted } = setup();
    const mediaPath = path.join(scanDir, "usb-clip.mov");
    const file = indexExistingClip(db, mediaPath);
    // A second, byte-identical copy outside the scanned folder: the failure
    // must not cost the clip either of its locations.
    const backupDir = path.join(dataDir, "backup-volume");
    mkdirSync(backupDir);
    const backupPath = path.join(backupDir, "usb-clip-copy.mov");
    writeFileSync(backupPath, "real bytes");
    db.registerFileLocation({
      path: backupPath,
      filename: "usb-clip-copy.mov",
      durationS: 12,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "indexed-hash",
      hasVideo: true,
      role: "raw",
    });
    expect(db.getFile(file.id)?.locations).toHaveLength(2);
    mocks.identifyFile.mockRejectedValue(new Error(PROBE_TIMEOUT));

    await discovery.scanFolder(folder);

    expect(db.listFiles()).toHaveLength(1);
    expect(db.getFile(file.id)?.locations?.map((location) => location.path).sort())
      .toEqual([backupPath, mediaPath].sort());
    expect(onFileDeleted).not.toHaveBeenCalled();
  });

  it("refreshes the message on a repeated failure without replacing the stub", async () => {
    const { scanDir, db, discovery, folder } = setup();
    const mediaPath = path.join(scanDir, "corrupt.mov");
    writeFileSync(mediaPath, "garbage");
    makeStable(mediaPath);
    mocks.identifyFile.mockRejectedValue(new Error("moov atom not found"));
    await discovery.scanFolder(folder);
    const stubId = db.getFileByPath(mediaPath)!.id;

    mocks.identifyFile.mockRejectedValue(new Error(PROBE_TIMEOUT));
    await discovery.scanFolder(folder);

    expect(db.listFiles()).toHaveLength(1);
    expect(db.getFileByPath(mediaPath)?.id).toBe(stubId);
    expect(
      db.listPipelineFileFacts().find((facts) => facts.file.id === stubId)?.discoveryError,
    ).toBe(PROBE_TIMEOUT);
  });

  it("still registers an unreadable stub for a path with no row yet", async () => {
    const { scanDir, db, discovery, folder, onFileDeleted } = setup();
    const mediaPath = path.join(scanDir, "brand-new.mov");
    writeFileSync(mediaPath, "garbage");
    makeStable(mediaPath);
    mocks.identifyFile.mockRejectedValue(new Error(PROBE_TIMEOUT));

    await discovery.scanFolder(folder);

    expect(db.listFiles()).toHaveLength(1);
    expect(db.getFileByPath(mediaPath)).toMatchObject({
      fileHash: `unreadable:${mediaPath}`,
      filename: "brand-new.mov",
      discoveryFailed: true,
    });
    expect(
      db.listPipelineFileFacts()[0]?.discoveryError,
    ).toBe(PROBE_TIMEOUT);
    expect(onFileDeleted).not.toHaveBeenCalled();
  });

  it("clears the failure when the drive recovers and the next scan succeeds", async () => {
    const { scanDir, db, discovery, folder } = setup();
    const mediaPath = path.join(scanDir, "usb-clip.mov");
    const file = indexExistingClip(db, mediaPath);
    mocks.identifyFile.mockRejectedValue(new Error(PROBE_TIMEOUT));
    await discovery.scanFolder(folder);
    expect(db.getFile(file.id)?.discoveryFailed).toBe(true);

    mocks.identifyFile.mockResolvedValue({
      path: mediaPath,
      filename: "usb-clip.mov",
      fileHash: "indexed-hash",
      size: 10,
    });
    await discovery.scanFolder(folder);

    expect(db.getFile(file.id)).toMatchObject({
      id: file.id,
      discoveryFailed: false,
      hasTranscript: true,
      proxyPath: "/cache/proxy.mp4",
    });
    expect(
      db.listPipelineFileFacts().find((facts) => facts.file.id === file.id)?.discoveryError,
    ).toBeNull();
  });
});
