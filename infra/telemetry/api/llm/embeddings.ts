import { proxyToOpenRouter } from "../../lib/managed-llm";

/** A 100-chunk batch is a few megabytes of floats; give it room. */
export const config = { maxDuration: 60 };

/** Web handler so the (large) response streams back instead of being buffered
 *  into the 4.5MB serverless response limit. */
export function POST(request: Request): Promise<Response> {
  return proxyToOpenRouter(request, { path: "/embeddings" });
}
