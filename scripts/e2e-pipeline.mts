/**
 * Headless end-to-end pipeline harness.
 * Drives the REAL pipeline modules (probe → OP-Atom group → audio → transcribe
 * → FTS) against a real folder, with the bundled whisper-cli and a downloaded
 * model. No Electron, no UI — this is the engine under test.
 *
 * Usage:
 *   npx tsx scripts/e2e-pipeline.mts "<folder>" <model> <modelsDir> [maxClips]
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openDatabase } from "../src/main/db/database";
import { createPipeline } from "../src/main/pipeline";
import { setGlobalModelsDir } from "../src/main/pipeline/binaries";
import type { ProjectFolder } from "../src/shared/types";

const folder = process.argv[2] ?? "";
const model = process.argv[3] ?? "tiny";
const modelsDir = process.argv[4] ?? "/tmp/dailies-e2e-models";
const maxClips = process.argv[5] ? Number(process.argv[5]) : Infinity;

if (!folder || !fs.existsSync(folder)) {
  console.error("folder not found:", folder);
  process.exit(1);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dailies-e2e-"));
setGlobalModelsDir(modelsDir);

const db = openDatabase(path.join(workDir, "e2e.db"));
db.resetRunningJobs();

const pipeline = createPipeline({
  db,
  dataDir: workDir,
  whisperModel: model,
  gemini: () => null, // audio-first: no visual index, no key needed
  embedder: () => null,
  onUpdate: () => {},
});

const projFolder: ProjectFolder = {
  id: 1,
  path: folder,
  role: "raw",
  episodeId: null,
  lastScannedAt: null,
};

function statusLine(): { line: string; done: boolean; anyRunning: boolean } {
  const files = db.listFiles();
  const jobs = db.listJobs(500);
  const byStatus: Record<string, number> = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
  const ready = files.filter((f) => f.status === "ready").length;
  const transcribed = files.filter((f) => f.hasTranscript).length;
  const errored = files.filter((f) => f.status === "error").length;
  const queued = byStatus["queued"] ?? 0;
  const running = byStatus["running"] ?? 0;
  const jobErr = byStatus["error"] ?? 0;
  const line = `files=${files.length} ready=${ready} transcribed=${transcribed} fileErr=${errored} | jobs q=${queued} run=${running} err=${jobErr}`;
  const done = files.length > 0 && queued === 0 && running === 0;
  return { line, done, anyRunning: running > 0 };
}

async function main() {
  console.log(`[e2e] folder: ${folder}`);
  console.log(`[e2e] model: ${model}  workDir: ${workDir}`);

  pipeline.watchFolder(projFolder);
  const scanStart = Date.now();
  await pipeline.scanFolder(projFolder);
  console.log(`[e2e] scan enqueued in ${((Date.now() - scanStart) / 1000).toFixed(1)}s`);

  // Optionally cap clips (delete extras) so fast iterations stay short.
  if (maxClips !== Infinity) {
    // Give the grouper time to flush (debounce ~4s), then trim.
    await new Promise((r) => setTimeout(r, 5000));
    const files = db.listFiles();
    for (const f of files.slice(maxClips)) {
      db.setFileStatus(f.id, "ready"); // park extras so they don't run
    }
    console.log(`[e2e] capped to ${Math.min(maxClips, files.length)} clips`);
  }

  pipeline.start();

  const startAll = Date.now();
  let lastLine = "";
  let stableTicks = 0;
  const deadlineMs = model === "tiny" ? 8 * 60_000 : 45 * 60_000;

  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const { line, done } = statusLine();
    if (line !== lastLine) {
      console.log(`[${((Date.now() - startAll) / 1000).toFixed(0)}s] ${line}`);
      lastLine = line;
      stableTicks = 0;
    } else {
      stableTicks++;
    }
    if (done) {
      console.log(`[e2e] pipeline drained in ${((Date.now() - startAll) / 1000).toFixed(0)}s`);
      break;
    }
    // stuck detection: no state change for ~2 min
    if (stableTicks > 40) {
      console.log(`[e2e] STUCK — no state change for 2min. Jobs:`);
      for (const j of db.listJobs(50)) {
        console.log(`   #${j.id} file=${j.fileId} ${j.stage} ${j.status} ${j.error ?? ""}`);
      }
      break;
    }
    if (Date.now() - startAll > deadlineMs) {
      console.log(`[e2e] TIMEOUT after ${(deadlineMs / 60000).toFixed(0)}min`);
      break;
    }
  }

  // ---- report ----
  console.log("\n===== FILES =====");
  for (const f of db.listFiles()) {
    console.log(
      `#${f.id} ${f.status.padEnd(10)} tx=${f.hasTranscript ? "Y" : "n"} kind=${f.mediaKind} name="${f.clipName ?? f.filename}"`,
    );
  }
  const jobErrors = db.listJobs(500).filter((j) => j.status === "error");
  if (jobErrors.length) {
    console.log("\n===== JOB ERRORS =====");
    for (const j of jobErrors) console.log(`file=${j.fileId} ${j.stage}: ${j.error}`);
  }

  // ---- prove search works over the real transcripts ----
  console.log("\n===== TRANSCRIPT SAMPLE =====");
  for (const f of db.listFiles().filter((x) => x.hasTranscript).slice(0, 3)) {
    const segs = db.listSegments(f.id);
    const sample = segs.slice(0, 2).map((s) => s.text.trim()).join(" ");
    console.log(`#${f.id}: "${sample.slice(0, 160)}" (${segs.length} segments)`);
  }

  console.log("\n===== FTS SEARCH =====");
  const anySeg = db.listFiles().flatMap((f) => db.listSegments(f.id));
  const words = [...new Set(anySeg.flatMap((s) => s.text.toLowerCase().split(/\W+/)).filter((w) => w.length > 4))];
  const probe = words.slice(0, 3);
  for (const term of probe) {
    const hits = db.searchTranscripts([term], 5);
    console.log(`  "${term}" → ${hits.length} hits${hits[0] ? ` (first @ ${hits[0].startTc})` : ""}`);
  }

  await pipeline.stop();
  db.close();
  console.log("\n[e2e] done. workDir:", workDir);
}

main().catch((e) => {
  console.error("[e2e] FATAL:", e);
  process.exit(1);
});
