import assert from "node:assert/strict";
import test from "node:test";

import {
  addDays,
  aggregateDays,
  aggregateLlmDays,
  createEventAggregator,
  createLlmAggregator,
  daysBetween,
  drilldownInstall,
  DRILLDOWN_BYTE_BUDGET,
  FACET_OVERFLOW_KEY,
  isValidDay,
  mapWithConcurrency,
  MAX_DRILLDOWN_LINE_CHARS,
  MAX_FACET_KEYS,
  MAX_INSTALL_ROWS_TOTAL,
  normalizeSignature,
  parseBatch,
  parseDayRange,
  parseUsageRecord,
  type RawDay,
} from "../lib/stats.ts";

const TODAY = "2026-08-02";

function batch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installId: "install-a",
    operator: "Ada",
    sessionId: "session-1",
    seq: 0,
    appVersion: "0.5.6",
    osVersion: "25.5.0",
    dropped: 0,
    lines: [{ t: "2026-08-02T10:00:00.000Z", level: "info", line: "[app] started" }],
    ...over,
  };
}

function day(dayName: string, payloads: unknown[], over: Partial<RawDay> = {}): RawDay {
  return { day: dayName, payloads, failed: 0, truncated: false, ...over };
}

/* ---------------------------------------------------------------- dates */

