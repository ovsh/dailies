/** Recapture library + clip view after copy fixes. Assumes app running on :9333. */
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target found");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
let seq = 0; const pending = new Map();
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(res.result.data, "base64"));
  console.log("captured", name);
};

await new Promise((r) => ws.on("open", r));
await send("Page.enable", {});
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(600);

// dismiss welcome overlay if present
await evaljs('(() => { const b = [...document.querySelectorAll("button, a, [role=button]")].find(x => x.textContent.includes("Continue with missing setup")); if (b) { b.click(); return "dismissed"; } return "no overlay"; })()').then(console.log);
await sleep(500);

await evaljs('document.querySelector("[aria-label=Library]").click()');
await sleep(1400);
await shot("library.png");

await evaljs(`(() => {
  const rows = [...document.querySelectorAll("main [role=button], main button, main a, main li, main div")].filter(e => e.textContent.includes("06252025/05") && e.textContent.length < 200);
  if (!rows.length) return "none";
  rows[rows.length-1].click(); return "clicked";
})()`).then((v) => console.log("clip:", v));
await sleep(1600);
await shot("clip-view.png");

process.exit(0);
