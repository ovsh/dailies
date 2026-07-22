import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getLogFiles,
  getSessionId,
  initLog,
  log,
  logFromRenderer,
  setBreadcrumbSink,
} from "../src/main/log";

// The logger is a module-level singleton, so all tests share one initLog().
const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-log-"));
initLog(dataDir);
const logFile = path.join(dataDir, "logs", "dailies.ndjson");

function lines(): Record<string, unknown>[] {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("session log", () => {
  it("writes one parseable NDJSON line per event with ts/level/scope/sessionId", () => {
    log.info("pipeline", "pipeline.stage.start", { stage: "probe", fileId: 3 });
    const last = lines().at(-1)!;
    expect(last.level).toBe("info");
    expect(last.scope).toBe("pipeline");
    expect(last.event).toBe("pipeline.stage.start");
    expect(last.stage).toBe("probe");
    expect(last.fileId).toBe(3);
    expect(last.sessionId).toBe(getSessionId());
    expect(typeof last.ts).toBe("string");
  });

  it("serializes an Error into message + stack on log.error", () => {
    log.error("agents", "agents.turn.failed", { turnId: "t1" }, new Error("boom"));
    const last = lines().at(-1)!;
    expect(last.error).toBe("boom");
    expect(String(last.stack)).toContain("boom");
  });

  it("mirrors every line to the breadcrumb sink", () => {
    const seen: string[] = [];
    setBreadcrumbSink((_level, _scope, event) => seen.push(event));
    log.warn("updater", "updater.internal", {});
    expect(seen).toEqual(["updater.internal"]);
    setBreadcrumbSink(() => {});
  });

  it("sanitizes renderer input: bad level/scope fall back, fields survive, proc is stamped", () => {
    logFromRenderer("nonsense", "also-nonsense", "ui.window.error", { error: "x", n: 1 });
    const last = lines().at(-1)!;
    expect(last.level).toBe("info");
    expect(last.scope).toBe("ui");
    expect(last.proc).toBe("renderer");
    expect(last.n).toBe(1);
  });

  it("drops unserializable renderer fields but keeps the event", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    logFromRenderer("info", "ui", "ui.cycle", cyclic);
    const last = lines().at(-1)!;
    expect(last.event).toBe("ui.cycle");
    expect(last.self).toBeUndefined();
  });

  it("getLogFiles returns the current file", () => {
    expect(getLogFiles()).toContain(logFile);
    expect(existsSync(logFile)).toBe(true);
  });
});
