import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeInvocationResult } from "./runtimes/contracts.js";

const directory = mkdtempSync(join(tmpdir(), "polychat-concurrency-"));
process.env.POLYCHAT_DATA_DIR = directory;
process.env.POLYCHAT_LEGACY_DATA_DIR = directory;
const db = await import("./db.js");
const { invokeAgent, cancelAgents } = await import("./runtime.js");
const { getRuntimeAdapter } = await import("./runtimes/registry.js");
const adapter = getRuntimeAdapter("claude-code");
const original = adapter.invoke;

test("independent rooms run concurrently; cancelling one leaves the other alive", async () => {
  const pending = new Map<string, (value: RuntimeInvocationResult) => void>();
  const prompts: string[] = [];
  adapter.invoke = ({ agent, prompt }, sink) => {
    prompts.push(prompt);
    sink({ type: "session.bound", sessionId: agent.sessionId! });
    return {
      completion: new Promise((resolve) => pending.set(agent.id, resolve)),
      cancel: async () => { pending.get(agent.id)!({ text: "cancelled", sessionId: agent.sessionId, metadata: {} }); },
    };
  };
  const a = db.createRoom({ name: "A" });
  const b = db.createRoom({ name: "B" });
  const peer = (roomId: string, sessionId: string) => db.createAgent({ roomId, sessionId, runtime: "claude-code", model: "fable", name: "Fable", cwd: directory });
  const alpha = peer(a.id, "alpha");
  const beta = peer(b.id, "beta");
  const duplicate = peer(b.id, "alpha");
  db.createMessage({ roomId: a.id, senderId: "riley", content: "Private alpha context" });
  const runA = invokeAgent(a.id, alpha, "A prompt");
  const runB = invokeAgent(b.id, beta, "B prompt");
  assert.equal(db.getAgent(alpha.id)?.status, "thinking");
  assert.equal(db.getAgent(beta.id)?.status, "thinking");
  assert.doesNotMatch(prompts[1], /Private alpha context|A prompt/);
  assert.throws(() => invokeAgent(b.id, duplicate, "collision"), /session is already responding/);
  assert.throws(() => invokeAgent(b.id, alpha, "wrong room"), /does not belong/);
  assert.equal(cancelAgents([alpha.id]), 1);
  await runA.completion;
  assert.equal(db.getAgent(beta.id)?.status, "thinking");
  pending.get(beta.id)!({ text: "B finished", sessionId: "beta", metadata: {} });
  await runB.completion;
  assert.equal(db.listMessages(a.id).some((m) => m.content === "B finished"), false);
  assert.equal(db.listMessages(b.id).filter((m) => m.status === "complete").length, 1);
  const resumed = invokeAgent(b.id, duplicate, "after release");
  pending.get(duplicate.id)!({ text: "resumed", sessionId: "alpha", metadata: {} });
  await resumed.completion;
});

test.after(() => { adapter.invoke = original; rmSync(directory, { recursive: true, force: true }); });
