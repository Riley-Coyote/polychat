import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { versionAtLeast, versionNumber } from "./transports/process.js";
import { readOnlyProfile } from "./transports/seatbelt.js";
import { codexFailure } from "./adapters/codex.js";
import { eventText as grokEventText, grokSignedIn } from "./adapters/grok.js";
import { appendSegment } from "./adapters/helpers.js";
import { getRuntimeAdapter, isRuntimeId, rankProjects, runtimeIds } from "./registry.js";

test("runtime registry contains every v1.1 peer and rejects unknown values", () => {
  assert.deepEqual(runtimeIds, ["claude-code", "codex", "grok", "kimi-code"]);
  assert.equal(isRuntimeId("grok"), true);
  assert.equal(isRuntimeId("kimi"), false);
  assert.equal(getRuntimeAdapter("kimi-code").descriptor.capabilities.transport, "acp");
});

test("runtime version comparison handles patch and missing versions", () => {
  assert.equal(versionNumber("Grok Build 0.2.114"), "0.2.114");
  assert.equal(versionAtLeast("0.2.114", "0.2.114"), true);
  assert.equal(versionAtLeast("0.3.0", "0.2.114"), true);
  assert.equal(versionAtLeast("0.2.99", "0.2.114"), false);
  assert.equal(versionAtLeast(null, "0.2.114"), false);
});

test("Kimi Seatbelt profile denies writes everywhere except Kimi's own state and scratch space", () => {
  const profile = readOnlyProfile('/tmp/home "quoted"');
  assert.match(profile, /allow default/);
  assert.match(profile, /\(deny file-write\*\)\n/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/tmp\/home \\"quoted\\"\/\.kimi-code"\)/);
  assert.match(profile, /\(subpath "\/private\/tmp"\)/);
});

test("project ranking prioritizes exact CWD, exact name, prefix, then recency", () => {
  const base = { runtime: "codex" as const, parentPath: "/tmp", sessionCount: 1, hasMemory: false, exists: true };
  const ranked = rankProjects([
    { ...base, id: "recent", name: "Polychat notes", cwd: "/tmp/notes", updatedAt: "2026-08-11T10:00:00Z" },
    { ...base, id: "exact-name", name: "polychat", cwd: "/tmp/polychat-old", updatedAt: "2026-08-10T10:00:00Z" },
    { ...base, id: "exact-cwd", name: "repo", cwd: "/work/polychat", updatedAt: "2026-08-09T10:00:00Z" },
  ], "/work/polychat");
  assert.equal(ranked[0].id, "exact-cwd");
  assert.equal(rankProjects(ranked, "polychat")[0].id, "exact-name");
});

test("Grok Build 1.0 reply text streams through while its reasoning stays hidden", () => {
  assert.deepEqual(grokEventText({ type: "text", data: "hello" }), { mode: "delta", text: "hello" });
  assert.equal(grokEventText({ type: "thought", data: "The user wants" }), null);
  assert.equal(grokEventText({ type: "available_commands", tools: ["write"] }), null);
});

test("a reply that resumes after a tool call starts a new paragraph", () => {
  assert.equal(appendSegment("I'll read the README.", "Lantern is a notes app.", true), "I'll read the README.\n\nLantern is a notes app.");
  assert.equal(appendSegment("Lantern is", " a notes app.", false), "Lantern is a notes app.");
  assert.equal(appendSegment("", "First words.", true), "First words.");
});

test("a Codex session that is open elsewhere is reported plainly, and other failures keep Codex's own words", () => {
  const busy = codexFailure("ERROR codex_core::session: Failed to create session: thread-store conflict: thread 01a1 already has an active writer\nError: thread/resume: thread/resume failed: thread 01a1 already has an active writer (code -32600)", 1);
  assert.equal(busy.detail.code, "invocation_busy");
  assert.equal(busy.detail.retryable, false);
  assert.match(busy.detail.message, /open somewhere else/);
  assert.doesNotMatch(busy.detail.message, /thread-store|-32600/);
  const other = codexFailure("  model not found  ", 1);
  assert.equal(other.detail.code, "process_failed");
  assert.equal(other.detail.message, "model not found");
  assert.equal(other.detail.retryable, true);
  assert.equal(codexFailure("", null).detail.code, "invocation_cancelled");
});

test("one failed Grok check is not taken as signed out, but two are", () => {
  const dir = mkdtempSync(join(tmpdir(), "polychat-grok-"));
  try {
    const authFile = join(dir, "auth.json"); writeFileSync(authFile, "{}");
    const fake = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path; };
    const calls = join(dir, "calls");
    const renewing = fake("renewing", `echo x >> "${calls}"\nif [ "$(wc -l < "${calls}")" -lt 2 ]; then echo "token expired" >&2; exit 1; fi\necho "You are logged in with grok.com."`);
    assert.equal(grokSignedIn(renewing, authFile), true);
    assert.equal(grokSignedIn(fake("signed-out", `echo "not authenticated" >&2; exit 1`), authFile), false);
    assert.equal(grokSignedIn(fake("quiet-refusal", `echo "Re-authentication required"`), authFile), false);
    assert.equal(grokSignedIn(fake("fine", `echo "You are logged in with grok.com."`), authFile), true);
    assert.equal(grokSignedIn(fake("never-asked", `exit 0`), join(dir, "missing.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
