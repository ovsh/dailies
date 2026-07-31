import { put } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const MAX_BODY_BYTES = 512 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).send("method not allowed");
    return;
  }
  const token = req.headers["x-dailies-token"];
  if (typeof token !== "string" || token !== process.env["DAILIES_INGEST_TOKEN"]) {
    res.status(401).send("unauthorized");
    return;
  }

  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
    res.status(413).send("payload too large");
    return;
  }

  // The runtime has already parsed the JSON body (content-type json).
  const batch: unknown = req.body;
  if (batch === null || typeof batch !== "object") {
    res.status(400).send("invalid json");
    return;
  }
  const rawInstallId = (batch as { installId?: unknown }).installId;
  const installId = typeof rawInstallId === "string"
    ? rawInstallId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64)
    : "unknown";

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `events/${day}/${now.getTime()}-${installId}.json`;
  await put(key, JSON.stringify(batch), { access: "public", contentType: "application/json" });

  res.status(200).json({ ok: true });
}
