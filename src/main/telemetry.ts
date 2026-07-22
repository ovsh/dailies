/**
 * Remote error reporting (Sentry). Main process only — renderer errors
 * arrive here through the session logger's IPC channel, so one SDK init
 * covers the whole app.
 *
 * What leaves the machine: error message + stack, the breadcrumb trail of
 * recent session-log events, app version, sessionId, and OS info. Media
 * paths in breadcrumbs are reduced to basenames and home directories are
 * scrubbed from every outgoing event. Nothing is sent when the DSN is
 * empty, when the user disables "Send error reports" in Settings, or in
 * e2e runs.
 */
import * as Sentry from "@sentry/electron/main";
import fs from "node:fs";
import path from "node:path";
import { getLogFiles, getSessionId, setBreadcrumbSink, setErrorSink } from "./log";

/**
 * Paste the Sentry project DSN here to enable remote error reporting.
 * The DSN is a public identifier (safe to ship in the app binary).
 */
export const SENTRY_DSN = "";

let active = false;

/** Basenames only for anything that looks like a filesystem path. */
function reduceValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/^(\/|[A-Za-z]:\\)/.test(value)) return path.basename(value);
  return value;
}

function reduceFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === "stack" ? v : reduceValue(v)]));
}

/** Strip usernames from home-dir paths anywhere in the outgoing event. */
function scrubEvent<T>(event: T): T {
  try {
    const json = JSON.stringify(event).replace(
      /(\/(?:Users|home)\/)[^/\\"]+/g,
      "$1<user>",
    );
    return JSON.parse(json) as T;
  } catch {
    return event;
  }
}

export interface TelemetryOptions {
  appVersion: string;
  isPackaged: boolean;
  /** Read at send time so the Settings toggle applies immediately. */
  isEnabled: () => boolean;
}

export function initTelemetry(opts: TelemetryOptions): void {
  if (!SENTRY_DSN || process.env["DAILIES_USER_DATA"]) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    release: `dailies@${opts.appVersion}`,
    environment: opts.isPackaged ? "production" : "development",
    maxBreadcrumbs: 100,
    beforeSend: (event) => (opts.isEnabled() ? scrubEvent(event) : null),
  });
  Sentry.setTag("sessionId", getSessionId());
  active = true;

  setBreadcrumbSink((level, scope, event, fields) => {
    Sentry.addBreadcrumb({
      category: scope,
      message: event,
      level: level === "warn" ? "warning" : level,
      data: reduceFields(fields),
    });
  });
  setErrorSink((err, scope, event) => {
    Sentry.withScope((s) => {
      s.setTag("scope", scope);
      s.setTag("event", event);
      Sentry.captureException(err);
    });
  });
}

/**
 * User-initiated problem report: description + the rotated session logs as
 * attachments. Explicit user action is the consent to include full logs
 * (which may contain file paths).
 */
export function reportProblem(description: string): { ok: boolean; error?: string } {
  if (!active) {
    return { ok: false, error: "Error reporting is not configured in this build." };
  }
  try {
    Sentry.withScope((scope) => {
      for (const file of getLogFiles()) {
        try {
          scope.addAttachment({ filename: path.basename(file), data: fs.readFileSync(file, "utf8") });
        } catch {
          // a missing/unreadable rotation never blocks the report
        }
      }
      scope.setTag("kind", "user-report");
      Sentry.captureMessage(description.trim() || "User problem report (no description)", "info");
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
