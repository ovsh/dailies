/**
 * Pure aggregation for the telemetry dashboard.
 *
 * Everything here is a plain function over plain data: no blob client, no
 * request object, no environment. `api/stats.ts` does the I/O and hands the
 * raw JSON in. That split is what makes the interesting part — day-range
 * validation, error-signature normalization, the reducers — testable with
 * `node --test` and nothing else running.
 *
 * Two rules the reducers follow everywhere:
 * - Every input is `unknown`. A batch written by an older app build can be
 *   missing fields (real 0.5.3 batches carry no `operator` at all), and a
 *   truncated blob can be any shape. Nothing may throw; unusable input is
 *   counted and skipped.
 * - Nothing here stores or returns more log text than it was given. A
 *   signature is a redacted shape plus ONE verbatim sample line.
 */

/** Levels the app's logger emits (src/main/index.ts). Anything else passes through as-is. */
export const ERROR_LEVELS: ReadonlySet<string> = new Set([
  "error",
  "uncaught",
  "unhandledRejection",
]);

/** Levels that get grouped into signatures for the Issues view. */
export const SIGNATURE_LEVELS: ReadonlySet<string> = new Set([...ERROR_LEVELS, "warn"]);

/** A range wider than this is a mistake, not a query — the blob listing cost is per day. */
export const MAX_RANGE_DAYS = 31;

const MAX_SIGNATURES = 200;
const MAX_SIGNATURE_CHARS = 200;
const MAX_SAMPLE_CHARS = 2000;
const MAX_SIGNATURE_FACETS = 20;

/**
 * Response-size budget. A Vercel function response is hard-capped at 4.5MB, and
 * the cap is hit exactly when the day is interesting — the noisiest install on
 * the busiest day. Everything the endpoint returns is therefore bounded by a
 * constant, not by how much telemetry arrived:
 *
 * - install rows: per day, and again across the whole range
 * - facet maps (levels, versions, models): keyed by DATA, so they need a
 *   ceiling of their own or one weird build invents 10,000 keys
 * - drill-down: a line count AND a byte budget, with over-long lines clipped
 */
export const MAX_INSTALL_ROWS_PER_DAY = 500;
export const MAX_INSTALL_ROWS_TOTAL = 1500;
const MIN_INSTALL_ROWS_PER_DAY = 25;
export const MAX_FACET_KEYS = 50;
/** Overflow bucket for a facet map past MAX_FACET_KEYS. Parenthesised so it
 *  cannot collide with a real level, version or model name. */
export const FACET_OVERFLOW_KEY = "(other)";
export const DEFAULT_DRILLDOWN_LINE_CAP = 5000;
export const DRILLDOWN_BYTE_BUDGET = 3_000_000;
export const MAX_DRILLDOWN_LINE_CHARS = 2000;

export interface TelemetryLine {
  t: string;
  level: string;
  line: string;
}

export interface TelemetryBatch {
  installId: string;
  operator: string | null;
  sessionId: string;
  seq: number;
  appVersion: string;
  osVersion: string;
  dropped: number;
  lines: TelemetryLine[];
}

/** One day's raw blob payloads, plus what went wrong while reading them. */
export interface RawDay {
  day: string;
  /** Parsed JSON of each blob, in listing order. */
  payloads: unknown[];
  /** Blobs that could not be fetched or parsed. */
  failed: number;
  /** True when the listing hit its limit, so the day is under-reported. */
  truncated: boolean;
}

