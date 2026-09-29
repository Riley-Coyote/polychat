import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Agent } from "../shared/types.js";

// A whole home folder of its own, so the card reads only what this test puts there.
const root = mkdtempSync(join(tmpdir(), "polychat-brings-"));
const home = join(root, "home");
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.GROK_HOME = join(home, ".grok");
process.env.KIMI_CODE_HOME = join(home, ".kimi-code");
const { describeMind } = await import("./brings.js");

const put = (path: string, content = "notes") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const app = join(home, "work", "app");
const web = join(app, "web");
mkdirSync(join(app, ".git"), { recursive: true });
put(join(app, "AGENTS.md")); put(join(app, "CLAUDE.md")); put(join(app, ".claude", "rules", "style.md"));
put(join(web, "AGENTS.md")); put(join(web, "AGENTS.override.md"));
put(join(home, ".claude", "CLAUDE.md")); put(join(home, ".claude", "rules", "team", "review.md"));
put(join(home, ".codex", "AGENTS.md")); put(join(home, ".grok", "AGENTS.md"));

const claudeProject = join(home, ".claude", "projects", app.replace(/[^a-zA-Z0-9]/g, "-"));
put(join(claudeProject, "memory", "MEMORY.md"), "- index"); put(join(claudeProject, "memory", "one.md")); put(join(claudeProject, "memory", "two.md"));
const record = (value: Record<string, unknown>) => JSON.stringify(value);
put(join(claudeProject, "earlier.jsonl"), [
  record({ type: "user", cwd: app, sessionId: "earlier", slug: "cached-dreaming-patterson", timestamp: "2026-09-20T10:00:00.000Z", message: { role: "user", content: "Plan the sync layer" } }),
  record({ type: "custom-title", customTitle: "Sync layer plan", sessionId: "earlier" }),
].join("\n"));
put(join(claudeProject, "roomborn.jsonl"), record({ type: "user", cwd: app, sessionId: "roomborn", timestamp: "2026-09-29T12:00:30.000Z", message: { role: "user", content: "NEW MESSAGE FROM Riley" } }));
put(join(home, ".codex", "sessions", "2026", "09", "21", "rollout-2026-09-21T08-00-00-0199aaaa-bbbb-cccc.jsonl"), [
  record({ type: "session_meta", payload: { id: "0199aaaa-bbbb-cccc", cwd: web, timestamp: "2026-09-21T08:00:00.000Z" } }),
  record({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for web" }, { type: "input_text", text: "<environment_context>…</environment_context>" }] } }),
  record({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find why the web build is slow" }] } }),
].join("\n"));

const joined = "2026-09-29T12:00:00.000Z";
const agent = (patch: Partial<Agent>): Agent => ({ id: "a", name: "A", runtime: "claude-code", model: null, cwd: web, sessionId: null, status: "available", createdAt: joined, updatedAt: joined, ...patch });
const labels = (value: Agent) => describeMind(value).notes.map((note) => note.label);

test("each runtime reports the instruction files it actually reads", () => {
  assert.deepEqual(labels(agent({ runtime: "claude-code" })), ["Your global CLAUDE.md", "1 rule file in ~/.claude/rules", "CLAUDE.md in app", "1 rule file in app"]);
  // Codex reads AGENTS.override.md instead of AGENTS.md in the same folder, from the Git root down.
  assert.deepEqual(labels(agent({ runtime: "codex" })), ["Your global AGENTS.md", "AGENTS.md in app", "AGENTS.override.md in web"]);
  // Grok reads CLAUDE.md as well as AGENTS.md, and has no override file.
  assert.deepEqual(labels(agent({ runtime: "grok" })), ["Your global AGENTS.md", "AGENTS.md in app", "CLAUDE.md in app", "AGENTS.md in web"]);
  assert.deepEqual(labels(agent({ runtime: "kimi-code" })), ["AGENTS.md in app", "AGENTS.md in web"]);
});

test("memory, the conversation continued, and a fresh start", () => {
  const claude = describeMind(agent({ runtime: "claude-code", sessionId: "earlier" }));
  assert.deepEqual(claude.memory && { count: claude.memory.count }, { count: 2 }, "memory is found under the Git root, without counting the index");
  assert.deepEqual(claude.project, { name: "web", path: web, exists: true });
  assert.equal(claude.conversation?.title, "Sync layer plan", "a session's own name beats its random nickname");
  assert.equal(claude.conversation?.origin, "earlier");
  assert.equal(describeMind(agent({ runtime: "claude-code", sessionId: "roomborn" })).conversation?.origin, "room", "a session that began after the participant joined started in this room");
  const codex = describeMind(agent({ runtime: "codex", sessionId: "0199aaaa-bbbb-cccc" })).conversation;
  assert.equal(codex?.title, "Find why the web build is slow", "the first thing the person said, not Codex's own setup");
  assert.equal(codex?.startedAt, "2026-09-21T08:00:00.000Z");
  assert.equal(describeMind(agent({ runtime: "codex" })).conversation, null);
  assert.deepEqual(describeMind(agent({ runtime: "grok", sessionId: "gone" })).conversation, { found: false, title: null, startedAt: null, lastActiveAt: null, origin: "earlier" });
  assert.equal(describeMind(agent({ runtime: "codex" })).memory, null);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
