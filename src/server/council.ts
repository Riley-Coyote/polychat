import type { Agent, ChatMessage, Council, CouncilMessageRole, CouncilPhase, CouncilPosition, CouncilResults } from "../shared/types.js";
import { createCouncil, createMessage, getAgent, getCouncil, listAgents, listCouncils, updateCouncil, updateMessage } from "./db.js";
import { publish } from "./events.js";
import { cancelAgents, invokeAgent } from "./runtime.js";

// A council puts one question to real, different minds in four rounds:
//   1. blind answers, in parallel, sealed until everyone is in;
//   2. a blind ranking of every answer with the authors hidden and shuffled;
//   3. a named cross-examination, where each mind answers the others;
//   4. minutes, written by the member whose answer the blind ranking placed first.
// Hiding authors matters here because the members are genuinely different models, and a model
// can favor its own style or a familiar name.

const turnLimitMs = Number(process.env.POLYCHAT_COUNCIL_TURN_MS ?? 5 * 60_000);
const activePhases = new Set<CouncilPhase>(["blind", "ranking", "responding", "minutes"]);
const letters = "ABCDEF";
const speaker = "Polychat council";
const runtimeNames: Record<Agent["runtime"], string> = { human: "Human", codex: "Codex", "claude-code": "Claude Code", grok: "Grok Build", "kimi-code": "Kimi Code" };

const who = (agent: Agent) => agent.name === runtimeNames[agent.runtime] ? agent.name : `${agent.name} (${runtimeNames[agent.runtime]})`;
const nameOf = (agentId: string) => getAgent(agentId)?.name ?? "A member";
const ordinal = (place: number) => ["first", "second", "third", "fourth", "fifth", "sixth"][place - 1] ?? `#${place}`;
const list = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function activeCouncil(roomId: string) { return listCouncils(roomId, 5).find((council) => activePhases.has(council.phase)); }
function publishCouncil(council: Council) { publish(council.roomId, { type: "council.updated", council }); return council; }
function setPhase(id: string, phase: CouncilPhase, patch: Partial<Pick<Council, "results" | "chairAgentId" | "error">> = {}) { return publishCouncil(updateCouncil(id, { phase, ...patch })); }
function stillRunning(id: string) { const council = getCouncil(id); return Boolean(council && activePhases.has(council.phase)); }

export function parseRanking(text: string, labels: string[]) {
  const line = text.match(/RANKING:\s*([^\n]+)/i)?.[1] ?? "";
  const order: string[] = [];
  for (const match of line.toUpperCase().matchAll(/\b([A-F])\b/g)) if (labels.includes(match[1]) && !order.includes(match[1])) order.push(match[1]);
  return order;
}

export function parsePosition(text: string): CouncilPosition | null {
  const stated = text.match(/Position:?\**\s*\**\s*(HELD|SHARPENED|CHANGED)\b/i)?.[1] ?? text.match(/\b(HELD|SHARPENED|CHANGED)\b/)?.[1];
  return stated ? stated.toUpperCase() as CouncilPosition : null;
}

// Borda count: on a ballot of n answers, first place earns n−1 points and last place earns 0.
export function tallyRankings(labels: Record<string, string>, ballots: Record<string, string[]>, seatOrder: string[]) {
  const count = Object.keys(labels).length;
  const points: Record<string, number> = Object.fromEntries(Object.values(labels).map((agentId) => [agentId, 0]));
  const firstPlaceVotes: Record<string, string[]> = {};
  const selfPreference: string[] = [];
  for (const [rankerId, order] of Object.entries(ballots)) {
    order.forEach((label, index) => { const agentId = labels[label]; if (agentId) points[agentId] += count - 1 - index; });
    const top = labels[order[0]];
    if (top) { (firstPlaceVotes[top] ??= []).push(rankerId); if (top === rankerId) selfPreference.push(rankerId); }
  }
  const order = Object.keys(points).sort((a, b) => points[b] - points[a] || (firstPlaceVotes[b]?.length ?? 0) - (firstPlaceVotes[a]?.length ?? 0) || seatOrder.indexOf(a) - seatOrder.indexOf(b));
  return { points, order, firstPlaceVotes, selfPreference };
}

function rankingSummary(results: Required<Pick<CouncilResults, "order" | "points" | "firstPlaceVotes" | "selfPreference">>) {
  const lines = results.order.map((agentId, index) => {
    const firsts = results.firstPlaceVotes[agentId] ?? [];
    return `${index + 1}. ${nameOf(agentId)}: ${results.points[agentId]} point${results.points[agentId] === 1 ? "" : "s"}${firsts.length ? `, first choice of ${list(firsts.map(nameOf))}` : ""}`;
  });
  lines.push(results.selfPreference.length ? `${list(results.selfPreference.map(nameOf))} ranked their own answer first.` : "No one ranked their own answer first.");
  return lines.join("\n");
}