export interface InstallStat {
  installId: string;
  operator: string | null;
  appVersions: string[];
  osVersions: string[];
  sessions: number;
  batches: number;
  lines: number;
  byLevel: Record<string, number>;
  errors: number;
  dropped: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface OperatorStat {
  operator: string;
  installs: number;
  lines: number;
}

export interface DayStats {
  day: string;
  batches: number;
  installs: number;
  sessions: number;
  lines: number;
  dropped: number;
  corrupt: number;
  truncated: boolean;
  operators: OperatorStat[];
  /** version → number of installs seen on it that day */
  appVersions: Record<string, number>;
  osVersions: Record<string, number>;
  byLevel: Record<string, number>;
  errors: number;
  installDetail: InstallStat[];
  installDetailTruncated: boolean;
}

export interface ErrorSignature {
  signature: string;
  level: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  installs: string[];
  installCount: number;
  operators: string[];
  appVersions: string[];
  /** day → count, so the client can split a range into current vs previous. */
  days: Record<string, number>;
  sample: string;
}

export interface RangeTotals {
  days: number;
  batches: number;
  installs: number;
  sessions: number;
  operators: number;
  lines: number;
  dropped: number;
  corrupt: number;
  errors: number;
  byLevel: Record<string, number>;
}

export interface EventStats {
  days: DayStats[];
  signatures: ErrorSignature[];
  signatureTotal: number;
  totals: RangeTotals;
}

/* ------------------------------------------------------------------ dates */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Strict: shape AND a real calendar date, so 2026-02-31 is rejected. */
export function isValidDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const base = new Date(`${day}T00:00:00.000Z`).getTime();
  return new Date(base + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive list of days. Returns [] when `to` is before `from`. */
export function daysBetween(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  if (end < start) return [];
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

export interface DayRangeQuery {
  day?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export type DayRangeResult =
  | { ok: true; from: string; to: string; days: string[] }
  | { ok: false; error: string };

/**
 * `day=` for one day, or `from=`+`to=` inclusive. No parameters means today.
 * Mixing the two forms is an error rather than a precedence rule nobody
 * remembers.
 */
export function parseDayRange(query: DayRangeQuery, today: string): DayRangeResult {
  const { day, from, to } = query;
  const hasSingle = day !== undefined && day !== "";
  const hasFrom = from !== undefined && from !== "";
  const hasTo = to !== undefined && to !== "";

  if (hasSingle && (hasFrom || hasTo)) {
    return { ok: false, error: "use day, or from and to — not both" };
  }
  if (hasSingle) {
    if (!isValidDay(day)) return { ok: false, error: "invalid day" };
    return { ok: true, from: day, to: day, days: [day] };
  }
  if (hasFrom !== hasTo) return { ok: false, error: "from and to are required together" };
  if (!hasFrom || !hasTo) {
    return { ok: true, from: today, to: today, days: [today] };
  }
  if (!isValidDay(from)) return { ok: false, error: "invalid from" };
  if (!isValidDay(to)) return { ok: false, error: "invalid to" };
  if (to < from) return { ok: false, error: "to is before from" };
  const days = daysBetween(from, to);
  if (days.length > MAX_RANGE_DAYS) {
    return { ok: false, error: `range is longer than ${MAX_RANGE_DAYS} days` };
  }
  return { ok: true, from, to, days };
}

/* ------------------------------------------------------------- signatures */

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|]*/g;
const POSIX_PATH = /(?<![\w:])\/(?:[\w.~@%+-]+\/)+[\w.~@%+-]*/g;
const HEX_ID = /\b(?:0x)?[0-9a-fA-F]{12,}\b/g;
const SEMVER = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;
// No word boundary on either end: real lines write their counters glued to a
// unit or an identifier ("after 567ms", "job42"), and a \b there would leave
// the digits in the key — one signature per measurement.
const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * Turns one log line into a stable grouping key: same failure, same string,
 * whatever ids and counters it carried. The order matters — timestamps and
 * URLs first, because both contain digits and separators that the later,
 * greedier patterns would otherwise eat.
 *
 * Only the first physical line is used: a stack trace below the message is
 * the same failure from many call sites, and keeping it would shatter one
 * issue into dozens.
 */
export function normalizeSignature(line: string): string {
  const head = line.split("\n", 1)[0] ?? "";
  const collapsed = head.replace(/\s+/g, " ").trim();
  const redacted = collapsed
    .replace(ISO_TIMESTAMP, "<t>")
    .replace(UUID, "<uuid>")
    .replace(URL_LIKE, "<url>")
    .replace(WINDOWS_PATH, "<path>")
    .replace(POSIX_PATH, "<path>")
    .replace(HEX_ID, "<hex>")
    .replace(SEMVER, "<ver>")
    .replace(NUMBER, "<n>");
  const trimmed = redacted.trim();
  if (trimmed.length <= MAX_SIGNATURE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SIGNATURE_CHARS)}…`;
}

/* ---------------------------------------------------------------- parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function parseLine(value: unknown): TelemetryLine | null {
  if (!isRecord(value)) return null;
  const text = value["line"];
  if (typeof text !== "string") return null;
  return {
    t: readString(value["t"], ""),
    level: readString(value["level"], "unknown"),
    line: text,
  };
}

/**
 * Accepts anything, returns a batch with every field present, or null when the
 * payload has no lines array at all (a `{ corrupt: … }` marker from dump, or a
 * blob that is not a batch).
 */
export function parseBatch(value: unknown): TelemetryBatch | null {
  if (!isRecord(value)) return null;
  const rawLines = value["lines"];
  if (!Array.isArray(rawLines)) return null;
  const lines: TelemetryLine[] = [];
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line) lines.push(line);
  }
  const operator = value["operator"];
  return {
    installId: readString(value["installId"], "unknown"),
    operator: typeof operator === "string" && operator.trim().length > 0 ? operator.trim() : null,
    sessionId: readString(value["sessionId"], "unknown"),
    seq: readCount(value["seq"]),
    appVersion: readString(value["appVersion"], "unknown"),
    osVersion: readString(value["osVersion"], "unknown"),
    dropped: readCount(value["dropped"]),
    lines,
  };
}

/* -------------------------------------------------------------- reducers */

/**
 * Every counter map here is keyed by DATA — a log level, an app version, a
 * model name — so `__proto__` and `constructor` are legal keys as far as this
 * code knows. On a normal object `map["__proto__"] = 1` silently sets nothing
 * and `map["constructor"]` reads a function; both are wrong answers rather than
 * errors. A null prototype removes the question.
 */
function counts<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (Object.hasOwn(map, key) ? (map[key] as number) : 0) + by;
}

/**
 * Caps a data-keyed map, keeping the biggest keys and folding the tail into one
 * bucket. Without this a build that logs a fresh level per line would put an
 * unbounded object in the response.
 */
function topKeys(map: Record<string, number>, limit = MAX_FACET_KEYS): Record<string, number> {
  const entries = Object.entries(map);
  // Emitted maps are ordinary objects: accumulation needs the null prototype,
  // the response does not, and a spread copies own properties only — including
  // a literal "__proto__" key, which plain assignment would have swallowed.
  if (entries.length <= limit) return { ...map };
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = counts<number>();
  let overflow = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i] as [string, number];
    if (i < limit - 1) out[key] = value;
    else overflow += value;
  }
  out[FACET_OVERFLOW_KEY] = overflow;
  return { ...out };
}

function addToSet(map: Map<string, Set<string>>, key: string, member: string): void {
  const set = map.get(key);
  if (set) set.add(member);
  else map.set(key, new Set([member]));
}

interface InstallAcc {
  installId: string;
  operator: string | null;
  appVersions: Set<string>;
  osVersions: Set<string>;
  sessions: Set<string>;
  batches: number;
  lines: number;
  byLevel: Record<string, number>;
  dropped: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

interface SignatureAcc {
  signature: string;
  level: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  installs: Set<string>;
  operators: Set<string>;
  appVersions: Set<string>;
  days: Record<string, number>;
  sample: string;
}

function errorCount(byLevel: Record<string, number>): number {
  let total = 0;
  for (const [level, count] of Object.entries(byLevel)) {
    if (ERROR_LEVELS.has(level)) total += count;
  }
  return total;
}

function noteSeen(acc: { firstSeen: string | null; lastSeen: string | null }, t: string): void {
  if (!t) return;
  if (acc.firstSeen === null || t < acc.firstSeen) acc.firstSeen = t;
  if (acc.lastSeen === null || t > acc.lastSeen) acc.lastSeen = t;
}

function capped(set: Set<string>): string[] {
  return [...set].sort().slice(0, MAX_SIGNATURE_FACETS);
}

export interface AggregateOptions {
  /**
   * How many days the caller intends to add. It only sets the per-day share of
   * the install-row budget; adding more days than announced is safe, they just
   * get the same share each.
   */
  dayCount?: number;
}

export interface EventAggregator {
  addDay(raw: RawDay): void;
  finish(): EventStats;
}

/**
 * The one pass that produces everything the dashboard shows: per-day rollups,
 * per-install rows, and cross-day error signatures.
 *
 * Incremental on purpose. A 31-day range holds tens of thousands of blobs, and
 * reading them all into an array before reducing means the whole range sits in
 * memory at once. The caller feeds one day at a time and drops its payloads,
 * so the peak is one day per in-flight fetch.
 */
export function createEventAggregator(options: AggregateOptions = {}): EventAggregator {
  const days: DayStats[] = [];
  const signatures = new Map<string, SignatureAcc>();

  const totalInstalls = new Set<string>();
  const totalSessions = new Set<string>();
  const totalOperators = new Set<string>();
  const totalByLevel = counts<number>();
  let totalBatches = 0;
  let totalLines = 0;
  let totalDropped = 0;
  let totalCorrupt = 0;

  const dayCount = Math.max(1, Math.floor(options.dayCount ?? 1));
  const installRowsPerDay = Math.min(
    MAX_INSTALL_ROWS_PER_DAY,
    Math.max(MIN_INSTALL_ROWS_PER_DAY, Math.floor(MAX_INSTALL_ROWS_TOTAL / dayCount)),
  );

  function addDay(raw: RawDay): void {
    const installAccs = new Map<string, InstallAcc>();
    const sessions = new Set<string>();
    const versionInstalls = new Map<string, Set<string>>();
    const osInstalls = new Map<string, Set<string>>();
    const operatorInstalls = new Map<string, Set<string>>();
    const operatorLines = new Map<string, number>();
    const byLevel = counts<number>();
    let batches = 0;
    let lines = 0;
    let dropped = 0;
    let corrupt = raw.failed;

    for (const payload of raw.payloads) {
      const batch = parseBatch(payload);
      if (!batch) {
        corrupt += 1;
        continue;
      }
      batches += 1;
      dropped += batch.dropped;
      sessions.add(batch.sessionId);
      addToSet(versionInstalls, batch.appVersion, batch.installId);
      addToSet(osInstalls, batch.osVersion, batch.installId);
      if (batch.operator) addToSet(operatorInstalls, batch.operator, batch.installId);

      let install = installAccs.get(batch.installId);
      if (!install) {
        install = {
          installId: batch.installId,
          operator: batch.operator,
          appVersions: new Set(),
          osVersions: new Set(),
          sessions: new Set(),
          batches: 0,
          lines: 0,
          byLevel: counts<number>(),
          dropped: 0,
          firstSeen: null,
          lastSeen: null,
        };
        installAccs.set(batch.installId, install);
      }
      // A rename lands mid-day; the latest non-null name wins.
      if (batch.operator) install.operator = batch.operator;
      install.batches += 1;
      install.dropped += batch.dropped;
      install.sessions.add(batch.sessionId);
      install.appVersions.add(batch.appVersion);
      install.osVersions.add(batch.osVersion);

      for (const line of batch.lines) {
        lines += 1;
        install.lines += 1;
        bump(byLevel, line.level);
        bump(install.byLevel, line.level);
        bump(totalByLevel, line.level);
        noteSeen(install, line.t);
        if (batch.operator) {
          operatorLines.set(batch.operator, (operatorLines.get(batch.operator) ?? 0) + 1);
        }
        if (!SIGNATURE_LEVELS.has(line.level)) continue;

        const signature = normalizeSignature(line.line);
        const key = `${line.level} ${signature}`;
        let acc = signatures.get(key);
        if (!acc) {
          acc = {
            signature,
            level: line.level,
            count: 0,
            firstSeen: null,
            lastSeen: null,
            installs: new Set(),
            operators: new Set(),
            appVersions: new Set(),
            days: counts<number>(),
            sample: line.line.slice(0, MAX_SAMPLE_CHARS),
          };
          signatures.set(key, acc);
        }
        acc.count += 1;
        acc.installs.add(batch.installId);
        if (batch.operator) acc.operators.add(batch.operator);
        acc.appVersions.add(batch.appVersion);
        bump(acc.days, raw.day);
        noteSeen(acc, line.t);
      }
    }

    const installDetail = [...installAccs.values()]
      .map((acc): InstallStat => ({
        installId: acc.installId,
        operator: acc.operator,
        appVersions: [...acc.appVersions].sort(),
        osVersions: [...acc.osVersions].sort(),
        sessions: acc.sessions.size,
        batches: acc.batches,
        lines: acc.lines,
        byLevel: topKeys(acc.byLevel),
        errors: errorCount(acc.byLevel),
        dropped: acc.dropped,
        firstSeen: acc.firstSeen,
        lastSeen: acc.lastSeen,
      }))
      .sort((a, b) => b.lines - a.lines || a.installId.localeCompare(b.installId));

    const operators = [...operatorInstalls.entries()]
      .map(([operator, set]): OperatorStat => ({
        operator,
        installs: set.size,
        lines: operatorLines.get(operator) ?? 0,
      }))
      .sort((a, b) => b.lines - a.lines || a.operator.localeCompare(b.operator));

    const appVersions = counts<number>();
    for (const [version, set] of versionInstalls) appVersions[version] = set.size;
    const osVersions = counts<number>();
    for (const [os, set] of osInstalls) osVersions[os] = set.size;

    for (const acc of installAccs.values()) totalInstalls.add(acc.installId);
    for (const session of sessions) totalSessions.add(session);
    for (const operator of operatorInstalls.keys()) totalOperators.add(operator);
    totalBatches += batches;
    totalLines += lines;
    totalDropped += dropped;
    totalCorrupt += corrupt;

    days.push({
      day: raw.day,
      batches,
      installs: installAccs.size,
      sessions: sessions.size,
      lines,
      dropped,
      corrupt,
      truncated: raw.truncated,
      operators: operators.slice(0, MAX_FACET_KEYS),
      appVersions: topKeys(appVersions),
      osVersions: topKeys(osVersions),
      byLevel: topKeys(byLevel),
      errors: errorCount(byLevel),
      installDetail: installDetail.slice(0, installRowsPerDay),
      installDetailTruncated: installDetail.length > installRowsPerDay,
    });
  }

  function finish(): EventStats {
    // Days arrive in whatever order their fetches finished; the dashboard reads
    // them as a time series.
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const ranked = [...signatures.values()].sort((a, b) => b.count - a.count);
    const top = ranked.slice(0, MAX_SIGNATURES).map((acc): ErrorSignature => ({
      signature: acc.signature,
      level: acc.level,
      count: acc.count,
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
      installs: capped(acc.installs),
      installCount: acc.installs.size,
      operators: capped(acc.operators),
      appVersions: capped(acc.appVersions),
      days: { ...acc.days },
      sample: acc.sample,
    }));

    return {
      days,
      signatures: top,
      signatureTotal: ranked.length,
      totals: {
        days: days.length,
        batches: totalBatches,
        installs: totalInstalls.size,
        sessions: totalSessions.size,
        operators: totalOperators.size,
        lines: totalLines,
        dropped: totalDropped,
        corrupt: totalCorrupt,
        errors: errorCount(totalByLevel),
        byLevel: topKeys(totalByLevel),
      },
    };
  }

  return { addDay, finish };
}

/** One-shot form, for tests and for anyone holding every day already. */
export function aggregateDays(
  rawDays: readonly RawDay[],
  options: AggregateOptions = {},
): EventStats {
  const aggregator = createEventAggregator({ dayCount: rawDays.length, ...options });
  for (const raw of rawDays) aggregator.addDay(raw);
  return aggregator.finish();
}

/* ------------------------------------------------------------- drill-down */

export interface SessionLine extends TelemetryLine {
  sessionId: string;
  /** Set when the line itself was cut to MAX_DRILLDOWN_LINE_CHARS. */
  clipped?: boolean;
}

export interface SessionDetail {
  sessionId: string;
  appVersion: string;
  osVersion: string;
  operator: string | null;
  batches: number;
  lines: number;
  dropped: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface InstallDrilldown {
  day: string;
  installId: string;
  found: boolean;
  sessions: SessionDetail[];
  lines: SessionLine[];
  lineTotal: number;
  /** Rough JSON size of `lines`, so the cap is visible instead of mysterious. */
  approxBytes: number;
  truncated: boolean;
}

/**
 * One install's whole day, in time order across its sessions. Ordering is by
 * the line's own timestamp with the batch sequence as the tiebreak, so lines
 * logged inside the same millisecond keep the order they were written in.
 */
export function drilldownInstall(
  rawDays: readonly RawDay[],
  installId: string,
  cap: number = DEFAULT_DRILLDOWN_LINE_CAP,
): InstallDrilldown {
  const day = rawDays[0]?.day ?? "";
  const sessionAccs = new Map<string, SessionDetail>();
  const collected: Array<{ line: SessionLine; seq: number; index: number }> = [];
  let found = false;
  let index = 0;

  for (const raw of rawDays) {
    for (const payload of raw.payloads) {
      const batch = parseBatch(payload);
      if (!batch || batch.installId !== installId) continue;
      found = true;
      let session = sessionAccs.get(batch.sessionId);
      if (!session) {
        session = {
          sessionId: batch.sessionId,
          appVersion: batch.appVersion,
          osVersion: batch.osVersion,
          operator: batch.operator,
          batches: 0,
          lines: 0,
          dropped: 0,
          firstSeen: null,
          lastSeen: null,
        };
        sessionAccs.set(batch.sessionId, session);
      }
      session.batches += 1;
      session.dropped += batch.dropped;
      if (batch.operator) session.operator = batch.operator;
      for (const line of batch.lines) {
        session.lines += 1;
        noteSeen(session, line.t);
        collected.push({
          line: { ...line, sessionId: batch.sessionId },
          seq: batch.seq,
          index: index++,
        });
      }
    }
  }

  collected.sort((a, b) => {
    if (a.line.t !== b.line.t) return a.line.t < b.line.t ? -1 : 1;
    return a.seq - b.seq || a.index - b.index;
  });

  const sessions = [...sessionAccs.values()].sort((a, b) => {
    const left = a.firstSeen ?? "";
    const right = b.firstSeen ?? "";
    return left < right ? -1 : left > right ? 1 : a.sessionId.localeCompare(b.sessionId);
  });

  // Keep the TAIL: when a day overflows the cap, the newest lines are the ones
  // an engineer opened the drill-down to read. Walking backwards means the byte
  // budget spends itself on the newest lines too.
  //
  // The line cap alone is not enough. 5000 lines of ordinary logging is ~1MB,
  // but 5000 lines carrying a serialized project state is over the 4.5MB
  // response limit — and that is exactly the install someone drills into. So:
  // clip any single monstrous line, and stop at a byte budget.
  const kept: SessionLine[] = [];
  let bytes = 0;
  for (let i = collected.length - 1; i >= 0 && kept.length < cap; i -= 1) {
    const entry = collected[i] as { line: SessionLine };
    const text = entry.line.line;
    const line: SessionLine = text.length > MAX_DRILLDOWN_LINE_CHARS
      ? { ...entry.line, line: `${text.slice(0, MAX_DRILLDOWN_LINE_CHARS)}…`, clipped: true }
      : entry.line;
    // The JSON cost of the line: its fields plus the key names and punctuation.
    const size = line.line.length + line.t.length + line.level.length + line.sessionId.length + 64;
    // Always keep at least one line, or a single over-budget line returns an
    // empty log with no explanation.
    if (kept.length > 0 && bytes + size > DRILLDOWN_BYTE_BUDGET) break;
    bytes += size;
    kept.push(line);
  }
  kept.reverse();

  return {
    day,
    installId,
    found,
    sessions,
    lines: kept,
    lineTotal: collected.length,
    approxBytes: bytes,
    truncated: collected.length > kept.length,
  };
}

/* ------------------------------------------------------------- llm usage */

export interface UsageRecord {
  t: string;
  route: string;
  operator: string | null;
  label: string;
  model: string;
  status: number;
  stream: boolean;
  prompt: number;
  completion: number;
  total: number;
}

export interface UsageBucket {
  requests: number;
  prompt: number;
  completion: number;
  total: number;
}

export interface LlmDayStats {
  day: string;
  requests: number;
  errors: number;
  prompt: number;
  completion: number;
  total: number;
  byModel: Record<string, UsageBucket>;
  byLabel: Record<string, UsageBucket>;
  byRoute: Record<string, number>;
  corrupt: number;
  truncated: boolean;
}

export interface LlmStats {
  days: LlmDayStats[];
  totals: UsageBucket & { errors: number; corrupt: number };
  byModel: Record<string, UsageBucket>;
  byLabel: Record<string, UsageBucket>;
  /**
   * True when the range held at least one usage blob. It separates "the proxy
   * served nothing" from "these records do not exist yet", which the dashboard
   * must not draw as a zero.
   */
  present: boolean;
}

/** The shape `lib/managed-llm.ts` writes. Everything is optional in practice. */
export function parseUsageRecord(value: unknown): UsageRecord | null {
  if (!isRecord(value)) return null;
  const route = value["route"];
  const t = value["t"];
  if (typeof route !== "string" && typeof t !== "string") return null;
  const usage = isRecord(value["usage"]) ? value["usage"] : {};
  const status = value["status"];
  const operator = value["operator"];
  return {
    t: typeof t === "string" ? t : "",
    route: typeof route === "string" ? route : "unknown",
    operator: typeof operator === "string" && operator.length > 0 ? operator : null,
    label: readString(value["token"], "unknown"),
    model: readString(value["model"], "unknown"),
    status: typeof status === "number" && Number.isFinite(status) ? status : 0,
    stream: value["stream"] === true,
    prompt: readCount(usage["prompt"]),
    completion: readCount(usage["completion"]),
    total: readCount(usage["total"]),
  };
}

function bucketFor(map: Record<string, UsageBucket>, key: string): UsageBucket {
  if (Object.hasOwn(map, key)) return map[key] as UsageBucket;
  const created: UsageBucket = { requests: 0, prompt: 0, completion: 0, total: 0 };
  map[key] = created;
  return created;
}

/** The bucket equivalent of topKeys: model and label names come from data. */
function topBuckets(
  map: Record<string, UsageBucket>,
  limit = MAX_FACET_KEYS,
): Record<string, UsageBucket> {
  const entries = Object.entries(map);
  if (entries.length <= limit) return { ...map };
  entries.sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
  const out = counts<UsageBucket>();
  const overflow: UsageBucket = { requests: 0, prompt: 0, completion: 0, total: 0 };
  for (let i = 0; i < entries.length; i += 1) {
    const [key, bucket] = entries[i] as [string, UsageBucket];
    if (i < limit - 1) {
      out[key] = bucket;
      continue;
    }
    overflow.requests += bucket.requests;
    overflow.prompt += bucket.prompt;
    overflow.completion += bucket.completion;
    overflow.total += bucket.total;
  }
  out[FACET_OVERFLOW_KEY] = overflow;
  return { ...out };
}

function addUsage(bucket: UsageBucket, record: UsageRecord): void {
  bucket.requests += 1;
  bucket.prompt += record.prompt;
  bucket.completion += record.completion;
  // OpenRouter usually sends `total`, but not always; fall back to the parts so
  // a missing total never reads as "this day cost nothing".
  bucket.total += record.total > 0 ? record.total : record.prompt + record.completion;
}

export interface LlmAggregator {
  addDay(raw: RawDay): void;
  finish(): LlmStats;
}

/** Same incremental shape as createEventAggregator, same reason. */
export function createLlmAggregator(): LlmAggregator {
  const days: LlmDayStats[] = [];
  const byModel = counts<UsageBucket>();
  const byLabel = counts<UsageBucket>();
  let present = false;
  const totals: UsageBucket & { errors: number; corrupt: number } = {
    requests: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    errors: 0,
    corrupt: 0,
  };

  function addDay(raw: RawDay): void {
    const dayModel = counts<UsageBucket>();
    const dayLabel = counts<UsageBucket>();
    const byRoute = counts<number>();
    const dayBucket: UsageBucket = { requests: 0, prompt: 0, completion: 0, total: 0 };
    let corrupt = raw.failed;
    let errors = 0;
    if (raw.payloads.length > 0 || raw.failed > 0) present = true;

    for (const payload of raw.payloads) {
      const record = parseUsageRecord(payload);
      if (!record) {
        corrupt += 1;
        continue;
      }
      if (record.status >= 400 || record.status === 0) errors += 1;
      bump(byRoute, record.route);
      addUsage(dayBucket, record);
      addUsage(bucketFor(dayModel, record.model), record);
      addUsage(bucketFor(dayLabel, record.label), record);
      addUsage(bucketFor(byModel, record.model), record);
      addUsage(bucketFor(byLabel, record.label), record);
    }

    totals.requests += dayBucket.requests;
    totals.prompt += dayBucket.prompt;
    totals.completion += dayBucket.completion;
    totals.total += dayBucket.total;
    totals.errors += errors;
    totals.corrupt += corrupt;

    days.push({
      day: raw.day,
      requests: dayBucket.requests,
      errors,
      prompt: dayBucket.prompt,
      completion: dayBucket.completion,
      total: dayBucket.total,
      byModel: topBuckets(dayModel),
      byLabel: topBuckets(dayLabel),
      byRoute: topKeys(byRoute),
      corrupt,
      truncated: raw.truncated,
    });
  }

  function finish(): LlmStats {
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return {
      days,
      totals,
      byModel: topBuckets(byModel),
      byLabel: topBuckets(byLabel),
      present,
    };
  }

  return { addDay, finish };
}

/** One-shot form, for tests and for anyone holding every day already. */
export function aggregateLlmDays(rawDays: readonly RawDay[]): LlmStats {
  const aggregator = createLlmAggregator();
  for (const raw of rawDays) aggregator.addDay(raw);
  return aggregator.finish();
}

/* ------------------------------------------------------------ concurrency */

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving
 * result order. A day can hold hundreds of blobs; unbounded `Promise.all`
 * over them opens hundreds of sockets and gets throttled.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  }

  const runners: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(size, items.length); i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}
