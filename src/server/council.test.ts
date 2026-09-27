import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeInvocationResult } from "./runtimes/contracts.js";

const directory = mkdtempSync(join(tmpdir(), "polychat-council-"));
process.env.POLYCHAT_DATA_DIR = directory;
process.env.POLYCHAT_LEGACY_DATA_DIR = directory;
const db = await import("./db.js");
const { parsePosition, parseRanking, startCouncil, tallyRankings } = await import("./council.js");
const { getRuntimeAdapter } = await import("./runtimes/registry.js");
const adapter = getRuntimeAdapter("claude-code");
const original = adapter.invoke;

async function settle(councilId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const council = db.getCouncil(councilId)!;
    if (!["blind", "ranking", "responding", "minutes"].includes(council.phase)) return council;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Council did not settle.");
}

function seatRoom(names: string[]) {
  const room = db.createRoom({ name: "Council test" });
  const agents = names.map((name) => db.createAgent({ roomId: room.id, runtime: "claude-code", model: "fable", name, cwd: directory, sessionId: `${name}-session` }));
  return { room, agents };
}

test("ballots, Borda points, self-preference, and positions are read correctly", () => {
  assert.deepEqual(parseRanking("Here goes.\nRANKING: C > A > B\nSTRONGEST: C: clear", ["A", "B", "C"]), ["C", "A", "B"]);
  assert.deepEqual(parseRanking("RANKING: Answer B > Answer A", ["A", "B", "C"]), ["B", "A"]);
  assert.deepEqual(parseRanking("no ranking here", ["A", "B"]), []);
  const tally = tallyRankings({ A: "alpha", B: "beta", C: "gamma" }, { alpha: ["A", "B", "C"], beta: ["A", "C", "B"], gamma: ["C", "A", "B"] }, ["alpha", "beta", "gamma"]);
  // alpha: 2 + 2 + 1; beta: 1 + 0 + 0; gamma: 0 + 1 + 2
  assert.deepEqual(tally.points, { alpha: 5, beta: 1, gamma: 3 });
  assert.deepEqual(tally.order, ["alpha", "gamma", "beta"]);
  assert.deepEqual(tally.firstPlaceVotes, { alpha: ["alpha", "beta"], gamma: ["gamma"] });
  assert.deepEqual(tally.selfPreference, ["alpha", "gamma"]);
  assert.equal(parsePosition("**Position:** SHARPENED. I now think…"), "SHARPENED");
  assert.equal(parsePosition("Position: held, because"), "HELD");
  assert.equal(parsePosition("nothing stated"), null);
});

