import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMediaResponse,
  mimeForPath,
  parseMediaRequestPath,
  parseRangeHeader,
} from "../src/main/media-protocol";

describe("media protocol helpers", () => {
  it("decodes an encoded absolute media path", () => {
    const filePath = "/Volumes/Camera Originals/Day 1 (A)/clip.mov";

    expect(parseMediaRequestPath(`media://local/${encodeURIComponent(filePath)}`)).toBe(filePath);
  });

  it("maps media extensions to mime types", () => {
    expect(mimeForPath("/x/proxy.mp4")).toBe("video/mp4");
    expect(mimeForPath("/x/audio.wav")).toBe("audio/wav");
    expect(mimeForPath("/x/keyframe-0.jpg")).toBe("image/jpeg");
    expect(mimeForPath("/x/unknown.bin")).toBe("application/octet-stream");
  });

  it("parses range headers against the file size", () => {
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader("bytes=0-49", 100)).toEqual({ start: 0, end: 49 });
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=0-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=nonsense", 100)).toBeNull();
  });
});

describe("buildMediaResponse", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-media-proto-"));
  const filePath = path.join(dir, "proxy.mp4");
  const content = Buffer.from("0123456789abcdefghij"); // 20 bytes
  writeFileSync(filePath, content);

  it("serves the whole file as 200 with Accept-Ranges", async () => {
    const res = await buildMediaResponse(filePath, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Length")).toBe("20");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("0123456789abcdefghij");
  });

  it("serves a range as 206 with Content-Range and the sliced bytes", async () => {
    const res = await buildMediaResponse(filePath, "bytes=5-9");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 5-9/20");
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("56789");
  });

  it("serves an open-ended range to EOF", async () => {
    const res = await buildMediaResponse(filePath, "bytes=10-");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 10-19/20");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("abcdefghij");
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const res = await buildMediaResponse(filePath, "bytes=20-");
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */20");
  });

  it("returns 404 for a missing file", async () => {
    const res = await buildMediaResponse(path.join(dir, "nope.mp4"), null);
    expect(res.status).toBe(404);
  });
});
