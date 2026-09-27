import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, ChatMessage, Room } from "../shared/types.js";

const testDir = mkdtempSync(join(tmpdir(), "polychat-db-"));
process.env.POLYCHAT_DATA_DIR = testDir;
process.env.POLYCHAT_LEGACY_DATA_DIR = testDir;
const db = await import(`./db.ts?test=${Date.now()}`);

test("saved rooms retain distinct participants and transcripts", () => {
  const alpha = db.createRoom({ name: "Alpha", projectCwd: "/tmp/alpha" });
  const beta = db.createRoom({ name: "Beta", projectCwd: "/tmp/beta" });
  const peer = db.createAgent({ roomId: alpha.id, name: "Opus", runtime: "claude-code", model: "opus", cwd: "/tmp/alpha" });
  db.createMessage({ roomId: alpha.id, senderId: peer.id, content: "Alpha only" });
  assert.equal(db.listAgents(alpha.id).some((agent: Agent) => agent.id === peer.id), true);
  assert.equal(db.listAgents(beta.id).some((agent: Agent) => agent.id === peer.id), false);
  assert.deepEqual(db.listMessages(alpha.id).map((message: ChatMessage) => message.content), ["Alpha only"]);
  assert.deepEqual(db.listMessages(beta.id), []);
});

test("meeting and archive state persist on a room", () => {
  const room = db.createRoom({ name: "State" });
  const updated = db.updateRoom(room.id, { meetingStatus: "live", hostAgentId: "host", hostExpiresAt: "2026-08-11T12:00:00.000Z" });
  assert.equal(updated.meetingStatus, "live");
  const archived = db.updateRoom(room.id, { archivedAt: "2026-08-11T12:01:00.000Z" });
  assert.equal(archived.archivedAt, "2026-08-11T12:01:00.000Z");
  assert.equal(db.listRooms().some((candidate: Room) => candidate.id === room.id), false);
  assert.equal(db.listRooms(true).some((candidate: Room) => candidate.id === room.id), true);
});

test("rooms persist Grok and Kimi participant bindings", () => {
  const room = db.createRoom({ name: "Mixed" });
  const grok = db.createAgent({ roomId: room.id, name: "Grok", runtime: "grok", model: "grok-code-fast-1", cwd: "/tmp", sessionId: "grok-session" });
  const kimi = db.createAgent({ roomId: room.id, name: "Kimi", runtime: "kimi-code", model: "kimi-for-coding", cwd: "/tmp", sessionId: "kimi-session" });
  assert.deepEqual(db.listAgents(room.id).filter((agent: Agent) => agent.runtime !== "human").map((agent: Agent) => [agent.runtime, agent.sessionId]).sort(), [["grok", "grok-session"], ["kimi-code", "kimi-session"]].sort());
});

test.after(() => rmSync(testDir, { recursive: true, force: true }));
