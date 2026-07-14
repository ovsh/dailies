import type { MediaFile } from "../../shared/types";

/** Media with playable audio but no known video stream or generated video proxy. */
export function isAudioOnly(file: MediaFile): boolean {
  return file.audioChannels > 0 && file.fps <= 0 && file.proxyPath === null;
}
