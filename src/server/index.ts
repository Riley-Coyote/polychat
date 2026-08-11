import express from "express";
import { execFile } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createAgent, createMessage, createRoom, dataDir, getAgent, getRoom, listAgents, listMessages, listRooms, removeAgentFromRoom, updateAgent, updateRoom } from "./db.js";
import { currentCursor, publish, subscribe } from "./events.js";
import { cancelAgents, invokeAgent } from "./runtime.js";
import { listClaudeProjects, listClaudeSessions } from "./claudeContexts.js";
import { listCodexProjects, listCodexSessions } from "./codexContexts.js";

const app = express();
const preferredPort = Number(process.env.POLYCHAT_PORT ?? 4317);
const host = "127.0.0.1";

app.use(express.json({ limit: "1mb" }));

function roomState(roomId: string) {
  let room = getRoom(roomId);
  if (!room) return null;
  if (room.meetingStatus === "live" && room.hostExpiresAt && Date.parse(room.hostExpiresAt) <= Date.now()) {
    if (room.hostAgentId) {
      const hostAgent = getAgent(room.hostAgentId);
      if (hostAgent && hostAgent.status !== "away") {
        const awayHost = updateAgent(hostAgent.id, { status: "away" });
        publish(roomId, { type: "agent.updated", agent: awayHost });
      }
    }
    room = updateRoom(roomId, { meetingStatus: "complete", hostExpiresAt: null });
    publish(roomId, { type: "room.updated", room });
  }
  return { room, agents: listAgents(roomId), messages: listMessages(roomId, 300), eventCursor: currentCursor() };
}

function senderInRoom(roomId: string, senderId: string) {
  return listAgents(roomId).find((agent) => agent.id === senderId);
}

async function runDiscussion(roomId: string, agentIds: string[], content: string, senderName: string, turnCount: number) {
  let previousSpeaker = senderName;
  for (let index = 0; index < turnCount; index += 1) {
    const room = getRoom(roomId);
    if (!room || room.meetingStatus === "cancelled") break;
    const agent = getAgent(agentIds[index % agentIds.length]);
    if (!agent || agent.runtime === "human") continue;
    const prompt = index === 0 ? content : `Continue the council. Contribution ${index + 1} of ${turnCount}. Respond directly to ${previousSpeaker}'s latest ideas, challenge or extend something substantive, and move toward a useful conclusion. Original agenda:\n\n${content}`;
    const completed = await invokeAgent(roomId, agent, prompt, previousSpeaker).completion;
    previousSpeaker = completed.senderName;
  }
}

function requestedTurns(content: string, recipients: number) {
  const match = content.match(/\b(\d+)\s+(?:turns?|contributions?|replies?)\b/i);
  if (match) return Math.min(Math.max(Number(match[1]), 1), 12);
  return Math.min(Math.max(recipients * 2, 2), 12);
}

