import { useState, type ReactNode } from "react";
import { chairStanding, councilProjectDir, listNames, selfPlacementNote } from "../shared/council";
import type { Agent, ChatMessage, Council, CouncilPhase, Room } from "../shared/types";
import { AgentMark } from "./AgentMark";

const inSession = new Set<CouncilPhase>(["blind", "ranking", "responding", "minutes"]);
const steps: Array<{ phase: CouncilPhase; label: string }> = [
  { phase: "blind", label: "Blind answers" },
  { phase: "ranking", label: "Blind ranking" },
  { phase: "responding", label: "Cross-examination" },
  { phase: "minutes", label: "Minutes" },
];

export function councilInSession(council?: Council) { return Boolean(council && inSession.has(council.phase)); }

export function phaseLabel(council: Council) {
  if (council.phase === "complete") return "Minutes recorded";
  if (council.phase === "cancelled") return "Stopped";
  if (council.phase === "failed") return "Ended early";
  return steps.find((step) => step.phase === council.phase)?.label ?? "In session";
}

// A stopped or failed council shows how far it got: each round leaves a trace in the results.
function reachedStep(council: Council) {
  const running = steps.findIndex((step) => step.phase === council.phase);
  if (running >= 0) return running;
  return council.chairAgentId ? 3 : council.results.order ? 2 : council.results.labels ? 1 : 0;
}

function stepState(council: Council, index: number) {
  if (council.phase === "complete") return "done";
  const reached = reachedStep(council);
  if (index < reached) return "done";
  if (index > reached) return "upcoming";
  return councilInSession(council) ? "active" : "stopped";
}

const nameOf = (agents: Agent[], id: string) => agents.find((agent) => agent.id === id)?.name ?? "A member";
const list = listNames;

export function CouncilGlyph() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="6" r="2.6" /><circle cx="5.5" cy="17.5" r="2.6" /><circle cx="18.5" cy="17.5" r="2.6" /></svg>;
}

export function CouncilOpening({ message, council, agents, time }: { message: ChatMessage; council: Council; agents: Agent[]; time: string }) {
  const members = council.agentIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent));
  return <article className={`message council-opening ${message.senderRuntime}`}>
    <div className={`avatar ${message.senderRuntime}`}><AgentMark runtime={message.senderRuntime} fallback={message.senderName} /></div>
    <div className="message-body">
      <header><strong>{message.senderName}</strong><span>Council of {members.length}</span><time>{time}</time></header>
      <div className="message-content">{message.content}</div>
      <ol className="council-rail" aria-label={`Council: ${phaseLabel(council)}`}>
        {steps.map((step, index) => <li key={step.phase} className={stepState(council, index)}><i aria-hidden="true" />{step.label}</li>)}
      </ol>
      <div className="council-members" aria-label="Members">{members.map((agent) => <span key={agent.id} className="council-member"><span className={`avatar ${agent.runtime}`}><AgentMark runtime={agent.runtime} fallback={agent.name} /></span>{agent.name}</span>)}</div>
      {council.phase === "cancelled" && <p className="council-note">Stopped before the minutes.</p>}
      {council.phase === "failed" && <p className="council-note">{council.error ?? "The council ended early."}</p>}
    </div>
  </article>;
}

export function RankingBlock({ council, ballots, agents }: { council: Council; ballots: ChatMessage[]; agents: Agent[] }) {
  const { order, points = {}, firstPlaceVotes = {}, labels = {} } = council.results;
  const selfNote = selfPlacementNote(council, (id) => nameOf(agents, id));
  const top = Math.max(1, ...Object.values(points));
  const key = Object.entries(labels).map(([letter, id]) => `${letter} was ${nameOf(agents, id)}`).join(" · ");
  return <section className="council-block council-ranking" aria-label="Blind ranking">
    <header><span className="section-label">Blind ranking</span><small>{order ? "Authors were hidden while each member ranked every answer." : "Each member is ranking every answer with the authors hidden."}</small></header>
    {order ? <ol className="ranking-list">{order.map((id, index) => {
      const agent = agents.find((candidate) => candidate.id === id);
      const firsts = firstPlaceVotes[id] ?? [];
      return <li key={id}>
        <span className="rank-place">{index + 1}</span>
        <span className={`avatar ${agent?.runtime ?? "human"}`}><AgentMark runtime={agent?.runtime ?? "human"} fallback={agent?.name ?? "?"} /></span>
        <span className="rank-name">{agent?.name ?? "A member"}</span>
        <span className="rank-bar" aria-hidden="true"><span style={{ width: `${(points[id] / top) * 100}%` }} /></span>
        <span className="rank-points">{points[id]} {points[id] === 1 ? "pt" : "pts"}</span>
        {firsts.length > 0 && <small>First choice of {list(firsts.map((voter) => nameOf(agents, voter)))}</small>}
      </li>;
    })}</ol> : <ul className="ranking-pending">{ballots.map((ballot) => <li key={ballot.id} className={ballot.status}><i aria-hidden="true" />{ballot.senderName}<span>{ballot.status === "streaming" ? "ranking" : ballot.status === "error" ? "couldn't rank" : "ranked"}</span></li>)}</ul>}
    {order && <p className="council-note">{selfNote}</p>}
    {order && ballots.length > 0 && <details className="council-ballots"><summary>Ballots</summary><p className="ballot-key">{key}</p>{ballots.map((ballot) => <div key={ballot.id} className="ballot"><strong>{ballot.senderName}</strong><pre>{ballot.content}</pre></div>)}</details>}
  </section>;
}

