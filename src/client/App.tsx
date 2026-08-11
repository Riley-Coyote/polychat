import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, ChatMessage, Room, RoomEvent, RoomState } from "../shared/types";
import { AddCollaborator } from "./AddCollaborator";
import { AgentMark } from "./AgentMark";
import { ContextPicker } from "./ContextPicker";

const emptyRoom: Room = { id: "", name: "Loading room", projectCwd: null, meetingStatus: "idle", hostAgentId: null, hostExpiresAt: null, archivedAt: null, createdAt: "", updatedAt: "" };
const initialState: RoomState = { room: emptyRoom, agents: [], messages: [], eventCursor: 0 };
const runtimeLabel: Record<Agent["runtime"], string> = { human: "Human", codex: "Codex", "claude-code": "Claude Code" };
const modelNames: Record<string, string> = { opus: "Opus", fable: "Fable", sonnet: "Sonnet", "gpt-5.6-sol": "GPT Sol", "gpt-5.6-terra": "GPT Terra", current: "Configured model" };

function modelLabel(agent: Agent) { return agent.runtime === "human" ? "Room owner" : `${modelNames[agent.model ?? ""] ?? agent.model ?? runtimeLabel[agent.runtime]} · ${runtimeLabel[agent.runtime]}`; }
function shortPath(path: string | null) { if (!path) return "No project selected"; const parts = path.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path; }
function timeLabel(timestamp: string) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp)); }
function upsert<T extends { id: string }>(items: T[], next: T) { const index = items.findIndex((item) => item.id === next.id); if (index < 0) return [...items, next]; const copy = [...items]; copy[index] = next; return copy; }