test("a council runs blind, ranks with authors hidden, cross-examines, and the top-ranked member chairs", async () => {
  const prompts = new Map<string, string[]>();
  adapter.invoke = ({ agent, prompt }) => {
    (prompts.get(agent.name) ?? prompts.set(agent.name, []).get(agent.name)!).push(prompt);
    let text = "";
    if (prompt.includes("COUNCIL · BLIND ROUND")) text = `${agent.name}'s view: the answer is ${agent.name.toLowerCase()}-shaped.\nPosition: go with ${agent.name}.`;
    else if (prompt.includes("COUNCIL · BLIND RANKING")) {
      // Everyone prefers Gamma's answer, then Alpha's, then Beta's, found by content since authors are hidden.
      const labelOf = (name: string) => prompt.match(new RegExp(`ANSWER ([A-F])\\n${name}'s view`))![1];
      text = `RANKING: ${labelOf("Gamma")} > ${labelOf("Alpha")} > ${labelOf("Beta")}\nSTRONGEST: x\nWEAKEST: y`;
    } else if (prompt.includes("COUNCIL · CROSS-EXAMINATION")) text = `**Challenge:** fine.\n**Position:** ${agent.name === "Beta" ? "CHANGED" : "SHARPENED"}. Now: go with Gamma.`;
    else if (prompt.includes("COUNCIL · MINUTES")) text = "## Decision\nGo with Gamma.";
    return { completion: Promise.resolve<RuntimeInvocationResult>({ text, sessionId: agent.sessionId, metadata: { runtime: "claude-code" } }), cancel: async () => undefined };
  };
  const { room, agents } = seatRoom(["Alpha", "Beta", "Gamma"]);
  db.createMessage({ roomId: room.id, senderId: "riley", content: "Earlier room context" });
  const council = startCouncil(room.id, { question: "Which way should we go?" });
  assert.equal(council.phase, "blind");
  assert.throws(() => startCouncil(room.id, { question: "Another" }), /already in session/);
  const done = await settle(council.id);
  assert.equal(done.phase, "complete", done.error ?? "");

  const blind = prompts.get("Alpha")![0];
  assert.match(blind, /Earlier room context/);
  assert.doesNotMatch(blind, /Beta's view|Gamma's view/);
  const ranking = prompts.get("Alpha")![1];
  assert.match(ranking, /ANSWER A\n/);
  assert.doesNotMatch(ranking, /### (Alpha|Beta|Gamma)|\(Claude Code\)/);
  assert.doesNotMatch(ranking.split("NEW MESSAGE FROM")[0], /'s view/, "blind answers must stay out of the transcript part of the ranking prompt");
  const response = prompts.get("Beta")![2];
  assert.match(response, /### Gamma \(Claude Code\), ranked first[\s\S]*### Alpha \(Claude Code\), ranked second/);
  assert.match(response, /Gamma ranked their own answer first\./, "Gamma put its own answer first, and the summary should say so");

  const gamma = agents.find((agent) => agent.name === "Gamma")!;
  assert.equal(done.chairAgentId, gamma.id);
  assert.deepEqual(done.results.order, ["Gamma", "Alpha", "Beta"].map((name) => agents.find((agent) => agent.name === name)!.id));
  assert.equal(done.results.points?.[gamma.id], 6);
  assert.equal(done.results.positions?.[agents.find((agent) => agent.name === "Beta")!.id], "CHANGED");
  const messages = db.listMessages(room.id).filter((message) => message.metadata.councilId === council.id);
  assert.deepEqual(messages.map((message) => message.metadata.councilRole), ["question", "blind", "blind", "blind", "ranking", "ranking", "ranking", "response", "response", "response", "minutes"]);
  assert.equal(messages.filter((message) => message.metadata.councilRole === "blind").every((message) => message.metadata.sealed === false), true);
  assert.equal(prompts.get("Gamma")!.length, 4);
  assert.equal(prompts.get("Alpha")!.length, 3);
});

test("stopping a council cancels its members, and a council needs two answers to go on", async () => {
  const pending = new Map<string, (value: RuntimeInvocationResult) => void>();
  adapter.invoke = ({ agent }) => ({
    completion: new Promise<RuntimeInvocationResult>((resolve) => pending.set(agent.id, resolve)),
    cancel: async () => { pending.get(agent.id)!({ text: "cancelled mid-thought", sessionId: agent.sessionId, metadata: {} }); },
  });
  const { room } = seatRoom(["One", "Two"]);
  const council = startCouncil(room.id, { question: "Should we stop?" });
  const { cancelCouncil } = await import("./council.js");
  assert.equal(cancelCouncil(room.id)?.phase, "cancelled");
  const done = await settle(council.id);
  assert.equal(done.phase, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(db.listMessages(room.id).some((message) => message.metadata.councilRole === "ranking"), false);

  adapter.invoke = ({ agent }) => ({ completion: agent.name === "One" ? Promise.resolve({ text: "Only me.", sessionId: agent.sessionId, metadata: {} }) : Promise.reject(new Error("offline")), cancel: async () => undefined });
  const lonely = await settle(startCouncil(room.id, { question: "Anyone?" }).id);
  assert.equal(lonely.phase, "failed");
  assert.match(lonely.error ?? "", /at least two answers/);
});

test.after(() => { adapter.invoke = original; rmSync(directory, { recursive: true, force: true }); });
