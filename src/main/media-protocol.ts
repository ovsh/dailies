/**
 * Pure helpers for decoding media:// paths and forwarding renderer request
 * details to the underlying file fetch.
 */

/** Strips the "media://local/" prefix and decodes the embedded absolute path. */
export function parseMediaRequestPath(url: string): string {
  const prefix = "media://local/";
  const raw = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  return decodeURIComponent(raw);
}

/**
 * Forwards the renderer's request method + headers onto the underlying
 * file:// fetch — crucially the Range header, so <video>/<audio> seeking
 * gets 206 Partial Content instead of a full 200 every time.
 */
export function forwardedRequestInit(
  request: Pick<Request, "method" | "headers">,
): RequestInit {
  return { method: request.method, headers: request.headers };
}
