/**
 * Ships the same lines the file logger writes to the telemetry ingest
 * endpoint, so testers' failures arrive without anyone exporting anything.
 *
 * Invariants:
 * - Never logs its own failures (a failing shipper that logged would feed
 *   itself). Failures keep the buffer and back off; overflow drops oldest
 *   and reports a drop count in the next successful batch.
 * - The user's toggle is checked at flush time, so turning telemetry off
 *   stops shipping immediately — no restart needed.
 * - Without a build-time endpoint/token (dev builds), it is inert.
 */
import { randomUUID } from "node:crypto";
import { release } from "node:os";

import { app } from "electron";

// Replaced by esbuild --define at package time; empty in dev builds.
declare const __DAILIES_TELEMETRY_URL__: string;
declare const __DAILIES_TELEMETRY_TOKEN__: string;

const FLUSH_INTERVAL_MS = 20_000;
const FLUSH_AT_LINES = 100;
const MAX_BUFFERED_LINES = 500;
const POST_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

interface TelemetryLine {
  t: string;
  level: string;
  line: string;
}

export interface TelemetryShipper {
  readonly sessionId: string;
  enqueue(level: string, line: string): void;
  /** Best-effort final flush for the quit path. */
  flushNow(): Promise<void>;
  stop(): void;
}

export function createTelemetryShipper(opts: {
  isEnabled: () => boolean;
  installId: string;
}): TelemetryShipper {
  const url = typeof __DAILIES_TELEMETRY_URL__ === "string" ? __DAILIES_TELEMETRY_URL__ : "";
  const token = typeof __DAILIES_TELEMETRY_TOKEN__ === "string" ? __DAILIES_TELEMETRY_TOKEN__ : "";
  const sessionId = randomUUID();
  const active = url.length > 0 && token.length > 0;

  let buffer: TelemetryLine[] = [];
  let dropped = 0;
  let seq = 0;
  let failures = 0;
  let backoffUntil = 0;
  let inFlight = false;

  const timer = active
    ? setInterval(() => void flush(), FLUSH_INTERVAL_MS)
    : null;
  timer?.unref();

  function enqueue(level: string, line: string): void {
    if (!active) return;
    buffer.push({ t: new Date().toISOString(), level, line });
    if (buffer.length > MAX_BUFFERED_LINES) {
      buffer.splice(0, buffer.length - MAX_BUFFERED_LINES);
      dropped += 1;
    }
    if (buffer.length >= FLUSH_AT_LINES) void flush();
  }

  async function flush(): Promise<void> {
    if (!active || inFlight || buffer.length === 0) return;
    if (Date.now() < backoffUntil) return;
    if (!opts.isEnabled()) return;

    const lines = buffer;
    buffer = [];
    const body = JSON.stringify({
      installId: opts.installId,
      sessionId,
      seq,
      appVersion: app.getVersion(),
      osVersion: release(),
      dropped,
      lines,
    });

    inFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-dailies-token": token },
          body,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ingest ${res.status}`);
      } finally {
        clearTimeout(timeout);
      }
      seq += 1;
      dropped = 0;
      failures = 0;
      backoffUntil = 0;
    } catch {
      // Put the lines back (newest win if the cap bites) and back off.
      buffer = [...lines, ...buffer];
      if (buffer.length > MAX_BUFFERED_LINES) {
        dropped += buffer.length - MAX_BUFFERED_LINES;
        buffer.splice(0, buffer.length - MAX_BUFFERED_LINES);
      }
      failures += 1;
      backoffUntil =
        Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    } finally {
      inFlight = false;
    }
  }

  return {
    sessionId,
    enqueue,
    flushNow: () => flush(),
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
