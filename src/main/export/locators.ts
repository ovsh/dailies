/**
 * Avid Media Composer locator/marker import list.
 * Format: one TAB-separated line per marker:
 *   Dailies\t{inTc}\tV1\t{color}\t{comment}\t1
 */
import type { ExportItem, MediaFile } from "../../shared/types";
import { compareTc } from "../../shared/timecode";

const DEFAULT_COLOR = "red";
const MAX_COMMENT_LENGTH = 256;

/** Strip tabs/newlines and clamp length so the TSV stays well-formed. */
function sanitizeComment(comment: string): string {
  const cleaned = comment.replace(/[\t\r\n]+/g, " ").trim();
  return cleaned.length > MAX_COMMENT_LENGTH ? cleaned.slice(0, MAX_COMMENT_LENGTH) : cleaned;
}

export function buildLocatorList(
  items: ExportItem[],
  getFile: (id: number) => MediaFile | null,
): string {
  interface Row {
    file: MediaFile;
    item: ExportItem;
  }

  const rows: Row[] = [];
  for (const item of items) {
    const file = getFile(item.fileId);
    if (!file) continue;
    rows.push({ file, item });
  }

  rows.sort((a, b) => {
    if (a.file.filename !== b.file.filename) {
      return a.file.filename < b.file.filename ? -1 : 1;
    }
    return compareTc(a.item.inTc, b.item.inTc, a.file.fps, a.file.dropFrame);
  });

  const lines = rows.map(({ file, item }) => {
    const color = item.color ?? DEFAULT_COLOR;
    const prefix = `[${file.filename} ${item.inTc}-${item.outTc}] `;
    const rawComment = `${prefix}${sanitizeComment(item.comment)}`;
    const comment = sanitizeComment(rawComment);
    return ["Dailies", item.inTc, "V1", color, comment, "1"].join("\t");
  });

  return lines.join("\n");
}
