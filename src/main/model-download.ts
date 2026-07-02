/**
 * Downloads whisper.cpp ggml speech models into the global models directory
 * (userData/models). One download at a time; progress is streamed to the
 * caller so the Settings UI can render a bar.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ModelDownloadProgress } from "../shared/types";

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

let inFlight: Promise<string> | null = null;

export function modelFileName(modelName: string): string {
  return `ggml-${modelName}.bin`;
}

/**
 * Downloads `ggml-<modelName>.bin` into `<modelsDir>/`, emitting progress
 * roughly twice a second. Joins an already-running download instead of
 * starting a second one. Resolves with the final model path.
 */
export function downloadWhisperModel(
  modelName: string,
  modelsDir: string,
  onProgress: (p: ModelDownloadProgress) => void,
): Promise<string> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    mkdirSync(modelsDir, { recursive: true });
    const finalPath = join(modelsDir, modelFileName(modelName));
    if (existsSync(finalPath)) {
      onProgress({ downloadedMb: 0, totalMb: null, pct: 100, done: true, error: null });
      return finalPath;
    }

    const partPath = `${finalPath}.part`;
    const url = `${HF_BASE}/${modelFileName(modelName)}?download=true`;

    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new Error(`Model download failed: HTTP ${res.status}`);
      }
      const totalBytes = Number(res.headers.get("content-length")) || null;
      const totalMb = totalBytes ? totalBytes / (1024 * 1024) : null;

      const out = createWriteStream(partPath);
      const reader = res.body.getReader();
      let downloaded = 0;
      let lastEmit = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        await new Promise<void>((resolve, reject) => {
          out.write(value, (err) => (err ? reject(err) : resolve()));
        });
        const now = Date.now();
        if (now - lastEmit > 500) {
          lastEmit = now;
          onProgress({
            downloadedMb: downloaded / (1024 * 1024),
            totalMb,
            pct: totalBytes ? Math.round((downloaded / totalBytes) * 100) : null,
            done: false,
            error: null,
          });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

      renameSync(partPath, finalPath);
      onProgress({
        downloadedMb: downloaded / (1024 * 1024),
        totalMb,
        pct: 100,
        done: true,
        error: null,
      });
      return finalPath;
    } catch (err) {
      rmSync(partPath, { force: true });
      const message = err instanceof Error ? err.message : String(err);
      onProgress({ downloadedMb: 0, totalMb: null, pct: null, done: true, error: message });
      throw new Error(message);
    }
  })();

  void inFlight.finally(() => {
    inFlight = null;
  });
  return inFlight;
}
