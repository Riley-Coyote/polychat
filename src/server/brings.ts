import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Agent, MindContext, MindNote } from "../shared/types.js";
import { claudeProjectDir, findClaudeSession } from "./claudeContexts.js";
import { findCodexSession } from "./codexContexts.js";
import { findGrokSession } from "./grokContexts.js";
import { findKimiSession } from "./kimiContexts.js";

// What a participant brings into the room, read from the same places its runtime reads them.
//   Claude Code: ~/.claude/CLAUDE.md and ~/.claude/rules, then CLAUDE.md, CLAUDE.local.md and
//     .claude/CLAUDE.md in every folder from the working folder up; plus its per-project memory notes.
//   Codex: its global AGENTS.md, then AGENTS.md (or AGENTS.override.md) from the Git root down.
//   Grok Build: Agents.md, Claude.md, AGENT.md or AGENTS.md, globally and from the Git root down.
//   Kimi Code: AGENTS.md, globally and in the project.

const home = homedir();
const place = (folder: string) => folder === home ? "~" : basename(folder) || folder;

function isFolder(path: string) { try { return statSync(path).isDirectory(); } catch { return false; } }

// macOS finds files regardless of case, so match that way and report each file by its real name.
function present(folder: string, names: string[]) {
  let entries: string[] = [];
  try { entries = readdirSync(folder); } catch { return []; }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return entries.filter((entry) => wanted.has(entry.toLowerCase())).sort();
}

function gitRoot(folder: string) {
  for (let current = folder; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

// Every folder from `top` down to `folder`, outermost first.
function descent(top: string, folder: string) {
  const folders: string[] = [];
  for (let current = folder; ; current = dirname(current)) {
    folders.unshift(current);
    if (current === top || dirname(current) === current) return folders;
  }
}

function markdownFiles(folder: string, recursive: boolean): number {
  let count = 0;
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md") count += 1;
      else if (recursive && entry.isDirectory()) count += markdownFiles(join(folder, entry.name), true);
    }
  } catch { /* A missing folder holds nothing. */ }
  return count;
}

function notesFor(agent: Agent): MindNote[] {
  const notes: MindNote[] = [];
  const note = (folder: string, file: string, label = `${file} in ${place(folder)}`) => notes.push({ label, path: join(folder, file) });
  const cwd = agent.cwd && isFolder(agent.cwd) ? agent.cwd : null;
  if (agent.runtime === "claude-code") {
    const user = join(home, ".claude");
    for (const file of present(user, ["CLAUDE.md"])) note(user, file, `Your global ${file}`);
    const rules = markdownFiles(join(user, "rules"), true);
    if (rules) notes.push({ label: `${rules} rule file${rules === 1 ? "" : "s"} in ~/.claude/rules`, path: join(user, "rules") });
    if (cwd) for (const folder of descent("/", cwd).filter((folder) => folder !== "/")) {
      for (const file of present(folder, ["CLAUDE.md", "CLAUDE.local.md"])) note(folder, file);
      // In the home folder, .claude is the global folder, already counted above.
      if (folder === home) continue;
      for (const file of present(join(folder, ".claude"), ["CLAUDE.md"])) note(folder, `.claude/${file}`);
      const projectRules = markdownFiles(join(folder, ".claude", "rules"), true);
      if (projectRules) notes.push({ label: `${projectRules} rule file${projectRules === 1 ? "" : "s"} in ${place(folder)}`, path: join(folder, ".claude", "rules") });
    }
    return notes;
  }
  if (agent.runtime === "human") return notes;
  const globalFolder = agent.runtime === "codex" ? process.env.CODEX_HOME ?? join(home, ".codex")
    : agent.runtime === "grok" ? process.env.GROK_HOME ?? join(home, ".grok")
    : process.env.KIMI_CODE_HOME ?? join(home, ".kimi-code");
  const names = agent.runtime === "grok" ? ["Agents.md", "Claude.md", "AGENT.md", "AGENTS.md"] : agent.runtime === "codex" ? ["AGENTS.override.md", "AGENTS.md"] : ["AGENTS.md"];
  // In any one folder, Codex reads AGENTS.override.md instead of AGENTS.md when both are there.
  const read = (folder: string) => { const found = present(folder, names); const override = found.find((file) => file.toLowerCase() === "agents.override.md"); return agent.runtime === "codex" && override ? [override] : found; };
  for (const file of read(globalFolder)) note(globalFolder, file, `Your global ${file}`);
  if (cwd) for (const folder of descent(gitRoot(cwd) ?? cwd, cwd)) for (const file of read(folder)) note(folder, file);
  return notes;
}

// Claude Code keeps memory notes per project; the working folder and its Git root are the two places to look.
function memoryFor(agent: Agent): MindContext["memory"] {
  if (agent.runtime !== "claude-code" || !agent.cwd) return null;
  for (const folder of new Set([agent.cwd, gitRoot(agent.cwd) ?? agent.cwd])) {
    const memory = join(claudeProjectDir(folder), "memory");
    const count = markdownFiles(memory, false);
    if (count) return { count, path: memory };
  }
  return null;
}

// A session that began after the participant joined was started in this room; an older one is being continued.
function conversationFor(agent: Agent): MindContext["conversation"] {
  if (!agent.sessionId || agent.runtime === "human") return null;
  const session = agent.runtime === "claude-code" ? findClaudeSession(agent.sessionId, agent.cwd)
    : agent.runtime === "codex" ? findCodexSession(agent.sessionId)
    : agent.runtime === "grok" ? findGrokSession(agent.sessionId)
    : findKimiSession(agent.sessionId);
  const startedAt = session?.createdAt ?? null;
  const origin = startedAt && Date.parse(startedAt) >= Date.parse(agent.createdAt) - 60_000 ? "room" : "earlier";
  return { found: Boolean(session), title: session?.title ?? null, startedAt, lastActiveAt: session?.updatedAt ?? null, origin };
}

export function describeMind(agent: Agent): MindContext {
  return {
    agentId: agent.id,
    project: agent.cwd ? { name: place(agent.cwd), path: agent.cwd, exists: isFolder(agent.cwd) } : null,
    notes: notesFor(agent),
    memory: memoryFor(agent),
    conversation: conversationFor(agent),
  };
}
