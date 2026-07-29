/**
 * Avid Media Composer locator/marker import list.
 * Format: one TAB-separated line per marker:
 *   Dailies\t{inTc}\tV1\t{color}\t{comment}\t1
 */
import type { ExportItem, MediaFile } from "../../shared/types";
import { compareTc, deriveSourceTimecode, UNKNOWN_SOURCE_RATE_FALLBACK_FPS } from "../../shared/timecode";

const DEFAULT_COLOR = "red";
const MAX_COMMENT_LENGTH = 256;

export interface LocatorGroup {
  fileId: number;
  clipName: string;
  markerCount: number;
  content: string;
}

/** Strip tabs/newlines and clamp length so the TSV stays well-formed. */
function sanitizeComment(comment: string): string {
  const cleaned = comment.replace(/[\t\r\n]+/g, " ").trim();
  return cleaned.length > MAX_COMMENT_LENGTH ? cleaned.slice(0, MAX_COMMENT_LENGTH) : cleaned;
}

function buildGroupContent(file: MediaFile, items: ExportItem[]): string {
  const clipName = file.clipName ?? file.filename;
  const sorted = [...items].sort((a, b) => {
    if (!(file.fps > 0)) {
      return (a.inS ?? 0) - (b.inS ?? 0);
    }
    return compareTc(a.inTc, b.inTc, file.fps, file.dropFrame);
  });

  const lines = sorted.map((item) => {
    const color = item.color ?? DEFAULT_COLOR;
    const unknownRate = !(file.fps > 0);
    const inTc = unknownRate && item.inS !== undefined
      ? deriveSourceTimecode(file.startTc, item.inS, file.fps, file.dropFrame).tc
      : item.inTc;
    const outTc = unknownRate && item.outS !== undefined
      ? deriveSourceTimecode(file.startTc, item.outS, file.fps, file.dropFrame).tc
      : item.outTc;
    const prefix = `[${clipName} ${inTc}-${outTc}] `;
    const warning = unknownRate
      ? `[SOURCE RATE UNKNOWN; ${UNKNOWN_SOURCE_RATE_FALLBACK_FPS} FPS FALLBACK] `
      : "";
    const rawComment = `${prefix}${warning}${sanitizeComment(item.comment)}`;
    const comment = sanitizeComment(rawComment);
    return ["Dailies", inTc, "V1", color, comment, "1"].join("\t");
  });

  return lines.join("\n");
}

export function buildLocatorGroups(
  items: ExportItem[],
  getFile: (id: number) => MediaFile | null,
): LocatorGroup[] {
  const files = new Map<number, MediaFile | null>();
  const itemsByFile = new Map<number, ExportItem[]>();

  for (const item of items) {
    if (!files.has(item.fileId)) files.set(item.fileId, getFile(item.fileId));
    const file = files.get(item.fileId);
    if (!file) continue;
    const groupItems = itemsByFile.get(item.fileId);
    if (groupItems) groupItems.push(item);
    else itemsByFile.set(item.fileId, [item]);
  }

  const groups: LocatorGroup[] = [];
  for (const [fileId, groupItems] of itemsByFile) {
    const file = files.get(fileId);
    if (!file) continue;
    groups.push({
      fileId,
      clipName: file.clipName ?? file.filename,
      markerCount: groupItems.length,
      content: buildGroupContent(file, groupItems),
    });
  }

  return groups.sort((a, b) =>
    a.clipName.localeCompare(b.clipName) ||
    a.fileId - b.fileId
  );
}

export function buildLocatorList(
  items: ExportItem[],
  getFile: (id: number) => MediaFile | null,
): string {
  return buildLocatorGroups(items, getFile)
    .map((group) => group.content)
    .join("\n");
}
