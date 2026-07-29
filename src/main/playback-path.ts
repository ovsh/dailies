import { existsSync } from "node:fs";
import { extname, join } from "node:path";

import type { MediaFile } from "../shared/types";

const PLAYABLE_ORIGINAL_EXTENSIONS = new Set([".mov", ".mp4", ".m4v"]);

type PlaybackFile = Pick<
  MediaFile,
  "id" | "mediaKind" | "path" | "proxyPath" | "hasVideo" | "videoUnplayable"
>;

/** Selects a Chromium-playable rendition without exposing MXF originals. */
export function resolvePlaybackPath(file: PlaybackFile, mediaDir: string): string | null {
  if (file.proxyPath && existsSync(file.proxyPath)) return file.proxyPath;

  const extractedAudioPath = join(mediaDir, String(file.id), "audio.wav");
  if (existsSync(extractedAudioPath)) return extractedAudioPath;

  if (
    !(file.hasVideo && file.videoUnplayable)
    && file.mediaKind === "standard"
    && PLAYABLE_ORIGINAL_EXTENSIONS.has(extname(file.path).toLowerCase())
  ) {
    return file.path;
  }

  return null;
}
