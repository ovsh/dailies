/**
 * CMX3600 EDL export (file-based, reel "AX"). Record timeline is
 * non-drop-frame, starting at 01:00:00:00, at the first included file's fps,
 * with each event's duration accumulated from its source in/out.
 */
import type { ExportItem, MediaFile } from "../../shared/types";
import { parseTc, framesToTc, tcToSeconds, secondsToFrames } from "../../shared/timecode";

const RECORD_START_TC = "01:00:00:00";

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function buildEdl(
  title: string,
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

  const lines: string[] = [];
  lines.push(`TITLE: ${title}`);

  const recordFps = rows.length > 0 ? rows[0]!.file.fps : 24;
  const firstDropFrame = rows.length > 0 ? rows[0]!.file.dropFrame : false;
  lines.push(firstDropFrame ? "FCM: DROP FRAME" : "FCM: NON-DROP FRAME");

  let recordFrames = parseTc(RECORD_START_TC, recordFps, false);

  rows.forEach((row, idx) => {
    const { file, item } = row;
    const evt = pad3(idx + 1);

    const srcIn = item.inTc;
    const srcOut = item.outTc;

    const durationS = tcToSeconds(item.outTc, file.fps, file.dropFrame) -
      tcToSeconds(item.inTc, file.fps, file.dropFrame);
    const durationFrames = secondsToFrames(durationS, recordFps);

    const recIn = framesToTc(recordFrames, recordFps, false);
    recordFrames += durationFrames;
    const recOut = framesToTc(recordFrames, recordFps, false);

    lines.push(`${evt}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${file.filename}`);
    lines.push(`* COMMENT: ${item.comment}`);
  });

  return lines.join("\n");
}
