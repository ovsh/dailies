import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePlaybackPath } from "../src/main/playback-path";

type PlaybackFile = Parameters<typeof resolvePlaybackPath>[0];

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

    expect(resolvePlaybackPath(file({ proxyPath }), mediaDir)).toBe(proxyPath);
  });

  it("uses retained audio when the proxy is absent", () => {
    const mediaDir = tempMediaDir();
    const audioPath = join(mediaDir, "42", "audio.wav");
    mkdirSync(join(mediaDir, "42"));
    writeFileSync(audioPath, "audio");

    expect(resolvePlaybackPath(file({ proxyPath: join(mediaDir, "missing.mp4") }), mediaDir)).toBe(audioPath);
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

  it("does not expose an MXF original when no rendition exists", () => {
    const mediaDir = tempMediaDir();

    expect(resolvePlaybackPath(file(), mediaDir)).toBeNull();
    expect(resolvePlaybackPath(file({ mediaKind: "standard" }), mediaDir)).toBeNull();
  });
});
