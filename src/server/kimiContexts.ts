import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProjectContext, SessionContext } from "../shared/types.js";

const root = join(process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"), "sessions");
const ttl = 30_000;
let cache: { expiresAt: number; records: KimiRecord[] } | null = null;

type State = { workDir?: string; title?: string; lastPrompt?: string; createdAt?: string; updatedAt?: string };
type KimiRecord = { id: string; cwd: string; path: string; size: number; state: State; updatedAt: string };

function records() {
  if (cache && cache.expiresAt > Date.now()) return cache.records;
  const next: KimiRecord[] = [];
  if (existsSync(root)) {
    for (const projectName of readdirSync(root)) {
      const projectDirectory = join(root, projectName);
      let sessionNames: string[] = [];
      try { sessionNames = readdirSync(projectDirectory); } catch { continue; }
      for (const sessionName of sessionNames) {
        if (!sessionName.startsWith("session_")) continue;
        const path = join(projectDirectory, sessionName, "state.json");
        try {
          const stats = statSync(path);
          if (!stats.isFile() || stats.size > 512_000) continue;
          const state = JSON.parse(readFileSync(path, "utf8")) as State;
          if (!state.workDir) continue;
          next.push({ id: sessionName, cwd: state.workDir, path, size: stats.size, state, updatedAt: state.updatedAt ?? stats.mtime.toISOString() });
        } catch { /* Ignore incomplete runtime state. */ }
      }
    }
  }
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  cache = { expiresAt: Date.now() + ttl, records: next };
  return next;
}

export function listKimiProjects(query = ""): ProjectContext[] {
  const needle = query.trim().toLowerCase();
  const grouped = new Map<string, KimiRecord[]>();
  for (const record of records()) grouped.set(record.cwd, [...(grouped.get(record.cwd) ?? []), record]);
  return [...grouped.entries()].map(([cwd, sessions]) => ({
    id: Buffer.from(cwd).toString("base64url"), runtime: "kimi-code" as const, name: basename(cwd) || cwd,
    cwd, parentPath: dirname(cwd), updatedAt: sessions[0].updatedAt, sessionCount: sessions.length,
    hasMemory: existsSync(join(cwd, "AGENTS.md")), exists: existsSync(cwd),
  })).filter((project) => !needle || `${project.name} ${project.cwd}`.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function toSession(record: KimiRecord): SessionContext {
  return {
    id: record.id,
    title: record.state.title?.trim().slice(0, 82) || record.state.lastPrompt?.trim().slice(0, 82) || "Untitled Kimi session",
    preview: record.state.lastPrompt?.trim().slice(0, 180) || "",
    lastPrompt: record.state.lastPrompt?.trim().slice(0, 180) || "",
    branch: null,
    createdAt: record.state.createdAt ?? null,
    updatedAt: record.updatedAt,
    size: record.size,
    isSidechain: false,
    source: "Kimi Code",
  };
}

export function listKimiSessions(projectId: string, limit = 32): SessionContext[] {
  let cwd = "";
  try { cwd = Buffer.from(projectId, "base64url").toString("utf8"); } catch { return []; }
  return records().filter((record) => record.cwd === cwd).slice(0, limit).map(toSession);
}

export function findKimiSession(sessionId: string) { const record = records().find((candidate) => candidate.id === sessionId); return record ? toSession(record) : null; }
export function findKimiSessionCwd(sessionId: string) { return records().find((record) => record.id === sessionId)?.cwd ?? null; }