test("isValidDay accepts real days and rejects impostors", () => {
  assert.equal(isValidDay("2026-08-02"), true);
  assert.equal(isValidDay("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(isValidDay("2026-02-31"), false);
  assert.equal(isValidDay("2026-13-01"), false);
  assert.equal(isValidDay("2026-8-2"), false);
  assert.equal(isValidDay(""), false);
  assert.equal(isValidDay(20260802), false);
});

test("addDays and daysBetween walk UTC days", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(daysBetween("2026-08-01", "2026-08-03"), [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
  assert.deepEqual(daysBetween("2026-08-03", "2026-08-01"), []);
});

test("parseDayRange defaults to today", () => {
  const range = parseDayRange({}, TODAY);
  assert.equal(range.ok, true);
  assert.deepEqual(range.ok && range.days, [TODAY]);
});

test("parseDayRange takes a single day", () => {
  const range = parseDayRange({ day: "2026-07-30" }, TODAY);
  assert.equal(range.ok && range.from, "2026-07-30");
  assert.equal(range.ok && range.to, "2026-07-30");
});

test("parseDayRange rejects mixed, partial, reversed and oversized ranges", () => {
  assert.deepEqual(parseDayRange({ day: TODAY, from: TODAY }, TODAY), {
    ok: false,
    error: "use day, or from and to — not both",
  });
  assert.equal(parseDayRange({ from: TODAY }, TODAY).ok, false);
  assert.equal(parseDayRange({ to: TODAY }, TODAY).ok, false);
  assert.equal(parseDayRange({ day: "2026-02-31" }, TODAY).ok, false);
  assert.equal(parseDayRange({ from: "bad", to: TODAY }, TODAY).ok, false);
  assert.equal(parseDayRange({ from: TODAY, to: "2026-08-01" }, TODAY).ok, false);
  assert.equal(parseDayRange({ from: "2026-07-01", to: "2026-08-01" }, TODAY).ok, false);
});

test("parseDayRange allows exactly 31 days", () => {
  const range = parseDayRange({ from: "2026-07-03", to: "2026-08-02" }, TODAY);
  assert.equal(range.ok, true);
  assert.equal(range.ok && range.days.length, 31);
});

/* ----------------------------------------------------------- signatures */

test("normalizeSignature strips ids, numbers, paths and timestamps", () => {
  const a = normalizeSignature(
    "[pipeline] failed to update OP-Atom clip 0x060A2B340101010501010F10130000003EBB0C7D0857A2065D07BA4797F52B28: expected one matching location, found 2",
  );
  const b = normalizeSignature(
    "[pipeline] failed to update OP-Atom clip 0x060A2B340101010501010F101300000044B025C40873A2061BD9BA4797F52B28: expected one matching location, found 3",
  );
  assert.equal(a, b);
  assert.match(a, /<hex>/);
  assert.match(a, /found <n>/);
});

test("normalizeSignature groups structured warn lines by shape", () => {
  const a = normalizeSignature(
    '[pipeline] queue {"event":"claim","jobId":1,"fileId":1,"stage":"probe","queuedClaims":1}',
  );
  const b = normalizeSignature(
    '[pipeline] queue {"event":"claim","jobId":42,"fileId":7,"stage":"probe","queuedClaims":3}',
  );
  assert.equal(a, b);
});

test("normalizeSignature groups counters that are glued to a unit", () => {
  const a = normalizeSignature("[db] semantic search failed after 567ms: SQLITE_BUSY: database is locked");
  const b = normalizeSignature("[db] semantic search failed after 27ms: SQLITE_BUSY: database is locked");
  assert.equal(a, b);
  assert.equal(a, "[db] semantic search failed after <n>ms: SQLITE_BUSY: database is locked");
});

test("normalizeSignature redacts each kind of noise", () => {
  assert.equal(normalizeSignature("started at 2026-08-02T10:00:00.123Z ok"), "started at <t> ok");
  assert.equal(
    normalizeSignature("session 3f2b7c1e-9a44-4f0d-8b1e-0b5a7c9d1e2f ended"),
    "session <uuid> ended",
  );
  assert.equal(normalizeSignature("GET https://example.test/a/b?x=1 failed"), "GET <url> failed");
  assert.equal(normalizeSignature("read /Users/ada/Movies/reel.mov"), "read <path>");
  assert.equal(normalizeSignature("read C:\\Users\\ada\\reel.mov"), "read <path>");
  assert.equal(normalizeSignature("update 0.5.6 available"), "update <ver> available");
});

test("normalizeSignature keeps only the first line and collapses whitespace", () => {
  const signature = normalizeSignature("boom: it broke\nError: it broke\n    at fn (file.ts:1:2)");
  assert.equal(signature, "boom: it broke");
  assert.equal(normalizeSignature("  a   b \t c  "), "a b c");
});

test("normalizeSignature caps its length", () => {
  const signature = normalizeSignature("x".repeat(500));
  assert.equal(signature.length, 201);
  assert.ok(signature.endsWith("…"));
});

/* -------------------------------------------------------------- parsing */

test("parseBatch fills in what old builds do not send", () => {
  const parsed = parseBatch({
    installId: "install-a",
    sessionId: "session-1",
    seq: 2,
    appVersion: "0.5.3",
    osVersion: "25.5.0",
    dropped: 4,
    lines: [{ t: "2026-08-02T10:00:00.000Z", level: "warn", line: "hi" }, "nonsense", {}],
  });
  assert.ok(parsed);
  assert.equal(parsed.operator, null, "0.5.3 batches carry no operator");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.dropped, 4);
});

test("parseBatch rejects anything without a lines array", () => {
  assert.equal(parseBatch(null), null);
  assert.equal(parseBatch("nope"), null);
  assert.equal(parseBatch({ corrupt: "events/2026-08-02/1-x.json" }), null);
  assert.equal(parseBatch([]), null);
});

/* ------------------------------------------------------------ reducers */

test("aggregateDays rolls up a day", () => {
  const stats = aggregateDays([
    day(TODAY, [
      batch(),
      batch({ sessionId: "session-2", seq: 1, dropped: 3, lines: [
        { t: "2026-08-02T11:00:00.000Z", level: "error", line: "boom 1" },
        { t: "2026-08-02T11:00:01.000Z", level: "warn", line: "careful" },
      ] }),
      batch({ installId: "install-b", operator: null, appVersion: "0.5.3", sessionId: "session-3" }),
      "not json at all",
    ], { failed: 2 }),
  ]);

  const today = stats.days[0]!;
  assert.equal(today.batches, 3);
  assert.equal(today.installs, 2);
  assert.equal(today.sessions, 3);
  assert.equal(today.lines, 4);
  assert.equal(today.dropped, 3);
  assert.equal(today.corrupt, 3, "2 fetch failures plus 1 unparseable payload");
  assert.deepEqual(today.byLevel, { info: 2, error: 1, warn: 1 });
  assert.equal(today.errors, 1);
  assert.deepEqual(today.appVersions, { "0.5.6": 1, "0.5.3": 1 });
  assert.deepEqual(today.osVersions, { "25.5.0": 2 });
  assert.deepEqual(today.operators, [{ operator: "Ada", installs: 1, lines: 3 }]);

  const rows = today.installDetail;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.installId, "install-a");
  assert.equal(rows[0]!.sessions, 2);
  assert.equal(rows[0]!.errors, 1);
  assert.equal(rows[0]!.firstSeen, "2026-08-02T10:00:00.000Z");
  assert.equal(rows[0]!.lastSeen, "2026-08-02T11:00:01.000Z");
  assert.equal(rows[1]!.operator, null);
});

test("aggregateDays unions installs and sessions across days", () => {
  const stats = aggregateDays([
    day("2026-08-01", [batch()]),
    day(TODAY, [batch({ sessionId: "session-9" }), batch({ installId: "install-c", sessionId: "s" })]),
  ]);
  assert.equal(stats.totals.days, 2);
  assert.equal(stats.totals.installs, 2);
  assert.equal(stats.totals.sessions, 3);
  assert.equal(stats.totals.operators, 1);
  assert.equal(stats.totals.batches, 3);
});

test("aggregateDays builds signatures with facets, per-day counts and a verbatim sample", () => {
  const noisy = (id: string, level: string) => ({
    t: "2026-08-02T12:00:00.000Z",
    level,
    line: `[pipeline] failed to update clip 0x${id}: expected one matching location, found 2`,
  });
  const stats = aggregateDays([
    day("2026-08-01", [batch({ lines: [noisy("AAAAAAAAAAAA", "error")] })]),
    day(TODAY, [
      batch({ lines: [noisy("BBBBBBBBBBBB", "error")] }),
      batch({ installId: "install-b", operator: "Grace", appVersion: "0.5.3",
        lines: [noisy("CCCCCCCCCCCC", "error"), { t: "2026-08-02T12:01:00.000Z", level: "info", line: "quiet" }] }),
    ]),
  ]);

  assert.equal(stats.signatures.length, 1, "info lines never become signatures");
  const signature = stats.signatures[0]!;
  assert.equal(signature.count, 3);
  assert.equal(signature.level, "error");
  assert.equal(signature.installCount, 2);
  assert.deepEqual(signature.operators, ["Ada", "Grace"]);
  assert.deepEqual(signature.appVersions, ["0.5.3", "0.5.6"]);
  assert.deepEqual(signature.days, { "2026-08-01": 1, [TODAY]: 2 });
  assert.equal(signature.sample, noisy("AAAAAAAAAAAA", "error").line, "sample stays verbatim");
});

test("aggregateDays keeps levels apart and ranks by count", () => {
  const stats = aggregateDays([
    day(TODAY, [
      batch({ lines: [
        { t: "2026-08-02T12:00:00.000Z", level: "warn", line: "same text" },
        { t: "2026-08-02T12:00:01.000Z", level: "error", line: "same text" },
        { t: "2026-08-02T12:00:02.000Z", level: "error", line: "same text" },
        { t: "2026-08-02T12:00:03.000Z", level: "uncaught", line: "crash" },
      ] }),
    ]),
  ]);
  assert.equal(stats.signatures.length, 3);
  assert.equal(stats.signatures[0]!.count, 2);
  assert.equal(stats.signatures[0]!.level, "error");
  assert.equal(stats.signatureTotal, 3);
});

test("aggregateDays shares the install-row budget across a long range", () => {
  const many = (dayName: string) =>
    day(
      dayName,
      Array.from({ length: 80 }, (_, index) =>
        batch({ installId: `install-${index}`, sessionId: `s-${index}` })),
    );
  const oneDay = aggregateDays([many(TODAY)]);
  assert.equal(oneDay.days[0]!.installDetail.length, 80, "a single day is nowhere near the cap");

  const days = daysBetween("2026-07-04", TODAY);
  assert.equal(days.length, 30);
  const range = aggregateDays(days.map(many));
  const rows = range.days.reduce((total, entry) => total + entry.installDetail.length, 0);
  assert.ok(rows <= MAX_INSTALL_ROWS_TOTAL, `whole-range rows stay bounded, got ${rows}`);
  assert.equal(range.days[0]!.installDetailTruncated, true, "and the cut is reported");
});

test("aggregateDays caps a facet map that data blew up", () => {
  const lines = Array.from({ length: MAX_FACET_KEYS + 20 }, (_, index) => ({
    t: "2026-08-02T10:00:00.000Z",
    level: `level-${index}`,
    line: "noise",
  }));
  const stats = aggregateDays([day(TODAY, [batch({ lines })])]);
  const keys = Object.keys(stats.days[0]!.byLevel);
  assert.equal(keys.length, MAX_FACET_KEYS);
  assert.ok(keys.includes(FACET_OVERFLOW_KEY));
  assert.equal(stats.days[0]!.byLevel[FACET_OVERFLOW_KEY], 21, "the tail is kept, not dropped");
  assert.equal(stats.days[0]!.lines, MAX_FACET_KEYS + 20, "totals still count every line");
});

test("aggregateDays counts a level named like an Object member", () => {
  const stats = aggregateDays([
    day(TODAY, [
      batch({ lines: [
        { t: "2026-08-02T10:00:00.000Z", level: "__proto__", line: "hostile" },
        { t: "2026-08-02T10:00:01.000Z", level: "__proto__", line: "hostile" },
        { t: "2026-08-02T10:00:02.000Z", level: "constructor", line: "hostile" },
      ] }),
    ]),
  ]);
  const byLevel = stats.days[0]!.byLevel;
  assert.equal(Object.hasOwn(byLevel, "__proto__"), true, "a real own key, not a prototype write");
  assert.equal(byLevel["__proto__"], 2);
  assert.equal(byLevel["constructor"], 1);
  assert.equal(stats.days[0]!.lines, 3);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("createEventAggregator matches aggregateDays whatever order days arrive in", () => {
  const first = day("2026-08-01", [batch({ sessionId: "s-1" })]);
  const second = day(TODAY, [batch({ sessionId: "s-2" })]);
  const shuffled = createEventAggregator({ dayCount: 2 });
  shuffled.addDay(second);
  shuffled.addDay(first);
  const out = shuffled.finish();
  assert.deepEqual(out.days.map((entry) => entry.day), ["2026-08-01", TODAY], "sorted at finish");
  assert.deepEqual(out, aggregateDays([first, second]));
});

test("createLlmAggregator separates absent records from a zero day", () => {
  const empty = createLlmAggregator();
  empty.addDay(day(TODAY, []));
  assert.equal(empty.finish().present, false, "no blobs at all");

  const zero = createLlmAggregator();
  zero.addDay(day(TODAY, [{ t: "2026-08-02T09:00:00.000Z", route: "chat/completions", status: 200 }]));
  const stats = zero.finish();
  assert.equal(stats.present, true);
  assert.equal(stats.totals.total, 0, "a request that reported no tokens");
});

/* ----------------------------------------------------------- drilldown */

test("drilldownInstall merges sessions in time order", () => {
  const raw = day(TODAY, [
    batch({ sessionId: "session-2", seq: 0, lines: [
      { t: "2026-08-02T10:00:05.000Z", level: "info", line: "second session" },
    ] }),
    batch({ sessionId: "session-1", seq: 0, lines: [
      { t: "2026-08-02T10:00:01.000Z", level: "info", line: "first" },
      { t: "2026-08-02T10:00:09.000Z", level: "warn", line: "third" },
    ] }),
    batch({ installId: "install-b", lines: [
      { t: "2026-08-02T10:00:02.000Z", level: "info", line: "other install" },
    ] }),
  ]);

  const drill = drilldownInstall([raw], "install-a");
  assert.equal(drill.found, true);
  assert.equal(drill.lineTotal, 3);
  assert.deepEqual(drill.lines.map((line) => line.line), ["first", "second session", "third"]);
  assert.deepEqual(drill.lines.map((line) => line.sessionId), ["session-1", "session-2", "session-1"]);
  assert.equal(drill.sessions.length, 2);
  assert.equal(drill.sessions[0]!.sessionId, "session-1", "sessions sort by first line");
  assert.equal(drill.truncated, false);
});

test("drilldownInstall keeps the newest lines when it has to cut", () => {
  const lines = Array.from({ length: 10 }, (_, index) => ({
    t: `2026-08-02T10:00:0${index}.000Z`,
    level: "info",
    line: `line ${index}`,
  }));
  const drill = drilldownInstall([day(TODAY, [batch({ lines })])], "install-a", 3);
  assert.equal(drill.truncated, true);
  assert.equal(drill.lineTotal, 10);
  assert.deepEqual(drill.lines.map((line) => line.line), ["line 7", "line 8", "line 9"]);
});

test("drilldownInstall clips a single monstrous line", () => {
  const huge = "x".repeat(MAX_DRILLDOWN_LINE_CHARS + 5000);
  const drill = drilldownInstall(
    [day(TODAY, [batch({ lines: [{ t: "2026-08-02T10:00:00.000Z", level: "warn", line: huge }] })])],
    "install-a",
  );
  assert.equal(drill.lines.length, 1);
  assert.equal(drill.lines[0]!.clipped, true);
  assert.equal(drill.lines[0]!.line.length, MAX_DRILLDOWN_LINE_CHARS + 1, "clipped plus the ellipsis");
  assert.equal(drill.truncated, false, "one line kept whole in count terms");
});

test("drilldownInstall stops at the byte budget, not just the line count", () => {
  // 3000 lines of 2000 chars is ~6MB — over the 4.5MB response limit at a line
  // count the 5000-line cap would happily allow.
  const text = "y".repeat(MAX_DRILLDOWN_LINE_CHARS);
  const start = Date.parse("2026-08-02T10:00:00.000Z");
  const lines = Array.from({ length: 3000 }, (_, index) => ({
    t: new Date(start + index * 10).toISOString(),
    level: "info",
    line: `${index} ${text}`,
  }));
  const drill = drilldownInstall([day(TODAY, [batch({ lines })])], "install-a");
  assert.equal(drill.lineTotal, 3000);
  assert.ok(drill.lines.length < 3000, "the byte budget cut it");
  assert.equal(drill.truncated, true);
  assert.ok(drill.approxBytes <= DRILLDOWN_BYTE_BUDGET, "stayed inside the budget");
  assert.ok(
    JSON.stringify(drill).length < 4_000_000,
    "the whole serialized response fits under Vercel's 4.5MB limit",
  );
  // Still the tail: the newest line survives.
  assert.ok(drill.lines[drill.lines.length - 1]!.line.startsWith("2999 "));
});

test("drilldownInstall reports a miss instead of throwing", () => {
  const drill = drilldownInstall([day(TODAY, [batch()])], "nobody");
  assert.equal(drill.found, false);
  assert.equal(drill.lines.length, 0);
  assert.equal(drill.sessions.length, 0);
});

/* ----------------------------------------------------------------- llm */

test("parseUsageRecord reads the proxy's own entry shape", () => {
  const record = parseUsageRecord({
    t: "2026-08-02T09:00:00.000Z",
    route: "chat/completions",
    operator: "Ada",
    token: "ada",
    model: "openai/gpt-5.6-sol",
    status: 200,
    stream: true,
    usage: { prompt: 100, completion: 20, total: 120 },
  });
  assert.ok(record);
  assert.equal(record.label, "ada");
  assert.equal(record.prompt, 100);
  assert.equal(record.total, 120);
  assert.equal(parseUsageRecord({ nothing: true }), null);
  assert.equal(parseUsageRecord(42), null);
});

test("aggregateLlmDays totals by model and by label", () => {
  const usage = (over: Record<string, unknown>) => ({
    t: "2026-08-02T09:00:00.000Z",
    route: "chat/completions",
    operator: "Ada",
    token: "ada",
    model: "openai/gpt-5.6-sol",
    status: 200,
    stream: false,
    usage: { prompt: 10, completion: 5, total: 15 },
    ...over,
  });
  const stats = aggregateLlmDays([
    day(TODAY, [
      usage({}),
      usage({ token: "grace", model: "x-ai/grok-4.5", usage: { prompt: 4, completion: 6 } }),
      usage({ status: 502, usage: undefined }),
      { junk: true },
    ], { failed: 1 }),
  ]);

  const today = stats.days[0]!;
  assert.equal(today.requests, 3);
  assert.equal(today.errors, 1);
  assert.equal(today.total, 25, "a missing total falls back to prompt + completion");
  assert.equal(today.corrupt, 2);
  assert.equal(today.byModel["openai/gpt-5.6-sol"]!.requests, 2);
  assert.equal(today.byModel["x-ai/grok-4.5"]!.total, 10);
  assert.equal(today.byLabel["grace"]!.requests, 1);
  assert.deepEqual(today.byRoute, { "chat/completions": 3 });
  assert.equal(stats.totals.requests, 3);
  assert.equal(stats.totals.total, 25);
});

test("aggregateLlmDays reports an empty day without inventing numbers", () => {
  const stats = aggregateLlmDays([day(TODAY, [])]);
  assert.equal(stats.days[0]!.requests, 0);
  assert.equal(stats.days[0]!.total, 0);
  assert.deepEqual(stats.byModel, {});
});

/* --------------------------------------------------------- concurrency */

test("mapWithConcurrency keeps order and respects the limit", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  let live = 0;
  let peak = 0;
  const results = await mapWithConcurrency(items, 3, async (item) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 1));
    live -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test("mapWithConcurrency handles an empty list", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});
