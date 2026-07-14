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
const fixtureMode = path.basename(path.resolve(folder)) === "landscaping test" && maxClips === Infinity;

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

  // OP-Atom grouping is debounced (~4s) — atoms are collected and only flushed
  // into clips after the scan settles. Wait past the debounce before the drain
  // loop, or it declares "done" before any audio clip has been enqueued.
  await new Promise((r) => setTimeout(r, 6000));

  pipeline.start();

  const startAll = Date.now();
  let lastLine = "";
  let stableTicks = 0;
  let drainFailure: string | null = null;
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
      drainFailure = "pipeline stuck with no state change for 2 minutes";
      break;
    }
    if (Date.now() - startAll > deadlineMs) {
      console.log(`[e2e] TIMEOUT after ${(deadlineMs / 60000).toFixed(0)}min`);
      drainFailure = `pipeline timeout after ${(deadlineMs / 60000).toFixed(0)} minutes`;
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
  const allFiles = db.listFiles();
  const anySeg = allFiles.flatMap((f) => db.listSegments(f.id));
  const words = [...new Set(anySeg.flatMap((s) => s.text.toLowerCase().split(/\W+/)).filter((w) => w.length > 4))];
  const probe = words.slice(0, 3);
  for (const term of probe) {
    const hits = db.searchTranscripts([term], 5);
    console.log(`  "${term}" → ${hits.length} hits${hits[0] ? ` (first @ ${hits[0].startTc})` : ""}`);
  }

  const failures: string[] = [];
  if (drainFailure) failures.push(drainFailure);
  const expectedCorrupt = fixtureMode
    ? allFiles.find((file) => file.filename.startsWith("06262025T0A02")) ?? null
    : null;
  const unexpectedFileErrors = allFiles.filter(
    (file) => file.status === "error" && file.id !== expectedCorrupt?.id,
  );
  const unexpectedJobErrors = jobErrors.filter((job) => job.fileId !== expectedCorrupt?.id);
  const validClips = allFiles.filter((file) => file.status !== "error");
  const audioFiles = allFiles.filter((file) => file.audioChannels > 0 && file.status !== "error");
  const transcribedAudio = audioFiles.filter((file) => file.hasTranscript);

  if (unexpectedFileErrors.length > 0) {
    failures.push(`${unexpectedFileErrors.length} unexpected file error(s)`);
  }
  if (unexpectedJobErrors.length > 0) {
    failures.push(`${unexpectedJobErrors.length} unexpected job error(s)`);
  }
  if (transcribedAudio.length !== audioFiles.length) {
    failures.push(`transcription coverage ${transcribedAudio.length}/${audioFiles.length}`);
  }

  if (fixtureMode) {
    const expectedNames = new Set([
      "06252025/01",
      "06252025/02",
      "06252025/03",
      "06252025/05",
      "06252025/06",
      "06252025/09",
    ]);
    const actualNames = new Set(
      allFiles
        .filter((file) => file.mediaKind === "opatom")
        .map((file) => file.clipName ?? file.filename),
    );
    const missingNames = [...expectedNames].filter((name) => !actualNames.has(name));
    const extraNames = [...actualNames].filter((name) => !expectedNames.has(name));
    if (missingNames.length > 0 || extraNames.length > 0) {
      failures.push(`fixture clip names mismatch missing=${missingNames.join(",")} extra=${extraNames.join(",")}`);
    }
    if (!expectedCorrupt || expectedCorrupt.status !== "error") {
      failures.push("fixture corrupt 06262025T0A02* is not visible as a file error");
    }

    // FTS rows are per-segment, so the probe phrase must come from ONE segment —
    // words joined across segment boundaries can never match as a phrase.
    const longestSegment = allFiles
      .flatMap((file) => db.listSegments(file.id))
      .map((segment) => segment.text.trim())
      .sort((a, b) => b.length - a.length)[0];
    const phraseWords = longestSegment?.match(/[\p{L}\p{N}']+/gu) ?? [];
    const phraseStart = phraseWords.findIndex((word) => word.length > 3);
    const phrase =
      phraseStart >= 0 && phraseWords.length >= phraseStart + 3
        ? phraseWords.slice(phraseStart, phraseStart + 3).join(" ")
        : "";
    if (!phrase || db.searchTranscripts([phrase], 5).length === 0) {
      failures.push(`fixture dynamic FTS phrase did not match: ${JSON.stringify(phrase)}`);
    } else {
      console.log(`[e2e] fixture FTS phrase ${JSON.stringify(phrase)} matched`);
    }
  }

  await pipeline.stop();
  db.close();
  console.log("\n[e2e] done. workDir:", workDir);
  for (const failure of failures) console.error(`[e2e] ASSERTION FAILED: ${failure}`);
  const wallclockS = Math.round((Date.now() - scanStart) / 1000);
  const audioS = Math.round(audioFiles.reduce((sum, file) => sum + file.durationS, 0));
  const errors = unexpectedFileErrors.length + unexpectedJobErrors.length +
    failures.filter((failure) => !failure.includes("unexpected ")).length;
  console.log(
    `E2E_RESULT clips=${validClips.length} transcribed=${transcribedAudio.length} errors=${errors} wallclock_s=${wallclockS} audio_s=${audioS}`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[e2e] FATAL:", e);
  process.exit(1);
});
