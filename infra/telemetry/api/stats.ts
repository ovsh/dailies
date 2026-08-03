/**
 * Aggregation endpoint behind the dashboard.
 *
 *   /api/stats?day=2026-08-02                 one day
 *   /api/stats?from=2026-07-20&to=2026-08-02  a range (31 days max)
 *   /api/stats?day=2026-08-02&install=<id>    one install's merged day
 *
 * Auth is the ingest token in the `x-dailies-token` header. Header only: a
 * token in a query string lands in the platform's access logs, the browser's
 * history and every Referer it sends. /api/dump keeps its `?token=` for curl.
 *
 * All reading is best-effort. A blob that will not fetch or will not parse is
 * counted as `corrupt` and the aggregate is still returned: a dashboard that
 * shows 95% of a day beats one that 500s.
 */
import { list } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import { constantTimeEqual } from "../lib/auth";
import {
  createEventAggregator,
  createLlmAggregator,
  DEFAULT_DRILLDOWN_LINE_CAP,
  drilldownInstall,
  mapWithConcurrency,
  parseDayRange,
  todayUtc,
  type RawDay,
} from "../lib/stats";

/** @vercel/blob's per-call ceiling. A busy day needs several of these. */
const LIST_PAGE_SIZE = 1000;
/** Enough for 5000 batches in one day — far past anything real, and bounded. */
const MAX_LIST_PAGES = 5;
/** How many blobs of one day we will actually fetch. */
const MAX_BLOBS_PER_DAY = 1500;
const FETCH_CONCURRENCY = 8;
const BLOB_TIMEOUT_MS = 10_000;
/** A range query fans out over days too; keep the total socket count sane. */
const DAY_CONCURRENCY = 3;

export const config = { maxDuration: 60 };

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function fetchJson(url: string): Promise<{ value: unknown; ok: boolean }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
    if (!response.ok) return { value: null, ok: false };
    return { value: (await response.json()) as unknown, ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

/**
 * Lists one prefix and fetches every blob under it, tolerating failures.
 *
 * The listing is paginated: one `list` call returns at most 1000 blobs, and a
 * single unpaginated call would hand back the OLDEST 1000 of a busy day —
 * exactly backwards, since every view here is about what happened recently.
 * So: walk the cursor to a bounded number of pages, then keep the NEWEST
 * MAX_BLOBS_PER_DAY and say so when anything was left behind.
 */
async function loadDay(prefix: string, day: string): Promise<RawDay> {
  let blobs: Array<{ url: string; pathname: string; uploadedAt: Date }> = [];
  let truncated = false;
  try {
    let cursor: string | undefined;
    let more = true;
    for (let page = 0; more && page < MAX_LIST_PAGES; page += 1) {
      const result = await list({
        prefix: `${prefix}/${day}/`,
        limit: LIST_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      blobs = blobs.concat(result.blobs);
      more = result.hasMore === true && typeof result.cursor === "string";
      cursor = result.cursor;
    }
    // Stopped with pages still to go: the day is under-reported either way.
    truncated = more;
  } catch {
    // A listing that fails leaves the day empty rather than failing the request.
    return { day, payloads: [], failed: 0, truncated: true };
  }

  if (blobs.length > MAX_BLOBS_PER_DAY) {
    // Keys are `<prefix>/<day>/<epochMs>-<id>.json`, so pathname order is
    // upload order; sort anyway rather than trust the store's ordering.
    blobs.sort((a, b) =>
      a.uploadedAt.getTime() - b.uploadedAt.getTime() || a.pathname.localeCompare(b.pathname));
    blobs = blobs.slice(blobs.length - MAX_BLOBS_PER_DAY);
    truncated = true;
  }

  const fetched = await mapWithConcurrency(blobs, FETCH_CONCURRENCY, (blob) => fetchJson(blob.url));
  const payloads: unknown[] = [];
  let failed = 0;
  for (const entry of fetched) {
    if (entry.ok) payloads.push(entry.value);
    else failed += 1;
  }
  return { day, payloads, failed, truncated };
}

function loadDays(prefix: string, days: readonly string[]): Promise<RawDay[]> {
  return mapWithConcurrency(days, DAY_CONCURRENCY, (day) => loadDay(prefix, day));
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).send("method not allowed");
    return;
  }

  const expected = process.env["DAILIES_INGEST_TOKEN"];
  const presented = req.headers["x-dailies-token"];
  // The token never appears in the response, and neither does the reason.
  res.setHeader("vary", "x-dailies-token");
  res.setHeader("x-content-type-options", "nosniff");
  if (!expected || typeof presented !== "string" || !constantTimeEqual(expected, presented)) {
    res.setHeader("cache-control", "no-store");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const today = todayUtc();
  const range = parseDayRange(
    {
      day: firstParam(req.query["day"] as string | string[] | undefined),
      from: firstParam(req.query["from"] as string | string[] | undefined),
      to: firstParam(req.query["to"] as string | string[] | undefined),
    },
    today,
  );
  if (!range.ok) {
    res.setHeader("cache-control", "no-store");
    res.status(400).json({ error: range.error });
    return;
  }

  // A finished UTC day can never gain another batch, so it is safe to hold.
  // The response is token-scoped, so the cache has to be the browser's own.
  const complete = range.to < today;
  res.setHeader("cache-control", complete ? "private, max-age=86400" : "no-store");

  const install = firstParam(req.query["install"] as string | string[] | undefined);
  if (install !== undefined && install !== "") {
    if (range.days.length !== 1) {
      res.setHeader("cache-control", "no-store");
      res.status(400).json({ error: "install drill-down takes a single day" });
      return;
    }
    const capParam = Number(firstParam(req.query["cap"] as string | string[] | undefined));
    const cap = Number.isFinite(capParam) && capParam > 0
      ? Math.min(Math.floor(capParam), DEFAULT_DRILLDOWN_LINE_CAP)
      : DEFAULT_DRILLDOWN_LINE_CAP;
    const rawDays = await loadDays("events", range.days);
    res.status(200).json({
      mode: "install",
      generatedAt: new Date().toISOString(),
      ...drilldownInstall(rawDays, install, cap),
    });
    return;
  }

  // Reduce each day as it lands and let its payloads go. Holding 31 days of
  // raw blobs to reduce them at the end is how a range query runs the function
  // out of memory on the one week somebody actually needs to look at.
  const eventAggregator = createEventAggregator({ dayCount: range.days.length });
  const llmAggregator = createLlmAggregator();
  await mapWithConcurrency(range.days, DAY_CONCURRENCY, async (day) => {
    eventAggregator.addDay(await loadDay("events", day));
    llmAggregator.addDay(await loadDay("llm", day));
  });

  const events = eventAggregator.finish();
  const llm = llmAggregator.finish();

  res.status(200).json({
    mode: "range",
    generatedAt: new Date().toISOString(),
    from: range.from,
    to: range.to,
    today,
    complete,
    days: events.days,
    totals: events.totals,
    signatures: events.signatures,
    signatureTotal: events.signatureTotal,
    llm,
  });
}
