import assert from "node:assert/strict";
import test from "node:test";
import { versionAtLeast, versionNumber } from "./transports/process.js";
import { readOnlyProfile } from "./transports/seatbelt.js";
import { eventText as grokEventText } from "./adapters/grok.js";
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
