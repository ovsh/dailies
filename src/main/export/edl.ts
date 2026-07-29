/**
 * CMX3600 EDL export (file-based, reel "AX"). The first included source with
 * a known edit rate selects the global record rate and FCM; all-unknown
 * exports use the explicit 30 NDF fallback. CMX3600 has only one global FCM,
 * so incompatible source rates/formats are rejected instead of mixed.
 */
import type { ExportItem, MediaFile } from "../../shared/types";
import {
  deriveSourceTimecode,
  framesToTc,
  parseTc,
  UNKNOWN_SOURCE_RATE_FALLBACK_FPS,
} from "../../shared/timecode";

const RECORD_START_TC = "01:00:00:00";

export interface EdlOffendingClip {
  fileId: number;
  filename: string;
  fps: number;
  dropFrame: boolean;
}

export class EdlIncompatibleSourceError extends Error {
  readonly code = "EDL_INCOMPATIBLE_SOURCE_FORMAT";

  constructor(
    readonly recordFps: number,
    readonly recordDropFrame: boolean,
    readonly offendingClips: EdlOffendingClip[],
  ) {
    const recordFormat = `${recordFps} fps ${recordDropFrame ? "DF" : "NDF"}`;
    const offenders = offendingClips
      .map((clip) => `${clip.filename} (${clip.fps > 0 ? `${clip.fps} fps` : "unknown fps"} ${clip.dropFrame ? "DF" : "NDF"})`)
      .join(", ");
    super(`CMX3600 record format is ${recordFormat}; incompatible source clips: ${offenders}`);
    this.name = "EdlIncompatibleSourceError";
  }
}

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

  const formatSource = rows.find((row) => row.file.fps > 0)?.file;
  const recordFps = formatSource?.fps ?? UNKNOWN_SOURCE_RATE_FALLBACK_FPS;
  const recordDropFrame = formatSource?.dropFrame ?? false;
  const offendingById = new Map<number, EdlOffendingClip>();
  for (const { file } of rows) {
    const sourceFps = file.fps > 0 ? file.fps : UNKNOWN_SOURCE_RATE_FALLBACK_FPS;
    const sourceDropFrame = file.fps > 0 ? file.dropFrame : false;
    if (Math.abs(sourceFps - recordFps) > 0.001 || sourceDropFrame !== recordDropFrame) {
      offendingById.set(file.id, {
        fileId: file.id,
        filename: file.filename,
        fps: file.fps,
        dropFrame: file.dropFrame,
      });
    }
  }
  if (offendingById.size > 0) {
    throw new EdlIncompatibleSourceError(recordFps, recordDropFrame, [...offendingById.values()]);
  }

  lines.push(recordDropFrame ? "FCM: DROP FRAME" : "FCM: NON-DROP FRAME");

  let recordFrames = parseTc(RECORD_START_TC, recordFps, recordDropFrame);

  rows.forEach((row, idx) => {
    const { file, item } = row;
    const evt = pad3(idx + 1);

    const sourceFps = file.fps > 0 ? file.fps : UNKNOWN_SOURCE_RATE_FALLBACK_FPS;
    const unknownRate = !(file.fps > 0);
    const rawSrcIn = unknownRate && item.inS !== undefined
      ? deriveSourceTimecode(file.startTc, item.inS, file.fps, file.dropFrame).tc
      : item.inTc;
    const rawSrcOut = unknownRate && item.outS !== undefined
      ? deriveSourceTimecode(file.startTc, item.outS, file.fps, file.dropFrame).tc
      : item.outTc;
    const sourceDropFrame = unknownRate ? false : file.dropFrame;
    const srcInFrames = parseTc(rawSrcIn, sourceFps, sourceDropFrame);
    const srcOutFrames = parseTc(rawSrcOut, sourceFps, sourceDropFrame);
    const srcIn = framesToTc(srcInFrames, sourceFps, recordDropFrame);
    const srcOut = framesToTc(srcOutFrames, sourceFps, recordDropFrame);
    const durationFrames = srcOutFrames - srcInFrames;

    const recIn = framesToTc(recordFrames, recordFps, recordDropFrame);
    recordFrames += durationFrames;
    const recOut = framesToTc(recordFrames, recordFps, recordDropFrame);

    lines.push(`${evt}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${file.filename}`);
    if (unknownRate) {
      lines.push(`* DAILIES WARNING: SOURCE EDIT RATE UNKNOWN; ${UNKNOWN_SOURCE_RATE_FALLBACK_FPS} FPS FALLBACK`);
    }
    lines.push(`* COMMENT: ${item.comment}`);
  });

  return lines.join("\n");
}
