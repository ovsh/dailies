/** Bearer-token checks shared by the beta proxy and the admin endpoint. */
import { createHash, timingSafeEqual } from "node:crypto";

/** The token out of an `Authorization: Bearer …` header, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Compares fixed-width digests so token length does not change the work done. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Constant-time check of a bearer header against one expected token. */
export function matchBearer(header: string | null, expected: string | undefined): boolean {
  const presented = bearerToken(header);
  const wanted = expected?.trim();
  if (!presented || !wanted) return false;
  return constantTimeEqual(wanted, presented);
}
