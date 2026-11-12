import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// These tests run a real broker in a temp folder, with a stand-in "codex" first on PATH that logs
// every launch. Nothing here reaches a real CLI, a real room or the person's own broker.

const repo = process.cwd();
const root = mkdtempSync(join(tmpdir(), "polychat-consult-"));
const paths = { home: join(root, "home"), data: join(root, "data"), records: join(root, "records"), bin: join(root, "bin"), log: join(root, "launches.log") };
for (const folder of [paths.home, paths.data, paths.records, paths.bin]) mkdirSync(folder, { recursive: true });
copyFileSync(join(repo, "examples/host-seam/stand-in-codex"), join(paths.bin, "codex"));
chmodSync(join(paths.bin, "codex"), 0o755);
writeFileSync(paths.log, "");

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const launches = (folder?: string) => readFileSync(paths.log, "utf8").split("\n").filter((line) => line && (!folder || line.endsWith(`folder=${folder}`))).length;
function project(name: string, mode: "reply" | "hold" | "busy") { const folder = join(root, "projects", name); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "stand-in-mode"), mode); return folder; }
const release = (folder: string) => writeFileSync(join(folder, "release"), "");

function freePort(): Promise<number> {
  return new Promise((done, fail) => { const probe = createServer(); probe.once("error", fail); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => done(port)); }); });
}

