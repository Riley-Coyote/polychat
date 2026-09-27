import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent, ChatMessage, MeetingStatus, MessageStatus, Room, Runtime } from "../shared/types.js";

const defaultDataDir = join(homedir(), "Library", "Application Support", "Polychat");
export const dataDir = process.env.POLYCHAT_DATA_DIR ?? defaultDataDir;
mkdirSync(dataDir, { recursive: true });

export const databasePath = join(dataDir, "polychat.db");
const legacyPath = join(process.env.POLYCHAT_LEGACY_DATA_DIR ?? process.cwd(), ".polychat", "polychat.db");
if (!existsSync(databasePath) && existsSync(legacyPath)) {
  copyFileSync(legacyPath, databasePath);
  const backup = join(dirname(legacyPath), "polychat.db.pre-v1.bak");
  if (!existsSync(backup)) copyFileSync(legacyPath, backup);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${legacyPath}${suffix}`)) {
      copyFileSync(`${legacyPath}${suffix}`, `${databasePath}${suffix}`);
      const sidecarBackup = join(dirname(legacyPath), `polychat.db${suffix}.pre-v1.bak`);
      if (!existsSync(sidecarBackup)) copyFileSync(`${legacyPath}${suffix}`, sidecarBackup);
    }
  }
}

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_cwd TEXT,
    meeting_status TEXT NOT NULL DEFAULT 'idle',
    host_agent_id TEXT,
    host_expires_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK(runtime IN ('human', 'claude-code', 'codex', 'grok', 'kimi-code')),
    model TEXT,
    cwd TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_agents (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (room_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES agents(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('complete', 'streaming', 'error')),
    reply_to TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
`);

function migrateRuntimeConstraint() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() as { sql?: string } | undefined;
  const currentVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
  if (schema?.sql?.includes("'grok'") && schema.sql.includes("'kimi-code'")) {
    if (currentVersion < 2) db.exec("PRAGMA user_version = 2");
    return;
  }
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const backupPath = join(dataDir, "polychat.db.pre-v1.1.bak");
  if (!existsSync(backupPath)) {
    const databaseSize = statSync(databasePath).size;
    const filesystem = statfsSync(dataDir);
    if (filesystem.bavail * filesystem.bsize < databaseSize * 2) throw new Error("Polychat v1.1 migration needs more free disk space for a safe database backup.");
    copyFileSync(databasePath, backupPath);
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE agents_v2 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runtime TEXT NOT NULL CHECK(runtime IN ('human', 'claude-code', 'codex', 'grok', 'kimi-code')),
        model TEXT,
        cwd TEXT,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'available',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agents_v2 SELECT id, name, runtime, model, cwd, session_id, status, created_at, updated_at FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v2 RENAME TO agents;
      PRAGMA user_version = 2;
      COMMIT;`);
    const violation = db.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Foreign key validation failed after migration: ${JSON.stringify(violation)}`);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
    throw error;
  } finally { db.exec("PRAGMA foreign_keys = ON"); }
}

migrateRuntimeConstraint();

