import { put } from "@vercel/blob";

export const config = { runtime: "edge" };

const MAX_BODY_BYTES = 512 * 1024;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const token = req.headers.get("x-dailies-token");
  if (!token || token !== process.env["DAILIES_INGEST_TOKEN"]) {
    return new Response("unauthorized", { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  let batch: { installId?: string };
  try {
    batch = JSON.parse(raw) as { installId?: string };
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const installId = typeof batch.installId === "string"
    ? batch.installId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64)
    : "unknown";

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `events/${day}/${now.getTime()}-${installId}.json`;
  await put(key, raw, { access: "public", contentType: "application/json" });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
