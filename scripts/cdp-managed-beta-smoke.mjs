/**
 * Managed-beta UI smoke test for the real Electron app.
 *
 * Launch an isolated build with a fake managed URL and token plus
 * `--remote-debugging-port`, then pass that port here. The script never sends
 * an LLM request. It checks only the build-time access state and renderer copy.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

function readArgs(argv) {
  const args = { port: 9334, shots: "output/playwright/managed-beta-smoke" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--port") args.port = Number(value), index += 1;
    else if (argv[index] === "--shots") args.shots = value, index += 1;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) throw new Error("--port must be positive");
  return args;
}

const args = readArgs(process.argv.slice(2));
await mkdir(args.shots, { recursive: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      // Electron can take a few seconds to expose the CDP endpoint.
    }
    await delay(250);
  }
  throw new Error(`No CDP page target on port ${args.port}`);
}

const target = await pageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();

socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function waitFor(label, expression) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(200);
  }
  throw new Error(`${label} did not appear`);
}

async function screenshot(name) {
  const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.resolve(args.shots, `${name}.png`);
  await writeFile(file, Buffer.from(image.data, "base64"));
  return file;
}

try {
  await send("Page.enable");
  await waitFor("Dailies API", `typeof window.dailies === "object"`);
  const projectName = `Managed beta smoke ${Date.now()}`;
  const project = await evaluate(`window.dailies.createProject(${JSON.stringify(projectName)})`);
  await evaluate(`window.dailies.openProject(${JSON.stringify(project.id)})`);
  await send("Page.reload", { ignoreCache: true });
  await waitFor("managed onboarding", `document.querySelector(".welcome-overlay") !== null`);

  const settings = await evaluate(`window.dailies.getSettings()`);
  if (settings.apiKeyStatus !== "managed" || settings.apiKeySet !== true) {
    throw new Error(`Expected managed access, got ${JSON.stringify(settings)}`);
  }

  const welcomeText = await evaluate(`document.querySelector(".welcome-panel")?.innerText ?? ""`);
  if (!/AI models/i.test(welcomeText) || !/Provided for beta/i.test(welcomeText)) {
    throw new Error(`Managed onboarding copy is missing: ${welcomeText}`);
  }
  const welcomeShot = await screenshot("01-managed-onboarding");

  await evaluate(`document.querySelector(".welcome-enter")?.click()`);
  await waitFor("chat empty state", `document.querySelector(".chat-empty") !== null`);
  if (await evaluate(`document.querySelector(".chat-key-hint") !== null`)) {
    throw new Error("Chat still shows the missing-key prompt in managed mode");
  }
  const chatShot = await screenshot("02-managed-chat");

  await evaluate(`document.querySelector('[aria-label="Settings & Jobs"]')?.click()`);
  await waitFor(
    "managed Settings copy",
    `document.body.innerText.includes("Models are provided for this beta")`,
  );
  await evaluate(`Array.from(document.querySelectorAll(".jobs-section"))
    .find((section) => section.textContent?.includes("Models are provided for this beta"))
    ?.scrollIntoView({ block: "center" })`);
  const settingsShot = await screenshot("03-managed-settings");

  console.log(JSON.stringify({
    ok: true,
    settings,
    screenshots: [welcomeShot, chatShot, settingsShot],
  }, null, 2));
} finally {
  socket.close();
}
