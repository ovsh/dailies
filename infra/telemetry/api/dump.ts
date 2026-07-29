import { list } from "@vercel/blob";

export const config = { runtime: "edge" };

/** Merge a day's event batches: /api/dump?token=...&day=2026-07-29 (day defaults to today). */
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token || token !== process.env["DAILIES_INGEST_TOKEN"]) {
    return new Response("unauthorized", { status: 401 });
  }
  const day = url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Response("invalid day", { status: 400 });
  }

  const { blobs } = await list({ prefix: `events/${day}/`, limit: 1000 });
  const batches: unknown[] = [];
  for (const blob of blobs) {
    const res = await fetch(blob.url);
    if (!res.ok) continue;
    try {
      batches.push(await res.json());
    } catch {
      batches.push({ corrupt: blob.pathname });
    }
  }

  return new Response(JSON.stringify({ day, batchCount: batches.length, batches }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
