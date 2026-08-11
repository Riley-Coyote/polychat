import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ClaudeProjectContext, ClaudeSessionContext } from "../shared/types.js";

const claudeProjectsRoot = join(homedir(), ".claude", "projects");
const claudeHistoryPath = join(homedir(), ".claude", "history.jsonl");
const projectCache = new Map<string, { expiresAt: number; value: ClaudeProjectContext[] }>();
const sessionCache = new Map<string, { expiresAt: number; value: ClaudeSessionContext[] }>();
const cacheTtl = 30_000;
let historyCache: { mtime: number; value: Map<string, HistoryProject> } | null = null;

type HistorySession = {
  id: string;
  firstPrompt: string;
  lastPrompt: string;
  firstTimestamp: number;
  lastTimestamp: number;
};

type HistoryProject = {
  cwd: string;
  lastTimestamp: number;
  sessions: Map<string, HistorySession>;
};

type TranscriptRecord = {
  type?: string;
  cwd?: string;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  entrypoint?: string;
  lastPrompt?: string;
  message?: { role?: string; content?: unknown };
};

function readSlice(path: string, offset: number, length: number) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseLines(text: string, trimEdges = false): TranscriptRecord[] {
  const lines = text.split("\n");
  if (trimEdges && lines.length > 2) {
    lines.shift();
    lines.pop();
  }
  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // A chunk may begin or end in the middle of a JSONL record.
    }
  }
  return records;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object" && "type" in block)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function cleanPreview(value: string, limit = 180) {
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function loadInteractiveHistory() {
  if (!existsSync(claudeHistoryPath)) return new Map<string, HistoryProject>();
  const stats = statSync(claudeHistoryPath);
  if (historyCache?.mtime === stats.mtimeMs) return historyCache.value;
  const projects = new Map<string, HistoryProject>();
  const lines = readFileSync(claudeHistoryPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as {
        project?: string;
        sessionId?: string;
        display?: string;
        timestamp?: number;
      };
      if (!record.project || !record.sessionId || typeof record.timestamp !== "number") continue;
      const prompt = cleanPreview(record.display ?? "");
      const meaningfulPrompt = prompt && !/^(exit|quit|clear)$/i.test(prompt) ? prompt : "";
      let project = projects.get(record.project);
      if (!project) {
        project = { cwd: record.project, lastTimestamp: record.timestamp, sessions: new Map() };
        projects.set(record.project, project);
      }
      project.lastTimestamp = Math.max(project.lastTimestamp, record.timestamp);
      const existing = project.sessions.get(record.sessionId);
      if (!existing) {
        project.sessions.set(record.sessionId, {
          id: record.sessionId,
          firstPrompt: meaningfulPrompt,
          lastPrompt: meaningfulPrompt,
          firstTimestamp: record.timestamp,
          lastTimestamp: record.timestamp,
        });
      } else {
        if (meaningfulPrompt && !existing.firstPrompt) existing.firstPrompt = meaningfulPrompt;
        if (meaningfulPrompt) existing.lastPrompt = meaningfulPrompt;
        existing.firstTimestamp = Math.min(existing.firstTimestamp, record.timestamp);
        existing.lastTimestamp = Math.max(existing.lastTimestamp, record.timestamp);
      }
    } catch {
      // Ignore malformed history records.
    }
  }
  historyCache = { mtime: stats.mtimeMs, value: projects };
  return projects;
}

function titleFrom(slug: string | undefined, preview: string) {
  if (slug) {
    return slug
      .split("-")
      .filter(Boolean)
      .map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
      .join(" ")
      .slice(0, 82);
  }
  if (preview) return preview.length > 82 ? `${preview.slice(0, 79)}…` : preview;
  return "Untitled Claude session";
}

function isMaintenanceSession(session: ClaudeSessionContext) {
  const sample = `${session.title} ${session.preview} ${session.lastPrompt}`;
  return /(?:^|\s)#?\s*Memory Extractor\b/i.test(sample)
    || /memory extraction system/i.test(sample)
    || /memory relationship classifier/i.test(sample)
    || /extract structured memories/i.test(sample);
}

function inspectTranscript(path: string): {
  cwd: string | null;
  session: ClaudeSessionContext;
} {
  const stats = statSync(path);
  const headLength = Math.min(stats.size, 512 * 1024);
  const tailLength = Math.min(stats.size, 256 * 1024);
  const head = parseLines(readSlice(path, 0, headLength));
  const tailOffset = Math.max(0, stats.size - tailLength);
  const tail = tailOffset === 0 ? head : parseLines(readSlice(path, tailOffset, tailLength), true);
  const records = [...head, ...tail];
  const cwdRecord = records.find((record) => record.cwd);
  const sessionRecord = records.find((record) => record.sessionId);
  const branchRecord = records.find((record) => record.gitBranch);
  const firstUser = head.find((record) => record.type === "user" && record.message?.role === "user");
  const lastPromptRecord = [...tail].reverse().find((record) => record.type === "last-prompt" && record.lastPrompt);
  const lastUser = [...tail].reverse().find((record) => record.type === "user" && record.message?.role === "user");
  const preview = cleanPreview(textContent(firstUser?.message?.content));
  const lastPrompt = cleanPreview(lastPromptRecord?.lastPrompt ?? textContent(lastUser?.message?.content));
  const sessionId = sessionRecord?.sessionId ?? basename(path, ".jsonl");
  const slug = records.find((record) => record.slug)?.slug;
  const createdAt = firstUser?.timestamp ?? cwdRecord?.timestamp ?? sessionRecord?.timestamp ?? null;

  return {
    cwd: cwdRecord?.cwd ?? null,
    session: {
      id: sessionId,
      title: titleFrom(slug, preview),
      preview,
      lastPrompt,
      branch: branchRecord?.gitBranch ?? null,
      createdAt,
      updatedAt: stats.mtime.toISOString(),
      size: stats.size,
      isSidechain: records.some((record) => record.isSidechain === true),
      source: records.find((record) => record.entrypoint)?.entrypoint ?? null,
    },
  };
}

