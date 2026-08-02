import { proxyToOpenRouter } from "../../../lib/managed-llm";

/**
 * A reasoning model can think for well over the 10s default, and a streamed
 * turn holds the function open for its whole length.
 */
export const config = { maxDuration: 60 };

/** Web handler, not the (req, res) form the other endpoints use: only this
 *  signature can hand a ReadableStream back and stream SSE without buffering. */
export function POST(request: Request): Promise<Response> {
  return proxyToOpenRouter(request, { path: "/chat/completions" });
}
