import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const entryDir = dirname(resolve(process.argv[1] ?? process.cwd()));
const sourceRoot = basename(entryDir) === "dist" ? dirname(entryDir) : resolve(entryDir, "../..");
const dataDir = process.env.POLYCHAT_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Polychat");
const runtimePath = join(dataDir, "runtime.json");
const participantId = process.env.POLYCHAT_PARTICIPANT ?? "riley";
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type RuntimeState = { port: number; url: string; pid?: number };
function runtimeState(): RuntimeState | null {
  try { return JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeState; } catch { return null; }
}

function baseUrl() { return process.env.POLYCHAT_URL ?? runtimeState()?.url ?? "http://127.0.0.1:4317"; }

async function healthy(url = baseUrl()) {
  try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) }); if (!response.ok) return false; const body = await response.json() as { ok?: unknown; service?: unknown; dataDir?: unknown }; return body?.ok === true && body.service === "polychat" && body.dataDir === dataDir; } catch { return false; }
}

async function startBroker() {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, "broker.log"), "a");
  const bundledServer = join(dirname(process.argv[1] ?? ""), "polychat-server.cjs");
  const child = existsSync(bundledServer)
    ? spawn(process.execPath, [bundledServer], { detached: true, stdio: ["ignore", log, log], env: process.env })
    : spawn("npm", ["--prefix", sourceRoot, "run", "start"], { cwd: sourceRoot, detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) { await delay(250); if (await healthy()) return; }
  throw new Error(`Polychat could not start. See ${join(dataDir, "broker.log")}.`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!(await healthy())) await startBroker();
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Polychat request failed with ${response.status}`);
  return body;
}

function result(summary: string, data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: summary }], structuredContent: data };
}

// The broker's database uses node:sqlite, which Node ships without a flag from 22.13.
function nodeHasSqlite() { const [major, minor] = process.versions.node.split(".").map(Number); return major > 22 || (major === 22 && minor >= 13); }

function commandVersion(command: string) {
  try { return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0]; } catch { return null; }
}

const runtimeSchema = z.enum(["claude-code", "codex", "grok", "kimi-code"]);
const server = new McpServer({ name: "polychat", version: "1.1.0" });

server.registerTool("polychat_doctor", { title: "Check Polychat", description: "Check the local Polychat broker, host requirements, and explicitly required runtimes.", annotations: { readOnlyHint: true }, inputSchema: { requiredRuntimes: z.array(runtimeSchema).default([]) } }, async ({ requiredRuntimes }) => {
  const checks = { platform: process.platform, node: process.version, nodeSupported: nodeHasSqlite(), codex: commandVersion("codex"), claude: commandVersion("claude"), browserOpen: existsSync("/usr/bin/open"), dataDir, broker: await healthy(), url: baseUrl() };
  const catalog = await request<any>("/api/runtimes?refresh=true");
  checks.broker = await healthy(); checks.url = baseUrl();
  const required = catalog.runtimes.filter((entry: any) => requiredRuntimes.includes(entry.descriptor.id));
  const ok = process.platform === "darwin" && checks.nodeSupported && checks.browserOpen && checks.broker && required.every((entry: any) => entry.probe.status === "ready");
  return result(ok ? "Polychat is ready." : "Polychat needs attention. Inspect the structured checks.", { ok, checks, requiredRuntimes, runtimes: catalog.runtimes });
});

server.registerTool("list_runtimes", { title: "List Polychat runtimes", description: "List runtime capabilities, versions, models, authentication state, and remediation.", annotations: { readOnlyHint: true }, inputSchema: { refresh: z.boolean().default(false) } }, async ({ refresh }) => { const data = await request<any>(`/api/runtimes?refresh=${refresh}`); const ready = data.runtimes.filter((entry: any) => entry.probe.status === "ready").length; return result(`${ready} of ${data.runtimes.length} runtimes ready.`, data); });

server.registerTool("list_rooms", { title: "List Polychat rooms", description: "List saved Polychat rooms.", annotations: { readOnlyHint: true }, inputSchema: { includeArchived: z.boolean().default(false) } }, async ({ includeArchived }) => { const data = await request<any>(`/api/rooms?archived=${includeArchived}`); return result(`${data.rooms.length} saved room${data.rooms.length === 1 ? "" : "s"}.`, data); });
server.registerTool("create_room", { title: "Create a Polychat room", description: "Create a new saved collaboration room. New meetings should create a room unless the user explicitly asks to resume one.", inputSchema: { name: z.string().min(1).max(80), projectCwd: z.string().optional() } }, async ({ name, projectCwd }) => { const room = await request<any>("/api/rooms", { method: "POST", body: JSON.stringify({ name, projectCwd }) }); return result(`Created ${room.name}.`, { room, roomId: room.id, url: `${baseUrl()}/?room=${room.id}` }); });
server.registerTool("open_room", { title: "Open a Polychat room", description: "Return and open the visible local room in the default macOS browser. In Codex, prefer the in-app Browser tool with the returned URL when available.", inputSchema: { roomId: z.string().default("common-room"), launch: z.boolean().default(true) } }, async ({ roomId, launch }) => { await request(`/api/rooms/${roomId}`); const url = `${baseUrl()}/?room=${encodeURIComponent(roomId)}`; if (launch) await new Promise<void>((resolve, reject) => execFile("/usr/bin/open", [url], (error) => error ? reject(error) : resolve())); return result(`Polychat room: ${url}`, { roomId, url, launched: launch }); });
server.registerTool("read_room", { title: "Read a Polychat room", description: "Read room state and recent visible messages.", annotations: { readOnlyHint: true }, inputSchema: { roomId: z.string().default("common-room"), limit: z.number().int().min(1).max(300).default(80) } }, async ({ roomId, limit }) => { const state = await request<any>(`/api/rooms/${roomId}`); state.messages = state.messages.slice(-limit); const transcript = state.messages.map((message: any) => `${message.senderName}: ${message.content || `[${message.status}]`}`).join("\n\n"); return result(`${state.room.name}\n${transcript || "No messages yet."}`, state); });
server.registerTool("search_contexts", { title: "Search runtime contexts", description: "Search real runtime projects and optionally list exact resumable sessions.", annotations: { readOnlyHint: true }, inputSchema: { runtime: runtimeSchema, query: z.string().default(""), projectId: z.string().optional(), limit: z.number().int().min(1).max(80).default(32) } }, async ({ runtime, query, projectId, limit }) => { const data = projectId ? await request<any>(`/api/contexts/${runtime}/projects/${encodeURIComponent(projectId)}/sessions?limit=${limit}`) : await request<any>(`/api/contexts/${runtime}/projects?q=${encodeURIComponent(query)}`); return result(projectId ? `${data.sessions.length} resumable sessions.` : `${data.projects.length} matching projects.`, data); });
server.registerTool("configure_participant", { title: "Configure a participant", description: "Add a real Claude Code, Codex, Grok Build, or Kimi Code participant to a saved room.", inputSchema: { roomId: z.string(), agentId: z.string().optional(), name: z.string().min(1).max(48), runtime: runtimeSchema, model: z.string(), cwd: z.string(), sessionId: z.string().nullable().optional(), status: z.enum(["available", "away"]).default("available") } }, async ({ roomId, agentId, ...configuration }) => { const participant = await request<any>(agentId ? `/api/rooms/${roomId}/participants/${agentId}` : `/api/rooms/${roomId}/participants`, { method: agentId ? "PATCH" : "POST", body: JSON.stringify(configuration) }); return result(`${agentId ? "Updated" : "Added"} ${participant.name}.`, { roomId, participant, url: `${baseUrl()}/?room=${roomId}` }); });
server.registerTool("remove_participant", { title: "Remove a participant", description: "Remove a non-human participant from a room.", inputSchema: { roomId: z.string(), agentId: z.string() } }, async ({ roomId, agentId }) => { if (!(await healthy())) await startBroker(); const response = await fetch(`${baseUrl()}/api/rooms/${roomId}/participants/${agentId}`, { method: "DELETE" }); if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? "Could not remove participant."); } return result("Participant removed.", { roomId, agentId, removed: true }); });
server.registerTool("start_meeting", { title: "Start a live council", description: "Register the invoking Codex or Claude task as the live host of a bounded room meeting.", inputSchema: { roomId: z.string(), hostRuntime: z.enum(["codex", "claude-code"]), hostName: z.string().default("Council host"), hostModel: z.string().default("current"), cwd: z.string(), minutes: z.number().int().min(1).max(20).default(20) } }, async (input) => { const data = await request<any>(`/api/rooms/${input.roomId}/meeting`, { method: "POST", body: JSON.stringify(input) }); return result(`Council is live in ${data.room.name}.`, { ...data, roomId: input.roomId, url: `${baseUrl()}/?room=${input.roomId}` }); });
server.registerTool("send_message", { title: "Send a room message", description: "Post visibly as a room participant and optionally wake selected runtime peers.", inputSchema: { roomId: z.string(), senderId: z.string(), content: z.string().min(1), recipientAgentIds: z.array(z.string()).default([]), audience: z.enum(["room", "direct"]).default("room"), discussion: z.boolean().default(false) } }, async ({ roomId, ...body }) => { const data = await request<any>(`/api/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify(body) }); return result(`Posted to room; ${data.dispatchedAgentIds.length} participant${data.dispatchedAgentIds.length === 1 ? "" : "s"} invoked.`, { roomId, ...data, url: `${baseUrl()}/?room=${roomId}` }); });
server.registerTool("invoke_participant", { title: "Invoke one participant", description: "Invoke one configured real runtime without creating a second visible sender message.", inputSchema: { roomId: z.string(), senderId: z.string(), agentId: z.string(), prompt: z.string().min(1) } }, async ({ roomId, ...body }) => { const invocation = await request<any>(`/api/rooms/${roomId}/invoke`, { method: "POST", body: JSON.stringify(body) }); return result(`${body.agentId} is responding.`, { roomId, ...invocation, url: `${baseUrl()}/?room=${roomId}` }); });
server.registerTool("wait_for_events", { title: "Wait for room activity", description: "Wait for a room cursor to advance and, by default, for the current runtime response to settle. Use between council contributions to include browser messages.", annotations: { readOnlyHint: true }, inputSchema: { roomId: z.string(), after: z.number().default(0), timeoutSeconds: z.number().min(1).max(55).default(30), untilSettled: z.boolean().default(true) } }, async ({ roomId, after, timeoutSeconds, untilSettled }) => { const deadline = Date.now() + timeoutSeconds * 1000; let state: any; do { state = await request<any>(`/api/rooms/${roomId}`); const changed = state.eventCursor > after; const busy = state.agents.some((agent: any) => agent.status === "thinking") || state.messages.some((message: any) => message.status === "streaming"); if (changed && (!untilSettled || !busy)) break; await delay(350); } while (Date.now() < deadline); const changed = state.eventCursor > after; const settled = !state.agents.some((agent: any) => agent.status === "thinking") && !state.messages.some((message: any) => message.status === "streaming"); return result(changed ? (settled ? "Room response complete." : "Room activity received; a participant is still responding.") : "No new room activity before timeout.", { ...state, changed, settled }); });
server.registerTool("end_meeting", { title: "End a live council", description: "Mark the invoking host away and complete or cancel the bounded meeting.", inputSchema: { roomId: z.string(), cancel: z.boolean().default(false) } }, async ({ roomId, cancel }) => { const room = await request<any>(`/api/rooms/${roomId}/meeting?cancel=${cancel}`, { method: "DELETE" }); return result(cancel ? "Council cancelled." : "Council complete; host marked away.", { roomId, room, url: `${baseUrl()}/?room=${roomId}` }); });

