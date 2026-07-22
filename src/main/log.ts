/**
 * Structured session logging. One NDJSON line per event:
 *   {"ts":"…","level":"info","scope":"pipeline","event":"pipeline.stage.failed","sessionId":"…",…fields}
 *
 * Files live in `<userData>/logs/` and rotate at 5 MB (dailies.ndjson,
 * dailies.ndjson.1, dailies.ndjson.2). Writes are sync appends so ordering
 * survives a crash. Volume is a handful of lines per user action — do not
 * add per-frame or per-chunk events without measuring.
 *
 * Import-safe from any process/test: before initLog() runs, calls are
 * dropped (no filesystem side effects). Sinks let telemetry mirror every
 * line as a Sentry breadcrumb and capture `log.error` exceptions — the
 * logger itself never depends on the Sentry SDK.
 *
 * Privacy: never pass API keys, transcript text, prompts, or document
 * contents in `fields`. Full file paths are acceptable here (local file)
 * but must not be forwarded remotely — sinks receive fields as-is, so the
 * telemetry layer is responsible for path reduction.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LogLevel, LogScope } from "../shared/types";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const ROTATIONS = 2;
const LOG_BASENAME = "dailies.ndjson";

const sessionId = crypto.randomUUID();

let logFile: string | null = null;
let approxBytes = 0;

type Fields = Record<string, unknown>;
type BreadcrumbSink = (level: LogLevel, scope: LogScope, event: string, fields: Fields) => void;
type ErrorSink = (err: Error, scope: LogScope, event: string, fields: Fields) => void;

let breadcrumbSink: BreadcrumbSink | null = null;
let errorSink: ErrorSink | null = null;

export function getSessionId(): string {
  return sessionId;
}

/** Rotated log files, current first. Empty before initLog(). */
export function getLogFiles(): string[] {
  if (!logFile) return [];
  const files = [logFile];
  for (let i = 1; i <= ROTATIONS; i++) files.push(`${logFile}.${i}`);
  return files.filter((f) => fs.existsSync(f));
}

export function setBreadcrumbSink(sink: BreadcrumbSink): void {
  breadcrumbSink = sink;
}

export function setErrorSink(sink: ErrorSink): void {
  errorSink = sink;
}

function rotate(file: string): void {
  try {
    for (let i = ROTATIONS; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${file}.${i}`);
    }
  } catch {
    // rotation is best-effort; keep appending to the current file
  }
}

function write(level: LogLevel, scope: LogScope, event: string, fields: Fields): void {
  breadcrumbSink?.(level, scope, event, fields);
  if (!logFile) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope,
      event,
      sessionId,
      ...fields,
    });
    if (approxBytes + line.length > MAX_LOG_BYTES) {
      rotate(logFile);
      approxBytes = 0;
    }
    fs.appendFileSync(logFile, line + "\n");
    approxBytes += line.length + 1;
  } catch {
    // never let logging break the app
  }
}

function describeError(err: unknown): Fields {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack ?? null };
  }
  return err === undefined ? {} : { error: String(err) };
}

export const log = {
  info(scope: LogScope, event: string, fields: Fields = {}): void {
    write("info", scope, event, fields);
  },
  warn(scope: LogScope, event: string, fields: Fields = {}): void {
    write("warn", scope, event, fields);
  },
  /** `err` (when an Error) is also forwarded to the error sink -> remote report. */
  error(scope: LogScope, event: string, fields: Fields = {}, err?: unknown): void {
    const merged = { ...fields, ...describeError(err) };
    write("error", scope, event, merged);
    if (err instanceof Error) errorSink?.(err, scope, event, merged);
  },
};

const LEVELS: LogLevel[] = ["info", "warn", "error"];
const SCOPES: LogScope[] = ["app", "pipeline", "agents", "db", "export", "updater", "ui"];

/**
 * Entry point for renderer lines arriving over IPC. Renderer input is
 * untrusted: levels/scopes are whitelisted, the event name is capped, and
 * fields are re-serialized (drops functions/cycles) and size-capped.
 */
export function logFromRenderer(level: unknown, scope: unknown, event: unknown, fields: unknown): void {
  const lvl = LEVELS.includes(level as LogLevel) ? (level as LogLevel) : "info";
  const scp = SCOPES.includes(scope as LogScope) ? (scope as LogScope) : "ui";
  const evt = typeof event === "string" ? event.slice(0, 120) : "ui.unknown";
  let safeFields: Fields = {};
  try {
    const json = JSON.stringify(fields ?? {});
    if (json && json.length <= 8 * 1024 && json.startsWith("{")) {
      safeFields = JSON.parse(json) as Fields;
    }
  } catch {
    // unserializable fields are dropped, the event itself still logs
  }
  const merged: Fields = { ...safeFields, proc: "renderer" };
  if (lvl === "error") {
    // Re-materialize an Error so renderer failures reach the error sink too.
    const message = typeof merged["error"] === "string" ? (merged["error"] as string) : evt;
    const err = new Error(message);
    err.stack = typeof merged["stack"] === "string" ? (merged["stack"] as string) : err.stack;
    log.error(scp, evt, merged, err);
  } else {
    log[lvl](scp, evt, merged);
  }
}

/**
 * Starts writing to `<dataDir>/logs/` and funnels console.error/warn and
 * process-level failures into the session log (replaces the old ad-hoc
 * dailies.log console patch). Call once, early, from the main process.
 */
export function initLog(dataDir: string): void {
  const dir = path.join(dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, LOG_BASENAME);
  try {
    const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    if (size > MAX_LOG_BYTES) rotate(logFile);
    else approxBytes = size;
  } catch {
    approxBytes = 0;
  }

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const asText = (args: unknown[]) =>
    args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a))).join(" ");
  console.error = (...args: unknown[]) => {
    log.error("app", "console.error", { message: asText(args) });
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    log.warn("app", "console.warn", { message: asText(args) });
    origWarn(...args);
  };
  // Logged without the err param: Sentry's own process-level integrations
  // already capture these, so routing them through the error sink too would
  // report every crash twice.
  process.on("uncaughtException", (err) =>
    log.error("app", "app.uncaught_exception", describeError(err)),
  );
  process.on("unhandledRejection", (reason) =>
    log.error("app", "app.unhandled_rejection", describeError(reason)),
  );
}