function sessionFiles(projectDirectory: string) {
  return readdirSync(projectDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const path = join(projectDirectory, entry.name);
      const stats = statSync(path);
      return { path, mtime: stats.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function listClaudeProjects(query = ""): ClaudeProjectContext[] {
  const normalizedQuery = query.trim().toLowerCase();
  const cached = projectCache.get(normalizedQuery);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!existsSync(claudeProjectsRoot)) return [];
  const interactiveHistory = loadInteractiveHistory();

  const directories = readdirSync(claudeProjectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !normalizedQuery || entry.name.toLowerCase().includes(normalizedQuery));

  const projects: ClaudeProjectContext[] = [];
  for (const directory of directories) {
    const projectDirectory = join(claudeProjectsRoot, directory.name);
    const files = sessionFiles(projectDirectory);
    if (!files.length) continue;
    try {
      const latest = inspectTranscript(files[0].path);
      if (!latest.cwd) continue;
      const searchText = `${latest.cwd} ${basename(latest.cwd)}`.toLowerCase();
      if (normalizedQuery && !searchText.includes(normalizedQuery) && !directory.name.toLowerCase().includes(normalizedQuery)) continue;
      const history = interactiveHistory.get(latest.cwd);
      projects.push({
        id: directory.name,
        runtime: "claude-code",
        name: basename(latest.cwd) || latest.cwd,
        cwd: latest.cwd,
        parentPath: dirname(latest.cwd),
        updatedAt: new Date(history?.lastTimestamp ?? files[0].mtime).toISOString(),
        sessionCount: history?.sessions.size ?? 0,
        hasMemory: existsSync(join(projectDirectory, "memory", "MEMORY.md")),
        exists: existsSync(latest.cwd),
      });
    } catch (error) {
      console.warn(`Could not inspect Claude project ${directory.name}:`, error);
    }
  }

  const value = projects.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 80);
  projectCache.set(normalizedQuery, { expiresAt: Date.now() + cacheTtl, value });
  return value;
}

export function listClaudeSessions(projectId: string, limit = 30): ClaudeSessionContext[] {
  const safeProjectId = basename(projectId);
  const cached = sessionCache.get(safeProjectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value.slice(0, limit);
  const projectDirectory = join(claudeProjectsRoot, safeProjectId);
  if (!existsSync(projectDirectory)) return [];

  const sessions: ClaudeSessionContext[] = [];
  const files = sessionFiles(projectDirectory);
  if (!files.length) return [];
  let cwd: string | null = null;
  try {
    cwd = inspectTranscript(files[0].path).cwd;
  } catch {
    // Fall through to the recent-file fallback.
  }
  const historySessions = cwd
    ? [...(loadInteractiveHistory().get(cwd)?.sessions.values() ?? [])]
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    : [];

  for (const history of historySessions) {
    const path = join(projectDirectory, `${history.id}.jsonl`);
    if (!existsSync(path)) continue;
    try {
      const inspected = inspectTranscript(path).session;
      if (inspected.isSidechain) continue;
      const enriched = {
        ...inspected,
        title: inspected.title === "Untitled Claude session"
          ? titleFrom(undefined, history.firstPrompt)
          : inspected.title,
        preview: history.firstPrompt || inspected.preview,
        lastPrompt: history.lastPrompt || inspected.lastPrompt,
        createdAt: new Date(history.firstTimestamp).toISOString(),
        updatedAt: new Date(history.lastTimestamp).toISOString(),
      };
      if (!isMaintenanceSession(enriched)) sessions.push(enriched);
      if (sessions.length >= Math.max(limit, 40)) break;
    } catch {
      // Ignore individual corrupt transcript files.
    }
  }

  const knownSessionIds = new Set(sessions.map((session) => session.id));
  const candidates = files.slice(0, Math.max(limit * 5, 120));
  for (const candidate of candidates) {
    try {
      const inspected = inspectTranscript(candidate.path).session;
      if (!inspected.isSidechain && inspected.source !== "sdk-cli" && !knownSessionIds.has(inspected.id) && !isMaintenanceSession(inspected)) {
        sessions.push(inspected);
        knownSessionIds.add(inspected.id);
      }
      if (sessions.length >= Math.max(limit, 40)) break;
    } catch {
      // Ignore individual corrupt transcript files.
    }
  }

  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  sessionCache.set(safeProjectId, { expiresAt: Date.now() + cacheTtl, value: sessions });
  return sessions.slice(0, limit);
}
