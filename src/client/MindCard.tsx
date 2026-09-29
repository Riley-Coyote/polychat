import { useEffect, useState } from "react";
import type { Agent, ChatMessage, MindContext } from "../shared/types";

// What a participant brings into the room: its project, the instruction files its runtime reads,
// its saved memory, the conversation it continues, and what it has said here.

function day(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso); const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "today";
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) }).format(date);
}
const clock = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
function folderLabel(path: string) { const parts = path.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path; }

// Loads what a participant brings. It becomes ready once, on the first answer or after a short
// wait, so a card can open with its content already in place; later changes refresh it quietly.
export function useMind(roomId: string, agent: Agent, live: boolean) {
  const [state, setState] = useState<{ mind: MindContext | null; ready: boolean }>({ mind: null, ready: !live });
  useEffect(() => {
    if (!live) { setState({ mind: null, ready: true }); return; }
    let current = true;
    const patience = setTimeout(() => { if (current) setState((previous) => ({ ...previous, ready: true })); }, 400);
    fetch(`/api/rooms/${roomId}/participants/${agent.id}/brings`).then((response) => response.ok ? response.json() : null)
      .then((mind: MindContext | null) => { if (current) setState((previous) => ({ mind: mind ?? previous.mind, ready: true })); })
      .catch(() => { if (current) setState((previous) => ({ ...previous, ready: true })); });
    return () => { current = false; clearTimeout(patience); };
  }, [live, roomId, agent.id, agent.cwd, agent.sessionId]);
  return state;
}

function Conversation({ agent, mind }: { agent: Agent; mind: MindContext | null }) {
  const conversation = mind?.conversation;
  if (!agent.sessionId) return <>Starts fresh<small>No earlier conversation. It reads this room's recent messages each time it replies.</small></>;
  if (!conversation) return <>Continuing a saved conversation</>;
  if (conversation.origin === "room") return <>Started in this room{conversation.startedAt && <small>{`Since ${day(conversation.startedAt)}`}</small>}</>;
  if (!conversation.found) return <>Continuing a saved conversation<small>It isn't on this Mac anymore, so the runtime may start over.</small></>;
  const dates = [conversation.startedAt && `started ${day(conversation.startedAt)}`, conversation.lastActiveAt && `last active ${day(conversation.lastActiveAt)}`].filter(Boolean).join(" · ");
  return <>Continuing “{conversation.title ?? "an earlier conversation"}”{dates && <small>{dates.charAt(0).toUpperCase() + dates.slice(1)}</small>}</>;
}

export function MindCard({ agent, mind, messages }: { agent: Agent; mind: MindContext | null; messages: ChatMessage[] }) {
  const replies = messages.filter((message) => message.senderId === agent.id && message.status === "complete" && message.content.trim());
  const last = replies.at(-1);
  return <dl className="mind-card">
    <div><dt>Project</dt><dd>{agent.cwd ? <><span title={agent.cwd}>{mind?.project?.name ?? agent.cwd.split("/").filter(Boolean).at(-1)}</span><small title={agent.cwd}>{folderLabel(agent.cwd)}{mind?.project && !mind.project.exists ? " · not on this Mac" : ""}</small></> : "No project folder"}</dd></div>
    <div><dt>Reads</dt><dd>{!mind ? <span className="quiet">…</span> : mind.notes.length ? <ul>{mind.notes.map((note) => <li key={note.path} title={note.path}>{note.label}</li>)}</ul> : <span className="quiet">No instruction files</span>}</dd></div>
    {mind?.memory && <div><dt>Memory</dt><dd title={mind.memory.path}>{mind.memory.count} saved note{mind.memory.count === 1 ? "" : "s"}<small>Its own notes about this project</small></dd></div>}
    <div><dt>Conversation</dt><dd><Conversation agent={agent} mind={mind} /></dd></div>
    <div><dt>In this room</dt><dd>{last ? <>{replies.length} {replies.length === 1 ? "reply" : "replies"}<small>Last {day(last.createdAt) === "today" ? `at ${clock(last.createdAt)}` : day(last.createdAt)}</small></> : <span className="quiet">Hasn't spoken yet</span>}</dd></div>
  </dl>;
}