function shuffle<T>(items: T[]) { const copy = [...items]; for (let index = copy.length - 1; index > 0; index -= 1) { const pick = Math.floor(Math.random() * (index + 1)); [copy[index], copy[pick]] = [copy[pick], copy[index]]; } return copy; }

function blindPrompt(question: string, count: number) {
  return `COUNCIL · BLIND ROUND
You are one of ${count} minds answering this question independently. You can't see the others' answers and they can't see yours; all the answers are revealed together once everyone is in. Draw on your own project, memory, and judgment.

QUESTION
${question}

Give your best answer in 150–400 words, plainly written. End with one line that starts "Position:" and states your recommendation in a sentence.`;
}

function rankingPrompt(question: string, labeled: Array<{ label: string; text: string }>) {
  return `COUNCIL · BLIND RANKING
${labeled.length} minds answered the question below independently. Their answers appear with the authors hidden, in shuffled order. One of them may be yours: judge it exactly as you would anyone else's.

QUESTION
${question}

${labeled.map((item) => `ANSWER ${item.label}\n${item.text}`).join("\n\n")}

Rank all ${labeled.length} answers (${labeled.map((item) => item.label).join(", ")}) from strongest to weakest, for rigor and for usefulness to the person asking. Reply in exactly this form and nothing else:
RANKING: <strongest letter> > … > <weakest letter>
STRONGEST: <letter>: its best point, in one sentence
WEAKEST: <letter>: its biggest problem, in one sentence`;
}

function responsePrompt(question: string, ranked: Array<{ agent: Agent; text: string }>, summary: string) {
  return `COUNCIL · CROSS-EXAMINATION
The blind round is over. Here is every answer with its author, in the order the council ranked them while the authors were hidden.

QUESTION
${question}

${ranked.map((item, index) => `### ${who(item.agent)}, ranked ${ordinal(index + 1)}\n${item.text}`).join("\n\n")}

BLIND RANKING
${summary}

Now answer the others directly, in 150–300 words:
**Strongest point from another mind:** who, and what it changes or sharpens for you.
**Challenge:** the claim you most disagree with. Quote it briefly, say who made it, and why you disagree.
**Concession:** what in your own answer you now think was wrong, overweighted, or missing. "None" only if you say why nothing landed.
**Position:** HELD, SHARPENED, or CHANGED, then your recommendation now in one sentence. Pick the one that's true, not the one that sounds balanced.`;
}

function minutesPrompt(question: string, ranked: Array<{ agent: Agent; text: string }>, summary: string, responses: Array<{ agent: Agent; text: string }>) {
  return `COUNCIL · MINUTES
You chair this council because the blind ranking placed your answer first. Write the minutes for the person who asked. Represent every mind fairly, including the ones who disagreed with you, and don't advocate for your own answer.

QUESTION
${question}

BLIND ANSWERS, IN RANKED ORDER
${ranked.map((item) => `### ${who(item.agent)}\n${item.text}`).join("\n\n")}

BLIND RANKING
${summary}

CROSS-EXAMINATION
${responses.map((item) => `### ${who(item.agent)}\n${item.text}`).join("\n\n")}

Write the minutes plainly, in Markdown, with exactly these sections:
## Decision
1–3 sentences: what the council recommends, and how settled it is.
## Where each mind landed
One bullet per member: **name**: HELD, SHARPENED, or CHANGED, then their recommendation in a sentence.
## What moved
Who changed or sharpened, and what moved them.
## Dissent
What is still disputed, and between whom. Write "None." if nothing is.
## Next steps
3–5 concrete steps. Where it's natural, name who in the room is best placed to take each one.`;
}

// Every member takes the round in parallel. A member that can't start still gets a visible error in
// the transcript, and the council carries on with whoever answered.
async function runRound(council: Council, role: CouncilMessageRole, agentIds: string[], promptFor: (agent: Agent) => string, extra: Record<string, unknown> = {}) {
  const metadata = { councilId: council.id, councilRole: role, ...extra };
  const hideMessage = (message: ChatMessage) => message.metadata.councilId === council.id;
  const turns = agentIds.map((agentId): Promise<ChatMessage | null> => {
    const agent = getAgent(agentId); if (!agent) return Promise.resolve(null);
    try { return invokeAgent(council.roomId, agent, promptFor(agent), speaker, turnLimitMs, { hideMessage, metadata }).completion; }
    catch (error) {
      const message = createMessage({ roomId: council.roomId, senderId: agent.id, status: "error", content: `Couldn't take part in this round: ${error instanceof Error ? error.message : String(error)}`, metadata });
      publish(council.roomId, { type: "message.created", message }); return Promise.resolve(message);
    }
  });
  const settled = await Promise.all(turns);
  return new Map(agentIds.map((agentId, index) => [agentId, settled[index]]));
}

