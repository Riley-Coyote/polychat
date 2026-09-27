import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProjectContext, SessionContext } from "../shared/types.js";

const root = join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "sessions");
const ttl = 30_000;
let cache: { expiresAt: number; records: GrokRecord[] } | null = null;

type Summary = {
  generated_title?: string;
  session_summary?: string;
  current_model_id?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
};

type GrokRecord = { id: string; cwd: string; path: string; size: number; summary: Summary; updatedAt: string };

function decodeCwd(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function records() {
  if (cache && cache.expiresAt > Date.now()) return cache.records;
  const next: GrokRecord[] = [];
  if (existsSync(root)) {
    for (const projectName of readdirSync(root)) {
      if (!projectName.startsWith("%")) continue;
      const projectDirectory = join(root, projectName);
      let sessionNames: string[] = [];
      try { sessionNames = readdirSync(projectDirectory); } catch { continue; }
      for (const id of sessionNames) {
        const path = join(projectDirectory, id, "summary.json");
        try {
          const stats = statSync(path);
          if (!stats.isFile() || stats.size > 512_000) continue;
          const summary = JSON.parse(readFileSync(path, "utf8")) as Summary;
          next.push({ id, cwd: decodeCwd(projectName), path, size: stats.size, summary, updatedAt: summary.last_active_at ?? summary.updated_at ?? stats.mtime.toISOString() });
        } catch { /* Ignore incomplete runtime state. */ }
      }
    }
  }
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  cache = { expiresAt: Date.now() + ttl, records: next };
  return next;
}

export function listGrokProjects(query = ""): ProjectContext[] {
  const needle = query.trim().toLowerCase();
  const grouped = new Map<string, GrokRecord[]>();
  for (const record of records()) grouped.set(record.cwd, [...(grouped.get(record.cwd) ?? []), record]);
  return [...grouped.entries()].map(([cwd, sessions]) => ({
    id: Buffer.from(cwd).toString("base64url"), runtime: "grok" as const, name: basename(cwd) || cwd,
    cwd, parentPath: dirname(cwd), updatedAt: sessions[0].updatedAt, sessionCount: sessions.length,
    hasMemory: existsSync(join(cwd, "AGENTS.md")), exists: existsSync(cwd),
  })).filter((project) => !needle || `${project.name} ${project.cwd}`.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listGrokSessions(projectId: string, limit = 32): SessionContext[] {
  let cwd = "";
  try { cwd = Buffer.from(projectId, "base64url").toString("utf8"); } catch { return []; }
  return records().filter((record) => record.cwd === cwd).slice(0, limit).map((record) => ({
    id: record.id,
    title: record.summary.generated_title?.trim() || record.summary.session_summary?.trim().slice(0, 82) || "Untitled Grok session",
    preview: record.summary.session_summary?.trim().slice(0, 180) || "",
    lastPrompt: "",
    branch: null,
    createdAt: record.summary.created_at ?? null,
    updatedAt: record.updatedAt,
    size: record.size,
    isSidechain: false,
    source: record.summary.current_model_id ?? "Grok Build",
  }));
}

export function findGrokSessionCwd(sessionId: string) { return records().find((record) => record.id === sessionId)?.cwd ?? null; }
