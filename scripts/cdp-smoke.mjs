/**
 * Packaged-app smoke test: drives the REAL app over CDP.
 * Launch the app with --remote-debugging-port=9333 first, then run this.
 * Exercises: createProject -> openProject -> getProjectState -> createEpisode.
 */
import WebSocket from "ws";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
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

const evalAsync = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15000,
  });
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.exception?.description ?? "unknown CDP error" };
  }
  return { value: res.result?.result?.value };
};

await new Promise((r) => ws.on("open", r));

const steps = [
  ["api present", `typeof window.dailies`],
  ["createProject", `window.dailies.createProject("CDP Test ${Date.now() % 100000}").then(p => JSON.stringify(p)).catch(e => "ERR: " + e.message)`],
];

let projectId = null;
for (const [name, expr] of steps) {
  const t0 = Date.now();
  const out = await evalAsync(expr);
  console.log(`[${name}] ${Date.now() - t0}ms ->`, out.error ?? out.value);
  if (name === "createProject" && typeof out.value === "string" && out.value.startsWith("{")) {
    projectId = JSON.parse(out.value).id;
  }
}

if (projectId) {
  for (const [name, expr] of [
    ["openProject", `window.dailies.openProject(${JSON.stringify(projectId)}).then(s => JSON.stringify(s.project.name)).catch(e => "ERR: " + e.message)`],
    ["getProjectState", `window.dailies.getProjectState().then(s => JSON.stringify(s && s.project.name)).catch(e => "ERR: " + e.message)`],
    ["createEpisode", `window.dailies.createEpisode("101").then(ep => JSON.stringify(ep)).catch(e => "ERR: " + e.message)`],
    ["getSettings", `window.dailies.getSettings().then(s => JSON.stringify(s)).catch(e => "ERR: " + e.message)`],
  ]) {
    const t0 = Date.now();
    const out = await evalAsync(expr);
    console.log(`[${name}] ${Date.now() - t0}ms ->`, out.error ?? out.value);
  }
}

ws.close();
process.exit(0);