export function Minutes({ message, council, agents, room, time }: { message: ChatMessage; council?: Council; agents: Agent[]; room: Room; time: string }) {
  const standing = council ? chairStanding(council, message.senderId) : null;
  const writing = message.status === "streaming";
  return <article className={`message council-minutes ${message.senderRuntime} ${message.status}`}>
    <div className={`avatar ${message.senderRuntime}`}><AgentMark runtime={message.senderRuntime} fallback={message.senderName} /></div>
    <div className="message-body">
      <header><strong>Minutes</strong><span>Chaired by {message.senderName}{standing ? `, ${standing}` : ""}</span><time>{time}</time>{message.status === "complete" && <button type="button" className="minutes-copy" onClick={() => void navigator.clipboard?.writeText(message.content)}>Copy</button>}</header>
      <div className="minutes-sheet">{writing && !message.content ? <span className="thinking-copy">Writing the minutes<span>…</span></span> : <MarkdownLite text={message.content} />}</div>
      {council && <MinutesFooter council={council} agents={agents} room={room} />}
    </div>
  </article>;
}

// A saved record is named by where it lives: the folder under Documents, or else the folder that holds it.
function placeOf(path: string) {
  const parts = path.split("/").filter(Boolean);
  const documents = parts.indexOf("Documents");
  return documents >= 0 && documents < parts.length - 2 ? parts[documents + 1] : parts.at(-2) ?? path;
}

// Every finished council is kept as a record. A copy can also go into the project itself.
function MinutesFooter({ council, agents, room }: { council: Council; agents: Agent[]; room: Room }) {
  const [saving, setSaving] = useState<"records" | "project" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const project = councilProjectDir(room, agents, council);
  const projectName = project?.split("/").filter(Boolean).at(-1) ?? null;
  const act = async (action: "records" | "reveal", target: "records" | "project") => {
    setProblem(null); if (action === "records") setSaving(target);
    try {
      const response = await fetch(`/api/rooms/${council.roomId}/councils/${council.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "That didn't work.");
    } catch (caught) { setProblem(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(null); }
  };
  const saved = (path: string, target: "records" | "project") => <button type="button" className="saved" title={`${path}\nShow in Finder`} onClick={() => void act("reveal", target)}>Saved in {target === "project" ? projectName : placeOf(path)}</button>;
  const save = (target: "records" | "project", label: string) => <button type="button" disabled={saving !== null} onClick={() => void act("records", target)}>{saving === target ? "Saving…" : label}</button>;
  return <footer className="minutes-footer">
    <span className="minutes-members">{council.agentIds.map((id) => nameOf(agents, id)).join(" · ")}</span>
    {council.phase === "complete" && <span className="minutes-records">
      {council.recordPath ? saved(council.recordPath, "records") : save("records", "Save a record")}
      {projectName && (council.projectRecordPath ? saved(council.projectRecordPath, "project") : save("project", `Save to ${projectName}`))}
    </span>}
    {problem && <span className="minutes-problem" role="alert">{problem}</span>}
  </footer>;
}

// Just enough Markdown for council messages: headings, lists, paragraphs, code, and **bold**.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    if (paragraph.length) { blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>); paragraph = []; }
    if (items.length) { const List = ordered ? "ol" : "ul"; blocks.push(<List key={blocks.length}>{items.map((item, index) => <li key={index}>{inline(item)}</li>)}</List>); items = []; }
  };
  let fence: string[] | null = null;
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) { if (fence) { blocks.push(<pre key={blocks.length}><code>{fence.join("\n")}</code></pre>); fence = null; } else { flush(); fence = []; } continue; }
    if (fence) { fence.push(raw); continue; }
    const line = raw.trim();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    // A single # is a headline, like the one that opens the minutes; deeper headings are section labels.
    if (heading) { flush(); blocks.push(heading[1].length === 1 ? <h3 key={blocks.length} className="md-headline">{inline(heading[2])}</h3> : <h4 key={blocks.length}>{heading[2]}</h4>); }
    else if (bullet || numbered) { if (paragraph.length || (items.length && ordered !== Boolean(numbered))) flush(); ordered = Boolean(numbered); items.push((bullet ?? numbered)![1]); }
    else if (!line) flush();
    else { if (items.length) flush(); paragraph.push(line); }
  }
  if (fence) blocks.push(<pre key={blocks.length}><code>{fence.join("\n")}</code></pre>);
  flush();
  return <>{blocks}</>;
}