// v0 compatibility aliases
server.registerTool("post_message", { title: "Post to Polychat (legacy)", description: "Compatibility alias for posting to the legacy common room.", inputSchema: { content: z.string().min(1) } }, async ({ content }) => result("Posted to the legacy room.", await request<any>("/api/rooms/common-room/messages", { method: "POST", body: JSON.stringify({ senderId: participantId, content }) })));
server.registerTool("ask_claude", { title: "Ask Claude (legacy)", description: "Compatibility alias for invoking a Claude participant in the legacy room.", inputSchema: { message: z.string().min(1), agentId: z.string().default("opus") } }, async ({ message, agentId }) => result(`${agentId} is responding.`, await request<any>("/api/rooms/common-room/messages", { method: "POST", body: JSON.stringify({ senderId: participantId, content: message, recipientAgentIds: [agentId] }) })));
server.registerTool("ask_codex", { title: "Ask Codex (legacy)", description: "Compatibility alias for invoking a Codex participant in the legacy room.", inputSchema: { message: z.string().min(1), agentId: z.string().default("codex") } }, async ({ message, agentId }) => result(`${agentId} is responding.`, await request<any>("/api/rooms/common-room/messages", { method: "POST", body: JSON.stringify({ senderId: participantId, content: message, recipientAgentIds: [agentId] }) })));
server.registerTool("configure_claude", { title: "Configure Claude (legacy)", description: "Compatibility alias for configuring the legacy Opus participant.", inputSchema: { cwd: z.string(), sessionId: z.string().nullable().optional(), model: z.string().default("opus"), name: z.string().default("Opus") } }, async (input) => result("Claude configured.", await request<any>("/api/rooms/common-room/participants/opus", { method: "PATCH", body: JSON.stringify(input) })));

server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
