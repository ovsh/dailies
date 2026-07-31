import { list } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

/** Merge a day's event batches: /api/dump?token=...&day=2026-07-29 (day defaults to today). */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const token = req.query["token"];
  if (typeof token !== "string" || token !== process.env["DAILIES_INGEST_TOKEN"]) {
    res.status(401).send("unauthorized");
    return;
  }
  const dayParam = req.query["day"];
  const day = typeof dayParam === "string" && dayParam.length > 0
    ? dayParam
    : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    res.status(400).send("invalid day");
    return;
  }

  const { blobs } = await list({ prefix: `events/${day}/`, limit: 1000 });
  const batches: unknown[] = [];
  for (const blob of blobs) {
    const blobRes = await fetch(blob.url);
    if (!blobRes.ok) continue;
    try {
      batches.push(await blobRes.json());
    } catch {
      batches.push({ corrupt: blob.pathname });
    }
  }

  res.status(200).json({ day, batchCount: batches.length, batches });
}
