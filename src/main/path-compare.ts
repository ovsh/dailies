/**
 * Canonical path comparison for the library index.
 *
 * Filesystem path comparison is not host-string comparison: the default
 * volumes on macOS (APFS) and Windows (NTFS) compare names
 * case-insensitively, and macOS can hand back decomposed Unicode (NFD)
 * for a name a file dialog reported composed (NFC). Historically the app
 * mixed three semantics — SQLite LIKE (ASCII case-insensitive), raw
 * string startsWith, and node:path relative() — so folder assignment
 * depended on which code path ran last. Every equality or containment
 * decision about stored paths must go through this module so the whole
 * app shares one rule.
 *
 * Linux keeps byte-exact comparison (case-sensitive filesystems are the
 * default there). Per-volume comparison profiles (case-sensitive APFS,
 * Windows case-sensitive directories) are a known limitation, tracked
 * for the volume-identity work.
 */
import { isAbsolute, normalize, relative, sep } from "node:path";

const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

function stripTrailingSeparators(path: string): string {
  let result = path;
  while (result.length > 1 && (result.endsWith("/") || result.endsWith("\\"))) {
    const shorter = result.slice(0, -1);
    // Keep "C:\" intact: "C:" alone is a drive-relative path, not the root.
    if (/^[a-zA-Z]:$/.test(shorter)) return result;
    result = shorter;
  }
  return result;
}

/**
 * Canonical comparison key for a stored path. NOT for display and NOT for
 * I/O — pass the original string to the filesystem and the UI.
 */
export function comparablePath(path: string): string {
  const normalized = stripTrailingSeparators(normalize(path).normalize("NFC"));
  return FOLD_CASE ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

/** True when `path` is `root` itself or lives anywhere under it. */
export function pathIsWithin(path: string, root: string): boolean {
  const relativePath = relative(comparablePath(root), comparablePath(path));
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}
