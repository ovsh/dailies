import type { MediaFile } from "../../shared/types";

/**
 * Media with playable audio but no known video stream or generated video
 * proxy. The stored ffprobe result (`hasVideo`) is the primary signal, not
 * file extension or channel/fps heuristics. `hasVideo === null` means probe
 * has not run yet (legacy backfill window); fall back to the prior
 * heuristic only in that gap.
 */
export function isAudioOnly(file: MediaFile): boolean {
  if (file.hasVideo === false) return true;
  if (file.hasVideo === true) {
    return file.audioChannels > 0 && file.videoUnplayable && file.proxyPath === null;
  }
  return file.audioChannels > 0 &&
    file.proxyPath === null &&
    (file.fps <= 0 || file.videoUnplayable);
}
