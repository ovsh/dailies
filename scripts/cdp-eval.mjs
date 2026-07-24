/**
 * One-off CDP evaluation against the running app (port from CDP_PORT, default 9333).
 * Usage: node scripts/cdp-eval.mjs '<js expression>'   (awaits promises, prints JSON value)
 */
import WebSocket from "ws";

const port = process.env.CDP_PORT ?? "9333";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target found");
const ws = new WebSocket(page.webSocketDebuggerUrl);

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

await new Promise((r) => ws.on("open", r));
const res = await send("Runtime.evaluate", {
  expression: process.argv[2],
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (res.result?.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(res.result?.result?.value));
ws.close();
process.exit(0);
