// The host seam, shown end to end on a throwaway broker. Run from the repository root after
// `npm install`:
//
//   node examples/host-seam/run.mjs
//
// It makes a temp folder for everything (home, data, records), puts a stand-in "codex" first on
// PATH that logs each launch, starts its own broker on a free port above 4500, and then:
//   1. sends one consult with a requestId and gets one reply;
//   2. sends the same request again and reads the outcome twice: still one launch, same message;
//   3. consults a stand-in that refuses the way Codex does when its session is open in the Codex
//      app, and shows the outcome is "busy" after exactly one launch, with no retry;
//   4. checks that none of this opened a council;
// and finally stops its own broker by PID. No network, no real CLI, no real room.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => (port > 4500 && port !== 4317 ? done(port) : freePort().then(done, fail))); });
  });
}

const root = mkdtempSync(join(tmpdir(), "polychat-host-seam-"));
const paths = { home: join(root, "home"), data: join(root, "data"), records: join(root, "records"), bin: join(root, "bin"), log: join(root, "launches.log") };
for (const folder of [paths.home, paths.data, paths.records, paths.bin]) mkdirSync(folder, { recursive: true });
copyFileSync(join(here, "stand-in-codex"), join(paths.bin, "codex"));
chmodSync(join(paths.bin, "codex"), 0o755);
writeFileSync(paths.log, "");

function project(name, mode) { const folder = join(root, "projects", name); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "stand-in-mode"), mode); return folder; }
const launches = () => readFileSync(paths.log, "utf8").split("\n").filter(Boolean);

const port = await freePort();
const broker = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
  cwd: repo,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOME: paths.home, POLYCHAT_DATA_DIR: paths.data, POLYCHAT_LEGACY_DATA_DIR: paths.data, POLYCHAT_RECORDS_DIR: paths.records, POLYCHAT_PORT: String(port), POLYCHAT_USER_NAME: "Host app", POLYCHAT_STAND_IN_LOG: paths.log, PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ""}` },
});
let brokerOutput = ""; broker.stdout.on("data", (chunk) => { brokerOutput += chunk; }); broker.stderr.on("data", (chunk) => { brokerOutput += chunk; });

let url = "";
async function call(method, path, body) {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function settled(roomId, requestId) {
  for (let attempt = 0; attempt < 100; attempt += 1) { const { body } = await call("GET", `/api/rooms/${roomId}/consults/${requestId}`); if (body.status !== "pending") return body; await delay(100); }
  throw new Error(`Consult ${requestId} never settled.`);
}
const show = (label, value) => console.log(`${label.padEnd(44)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

try {
  for (let attempt = 0; attempt < 100 && !url; attempt += 1) {
    await delay(100);
    const runtimePath = join(paths.data, "runtime.json");
    if (!existsSync(runtimePath)) continue;
    const candidate = JSON.parse(readFileSync(runtimePath, "utf8")).url;
    try { if ((await fetch(`${candidate}/api/health`)).ok) url = candidate; } catch { /* still starting */ }
  }
  if (!url) throw new Error(`The throwaway broker did not start.\n${brokerOutput}`);
  show("Throwaway broker", `pid ${broker.pid} at ${url}, data in a temp folder`);

  const room = (await call("POST", "/api/rooms", { name: "Host seam example" })).body;
  const codex = (await call("POST", `/api/rooms/${room.id}/participants`, { name: "Codex", runtime: "codex", model: "current", cwd: project("answers", "reply") })).body;

  console.log("\n1. One consult, one reply");
  const first = await call("POST", `/api/rooms/${room.id}/invoke`, { senderId: "riley", agentId: codex.id, prompt: "What is the one risk in this plan?", requestId: "consult-1" });
  show("first request", { http: first.status, messageId: first.body.message.id, duplicate: first.body.duplicate });
  const outcome = await settled(room.id, "consult-1");
  show("outcome", { status: outcome.status, messageId: outcome.messageId, reply: outcome.reply });
  show("launches so far", launches().length);

  console.log("\n2. The same request again, and the outcome read twice");
  const again = await call("POST", `/api/rooms/${room.id}/invoke`, { senderId: "riley", agentId: codex.id, prompt: "What is the one risk in this plan?", requestId: "consult-1" });
  show("repeat request", { http: again.status, messageId: again.body.message.id, duplicate: again.body.duplicate, status: again.body.message.status });
  const readOne = (await call("GET", `/api/rooms/${room.id}/consults/consult-1`)).body;
  const readTwo = (await call("GET", `/api/rooms/${room.id}/consults/consult-1`)).body;
  show("two reads identical", JSON.stringify(readOne) === JSON.stringify(readTwo));
  show("same message id every time", new Set([first.body.message.id, outcome.messageId, again.body.message.id, readOne.messageId, readTwo.messageId]).size === 1);
  await delay(500);
  show("launches so far (still one)", launches().length);

  console.log("\n3. A session that is open in the Codex app");
  const open = (await call("POST", `/api/rooms/${room.id}/participants`, { name: "Codex in the app", runtime: "codex", model: "current", cwd: project("open-in-app", "busy"), sessionId: "019a-open-in-the-app" })).body;
  const busyAsk = await call("POST", `/api/rooms/${room.id}/invoke`, { senderId: "riley", agentId: open.id, prompt: "Can you look at this too?", requestId: "consult-2" });
  show("request", { http: busyAsk.status, messageId: busyAsk.body.message.id });
  const busy = await settled(room.id, "consult-2");
  show("outcome", { status: busy.status, code: busy.error?.code, retryable: busy.error?.retryable });
  show("what the room says", busy.error?.message);
  await delay(1500);
  const busyLaunches = launches().filter((line) => line.includes("folder=open-in-app"));
  show("launches of that session after 1.5 s", busyLaunches.length);
  const busyAgain = await call("POST", `/api/rooms/${room.id}/invoke`, { senderId: "riley", agentId: open.id, prompt: "Can you look at this too?", requestId: "consult-2" });
  show("same request again", { http: busyAgain.status, duplicate: busyAgain.body.duplicate, messageId: busyAgain.body.message.id });
  show("launches of that session now", launches().filter((line) => line.includes("folder=open-in-app")).length);

  console.log("\n4. No council");
  const state = (await call("GET", `/api/rooms/${room.id}`)).body;
  show("councils in the room", state.councils.length);
  show("messages in the room", state.messages.map((message) => `${message.senderName}: ${message.status}`).join(" | "));
  console.log("\nLaunch log:");
  for (const line of launches()) console.log(`  ${line}`);
} finally {
  if (broker.exitCode === null) {
    const exited = new Promise((done) => broker.once("exit", done));
    process.kill(broker.pid, "SIGTERM");
    await exited;
  }
  console.log(`\nStopped throwaway broker pid ${broker.pid}.`);
  rmSync(root, { recursive: true, force: true });
}
