import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "polychat-contexts-"));
const project = join(root, "sample-project"); mkdirSync(project);
const grokHome = join(root, "grok"); const encoded = encodeURIComponent(project); const grokSession = join(grokHome, "sessions", encoded, "grok-session"); mkdirSync(grokSession, { recursive: true });
writeFileSync(join(grokSession, "summary.json"), JSON.stringify({ generated_title: "Grok council", session_summary: "Architecture review", current_model_id: "grok-code-fast-1", created_at: "2026-08-01T00:00:00.000Z", last_active_at: "2026-08-02T00:00:00.000Z" }));
const kimiHome = join(root, "kimi"); const kimiSession = join(kimiHome, "sessions", "wd_sample", "session_kimi-session"); mkdirSync(kimiSession, { recursive: true });
writeFileSync(join(kimiSession, "state.json"), JSON.stringify({ workDir: project, title: "Kimi council", lastPrompt: "Review the architecture", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" }));
process.env.GROK_HOME = grokHome; process.env.KIMI_CODE_HOME = kimiHome;
const grok = await import(`./grokContexts.ts?test=${Date.now()}`); const kimi = await import(`./kimiContexts.ts?test=${Date.now()}`);

test("Grok metadata index groups projects without reading transcripts", () => {
  const projects = grok.listGrokProjects("sample"); assert.equal(projects.length, 1); assert.equal(projects[0].cwd, project);
  const sessions = grok.listGrokSessions(projects[0].id); assert.equal(sessions[0].id, "grok-session"); assert.equal(sessions[0].title, "Grok council");
  assert.equal(grok.findGrokSessionCwd("grok-session"), project);
});

test("Kimi state index exposes project and exact session metadata", () => {
  const projects = kimi.listKimiProjects("sample"); assert.equal(projects.length, 1); assert.equal(projects[0].runtime, "kimi-code");
  const sessions = kimi.listKimiSessions(projects[0].id); assert.equal(sessions[0].id, "session_kimi-session"); assert.equal(sessions[0].lastPrompt, "Review the architecture");
  assert.equal(kimi.findKimiSessionCwd("session_kimi-session"), project);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
