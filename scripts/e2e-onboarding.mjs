/**
 * CDP onboarding journey for the packaged/dev Electron app.
 *
 * The app must be launched separately with DAILIES_USER_DATA,
 * DAILIES_E2E_FOLDER, and --remote-debugging-port set. This script never
 * reads or enters an API key.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

function readArgs(argv) {
  const result = {
    folder: "",
    shots: "",
    port: 9333,
    maxWaitMs: 10 * 60_000,
    stuckAfterMs: 2 * 60_000,
    expectFresh: false,
    skipKeyDependent: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--folder") result.folder = value, i += 1;
    else if (arg === "--shots") result.shots = value, i += 1;
    else if (arg === "--port") result.port = Number(value), i += 1;
    else if (arg === "--max-wait") result.maxWaitMs = Number(value) * 1000, i += 1;
    else if (arg === "--stuck-after") result.stuckAfterMs = Number(value) * 1000, i += 1;
    else if (arg === "--expect-fresh") result.expectFresh = true;
    else if (arg === "--skip-key-dependent") result.skipKeyDependent = true;
    else if (arg === "--expect-file-errors") result.expectFileErrors = Number(value), i += 1;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.folder) throw new Error("--folder is required");
  if (!result.shots) throw new Error("--shots is required");
  if (!Number.isFinite(result.port) || result.port <= 0) throw new Error("--port must be positive");
  if (!Number.isFinite(result.maxWaitMs) || result.maxWaitMs <= 0) throw new Error("--max-wait must be positive");
  return result;
}

const args = readArgs(process.argv.slice(2));
await mkdir(args.shots, { recursive: true });

const summary = {
  ok: false,
  startedAt: new Date().toISOString(),
  port: args.port,
  folder: path.resolve(args.folder),
  steps: [],
  final: null,
  error: null,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
      const page = list.find((target) => target.type === "page");
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`No CDP page target on port ${args.port}${lastError ? `: ${lastError.message}` : ""}`);
}

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "CDP evaluation failed");
  }
  return result.result?.value;
}

async function waitFor(label, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`${label} did not appear within ${Math.round(timeoutMs / 1000)}s${lastError ? `: ${lastError.message}` : ""}`);
}

async function shot(name) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(args.shots, `${String(summary.steps.length + 1).padStart(2, "0")}-${name}.png`);
  await writeFile(file, Buffer.from(result.data, "base64"));
  return file;
}

async function record(name, details = {}) {
  const screenshot = await shot(name);
  summary.steps.push({ name, at: new Date().toISOString(), screenshot, ...details });
}

function counts(state) {
  const jobStatuses = {};
  for (const job of state.jobs) jobStatuses[job.status] = (jobStatuses[job.status] ?? 0) + 1;
  const fileStatuses = {};
  for (const file of state.files) fileStatuses[file.status] = (fileStatuses[file.status] ?? 0) + 1;
  return { files: state.files.length, fileStatuses, jobs: state.jobs.length, jobStatuses };
}

try {
  const target = await pageTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await send("Page.enable");

  await waitFor("Dailies API", `typeof window.dailies === "object"`);
  await waitFor("fresh-profile project entry", `document.querySelector(".project-screen") !== null`);
  const initialProjects = await evaluate(`window.dailies.listProjects()`);
  if (args.expectFresh && initialProjects.length !== 0) {
    throw new Error(`Expected a fresh profile, but found ${initialProjects.length} project(s)`);
  }
  await record("fresh-profile", { projectCount: initialProjects.length });

  const projectName = `Onboarding ${Date.now()}`;
  const project = await evaluate(`window.dailies.createProject(${JSON.stringify(projectName)})`);
  await evaluate(`window.dailies.openProject(${JSON.stringify(project.id)})`);
  await record("project-created", { projectId: project.id, projectName });
  await send("Page.reload", { ignoreCache: true });
  await waitFor("Dailies API after reload", `typeof window.dailies === "object"`);
  await waitFor("Welcome setup", `document.querySelector(".welcome-overlay") !== null`);
  // innerText reflects CSS text-transform (headings render uppercase) — compare case-insensitively.
  const welcomeText = (await evaluate(`document.querySelector(".welcome-panel")?.innerText ?? ""`)).toLowerCase();
  for (const requirement of ["openrouter api key", "footage folder", "speech model"]) {
    if (!welcomeText.includes(requirement)) throw new Error(`Welcome is missing requirement: ${requirement}`);
  }
  await record("welcome", { projectName });

  const addedFolder = await evaluate(`window.dailies.addProjectFolder("raw", null, ${JSON.stringify(path.resolve(args.folder))})`);
  if (!addedFolder?.id) throw new Error("Folder IPC returned no folder");
  await waitFor("folder status", `(document.querySelector(".welcome-panel")?.innerText ?? "").toLowerCase().includes("watching")`);
  await record("folder-added", { folderId: addedFolder.id });

  await waitFor("indexing jobs", `window.dailies.listJobs().then(jobs => jobs.length > 0)`, Math.min(args.maxWaitMs, 120_000));
  await evaluate(`document.querySelector(".welcome-enter")?.click()`);
  await waitFor("app rail", `document.querySelector('[aria-label="Settings & Jobs"]') !== null`);
  await evaluate(`document.querySelector('[aria-label="Settings & Jobs"]')?.click()`);
  await waitFor("jobs screen", `document.querySelector(".jobs-table tbody tr") !== null`);
  await record("jobs-visible");

  const deadline = Date.now() + args.maxWaitMs;
  let lastFingerprint = "";
  let lastChangeAt = Date.now();
  let terminal = null;
  while (Date.now() < deadline) {
    const state = await evaluate(`Promise.all([
      window.dailies.listFiles(),
      window.dailies.listJobs(),
      window.dailies.getSettings()
    ]).then(([files, jobs, settings]) => ({ files, jobs, settings }))`);
    const status = counts(state);
    const failedJobs = state.jobs.filter((job) => job.status === "error");
    const failedFiles = state.files.filter((file) => file.status === "error");
    // Fixtures may include deliberately corrupt media; those must surface as
    // visible file errors (that IS the pass condition), capped by the flag.
    const allowedFileErrors = args.expectFileErrors ?? 0;
    if (failedJobs.length > 0 || failedFiles.length > allowedFileErrors) {
      throw new Error(`Indexing failed: ${failedJobs.length} job error(s), ${failedFiles.length} file error(s)`);
    }
    const pendingFiles = state.files.filter((file) => file.status !== "error");
    if (pendingFiles.length > 0 && pendingFiles.every((file) => file.status === "ready")) {
      terminal = { outcome: "ready", ...status, settings: state.settings };
      break;
    }

    const active = state.jobs.filter((job) => job.status === "queued" || job.status === "running");
    const waiting = state.jobs.filter((job) => job.status === "waiting");
    const knownPrerequisiteWait = waiting.every((job) =>
      /speech model|OpenRouter API key/i.test(job.error ?? ""),
    );
    if (args.skipKeyDependent && state.files.length > 0 && active.length === 0 && waiting.length > 0 && knownPrerequisiteWait) {
      terminal = { outcome: "waiting-for-setup", ...status, settings: state.settings };
      break;
    }

    const fingerprint = JSON.stringify(status);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastChangeAt = Date.now();
    } else if (active.length > 0 && Date.now() - lastChangeAt > args.stuckAfterMs) {
      throw new Error(`Indexing is stuck: no file/job status change for ${Math.round(args.stuckAfterMs / 1000)}s`);
    }
    await delay(1000);
  }
  if (!terminal) throw new Error(`Indexing did not reach a terminal state within ${Math.round(args.maxWaitMs / 1000)}s`);

  summary.final = terminal;
  await record("terminal", { outcome: terminal.outcome });
  summary.ok = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  try {
    if (ws?.readyState === WebSocket.OPEN) await record("failed", { error: summary.error });
  } catch {
    // Preserve the journey failure if screenshot capture also fails.
  }
} finally {
  summary.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(summary, null, 2));
  ws?.close();
  process.exitCode = summary.ok ? 0 : 1;
}