function sendMessage(roomId: string, body: Record<string, unknown>) {
  const content = String(body.content ?? "").trim();
  const senderId = String(body.senderId ?? "riley");
  if (!content) throw new Error("Message content is required.");
  const sender = senderInRoom(roomId, senderId);
  if (!sender) throw new Error(`Unknown sender in this room: ${senderId}`);
  const requested = Array.isArray(body.recipientAgentIds) ? body.recipientAgentIds.map(String) : sender.runtime === "human" ? listAgents(roomId).filter((agent) => agent.runtime !== "human" && agent.status !== "away").map((agent) => agent.id) : [];
  const recipientIds = [...new Set(requested)].filter((id) => id !== senderId);
  const message = createMessage({ roomId, senderId, content, metadata: { audience: body.audience === "direct" ? "direct" : "room", recipientAgentIds: recipientIds } });
  publish(roomId, { type: "message.created", message });
  const dispatchedAgentIds: string[] = []; const dispatchErrors: Array<{ agentId: string; error: string }> = [];
  const runnable = recipientIds.map(getAgent).filter((agent) => agent && agent.runtime !== "human" && agent.status !== "away");
  if (body.discussion === true && runnable.length) {
    dispatchedAgentIds.push(...runnable.map((agent) => agent!.id));
    void runDiscussion(roomId, runnable.map((agent) => agent!.id), content, sender.name, requestedTurns(content, runnable.length)).catch((error) => console.error("Polychat council failed:", error));
  } else {
    for (const agent of runnable) {
      try { invokeAgent(roomId, agent!, content, sender.name); dispatchedAgentIds.push(agent!.id); }
      catch (error) { dispatchErrors.push({ agentId: agent!.id, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return { ...message, dispatchedAgentIds, dispatchErrors };
}

app.get("/api/health", (_request, response) => response.json({ ok: true, service: "polychat", version: "1.0.0", dataDir }));
app.get("/api/rooms", (request, response) => response.json({ rooms: listRooms(request.query.archived === "true") }));
app.post("/api/rooms", (request, response) => { try { const name = String(request.body?.name ?? "New council").trim().slice(0, 80) || "New council"; response.status(201).json(createRoom({ name, projectCwd: typeof request.body?.projectCwd === "string" ? request.body.projectCwd : null })); } catch (error) { response.status(400).json({ error: String(error) }); } });
app.get("/api/rooms/:roomId", (request, response) => { const state = roomState(request.params.roomId); state ? response.json(state) : response.status(404).json({ error: "Room not found." }); });
app.patch("/api/rooms/:roomId", (request, response) => { try { const patch = { ...(typeof request.body?.name === "string" ? { name: request.body.name.trim().slice(0, 80) } : {}), ...(request.body?.archivedAt === null || typeof request.body?.archivedAt === "string" ? { archivedAt: request.body.archivedAt } : {}) }; const room = updateRoom(request.params.roomId, patch); publish(room.id, { type: "room.updated", room }); response.json(room); } catch (error) { response.status(404).json({ error: error instanceof Error ? error.message : String(error) }); } });

app.get("/api/rooms/:roomId/events", (request, response) => { if (!getRoom(request.params.roomId)) return response.status(404).end(); response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive"); response.flushHeaders(); const after = Number(request.query.after ?? request.headers["last-event-id"] ?? 0); subscribe(request.params.roomId, response, Number.isFinite(after) ? after : 0); request.on("close", () => response.end()); });
app.post("/api/rooms/:roomId/messages", (request, response) => { try { const result = sendMessage(request.params.roomId, request.body ?? {}); response.status(result.dispatchedAgentIds.length ? 202 : 201).json(result); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });

app.post("/api/rooms/:roomId/participants", (request, response) => {
  try {
    const runtime = request.body?.runtime;
    if (!getRoom(request.params.roomId)) return response.status(404).json({ error: "Room not found." });
    if (runtime !== "human" && runtime !== "claude-code" && runtime !== "codex") return response.status(400).json({ error: "Choose Claude Code or Codex." });
    const name = String(request.body?.name ?? "").trim(); if (!name || name.length > 48) return response.status(400).json({ error: "Choose a name under 48 characters." });
    const cwd = request.body?.cwd === null ? null : String(request.body?.cwd ?? process.cwd()).trim();
    if (cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) return response.status(400).json({ error: "The working folder does not exist." });
    const agent = createAgent({ roomId: request.params.roomId, runtime, name, model: runtime === "human" ? null : String(request.body?.model || (runtime === "claude-code" ? "opus" : "current")), cwd, sessionId: typeof request.body?.sessionId === "string" ? request.body.sessionId : null, status: request.body?.status === "away" ? "away" : "available" });
    publish(request.params.roomId, { type: "agent.updated", agent }); response.status(201).json(agent);
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.patch("/api/rooms/:roomId/participants/:agentId", (request, response) => { try { if (!senderInRoom(request.params.roomId, request.params.agentId)) return response.status(404).json({ error: "Participant not found." }); const patch = { ...(typeof request.body?.name === "string" ? { name: request.body.name } : {}), ...(typeof request.body?.model === "string" ? { model: request.body.model } : {}), ...(typeof request.body?.cwd === "string" ? { cwd: request.body.cwd } : {}), ...(request.body?.sessionId === null || typeof request.body?.sessionId === "string" ? { sessionId: request.body.sessionId } : {}), ...(typeof request.body?.status === "string" ? { status: request.body.status } : {}) }; const agent = updateAgent(request.params.agentId, patch); publish(request.params.roomId, { type: "agent.updated", agent }); response.json(agent); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.delete("/api/rooms/:roomId/participants/:agentId", (request, response) => { const agent = senderInRoom(request.params.roomId, request.params.agentId); if (!agent) return response.status(404).json({ error: "Participant not found." }); if (agent.runtime === "human") return response.status(400).json({ error: "A human participant cannot be removed." }); if (agent.status === "thinking") return response.status(409).json({ error: `${agent.name} is still responding.` }); removeAgentFromRoom(agent.id, request.params.roomId); publish(request.params.roomId, { type: "agent.removed", agentId: agent.id }); response.status(204).end(); });
app.post("/api/rooms/:roomId/invoke", (request, response) => { const agent = getAgent(String(request.body?.agentId ?? "")); const sender = senderInRoom(request.params.roomId, String(request.body?.senderId ?? "riley")); const prompt = String(request.body?.prompt ?? "").trim(); if (!agent || !sender || !prompt) return response.status(400).json({ error: "A room participant, sender, and prompt are required." }); try { const invocation = invokeAgent(request.params.roomId, agent, prompt, sender.name); response.status(202).json({ message: invocation.placeholder, eventCursor: currentCursor() }); } catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });

app.post("/api/rooms/:roomId/meeting", (request, response) => { try { const roomId = request.params.roomId; const host = createAgent({ roomId, runtime: request.body?.hostRuntime === "claude-code" ? "claude-code" : "codex", name: String(request.body?.hostName ?? (request.body?.hostRuntime === "claude-code" ? "Claude host" : "Codex host")), model: String(request.body?.hostModel ?? "current"), cwd: String(request.body?.cwd ?? process.cwd()), status: "available" }); const expiresAt = new Date(Date.now() + Math.min(Math.max(Number(request.body?.minutes ?? 20), 1), 20) * 60_000).toISOString(); const room = updateRoom(roomId, { meetingStatus: "live", hostAgentId: host.id, hostExpiresAt: expiresAt }); publish(roomId, { type: "agent.updated", agent: host }); publish(roomId, { type: "room.updated", room }); response.status(201).json({ room, host, eventCursor: currentCursor() }); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.delete("/api/rooms/:roomId/meeting", (request, response) => { try { const room = getRoom(request.params.roomId); if (!room) return response.status(404).json({ error: "Room not found." }); cancelAgents(listAgents(room.id).map((agent) => agent.id)); if (room.hostAgentId) { const hostAgent = updateAgent(room.hostAgentId, { status: "away" }); publish(room.id, { type: "agent.updated", agent: hostAgent }); } const next = updateRoom(room.id, { meetingStatus: request.query.cancel === "true" ? "cancelled" : "complete", hostExpiresAt: null }); publish(room.id, { type: "room.updated", room: next }); response.json(next); } catch (error) { response.status(400).json({ error: String(error) }); } });

app.get("/api/contexts/:runtime/projects", (request, response) => { try { const query = typeof request.query.q === "string" ? request.query.q : ""; const projects = request.params.runtime === "codex" ? listCodexProjects(query) : listClaudeProjects(query).map((project) => ({ ...project, runtime: "claude-code" })); response.json({ projects }); } catch (error) { response.status(500).json({ error: String(error) }); } });
app.get("/api/contexts/:runtime/projects/:projectId/sessions", (request, response) => { try { const limit = Math.min(Math.max(Number(request.query.limit ?? 32), 1), 80); response.json({ sessions: request.params.runtime === "codex" ? listCodexSessions(request.params.projectId, limit) : listClaudeSessions(request.params.projectId, limit) }); } catch (error) { response.status(500).json({ error: String(error) }); } });

// v0 compatibility wrappers
app.get("/api/room", (_request, response) => response.json(roomState("common-room")));
app.get("/api/events", (request, response) => { response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive"); response.flushHeaders(); subscribe("common-room", response); request.on("close", () => response.end()); });
app.post("/api/messages", (request, response) => { try { const result = sendMessage("common-room", request.body ?? {}); response.status(result.dispatchedAgentIds.length ? 202 : 201).json(result); } catch (error) { response.status(400).json({ error: String(error) }); } });
app.get("/api/claude/projects", (request, response) => response.json({ projects: listClaudeProjects(typeof request.query.q === "string" ? request.query.q : "") }));
app.get("/api/claude/projects/:id/sessions", (request, response) => response.json({ sessions: listClaudeSessions(request.params.id, Number(request.query.limit ?? 32)) }));
const entryDir = dirname(resolve(process.argv[1] ?? process.cwd()));
const dist = basename(entryDir) === "dist" ? entryDir : join(entryDir, "../../dist");
if (existsSync(dist)) { app.use(express.static(dist)); app.get("/{*path}", (_request, response) => response.sendFile(join(dist, "index.html"))); }

function listen(port: number) {
  const server = app.listen(port, host, () => { const url = `http://${host}:${port}`; writeFileSync(join(dataDir, "runtime.json"), JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }, null, 2)); console.log(`Polychat broker listening at ${url}`); });
  server.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE" && port < preferredPort + 20) listen(port + 1); else throw error; });
}
listen(preferredPort);