function addColumn(table: string, name: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

addColumn("rooms", "project_cwd", "TEXT");
addColumn("rooms", "meeting_status", "TEXT NOT NULL DEFAULT 'idle'");
addColumn("rooms", "host_agent_id", "TEXT");
addColumn("rooms", "host_expires_at", "TEXT");
addColumn("rooms", "archived_at", "TEXT");
addColumn("rooms", "updated_at", "TEXT");
db.prepare("UPDATE rooms SET updated_at = COALESCE(updated_at, created_at)").run();

function importLegacyDatabase() {
  if (!existsSync(legacyPath) || legacyPath === databasePath) return;
  let legacy: DatabaseSync | null = null;
  try {
    legacy = new DatabaseSync(legacyPath, { readOnly: true });
    const rooms = legacy.prepare("SELECT id, name, created_at FROM rooms").all() as Array<Record<string, any>>;
    const agents = legacy.prepare("SELECT * FROM agents").all() as Array<Record<string, any>>;
    const memberships = legacy.prepare("SELECT room_id, agent_id FROM room_agents").all() as Array<Record<string, any>>;
    const messages = legacy.prepare("SELECT * FROM messages").all() as Array<Record<string, any>>;
    db.exec("BEGIN");
    for (const room of rooms) db.prepare("INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(room.id, room.name, room.created_at, room.created_at);
    for (const agent of agents) db.prepare(`INSERT OR IGNORE INTO agents (id, name, runtime, model, cwd, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent.id, agent.name, agent.runtime, agent.model, agent.cwd, agent.session_id, agent.status, agent.created_at, agent.updated_at);
    for (const membership of memberships) db.prepare("INSERT OR IGNORE INTO room_agents (room_id, agent_id) VALUES (?, ?)").run(membership.room_id, membership.agent_id);
    for (const message of messages) db.prepare(`INSERT OR IGNORE INTO messages (id, room_id, sender_id, content, status, reply_to, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.room_id, message.sender_id, message.content, message.status, message.reply_to, message.metadata, message.created_at, message.updated_at);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* No transaction was active. */ }
    console.warn("Polychat legacy import skipped:", error);
  } finally { legacy?.close(); }
}

importLegacyDatabase();
db.prepare("UPDATE agents SET status = 'available' WHERE status = 'thinking'").run();
db.prepare(`UPDATE messages
  SET status = 'error',
      content = CASE WHEN TRIM(content) = ''
        THEN 'Runtime interrupted by a broker restart. Send the message again to retry.'
        ELSE content || '\n\nRuntime interrupted by a broker restart. Send the message again to retry.' END,
      updated_at = ?
  WHERE status = 'streaming'`).run(new Date().toISOString());

const now = () => new Date().toISOString();

function seedLegacyRoom() {
  const timestamp = now();
  const humanName = process.env.POLYCHAT_USER_NAME?.trim() || "You";
  db.prepare("INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("common-room", "Common room", timestamp, timestamp);
  db.prepare(`INSERT OR IGNORE INTO agents
    (id, name, runtime, model, cwd, session_id, status, created_at, updated_at)
    VALUES ('riley', ?, 'human', NULL, NULL, NULL, 'available', ?, ?)`)
    .run(humanName, timestamp, timestamp);
  db.prepare("INSERT OR IGNORE INTO room_agents (room_id, agent_id) VALUES ('common-room', 'riley')").run();
}
seedLegacyRoom();

type RoomRow = { id: string; name: string; project_cwd: string | null; meeting_status: MeetingStatus; host_agent_id: string | null; host_expires_at: string | null; archived_at: string | null; created_at: string; updated_at: string };
type AgentRow = { id: string; name: string; runtime: Runtime; model: string | null; cwd: string | null; session_id: string | null; status: Agent["status"]; created_at: string; updated_at: string };
type MessageRow = { id: string; room_id: string; sender_id: string; sender_name: string; sender_runtime: Runtime; content: string; status: MessageStatus; reply_to: string | null; metadata: string; created_at: string; updated_at: string };

const mapRoom = (row: RoomRow): Room => ({ id: row.id, name: row.name, projectCwd: row.project_cwd, meetingStatus: row.meeting_status, hostAgentId: row.host_agent_id, hostExpiresAt: row.host_expires_at, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at });
const mapAgent = (row: AgentRow): Agent => ({ id: row.id, name: row.name, runtime: row.runtime, model: row.model, cwd: row.cwd, sessionId: row.session_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
const mapMessage = (row: MessageRow): ChatMessage => ({ id: row.id, roomId: row.room_id, senderId: row.sender_id, senderName: row.sender_name, senderRuntime: row.sender_runtime, content: row.content, status: row.status, replyTo: row.reply_to, metadata: JSON.parse(row.metadata) as Record<string, unknown>, createdAt: row.created_at, updatedAt: row.updated_at });
const messageSelect = `SELECT messages.*, agents.name AS sender_name, agents.runtime AS sender_runtime FROM messages JOIN agents ON agents.id = messages.sender_id`;

export function listRooms(includeArchived = false): Room[] {
  return (db.prepare(`SELECT * FROM rooms ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY updated_at DESC`).all() as RoomRow[]).map(mapRoom);
}

export function getRoom(id = "common-room"): Room | undefined {
  const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
  return row ? mapRoom(row) : undefined;
}

export function createRoom(input: { name: string; projectCwd?: string | null }): Room {
  const id = randomUUID();
  const timestamp = now();
  db.prepare("INSERT INTO rooms (id, name, project_cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.projectCwd ?? null, timestamp, timestamp);
  db.prepare("INSERT OR IGNORE INTO room_agents (room_id, agent_id) VALUES (?, 'riley')").run(id);
  return getRoom(id)!;
}

export function updateRoom(id: string, patch: Partial<Pick<Room, "name" | "projectCwd" | "meetingStatus" | "hostAgentId" | "hostExpiresAt" | "archivedAt">>): Room {
  const current = getRoom(id);
  if (!current) throw new Error(`Unknown room: ${id}`);
  const next = { ...current, ...patch, updatedAt: now() };
  db.prepare(`UPDATE rooms SET name = ?, project_cwd = ?, meeting_status = ?, host_agent_id = ?, host_expires_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`)
    .run(next.name, next.projectCwd, next.meetingStatus, next.hostAgentId, next.hostExpiresAt, next.archivedAt, next.updatedAt, id);
  return getRoom(id)!;
}

export function listAgents(roomId = "common-room"): Agent[] {
  return (db.prepare(`SELECT agents.* FROM agents JOIN room_agents ON room_agents.agent_id = agents.id WHERE room_agents.room_id = ? ORDER BY CASE agents.runtime WHEN 'human' THEN 0 WHEN 'codex' THEN 1 ELSE 2 END, agents.created_at`).all(roomId) as AgentRow[]).map(mapAgent);
}

export function getAgent(id: string): Agent | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? mapAgent(row) : undefined;
}

export function createAgent(input: { name: string; runtime: Runtime; model: string | null; cwd: string | null; sessionId?: string | null; roomId: string; status?: Agent["status"]; id?: string }): Agent {
  const id = input.id ?? randomUUID();
  const timestamp = now();
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO agents (id, name, runtime, model, cwd, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.runtime, input.model, input.cwd, input.sessionId ?? null, input.status ?? "available", timestamp, timestamp);
    db.prepare("INSERT INTO room_agents (room_id, agent_id) VALUES (?, ?)").run(input.roomId, id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getAgent(id)!;
}

export function removeAgentFromRoom(agentId: string, roomId: string) {
  return Number(db.prepare("DELETE FROM room_agents WHERE room_id = ? AND agent_id = ?").run(roomId, agentId).changes) > 0;
}

export function updateAgent(id: string, patch: Partial<Pick<Agent, "name" | "model" | "cwd" | "sessionId" | "status">>): Agent {
  const current = getAgent(id);
  if (!current) throw new Error(`Unknown agent: ${id}`);
  const next = { ...current, ...patch, updatedAt: now() };
  db.prepare("UPDATE agents SET name = ?, model = ?, cwd = ?, session_id = ?, status = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.model, next.cwd, next.sessionId, next.status, next.updatedAt, id);
  return getAgent(id)!;
}

export function listMessages(roomId = "common-room", limit = 200): ChatMessage[] {
  return (db.prepare(`${messageSelect} WHERE messages.room_id = ? ORDER BY messages.created_at DESC LIMIT ?`).all(roomId, limit) as MessageRow[]).reverse().map(mapMessage);
}

export function getMessage(id: string): ChatMessage | undefined {
  const row = db.prepare(`${messageSelect} WHERE messages.id = ?`).get(id) as MessageRow | undefined;
  return row ? mapMessage(row) : undefined;
}

export function createMessage(input: { roomId: string; senderId: string; content?: string; status?: MessageStatus; replyTo?: string | null; metadata?: Record<string, unknown> }): ChatMessage {
  const id = randomUUID(); const timestamp = now();
  db.prepare(`INSERT INTO messages (id, room_id, sender_id, content, status, reply_to, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.roomId, input.senderId, input.content ?? "", input.status ?? "complete", input.replyTo ?? null, JSON.stringify(input.metadata ?? {}), timestamp, timestamp);
  db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").run(timestamp, input.roomId);
  return getMessage(id)!;
}

export function updateMessage(id: string, patch: Partial<Pick<ChatMessage, "content" | "status" | "metadata">>): ChatMessage {
  const current = getMessage(id); if (!current) throw new Error(`Unknown message: ${id}`);
  db.prepare("UPDATE messages SET content = ?, status = ?, metadata = ?, updated_at = ? WHERE id = ?")
    .run(patch.content ?? current.content, patch.status ?? current.status, JSON.stringify(patch.metadata ?? current.metadata), now(), id);
  return getMessage(id)!;
}
