import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Agent, ChatMessage, Council, Room } from "../shared/types.js";
import { chairStanding, councilProjectDir, listNames, selfPlacementNote } from "../shared/council.js";
import { getAgent, getCouncil, getRoom, listCouncilMessages, updateCouncil } from "./db.js";

// A finished council's minutes are kept as a Markdown record, so the decision outlives the room:
// always in the records folder, and in the project's own councils folder when someone asks for it.

const runtimeNames: Record<Agent["runtime"], string> = { human: "Human", codex: "Codex", "claude-code": "Claude Code", grok: "Grok Build", "kimi-code": "Kimi Code" };
const trailingFiller = /\s+(?:a|an|and|are|as|at|be|but|by|for|from|in|is|of|on|or|the|to|with)$/i;

// A second Polychat (a custom data folder, as tests and dev copies use) keeps its records beside its data.
export function recordsDir() {
  if (process.env.POLYCHAT_RECORDS_DIR) return process.env.POLYCHAT_RECORDS_DIR;
  if (process.env.POLYCHAT_DATA_DIR) return join(process.env.POLYCHAT_DATA_DIR, "records");
  return join(homedir(), "Documents", "council-records", "polychat");
}

function localDate(iso: string) {
  const date = new Date(iso); const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The question makes the best file name: short, on a word boundary, and safe on any filesystem.
export function recordTitle(question: string) {
  let title = question.replace(/\s+/g, " ").trim();
  if (title.length > 72) title = title.slice(0, 72).replace(/\s+\S*$/, "");
  title = title.replace(/[/\\:*?"<>|]+/g, " ").replace(/^[\s.]+/, "").replace(/\s+/g, " ");
  for (let previous = ""; previous !== title;) { previous = title; title = title.replace(/[\s.,;:!?'‘’“”()\-–—]+$/, "").replace(trailingFiller, ""); }
  return title || "Council";
}

function memberLabel(agent: Agent) {
  const details = [agent.name === runtimeNames[agent.runtime] ? null : runtimeNames[agent.runtime], agent.model && agent.model !== "current" ? agent.model : null].filter(Boolean);
  return details.length ? `${agent.name} (${details.join(", ")})` : agent.name;
}

// The chair opens the minutes with a "# " headline and writes ## sections; inside the record the
// headline becomes the record's own title and the sections sit one level down.
const demote = (markdown: string) => markdown.replace(/^(#{1,5})(?=\s)/gm, "#$1");
const title = (position: string) => position.charAt(0) + position.slice(1).toLowerCase();
const finished = (messages: ChatMessage[]) => messages.find((message) => message.metadata.councilRole === "minutes" && message.status === "complete");

export function splitMinutes(content: string) {
  const match = content.trim().match(/^#[ \t]+(.+?)[ \t#]*(?:\n|$)/);
  const headline = match?.[1].replace(/\*\*/g, "").trim() || null;
  // "# Minutes" says nothing a file name can use.
  return { headline: headline && !/^(?:the\s+)?(?:council\s+)?minutes$/i.test(headline) ? headline : null, body: (match ? content.trim().slice(match[0].length) : content).trim() };
}

export function councilMarkdown({ council, room, agents, messages }: { council: Council; room: Room; agents: Agent[]; messages: ChatMessage[] }) {
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "A member";
  const said = (role: string) => messages.filter((message) => message.metadata.councilRole === role && message.status !== "streaming");
  const { order = [], points = {}, firstPlaceVotes = {}, labels = {}, positions = {} } = council.results;
  const members = council.agentIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent));
  const minutes = finished(messages);
  const { headline, body } = splitMinutes(minutes?.content ?? "");
  const lines = [`# ${headline ?? room.name}`, "", `*Polychat council · ${localDate(council.createdAt)}${headline ? ` · ${room.name}` : ""} · ${members.map(memberLabel).join(" · ")}*`, "", "## Question", "", council.question.trim(), ""];

  const standing = minutes ? chairStanding(council, minutes.senderId) : null;
  if (minutes) lines.push("## Minutes", "", `*Chaired by ${minutes.senderName}${standing ? `, ${standing}` : ""}*`, "", demote(body), "");

  // After the decision, the record keeps the order things happened in. Answers stay in their seats,
  // unsorted by score, so no one reads them through the ranking first.
  const answers = said("blind");
  if (answers.length) {
    lines.push("## Blind answers", "", "Answered in parallel and sealed until everyone was in.", "");
    for (const answer of answers) lines.push(`### ${answer.senderName}`, "", answer.status === "complete" ? answer.content.trim() : `*${answer.senderName} couldn't answer.*${answer.content.trim() ? `\n\n${answer.content.trim()}` : ""}`, "");
  }

  if (order.length) {
    lines.push("## Blind ranking", "", "Each member ranked every answer with the authors hidden and shuffled.", "");
    order.forEach((id, index) => { const firsts = firstPlaceVotes[id] ?? []; lines.push(`${index + 1}. ${nameOf(id)}: ${points[id] ?? 0} point${points[id] === 1 ? "" : "s"}${firsts.length ? `, first choice of ${listNames(firsts.map(nameOf))}` : ""}`); });
    lines.push("", selfPlacementNote(council, nameOf));
    const key = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([letter, id]) => `${letter} was ${nameOf(id)}`).join(" · ");
    if (key) lines.push("", `Answer letters: ${key}`);
    const ballots = said("ranking").filter((message) => message.status === "complete" && message.content.trim());
    if (ballots.length) { lines.push("", "Ballots:"); for (const ballot of ballots) lines.push("", `**${ballot.senderName}**`, "", "```", ballot.content.trim(), "```"); }
    lines.push("");
  }

  const responses = said("response");
  if (responses.length) {
    lines.push("## Cross-examination", "");
    for (const response of responses) lines.push(`### ${response.senderName}${positions[response.senderId] ? `: ${title(positions[response.senderId])}` : ""}`, "", response.status === "complete" ? response.content.trim() : `*${response.senderName} couldn't respond.*${response.content.trim() ? `\n\n${response.content.trim()}` : ""}`, "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// Saving again rewrites the same file. A new record never overwrites someone else's file.
export function writeRecord(directory: string, name: string, content: string, previous: string | null) {
  mkdirSync(directory, { recursive: true });
  if (previous && dirname(previous) === directory && existsSync(previous)) { writeFileSync(previous, content); return previous; }
  let path = join(directory, `${name}.md`);
  for (let copy = 2; existsSync(path); copy += 1) path = join(directory, `${name} ${copy}.md`);
  writeFileSync(path, content, { flag: "wx" });
  return path;
}

export function saveCouncilRecord(councilId: string, target: "records" | "project") {
  const council = getCouncil(councilId); if (!council) throw new Error("Unknown council.");
  if (council.phase !== "complete") throw new Error("The minutes aren't written yet.");
  const room = getRoom(council.roomId); if (!room) throw new Error("Room not found.");
  const agents = council.agentIds.map(getAgent).filter((agent): agent is Agent => Boolean(agent));
  const messages = listCouncilMessages(council.id);
  const content = councilMarkdown({ council, room, agents, messages });
  // The chair's headline names the record; without one, the question does.
  const name = `${localDate(council.createdAt)} ${recordTitle(splitMinutes(finished(messages)?.content ?? "").headline ?? council.question)}`;
  if (target === "records") return updateCouncil(council.id, { recordPath: writeRecord(recordsDir(), name, content, council.recordPath) });
  const project = councilProjectDir(room, agents, council);
  if (!project) throw new Error("This room isn't tied to a project folder.");
  if (!existsSync(project)) throw new Error(`The project folder isn't there anymore: ${project}`);
  return updateCouncil(council.id, { projectRecordPath: writeRecord(join(project, "councils"), name, content, council.projectRecordPath) });
}

// Show a saved record in Finder. Only paths Polychat wrote itself are ever revealed.
export function revealCouncilRecord(council: Council, target: "records" | "project") {
  const path = target === "records" ? council.recordPath : council.projectRecordPath;
  if (!path || !existsSync(path)) throw new Error("That record isn't where Polychat saved it anymore.");
  execFile("/usr/bin/open", ["-R", path], (error) => { if (error) console.error("Polychat couldn't reveal a record:", error); });
}
