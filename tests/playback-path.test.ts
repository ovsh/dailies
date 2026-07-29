import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePlaybackPath } from "../src/main/playback-path";

type PlaybackFile = Parameters<typeof resolvePlaybackPath>[0] & {
  hasVideo: boolean;
  videoUnplayable: boolean;
};

const tempDirs: string[] = [];

function tempMediaDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dailies-playback-"));
  tempDirs.push(root);
  const mediaDir = join(root, "media");
  mkdirSync(mediaDir);
  return mediaDir;
}

function file(overrides: Partial<PlaybackFile> = {}): PlaybackFile {
  return {
    id: 42,
    mediaKind: "opatom",
    path: "/avid/clip.mxf",
    proxyPath: null,
    hasVideo: true,
    videoUnplayable: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("playback path resolution", () => {
  it("prefers an existing proxy over extracted audio", () => {
    const mediaDir = tempMediaDir();
    const proxyPath = join(mediaDir, "proxy.mp4");
    const audioPath = join(mediaDir, "42", "audio.wav");
    mkdirSync(join(mediaDir, "42"));
    writeFileSync(proxyPath, "proxy");
    writeFileSync(audioPath, "audio");

    expect(resolvePlaybackPath(file({ proxyPath, videoUnplayable: true }), mediaDir)).toBe(proxyPath);
  });

  it("uses retained audio when the proxy is absent", () => {
    const mediaDir = tempMediaDir();
    const audioPath = join(mediaDir, "42", "audio.wav");
    mkdirSync(join(mediaDir, "42"));
    writeFileSync(audioPath, "audio");

    expect(resolvePlaybackPath(file({
      proxyPath: join(mediaDir, "missing.mp4"),
      videoUnplayable: true,
    }), mediaDir)).toBe(audioPath);
  });

  it.each([".mov", ".mp4", ".m4v", ".M4V"])(
    "falls back to a supported %s standard-media original",
    (extension) => {
      const mediaDir = tempMediaDir();
      const originalPath = join(mediaDir, `original${extension}`);
      writeFileSync(originalPath, "original");

      expect(
        resolvePlaybackPath(file({ mediaKind: "standard", path: originalPath }), mediaDir),
      ).toBe(originalPath);
    },
  );

  it("does not expose a video original after its proxy fails", () => {
    const mediaDir = tempMediaDir();
    const originalPath = join(mediaDir, "prores.mov");
    writeFileSync(originalPath, "original");

    expect(resolvePlaybackPath(file({
      mediaKind: "standard",
      path: originalPath,
      videoUnplayable: true,
    }), mediaDir)).toBeNull();
  });

  it("keeps an audio-only standard-media original playable", () => {
    const mediaDir = tempMediaDir();
    const originalPath = join(mediaDir, "audio-only.m4v");
    writeFileSync(originalPath, "audio");

    expect(resolvePlaybackPath(file({
      mediaKind: "standard",
      path: originalPath,
      hasVideo: false,
    }), mediaDir)).toBe(originalPath);
  });

  it("uses a regenerated proxy after retry clears the video failure", () => {
    const mediaDir = tempMediaDir();
    const proxyPath = join(mediaDir, "regenerated.mp4");
    const failedFile = file({
      mediaKind: "standard",
      path: join(mediaDir, "prores.mov"),
      videoUnplayable: true,
    });
    writeFileSync(failedFile.path, "original");

    expect(resolvePlaybackPath(failedFile, mediaDir)).toBeNull();

    writeFileSync(proxyPath, "proxy");
    expect(resolvePlaybackPath({
      ...failedFile,
      proxyPath,
      videoUnplayable: false,
    }, mediaDir)).toBe(proxyPath);
  });

  it("does not expose an MXF original when no rendition exists", () => {
    const mediaDir = tempMediaDir();

    expect(resolvePlaybackPath(file(), mediaDir)).toBeNull();
    expect(resolvePlaybackPath(file({ mediaKind: "standard" }), mediaDir)).toBeNull();
  });
});