export function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState(new URLSearchParams(location.search).get("room") ?? "");
  const [state, setState] = useState<RoomState>(initialState);
  const [draft, setDraft] = useState("");
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState("all");
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const runtimeAgents = useMemo(() => state.agents.filter((agent) => agent.runtime !== "human" && agent.status !== "away"), [state.agents]);
  const inspectedAgent = state.agents.find((agent) => agent.id === inspectedAgentId) ?? state.agents.find((agent) => agent.runtime !== "human");
  const recipient = recipientId === "all" ? undefined : runtimeAgents.find((agent) => agent.id === recipientId);

  async function loadRooms(preferred?: string) {
    const response = await fetch("/api/rooms"); const data = await response.json(); const next = data.rooms as Room[]; setRooms(next);
    if (!roomId && next.length) selectRoom(preferred ?? next[0].id);
    if (!next.length) await createNewRoom();
  }

  function selectRoom(id: string) { setRoomId(id); history.replaceState(null, "", `/?room=${encodeURIComponent(id)}`); setRoomMenuOpen(false); setRecipientId("all"); setInspectedAgentId(null); }

  async function createNewRoom() {
    const response = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Council ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date())}` }) });
    const room = await response.json(); setRooms((current) => [room, ...current]); selectRoom(room.id);
  }

  useEffect(() => { void loadRooms(); }, []);
  useEffect(() => {
    if (!roomId) return;
    setConnection("connecting");
    fetch(`/api/rooms/${roomId}`).then(async (response) => { if (!response.ok) throw new Error("Room unavailable"); return response.json(); }).then((next) => { setState(next); setConnection("live"); }).catch(() => setConnection("offline"));
    const events = new EventSource(`/api/rooms/${roomId}/events`);
    events.addEventListener("open", () => setConnection("live")); events.addEventListener("error", () => setConnection("offline"));
    events.addEventListener("room", (raw) => { const event = JSON.parse((raw as MessageEvent).data) as RoomEvent; setState((current) => { if (event.type === "room.updated") return { ...current, room: event.room, eventCursor: event.eventId }; if (event.type === "agent.updated") return { ...current, agents: upsert(current.agents, event.agent), eventCursor: event.eventId }; if (event.type === "agent.removed") return { ...current, agents: current.agents.filter((agent) => agent.id !== event.agentId), eventCursor: event.eventId }; return { ...current, messages: upsert(current.messages, event.message), eventCursor: event.eventId }; }); });
    return () => events.close();
  }, [roomId]);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }, [state.messages]);
  useEffect(() => { if (recipientId !== "all" && !runtimeAgents.some((agent) => agent.id === recipientId)) setRecipientId("all"); }, [recipientId, runtimeAgents]);

  async function send(event: FormEvent) {
    event.preventDefault(); const content = draft.trim(); if (!content || !roomId) return; setDraft(""); setError(null);
    const recipients = recipient ? [recipient] : runtimeAgents;
    if (!recipients.length) { setError("Add an available collaborator before sending."); return; }
    try { const response = await fetch(`/api/rooms/${roomId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ senderId: state.agents.find((agent) => agent.runtime === "human")?.id ?? "riley", content, audience: recipient ? "direct" : "room", recipientAgentIds: recipients.map((agent) => agent.id), discussion: recipients.length > 1 && /\b(council|brainstorm|discuss|talk|rounds?|turns?)\b/i.test(content) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); if (data.dispatchErrors?.length) throw new Error(data.dispatchErrors.map((item: any) => item.error).join(" · ")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function renameRoom() { const name = window.prompt("Room name", state.room.name)?.trim(); if (!name) return; const response = await fetch(`/api/rooms/${roomId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); if (response.ok) { const room = await response.json(); setRooms((items) => upsert(items, room)); setState((current) => ({ ...current, room })); } }
  async function archiveRoom() { await fetch(`/api/rooms/${roomId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archivedAt: new Date().toISOString() }) }); const next = rooms.filter((room) => room.id !== roomId); setRooms(next); if (next[0]) selectRoom(next[0].id); else await createNewRoom(); }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="wordmark"><span className="wordmark-mark">P</span><span>Polychat</span></div>
        <div className="room-switcher">
          <button className="room-trigger" onClick={() => setRoomMenuOpen((open) => !open)} aria-expanded={roomMenuOpen}><span>{state.room.name}</span><i>⌄</i></button>
          <span className={`connection ${connection}`}><i />{connection}</span>
          {roomMenuOpen && <div className="room-menu">
            <div className="room-menu-head"><span>Saved rooms</span><button onClick={() => void createNewRoom()} aria-label="Create room">+</button></div>
            <div className="room-menu-list">{rooms.map((room) => <button key={room.id} className={room.id === roomId ? "selected" : ""} onClick={() => selectRoom(room.id)}><span><strong>{room.name}</strong><small>{room.projectCwd ? shortPath(room.projectCwd) : "Local council"}</small></span><i>{room.meetingStatus === "live" ? "LIVE" : ""}</i></button>)}</div>
            <div className="room-menu-actions"><button onClick={() => void renameRoom()}>Rename</button><button onClick={() => void archiveRoom()}>Archive</button></div>
          </div>}
        </div>
        <button className="quiet-button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>{settingsOpen ? "Close context" : "Room context"}</button>
      </header>

      <div className={`workspace ${settingsOpen ? "with-context" : ""}`}>
        <aside className="participants" aria-label="Participants">
          <div className="section-label">In this room</div>
          <div className="participant-list">{state.agents.map((agent) => <button key={agent.id} className={`participant ${inspectedAgent?.id === agent.id ? "selected" : ""} ${agent.status === "away" ? "away" : ""}`} onClick={() => agent.runtime !== "human" && setInspectedAgentId(agent.id)} disabled={agent.runtime === "human"}>
            <span className={`avatar ${agent.runtime}`}><AgentMark runtime={agent.runtime} fallback={agent.name} /></span>
            <span className="participant-copy"><strong>{agent.name}</strong><small>{modelLabel(agent)}</small></span><span className={`presence ${agent.status}`} title={agent.status} />
          </button>)}</div>
          <button className="add-collaborator-button" onClick={() => setAddOpen(true)}><span>+</span><strong>Add collaborator</strong></button>
          <div className="room-principle"><span className="section-label">Room principle</span><p>Shared words, distinct minds. Each participant keeps their own memory, tools, and context.</p></div>
        </aside>

        <main className="conversation">
          <div className="room-status-line"><span className={`meeting-state ${state.room.meetingStatus}`}>{state.room.meetingStatus === "live" ? "Council live" : state.room.meetingStatus === "complete" ? "Council complete" : state.room.meetingStatus === "cancelled" ? "Council stopped" : "Room ready"}</span><span>{state.room.projectCwd ? shortPath(state.room.projectCwd) : "No shared project binding"}</span></div>
          <div className="transcript" ref={transcriptRef}>{state.messages.length ? state.messages.map((message) => <Message key={message.id} message={message} />) : <EmptyRoom hasCollaborators={runtimeAgents.length > 0} onAdd={() => setAddOpen(true)} />}</div>
          <div className="composer-wrap">{error && <div className="composer-error" role="alert">{error}</div>}<form className="composer" onSubmit={send}>
            <div className="recipient-control"><span className="recipient-kicker">To</span><button className="recipient-trigger" type="button" onClick={() => setRecipientMenuOpen((open) => !open)} aria-expanded={recipientMenuOpen}><RecipientMark agents={runtimeAgents} recipient={recipient} /><span><strong>{recipient?.name ?? "Everyone"}</strong><small>{recipient ? `Only ${recipient.name} responds` : `${runtimeAgents.length} available collaborator${runtimeAgents.length === 1 ? "" : "s"}`}</small></span><i>⌄</i></button>
              {recipientMenuOpen && <div className="recipient-menu"><button className={recipientId === "all" ? "selected" : ""} onClick={() => { setRecipientId("all"); setRecipientMenuOpen(false); }} type="button"><RecipientMark agents={runtimeAgents} /><span><strong>Everyone</strong><small>Invite the whole room</small></span></button>{runtimeAgents.map((agent) => <button key={agent.id} className={recipientId === agent.id ? "selected" : ""} onClick={() => { setRecipientId(agent.id); setRecipientMenuOpen(false); }} type="button"><RecipientMark agents={runtimeAgents} recipient={agent} /><span><strong>{agent.name}</strong><small>{modelLabel(agent)}</small></span></button>)}</div>}
            </div>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={recipient ? `Message ${recipient.name}…` : "Say something to the room…"} rows={1} />
            <div className="composer-actions"><span>Enter to send · Shift Enter for a new line</span><button className="send-button" disabled={!draft.trim()}><span>Send</span><i>↑</i></button></div>
          </form></div>
        </main>

        {settingsOpen && <aside className="context-panel"><div className="context-heading"><span className="section-label">Participant context</span><button onClick={() => setSettingsOpen(false)}>×</button></div>{inspectedAgent ? <><div className="context-agent"><span className={`avatar ${inspectedAgent.runtime}`}><AgentMark runtime={inspectedAgent.runtime} fallback={inspectedAgent.name} /></span><div><strong>{inspectedAgent.name}</strong><small>{modelLabel(inspectedAgent)}</small></div></div><dl><div><dt>Project</dt><dd>{shortPath(inspectedAgent.cwd)}</dd></div><div><dt>Session</dt><dd>{inspectedAgent.sessionId ? `${inspectedAgent.sessionId.slice(0, 12)}…` : "New thread"}</dd></div><div><dt>Presence</dt><dd>{inspectedAgent.status}</dd></div></dl><button className="context-primary" onClick={() => setContextPickerOpen(true)}>Choose context</button><button className="context-danger" onClick={async () => { await fetch(`/api/rooms/${roomId}/participants/${inspectedAgent.id}`, { method: "DELETE" }); setSettingsOpen(false); }}>Remove from room</button></> : <div className="context-empty">Select a collaborator to inspect their working context.</div>}</aside>}
      </div>
      {addOpen && <AddCollaborator roomId={roomId} defaultCwd={state.room.projectCwd ?? ""} onClose={() => setAddOpen(false)} onCreated={(agent) => { setState((current) => ({ ...current, agents: upsert(current.agents, agent) })); setInspectedAgentId(agent.id); }} />}
      {contextPickerOpen && inspectedAgent && <ContextPicker roomId={roomId} agent={inspectedAgent} onClose={() => setContextPickerOpen(false)} onSelected={(agent) => setState((current) => ({ ...current, agents: upsert(current.agents, agent) }))} />}
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) { return <article className={`message ${message.senderRuntime} ${message.status}`}><div className={`avatar ${message.senderRuntime}`}><AgentMark runtime={message.senderRuntime} fallback={message.senderName} /></div><div className="message-body"><header><strong>{message.senderName}</strong><span>{message.senderRuntime === "human" ? "You" : runtimeLabel[message.senderRuntime]}</span><time>{timeLabel(message.createdAt)}</time></header><div className="message-content">{message.content || <span className="thinking-copy">Thinking<span>…</span></span>}</div></div></article>; }
function EmptyRoom({ hasCollaborators, onAdd }: { hasCollaborators: boolean; onAdd: () => void }) { return <div className="empty-room"><div className="empty-mark">P</div><h1>{hasCollaborators ? "The room is listening." : "A room with actual continuity."}</h1><p>{hasCollaborators ? "Send a message to one collaborator or convene everyone for a council." : "Add a real Claude Code or Codex collaborator, then speak to one mind or convene the room."}</p>{!hasCollaborators && <button onClick={onAdd}>Add the first collaborator</button>}</div>; }
function RecipientMark({ agents, recipient }: { agents: Agent[]; recipient?: Agent }) { if (recipient) return <span className={`recipient-mark avatar ${recipient.runtime}`}><AgentMark runtime={recipient.runtime} fallback={recipient.name} /></span>; return <span className="recipient-stack">{agents.slice(0, 3).map((agent) => <span key={agent.id} className={`avatar ${agent.runtime}`}><AgentMark runtime={agent.runtime} fallback={agent.name} /></span>)}</span>; }
