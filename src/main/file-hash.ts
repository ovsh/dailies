export const FULL_CONTENT_HASH_LIMIT_BYTES = 2 * 1024 * 1024;

export function usesFullContentHash(size: number): boolean {
  return size <= FULL_CONTENT_HASH_LIMIT_BYTES;
}
