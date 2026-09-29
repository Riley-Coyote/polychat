import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProjectContext, SessionContext } from "../shared/types.js";

const sessionsRoot = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

type CodexRecord = { id: string; cwd: string; updatedAt: string; path: string; source: string | null; title: string };

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => entry.isDirectory() ? files(join(path, entry.name)) : entry.name.endsWith(".jsonl") ? [join(path, entry.name)] : []);
}

function inspect(path: string): CodexRecord | null {
  try {
    const descriptor = BunLikeFirstLine(path);
    const record = JSON.parse(descriptor) as Record<string, any>;
    const payload = record.type === "session_meta" ? record.payload : null;
    if (!payload?.id || !payload?.cwd) return null;
    return { id: payload.id, cwd: payload.cwd, updatedAt: statSync(path).mtime.toISOString(), path, source: payload.originator ?? payload.thread_source ?? null, title: basename(payload.cwd) };
  } catch { return null; }
}

function BunLikeFirstLine(path: string) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const content = buffer.toString("utf8", 0, length);
    const newline = content.indexOf("\n");
    return newline < 0 ? content : content.slice(0, newline);
  } finally { closeSync(descriptor); }
}

function records() {
  return files(sessionsRoot).map(inspect).filter((record): record is CodexRecord => Boolean(record)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listCodexProjects(query = ""): ProjectContext[] {
  const grouped = new Map<string, CodexRecord[]>();
  for (const record of records()) grouped.set(record.cwd, [...(grouped.get(record.cwd) ?? []), record]);
  const needle = query.trim().toLowerCase();
  return [...grouped.entries()].map(([cwd, sessions]) => ({ id: Buffer.from(cwd).toString("base64url"), runtime: "codex" as const, name: basename(cwd), cwd, parentPath: dirname(cwd), updatedAt: sessions[0].updatedAt, sessionCount: sessions.length, hasMemory: existsSync(join(cwd, "AGENTS.md")), exists: existsSync(cwd) })).filter((project) => !needle || `${project.name} ${project.cwd}`.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// A Codex session file ends with its id: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Newest folders first.
function findFile(directory: string, suffix: string): string | null {
  let entries: Dirent[] = [];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return path;
    if (entry.isDirectory()) { const found = findFile(path, suffix); if (found) return found; }
  }
  return null;
}

// Codex opens a session with its own instructions and environment; the person's first words come after.
function firstPrompt(path: string) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const text = buffer.toString("utf8", 0, readSync(descriptor, buffer, 0, buffer.length, 0));
    for (const line of text.split("\n")) {
      if (!line.includes('"role":"user"')) continue;
      try {
        const payload = JSON.parse(line).payload;
        for (const part of payload?.content ?? []) {
          const said = typeof part?.text === "string" ? part.text.replace(/\s+/g, " ").trim() : "";
          if (said && !said.startsWith("<") && !said.startsWith("# AGENTS.md")) return said.length > 82 ? `${said.slice(0, 79)}…` : said;
        }
      } catch { /* A read can end mid-record. */ }
    }
  } finally { closeSync(descriptor); }
  return null;
}

export function findCodexSession(sessionId: string): SessionContext | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const path = findFile(sessionsRoot, `${sessionId}.jsonl`);
  const record = path ? inspect(path) : null;
  if (!path || !record) return null;
  let createdAt: string | null = null;
  try { createdAt = JSON.parse(BunLikeFirstLine(path)).payload?.timestamp ?? null; } catch { /* Keep the session without a start time. */ }
  return { id: record.id, title: firstPrompt(path) ?? `Codex session in ${record.title}`, preview: "", lastPrompt: "", branch: null, createdAt, updatedAt: record.updatedAt, size: statSync(path).size, isSidechain: false, source: record.source };
}

export function listCodexSessions(projectId: string, limit = 40): SessionContext[] {
  let cwd = "";
  try { cwd = Buffer.from(projectId, "base64url").toString("utf8"); } catch { return []; }
  return records().filter((record) => record.cwd === cwd).slice(0, limit).map((record) => ({ id: record.id, title: record.title, preview: `Codex task in ${record.cwd}`, lastPrompt: "", branch: null, createdAt: null, updatedAt: record.updatedAt, size: statSync(record.path).size, isSidechain: false, source: record.source }));
}