const env = (port: number) => ({ ...process.env, HOME: paths.home, POLYCHAT_DATA_DIR: paths.data, POLYCHAT_LEGACY_DATA_DIR: paths.data, POLYCHAT_RECORDS_DIR: paths.records, POLYCHAT_PORT: String(port), POLYCHAT_STAND_IN_LOG: paths.log, PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ""}` });
let broker: ChildProcess | null = null;
let url = "";

async function startBroker() {
  const port = await freePort();
  rmSync(join(paths.data, "runtime.json"), { force: true });
  broker = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { cwd: repo, env: env(port), stdio: "ignore" });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(100);
    if (!existsSync(join(paths.data, "runtime.json"))) continue;
    const candidate = (JSON.parse(readFileSync(join(paths.data, "runtime.json"), "utf8")) as { url: string }).url;
    try { if ((await fetch(`${candidate}/api/health`)).ok) { url = candidate; return; } } catch { /* still starting */ }
  }
  throw new Error("The test broker did not start.");
}

async function stopBroker() {
  const child = broker; broker = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  process.kill(child.pid!, "SIGTERM");
  await exited;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function outcome(roomId: string, requestId: string) { return (await call("GET", `/api/rooms/${roomId}/consults/${encodeURIComponent(requestId)}`)).body; }
async function settled(roomId: string, requestId: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) { const body = await outcome(roomId, requestId); if (body.status !== "pending") return body; await delay(50); }
  throw new Error(`Consult ${requestId} never settled.`);
}
async function messageSettled(roomId: string, messageId: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) { const state = (await call("GET", `/api/rooms/${roomId}`)).body; const message = state.messages.find((candidate: any) => candidate.id === messageId); if (message && message.status !== "streaming") return message; await delay(50); }
  throw new Error("Message never settled.");
}
async function room(name: string) { return (await call("POST", "/api/rooms", { name })).body as { id: string }; }
async function codex(roomId: string, name: string, folder: string, sessionId?: string) { return (await call("POST", `/api/rooms/${roomId}/participants`, { name, runtime: "codex", model: "current", cwd: folder, ...(sessionId ? { sessionId } : {}) })).body as { id: string }; }
const ask = (roomId: string, agentId: string, prompt: string, requestId?: string) => call("POST", `/api/rooms/${roomId}/invoke`, { senderId: "riley", agentId, prompt, ...(requestId === undefined ? {} : { requestId }) });

test.before(startBroker);
test.after(async () => { await stopBroker(); rmSync(root, { recursive: true, force: true }); });

test("a consult's first request behaves as a plain invoke, and a repeat launches nothing and returns the same message", async () => {
  const { id: roomId } = await room("Once");
  const folder = project("once", "hold");
  const agent = await codex(roomId, "Codex", folder);
  const first = await ask(roomId, agent.id, "One question.", "req-1");
  assert.equal(first.status, 202);
  assert.equal(first.body.message.status, "streaming");
  assert.equal(first.body.message.metadata.requestId, "req-1");
  assert.equal(first.body.duplicate, false);
  await delay(300);
  assert.equal(launches("once"), 1);
  // While the first is still running.
  const whileRunning = await ask(roomId, agent.id, "One question.", "req-1");
  assert.equal(whileRunning.status, 200);
  assert.equal(whileRunning.body.duplicate, true);
  assert.equal(whileRunning.body.message.id, first.body.message.id);
  assert.equal((await outcome(roomId, "req-1")).status, "pending");
  release(folder);
  const done = await settled(roomId, "req-1");
  assert.deepEqual({ status: done.status, messageId: done.messageId, reply: done.reply, error: done.error }, { status: "complete", messageId: first.body.message.id, reply: "Stand-in Codex here: one reply, from one launch.", error: null });
  // After it finished.
  const afterwards = await ask(roomId, agent.id, "One question.", "req-1");
  assert.equal(afterwards.body.duplicate, true);
  assert.equal(afterwards.body.message.id, first.body.message.id);
  assert.equal(afterwards.body.message.status, "complete");
  await delay(300);
  assert.equal(launches("once"), 1);
  // The same requestId in another room is a different consult.
  const { id: otherRoom } = await room("Elsewhere");
  const elsewhere = await codex(otherRoom, "Codex", project("elsewhere", "reply"));
  const other = await ask(otherRoom, elsewhere.id, "One question.", "req-1");
  assert.equal(other.body.duplicate, false);
  assert.notEqual(other.body.message.id, first.body.message.id);
});

test("reading a consult's outcome any number of times changes nothing", async () => {
  const { id: roomId } = await room("Reads");
  const agent = await codex(roomId, "Codex", project("reads", "reply"));
  await ask(roomId, agent.id, "Read me.", "read-1");
  await settled(roomId, "read-1");
  const before = (await call("GET", `/api/rooms/${roomId}`)).body;
  const reads = await Promise.all(Array.from({ length: 5 }, () => outcome(roomId, "read-1")));
  for (const read of reads) assert.deepEqual(read, reads[0]);
  const after = (await call("GET", `/api/rooms/${roomId}`)).body;
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.room.updatedAt, before.room.updatedAt);
  assert.equal((await call("GET", `/api/rooms/${roomId}/consults/never-sent`)).status, 404);
});

test("a session open elsewhere comes back busy after one launch, and is never retried", async () => {
  const { id: roomId } = await room("Busy");
  const agent = await codex(roomId, "Codex in the app", project("open", "busy"), "019a-open");
  const first = await ask(roomId, agent.id, "Are you there?", "busy-1");
  assert.equal(first.status, 202);
  const busy = await settled(roomId, "busy-1");
  assert.equal(busy.status, "busy");
  assert.equal(busy.error.code, "invocation_busy");
  assert.equal(busy.error.retryable, false);
  assert.equal(busy.messageId, first.body.message.id);
  await delay(1500);
  assert.equal(launches("open"), 1);
  const again = await ask(roomId, agent.id, "Are you there?", "busy-1");
  assert.equal(again.body.duplicate, true);
  await delay(300);
  assert.equal(launches("open"), 1);
});

test("a participant already mid-turn refuses a consult plainly: busy, nothing launched, nothing queued", async () => {
  const { id: roomId } = await room("Mid-turn");
  const folder = project("midturn", "hold");
  const agent = await codex(roomId, "Codex", folder);
  await ask(roomId, agent.id, "Long one.", "long");
  await delay(300);
  const refused = await ask(roomId, agent.id, "Quick one.", "quick");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "invocation_busy");
  assert.equal(refused.body.retryable, true);
  assert.match(refused.body.error, /already responding/);
  const busy = await outcome(roomId, "quick");
  assert.equal(busy.status, "busy");
  assert.equal(busy.messageId, refused.body.message.id);
  assert.equal(busy.error.code, "invocation_busy");
  // The same refused request again is recognised and still launches nothing.
  const repeat = await ask(roomId, agent.id, "Quick one.", "quick");
  assert.equal(repeat.body.duplicate, true);
  assert.equal(repeat.body.message.id, refused.body.message.id);
  release(folder);
  await settled(roomId, "long");
  await delay(1000);
  // One launch for the long turn; the refused consult was never run once the participant was free.
  assert.equal(launches("midturn"), 1);
  assert.equal((await outcome(roomId, "quick")).status, "busy");
  // The same exact session, already answering in another room, is busy in the same way.
  const { id: firstRoom } = await room("Session A");
  const { id: secondRoom } = await room("Session B");
  const sharedFolder = project("shared-session", "hold");
  const one = await codex(firstRoom, "Codex", sharedFolder, "019a-shared");
  const two = await codex(secondRoom, "Codex", sharedFolder, "019a-shared");
  await ask(firstRoom, one.id, "First room.", "shared-a");
  await delay(300);
  const shared = await ask(secondRoom, two.id, "Second room.", "shared-b");
  assert.equal(shared.status, 409);
  assert.equal(shared.body.code, "invocation_busy");
  assert.equal(shared.body.retryable, true);
  assert.match(shared.body.error, /already responding in another room/);
  assert.equal((await outcome(secondRoom, "shared-b")).status, "busy");
  release(sharedFolder);
  await settled(firstRoom, "shared-a");
  assert.equal(launches("shared-session"), 1);
});

test("without a requestId, invoke and send behave as they always have", async () => {
  const { id: roomId } = await room("Plain");
  const folder = project("plain", "hold");
  const agent = await codex(roomId, "Codex", folder);
  const first = await ask(roomId, agent.id, "Plain one.");
  assert.equal(first.status, 202);
  assert.deepEqual(Object.keys(first.body).sort(), ["eventCursor", "message"]);
  assert.equal("requestId" in first.body.message.metadata, false);
  await delay(300);
  const countBefore = (await call("GET", `/api/rooms/${roomId}`)).body.messages.length;
  const refused = await ask(roomId, agent.id, "Plain two.");
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: "Codex is already responding." });
  assert.equal((await call("GET", `/api/rooms/${roomId}`)).body.messages.length, countBefore);
  release(folder);
  await messageSettled(roomId, first.body.message.id);
  // A plain repeat is a new turn, exactly as before.
  const repeat = await ask(roomId, agent.id, "Plain one.");
  assert.equal(repeat.status, 202);
  await messageSettled(roomId, repeat.body.message.id);
  assert.equal(launches("plain"), 2);
  const sent = await call("POST", `/api/rooms/${roomId}/messages`, { senderId: "riley", content: "Plain message.", recipientAgentIds: [agent.id] });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.body.dispatchedAgentIds, [agent.id]);
  assert.equal("duplicate" in sent.body, false);
  assert.equal(sent.body.metadata.requestId, undefined);
});

test("a message with a requestId is posted and delivered once", async () => {
  const { id: roomId } = await room("Send once");
  const agent = await codex(roomId, "Codex", project("send", "reply"));
  const body = { senderId: "riley", content: "Please review.", recipientAgentIds: [agent.id], requestId: "send-1" };
  const first = await call("POST", `/api/rooms/${roomId}/messages`, body);
  assert.equal(first.status, 202);
  assert.deepEqual(first.body.dispatchedAgentIds, [agent.id]);
  assert.equal(first.body.duplicate, false);
  const done = await settled(roomId, "send-1");
  assert.equal(done.status, "complete");
  assert.equal(done.messageId, first.body.id);
  assert.equal(done.replies.length, 1);
  assert.equal(done.reply, "Stand-in Codex here: one reply, from one launch.");
  const countBefore = (await call("GET", `/api/rooms/${roomId}`)).body.messages.length;
  const again = await call("POST", `/api/rooms/${roomId}/messages`, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.id, first.body.id);
  assert.deepEqual(again.body.dispatchedAgentIds, []);
  await delay(300);
  assert.equal((await call("GET", `/api/rooms/${roomId}`)).body.messages.length, countBefore);
  assert.equal(launches("send"), 1);
});

test("a message consult to a participant mid-turn records busy for that participant and queues nothing", async () => {
  const { id: roomId } = await room("Send busy");
  const folder = project("sendbusy", "hold");
  const agent = await codex(roomId, "Codex", folder);
  await ask(roomId, agent.id, "Long one.", "long");
  await delay(300);
  const sent = await call("POST", `/api/rooms/${roomId}/messages`, { senderId: "riley", content: "And this?", recipientAgentIds: [agent.id], requestId: "send-busy" });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.dispatchedAgentIds, []);
  assert.equal(sent.body.dispatchErrors.length, 1);
  const busy = await outcome(roomId, "send-busy");
  assert.equal(busy.status, "busy");
  assert.equal(busy.replies[0].error.code, "invocation_busy");
  release(folder);
  await settled(roomId, "long");
  await delay(1000);
  assert.equal(launches("sendbusy"), 1);
});

test("a requestId that is too long, or one asking for a discussion, is refused before anything happens", async () => {
  const { id: roomId } = await room("Refusals");
  const agent = await codex(roomId, "Codex", project("refusals", "reply"));
  const tooLong = "x".repeat(129);
  assert.equal((await ask(roomId, agent.id, "Hi.", tooLong)).status, 400);
  assert.equal((await ask(roomId, agent.id, "Hi.", "")).status, 400);
  assert.equal((await call("POST", `/api/rooms/${roomId}/messages`, { senderId: "riley", content: "Hi.", recipientAgentIds: [agent.id], requestId: tooLong })).status, 400);
  const discussion = await call("POST", `/api/rooms/${roomId}/messages`, { senderId: "riley", content: "Discuss.", recipientAgentIds: [agent.id], discussion: true, requestId: "talk" });
  assert.equal(discussion.status, 400);
  assert.equal((await call("GET", `/api/rooms/${roomId}/consults/talk`)).status, 404);
  assert.equal(launches("refusals"), 0);
  assert.equal((await call("GET", `/api/rooms/${roomId}`)).body.messages.length, 0);
  // A first request refused for a missing prompt doesn't use up its requestId.
  assert.equal((await ask(roomId, agent.id, "", "later")).status, 400);
  const later = await ask(roomId, agent.id, "Now with a prompt.", "later");
  assert.equal(later.status, 202);
  assert.equal(later.body.duplicate, false);
});

test("a plain ask, with or without a requestId, never opens a council", async () => {
  const { id: roomId } = await room("No council");
  const a = await codex(roomId, "Codex", project("nocouncil-a", "reply"));
  const b = await codex(roomId, "Codex two", project("nocouncil-b", "reply"));
  const question = "Should we run a council on this? Council please.";
  await ask(roomId, a.id, question);
  await ask(roomId, b.id, question, "nc-1");
  await settled(roomId, "nc-1");
  await call("POST", `/api/rooms/${roomId}/messages`, { senderId: "riley", content: `/council ${question}` });
  await call("POST", `/api/rooms/${roomId}/messages`, { senderId: "riley", content: question, requestId: "nc-2" });
  await settled(roomId, "nc-2");
  const state = (await call("GET", `/api/rooms/${roomId}`)).body;
  assert.equal(state.councils.length, 0);
  assert.equal(state.messages.some((message: any) => message.metadata.councilId), false);
});

test("the two MCP tools pass requestId through", async () => {
  const { id: roomId } = await room("MCP");
  const agent = await codex(roomId, "Codex", project("mcp", "reply"));
  const client = new Client({ name: "consult-test", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", join(repo, "src/mcp/index.ts")], cwd: repo, env: { ...env(0), POLYCHAT_URL: url } as Record<string, string>, stderr: "pipe" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const name of ["invoke_participant", "send_message"]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.requestId, `${name} accepts requestId`);
      assert.equal(schema.required?.includes("requestId") ?? false, false);
    }
    const args = { roomId, senderId: "riley", agentId: agent.id, prompt: "Through MCP.", requestId: "mcp-1" };
    const first = await client.callTool({ name: "invoke_participant", arguments: args }) as any;
    await settled(roomId, "mcp-1");
    const second = await client.callTool({ name: "invoke_participant", arguments: args }) as any;
    assert.equal(first.structuredContent.duplicate, false);
    assert.equal(second.structuredContent.duplicate, true);
    assert.equal(second.structuredContent.message.id, first.structuredContent.message.id);
    assert.match(second.content[0].text, /nothing was launched again/);
    // The room link a host can show or open.
    assert.equal(first.structuredContent.url, `${url}/?room=${roomId}`);
    const sendArgs = { roomId, senderId: "riley", content: "Through MCP too.", recipientAgentIds: [agent.id], requestId: "mcp-2" };
    const sent = await client.callTool({ name: "send_message", arguments: sendArgs }) as any;
    await settled(roomId, "mcp-2");
    const resent = await client.callTool({ name: "send_message", arguments: sendArgs }) as any;
    assert.equal(resent.structuredContent.duplicate, true);
    assert.equal(resent.structuredContent.id, sent.structuredContent.id);
    await delay(300);
    assert.equal(launches("mcp"), 2);
  } finally { await client.close(); }
});

test("typing stop ends a council or a live meeting, and the turns in it", async () => {
  const { id: meetingRoom } = await room("Meeting");
  const meetingFolder = project("meeting", "hold");
  const agent = await codex(meetingRoom, "Codex", meetingFolder);
  assert.equal((await call("POST", `/api/rooms/${meetingRoom}/meeting`, { hostRuntime: "codex", hostName: "Host", cwd: project("meeting-host", "reply"), minutes: 5 })).status, 201);
  await ask(meetingRoom, agent.id, "Long one.", "stop-1");
  await delay(300);
  assert.equal(launches("meeting"), 1);
  await call("POST", `/api/rooms/${meetingRoom}/messages`, { senderId: "riley", content: "stop" });
  const stopped = await settled(meetingRoom, "stop-1");
  assert.equal(stopped.status, "error");
  assert.equal(stopped.error.code, "invocation_cancelled");
  assert.equal((await call("GET", `/api/rooms/${meetingRoom}`)).body.room.meetingStatus, "cancelled");

  const { id: councilRoom } = await room("Council");
  for (const name of ["council-a", "council-b"]) await codex(councilRoom, name, project(name, "hold"));
  const started = await call("POST", `/api/rooms/${councilRoom}/councils`, { question: "Which way?", senderId: "riley" });
  assert.equal(started.status, 202);
  await delay(500);
  assert.equal(launches("council-a") + launches("council-b"), 2);
  await call("POST", `/api/rooms/${councilRoom}/messages`, { senderId: "riley", content: "stop" });
  await delay(1000);
  assert.equal((await call("GET", `/api/rooms/${councilRoom}`)).body.councils[0].phase, "cancelled");
  assert.equal(launches("council-a") + launches("council-b"), 2);
});

// Runs last: the broker is stopped and started again on the same data.
test("a consult is still recognised after the broker restarts", async () => {
  const { id: roomId } = await room("Restart");
  const agent = await codex(roomId, "Codex", project("restart", "reply"));
  const first = await ask(roomId, agent.id, "Before the restart.", "restart-1");
  const before = await settled(roomId, "restart-1");
  const heldFolder = project("restart-held", "hold");
  const held = await codex(roomId, "Codex held", heldFolder);
  await ask(roomId, held.id, "Still thinking when the broker stops.", "restart-2");
  await delay(300);
  await stopBroker();
  await startBroker();
  // A turn cut off by the restart reads as an error, and asking again with its id launches nothing.
  const interrupted = await outcome(roomId, "restart-2");
  assert.equal(interrupted.status, "error");
  assert.match(interrupted.error.message, /interrupted by a broker restart/);
  assert.equal((await ask(roomId, held.id, "Still thinking when the broker stops.", "restart-2")).body.duplicate, true);
  release(heldFolder);
  const after = await ask(roomId, agent.id, "Before the restart.", "restart-1");
  assert.equal(after.status, 200);
  assert.equal(after.body.duplicate, true);
  assert.equal(after.body.message.id, first.body.message.id);
  assert.deepEqual(await outcome(roomId, "restart-1"), before);
  await delay(300);
  assert.equal(launches("restart"), 1);
  assert.equal(launches("restart-held"), 1);
});

test("a database from before consults opens with its rooms and messages intact and gains the consult table", () => {
  const directory = mkdtempSync(join(tmpdir(), "polychat-consult-upgrade-"));
  const moduleUrl = pathToFileURL(join(repo, "src/server/db.ts")).href;
  const run = (script: string) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repo, env: { ...process.env, HOME: directory, POLYCHAT_DATA_DIR: directory, POLYCHAT_LEGACY_DATA_DIR: directory }, stdio: "pipe" }).toString();
  try {
    run(`const db = await import(${JSON.stringify(`${moduleUrl}?seed=1`)}); const room = db.createRoom({ name: "Kept" }); db.createMessage({ roomId: room.id, senderId: "riley", content: "still here" });`);
    // Take the database back to the shape the previous release left: everything but the consult table.
    const old = new DatabaseSync(join(directory, "polychat.db"));
    old.exec("DROP TABLE consults");
    assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name = 'consults'").get(), undefined);
    old.close();
    run(`await import(${JSON.stringify(`${moduleUrl}?upgrade=1`)});`);
    const upgraded = new DatabaseSync(join(directory, "polychat.db"), { readOnly: true });
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'consults'").get());
    assert.equal((upgraded.prepare("SELECT content FROM messages WHERE content = 'still here'").get() as { content: string }).content, "still here");
    assert.equal((upgraded.prepare("SELECT COUNT(*) AS count FROM rooms WHERE name = 'Kept'").get() as { count: number }).count, 1);
    assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    upgraded.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
