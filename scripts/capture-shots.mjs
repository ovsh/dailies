/**
 * One-pass marketing capture over CDP: Library, Clip view, Chat, Settings & Jobs.
 * Usage: node scripts/capture-shots.mjs <outdir>
 * Captures renderer content at 2x via Emulation.setDeviceMetricsOverride.
 */
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "site/assets/raw";
mkdirSync(outDir, { recursive: true });

const port = process.env.CDP_PORT ?? "9333";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target found");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });

let seq = 0;
const pending = new Map();
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaljs = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
  return res.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(res.result.data, "base64"));
  console.log("captured", name);
};

await new Promise((r) => ws.on("open", r));
await send("Page.enable", {});
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
});
await sleep(500);

// 1. Library
await evaljs('document.querySelector("[aria-label=Library]").click()');
await sleep(1200);
await shot("library.png");

// 2. Clip view: open the clip named 06252025/05 (fully processed, bricks/rain-garden content)
const opened = await evaljs(`(() => {
  const rows = [...document.querySelectorAll("main [role=button], main button, main a, main li, main div")].filter(e => e.textContent.includes("06252025/05") && e.textContent.length < 200);
  if (!rows.length) return "none";
  rows[rows.length-1].click(); return "clicked";
})()`);
console.log("clip open:", opened);
await sleep(1500);
await shot("clip-initial.png");
console.log("state:", (await evaljs("document.body.innerText.slice(0,300)")).replace(/\n/g, " | "));

// 3. Chat screen (honest ask state)
await evaljs('document.querySelector("[aria-label=Chat]").click()');
await sleep(1000);
await shot("chat.png");

// 4. Settings & Jobs
await evaljs('document.querySelector("[aria-label=\\"Settings & Jobs\\"]").click()');
await sleep(1000);
await shot("jobs.png");

ws.close();
process.exit(0);
