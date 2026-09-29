import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { RuntimeInvocationResult } from "./runtimes/contracts.js";

const directory = mkdtempSync(join(tmpdir(), "polychat-council-"));
process.env.POLYCHAT_DATA_DIR = directory;
process.env.POLYCHAT_LEGACY_DATA_DIR = directory;
delete process.env.POLYCHAT_RECORDS_DIR;
const db = await import("./db.js");
const { parsePosition, parseRanking, startCouncil, tallyRankings } = await import("./council.js");
const { recordTitle, recordsDir, saveCouncilRecord, writeRecord } = await import("./records.js");
const { chairStanding } = await import("../shared/council.js");
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

  // The finished minutes were kept as a record, beside this test's own data rather than in the real records folder.
  const kept = db.getCouncil(council.id)!;
  assert.equal(recordsDir(), join(directory, "records"));
  assert.ok(kept.recordPath && dirname(kept.recordPath) === recordsDir() && existsSync(kept.recordPath), "the council should leave a record");
  assert.match(kept.recordPath!, /\d{4}-\d{2}-\d{2} Which way should we go\.md$/);
  const record = readFileSync(kept.recordPath!, "utf8");
  const sections = ["## Question", "## Minutes", "## Blind answers", "## Blind ranking", "## Cross-examination"].map((heading) => record.indexOf(heading));
  assert.deepEqual([...sections].sort((a, b) => a - b), sections, "the decision comes first, then everything in the order it happened");
  assert.ok(sections.every((index) => index >= 0));
  assert.match(record, /\*Chaired by Gamma, ranked first in the blind round\*\n\n### Decision\nGo with Gamma\./);
  assert.match(record, /### Alpha\n\nAlpha's view[\s\S]*### Beta\n\nBeta's view[\s\S]*### Gamma\n\nGamma's view/, "answers keep their seats, unsorted by score");
  assert.match(record, /1\. Gamma: 6 points, first choice of Alpha, Beta and Gamma/);
  assert.match(record, /Gamma ranked its own answer first\. Beta ranked its own last\./);
  assert.match(record, /### Beta: Changed/);
  assert.equal(kept.projectRecordPath, null);
});

test("a tie at the top of the ranking is called a tie", () => {
  const tied = { results: { order: ["codex", "claude"], points: { codex: 1, claude: 1 }, firstPlaceVotes: { codex: ["claude"], claude: ["codex"] } } };
  assert.equal(chairStanding(tied, "codex"), "tied for first in the blind round");
  assert.equal(chairStanding({ results: { ...tied.results, points: { codex: 2, claude: 0 } } }, "codex"), "ranked first in the blind round");
  assert.equal(chairStanding(tied, "claude"), null);
});

test("records get safe, readable names and never overwrite someone else's file", () => {
  assert.equal(recordTitle("Should we ship: yes/no?"), "Should we ship yes no");
  assert.equal(recordTitle("For Lantern, should conflict copies be shown inline in the note, or in a separate 'conflicts' list the user reviews?"), "For Lantern, should conflict copies be shown inline in the note");
  assert.equal(recordTitle("  ...  "), "Council");
  const folder = join(directory, "names");
  mkdirSync(folder);
  writeFileSync(join(folder, "2026-09-29 Plan.md"), "someone else's notes");
  const first = writeRecord(folder, "2026-09-29 Plan", "one", null);
  assert.equal(first, join(folder, "2026-09-29 Plan 2.md"));
  assert.equal(readFileSync(join(folder, "2026-09-29 Plan.md"), "utf8"), "someone else's notes");
  assert.equal(writeRecord(folder, "2026-09-29 Plan", "two", first), first, "saving again rewrites the same record");
  assert.equal(readFileSync(first, "utf8"), "two");
});

test("a copy of the minutes can go into the project's councils folder", async () => {
  adapter.invoke = ({ agent, prompt }) => {
    const text = prompt.includes("COUNCIL · BLIND RANKING") ? "RANKING: A > B" : prompt.includes("COUNCIL · MINUTES") ? "# Keep the **simple** plan\n\n## Decision\nKeep it." : `${agent.name} says keep it.\nPosition: keep it.`;
    return { completion: Promise.resolve<RuntimeInvocationResult>({ text, sessionId: agent.sessionId, metadata: {} }), cancel: async () => undefined };
  };
  const project = join(directory, "lantern");
  mkdirSync(project);
  const room = db.createRoom({ name: "Project council", projectCwd: project });
  for (const name of ["North", "South"]) db.createAgent({ roomId: room.id, runtime: "claude-code", model: "sonnet", name, cwd: project });
  const unfinished = startCouncil(room.id, { question: "Keep it?" });
  assert.throws(() => saveCouncilRecord(unfinished.id, "project"), /aren't written yet/);
  const done = await settle(unfinished.id);
  assert.equal(done.phase, "complete", done.error ?? "");
  const saved = saveCouncilRecord(done.id, "project");
  assert.equal(dirname(saved.projectRecordPath!), join(project, "councils"));
  // The chair's headline names the record and titles it; the room moves to the byline.
  assert.match(saved.projectRecordPath!, /\d{4}-\d{2}-\d{2} Keep the simple plan\.md$/);
  const kept = readFileSync(saved.projectRecordPath!, "utf8");
  assert.match(kept, /^# Keep the simple plan\n\n\*Polychat council · \d{4}-\d{2}-\d{2} · Project council · North \(Claude Code, sonnet\) · South \(Claude Code, sonnet\)\*/);
  assert.match(kept, /ranked first in the blind round\*\n\n### Decision\nKeep it\./, "the headline isn't repeated inside the minutes");
  assert.deepEqual(readdirSync(join(project, "councils")), [saved.projectRecordPath!.split("/").at(-1)]);
  assert.equal(readFileSync(saved.projectRecordPath!, "utf8"), readFileSync(saved.recordPath!, "utf8"), "the project copy is the same record");
  assert.equal(saveCouncilRecord(done.id, "project").projectRecordPath, saved.projectRecordPath, "saving twice keeps one copy");
  assert.equal(readdirSync(join(project, "councils")).length, 1);

  const loose = db.createRoom({ name: "No project" });
  db.createAgent({ roomId: loose.id, runtime: "claude-code", model: "sonnet", name: "East", cwd: project });
  db.createAgent({ roomId: loose.id, runtime: "claude-code", model: "sonnet", name: "West", cwd: directory });
  const scattered = await settle(startCouncil(loose.id, { question: "Where do we live?" }).id);
  assert.throws(() => saveCouncilRecord(scattered.id, "project"), /isn't tied to a project folder/);
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
