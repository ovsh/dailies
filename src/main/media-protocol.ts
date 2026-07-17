/**
 * media:// protocol support: path decoding plus real HTTP Range semantics for
 * serving local media files to the renderer.
 *
 * Chromium's <video>/<audio> stack pages media in with Range requests and
 * needs genuine 206 Partial Content responses to buffer past the start or
 * seek. Electron's net.fetch over file:// slices the body for a Range header
 * but still reports a plain 200 with no Content-Range, which the media
 * element treats as a full-file response — so we serve files ourselves with
 * correct 200/206/416 semantics.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";

/** Strips the "media://local/" prefix and decodes the embedded absolute path. */
export function parseMediaRequestPath(url: string): string {
  const prefix = "media://local/";
  const raw = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  return decodeURIComponent(raw);
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range "bytes=" header against a file size.
 * Returns null for a missing/malformed header (serve the whole file) and
 * "unsatisfiable" when the requested range lies outside the file.
 */
export function parseRangeHeader(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // Suffix range: the last N bytes of the file.
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Builds the Response for a media:// request with proper Range handling. */
export async function buildMediaResponse(
  filePath: string,
  rangeHeader: string | null,
): Promise<Response> {
  let size: number;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return new Response("not a file", { status: 404 });
    size = s.size;
  } catch {
    return new Response("not found", { status: 404 });
  }

  const range = parseRangeHeader(rangeHeader, size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  const common = { "Accept-Ranges": "bytes", "Content-Type": mimeForPath(filePath) };
  if (!range) {
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { ...common, "Content-Length": String(size) },
    });
  }

  const body = Readable.toWeb(
    createReadStream(filePath, { start: range.start, end: range.end }),
  ) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      ...common,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}
