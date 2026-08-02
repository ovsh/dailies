import { describe, expect, it } from "vitest";

import { comparablePath, pathIsWithin, pathsEqual } from "../src/main/path-compare";

const onMacOrWindows = process.platform === "darwin" || process.platform === "win32";

describe("comparablePath", () => {
  it("strips trailing separators", () => {
    expect(comparablePath("/Volumes/Drive/")).toBe(comparablePath("/Volumes/Drive"));
  });

  it("keeps the filesystem root intact", () => {
    expect(comparablePath("/")).toBe("/");
  });

  it("unifies NFC and NFD spellings of the same name", () => {
    const nfc = "/Volumes/Zürich/clip.mov";
    const nfd = "/Volumes/Zürich/clip.mov";
    expect(comparablePath(nfc)).toBe(comparablePath(nfd));
  });
});

describe("pathsEqual", () => {
  it.runIf(onMacOrWindows)("ignores case on case-insensitive platforms", () => {
    expect(pathsEqual("/Volumes/G-DRIVE mob", "/volumes/g-drive MOB")).toBe(true);
  });

  it.runIf(process.platform === "linux")("respects case on linux", () => {
    expect(pathsEqual("/media/Drive", "/media/drive")).toBe(false);
  });

  it("treats trailing separators as equal", () => {
    expect(pathsEqual("/a/b/", "/a/b")).toBe(true);
  });
});

describe("pathIsWithin", () => {
  it("matches the root itself", () => {
    expect(pathIsWithin("/Volumes/Drive", "/Volumes/Drive")).toBe(true);
  });

  it("matches nested paths", () => {
    expect(pathIsWithin("/Volumes/Drive/a/b.mov", "/Volumes/Drive")).toBe(true);
  });

  it("rejects sibling prefixes", () => {
    expect(pathIsWithin("/Volumes/Drive2/a.mov", "/Volumes/Drive")).toBe(false);
  });

  it("rejects parents and unrelated roots", () => {
    expect(pathIsWithin("/Volumes", "/Volumes/Drive")).toBe(false);
    expect(pathIsWithin("/Users/x/clip.mov", "/Volumes/Drive")).toBe(false);
  });

  it("tolerates a trailing separator on the root", () => {
    expect(pathIsWithin("/Volumes/Drive/a.mov", "/Volumes/Drive/")).toBe(true);
  });

  it.runIf(onMacOrWindows)("ignores case differences from dialogs vs readdir", () => {
    expect(pathIsWithin("/Volumes/g-drive mob/FOOTAGE/a.mxf", "/Volumes/G-DRIVE mob")).toBe(true);
  });
});