async function runCouncil(id: string) {
  let council = getCouncil(id)!;
  const seats = council.agentIds;

  const blind = await runRound(council, "blind", seats, () => blindPrompt(council.question, seats.length), { sealed: true });
  for (const message of blind.values()) if (message) publish(council.roomId, { type: "message.updated", message: updateMessage(message.id, { metadata: { ...message.metadata, sealed: false } }) });
  if (!stillRunning(id)) return;
  const answered = seats.filter((agentId) => blind.get(agentId)?.status === "complete" && blind.get(agentId)!.content.trim());
  if (answered.length < 2) { setPhase(id, "failed", { error: `A council needs at least two answers, and ${answered.length === 1 ? "only one" : "none"} came back.` }); return; }

  const shuffled = shuffle(answered);
  const labels = Object.fromEntries(shuffled.map((agentId, index) => [letters[index], agentId]));
  const labeled = shuffled.map((agentId, index) => ({ label: letters[index], text: blind.get(agentId)!.content }));
  council = setPhase(id, "ranking", { results: { labels } });
  const rankings = await runRound(council, "ranking", answered, () => rankingPrompt(council.question, labeled));
  if (!stillRunning(id)) return;
  const ballots: Record<string, string[]> = {};
  for (const agentId of answered) { const message = rankings.get(agentId); const order = message?.status === "complete" ? parseRanking(message.content, Object.keys(labels)) : []; if (order.length) ballots[agentId] = order; }
  const tally = tallyRankings(labels, ballots, seats);
  council = setPhase(id, "responding", { results: { labels, ballots, ...tally } });

  const ranked = tally.order.map((agentId) => ({ agent: getAgent(agentId)!, text: blind.get(agentId)!.content }));
  const summary = rankingSummary(tally);
  const responses = await runRound(council, "response", answered, () => responsePrompt(council.question, ranked, summary));
  if (!stillRunning(id)) return;
  const positions: Record<string, CouncilPosition> = {};
  for (const agentId of answered) { const message = responses.get(agentId); const position = message?.status === "complete" ? parsePosition(message.content) : null; if (position) positions[agentId] = position; }

  const chairId = tally.order.find((agentId) => responses.get(agentId)?.status === "complete") ?? tally.order[0];
  const answeredBack = answered.filter((agentId) => responses.get(agentId)?.status === "complete").map((agentId) => ({ agent: getAgent(agentId)!, text: responses.get(agentId)!.content }));
  council = setPhase(id, "minutes", { results: { ...council.results, positions }, chairAgentId: chairId });
  const minutes = await runRound(council, "minutes", [chairId], () => minutesPrompt(council.question, ranked, summary, answeredBack));
  if (!stillRunning(id)) return;
  const written = minutes.get(chairId)?.status === "complete";
  setPhase(id, written ? "complete" : "failed", written ? {} : { error: `${nameOf(chairId)} couldn't write the minutes.` });
}

export function startCouncil(roomId: string, input: { question: string; agentIds?: string[]; senderId?: string }) {
  const question = input.question.trim(); if (!question) throw new Error("A council needs a question.");
  if (activeCouncil(roomId)) throw new Error("A council is already in session in this room.");
  const members = listAgents(roomId);
  const sender = members.find((agent) => agent.id === (input.senderId ?? "riley"));
  if (!sender) throw new Error(`Unknown sender in this room: ${input.senderId}`);
  const wanted = input.agentIds?.length ? new Set(input.agentIds) : null;
  const seated = members.filter((agent) => agent.runtime !== "human" && agent.status !== "away" && agent.id !== sender.id && (!wanted || wanted.has(agent.id)));
  if (seated.length < 2) throw new Error("A council needs at least two available collaborators.");
  if (seated.length > letters.length) throw new Error(`A council seats at most ${letters.length} collaborators.`);
  const council = createCouncil({ roomId, question, agentIds: seated.map((agent) => agent.id) });
  const message = createMessage({ roomId, senderId: sender.id, content: question, metadata: { councilId: council.id, councilRole: "question", audience: "room", recipientAgentIds: council.agentIds } });
  publish(roomId, { type: "message.created", message }); publishCouncil(council);
  void runCouncil(council.id).catch((error) => {
    console.error("Polychat council failed:", error);
    if (stillRunning(council.id)) setPhase(council.id, "failed", { error: error instanceof Error ? error.message : String(error) });
  });
  return council;
}

export function cancelCouncil(roomId: string, councilId?: string) {
  const council = councilId ? getCouncil(councilId) : activeCouncil(roomId);
  if (!council || council.roomId !== roomId || !activePhases.has(council.phase)) return null;
  const cancelled = setPhase(council.id, "cancelled");
  cancelAgents(council.agentIds);
  return cancelled;
}
