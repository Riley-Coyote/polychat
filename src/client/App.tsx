import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, ChatMessage, Room, RoomEvent, RoomState } from "../shared/types";
import { AddCollaborator } from "./AddCollaborator";
import { AgentMark } from "./AgentMark";
import { ContextPicker } from "./ContextPicker";
import { MindCard } from "./MindCard";
import { CouncilGlyph, CouncilOpening, MarkdownLite, Minutes, RankingBlock, councilInSession, phaseLabel } from "./Council";
import { guidedInitialState, guidedOpusResponse, guidedTurns } from "./guidedDemo";
import { showcaseState } from "./showcase";

const emptyRoom: Room = { id: "", name: "Loading room", projectCwd: null, meetingStatus: "idle", hostAgentId: null, hostExpiresAt: null, archivedAt: null, createdAt: "", updatedAt: "" };
const initialState: RoomState = { room: emptyRoom, agents: [], messages: [], councils: [], eventCursor: 0 };
const runtimeLabel: Record<Agent["runtime"], string> = { human: "Human", codex: "Codex", "claude-code": "Claude Code", grok: "Grok Build", "kimi-code": "Kimi Code" };
const modelNames: Record<string, string> = { opus: "Opus", fable: "Fable", sonnet: "Sonnet", "gpt-5.6-sol": "GPT Sol", "gpt-5.6-terra": "GPT Terra", current: "Configured model" };

function modelLabel(agent: Agent) { return agent.runtime === "human" ? "Room owner" : `${modelNames[agent.model ?? ""] ?? agent.model ?? runtimeLabel[agent.runtime]} · ${runtimeLabel[agent.runtime]}`; }
function shortPath(path: string | null) { if (!path) return "No project selected"; const parts = path.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path; }
function timeLabel(timestamp: string) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp)); }
function upsert<T extends { id: string }>(items: T[], next: T) { const index = items.findIndex((item) => item.id === next.id); if (index < 0) return [...items, next]; const copy = [...items]; copy[index] = next; return copy; }

export function App() {
  const showcase = new URLSearchParams(location.search).get("showcase") === "1";
  const guided = new URLSearchParams(location.search).get("guided") === "polyphonic-performance";
  const presentation = showcase || guided;
  const seededState = guided ? guidedInitialState : showcase ? showcaseState : initialState;
  const [rooms, setRooms] = useState<Room[]>(presentation ? [seededState.room] : []);
  const [roomId, setRoomId] = useState(presentation ? seededState.room.id : new URLSearchParams(location.search).get("room") ?? "");
  const [state, setState] = useState<RoomState>(seededState);
  const [draft, setDraft] = useState("");
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState("all");
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [participantsExpanded, setParticipantsExpanded] = useState(() => window.innerWidth > 760);
  const [addOpen, setAddOpen] = useState(false);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">(presentation ? "live" : "connecting");
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const input = composerRef.current;
    if (input) { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
  }, [draft]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setRecipientMenuOpen(false); setRoomMenuOpen(false); setSettingsOpen(false); setAddOpen(false); setContextPickerOpen(false); }
    };
    const dismissMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".recipient-control")) setRecipientMenuOpen(false);
      if (!event.target.closest(".room-switcher")) setRoomMenuOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismissMenus);
    return () => { document.removeEventListener("keydown", dismiss); document.removeEventListener("pointerdown", dismissMenus); };
  }, []);
  const guidedStarted = useRef(false);

  const runtimeAgents = useMemo(() => state.agents.filter((agent) => agent.runtime !== "human" && agent.status !== "away"), [state.agents]);
  const inspectedAgent = state.agents.find((agent) => agent.id === inspectedAgentId) ?? state.agents.find((agent) => agent.runtime !== "human");
  const recipient = recipientId === "all" ? undefined : runtimeAgents.find((agent) => agent.id === recipientId);
  const councilById = useMemo(() => new Map(state.councils.map((council) => [council.id, council])), [state.councils]);
  const sessionCouncil = state.councils.find(councilInSession);
  const humanId = state.agents.find((agent) => agent.runtime === "human")?.id ?? "riley";

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

  useEffect(() => { if (!presentation) void loadRooms(); }, [presentation]);
  useEffect(() => {
    if (!roomId || presentation) return;
    setConnection("connecting");
    fetch(`/api/rooms/${roomId}`).then(async (response) => { if (!response.ok) throw new Error("Room unavailable"); return response.json(); }).then((next: RoomState) => { setState({ ...next, councils: next.councils ?? [] }); setConnection("live"); }).catch(() => setConnection("offline"));
    const events = new EventSource(`/api/rooms/${roomId}/events`);
    events.addEventListener("open", () => setConnection("live")); events.addEventListener("error", () => setConnection("offline"));
    events.addEventListener("room", (raw) => { const event = JSON.parse((raw as MessageEvent).data) as RoomEvent; setState((current) => { if (event.type === "room.updated") return { ...current, room: event.room, eventCursor: event.eventId }; if (event.type === "agent.updated") return { ...current, agents: upsert(current.agents, event.agent), eventCursor: event.eventId }; if (event.type === "agent.removed") return { ...current, agents: current.agents.filter((agent) => agent.id !== event.agentId), eventCursor: event.eventId }; if (event.type === "message.created" || event.type === "message.updated") return { ...current, messages: upsert(current.messages, event.message), eventCursor: event.eventId }; if (event.type === "council.updated") return { ...current, councils: upsert(current.councils, event.council), eventCursor: event.eventId }; return { ...current, eventCursor: event.eventId }; }); });
    return () => events.close();
  }, [presentation, roomId]);
  useEffect(() => {
    if (!guided || guidedStarted.current) return;
    guidedStarted.current = true;
    let cancelled = false;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const stream = async (id: string, senderId: string, content: string, pause: number) => {
      await wait(pause); if (cancelled) return;
      const sender = guidedInitialState.agents.find((agent) => agent.id === senderId); if (!sender) return;
      const now = new Date().toISOString();
      const message: ChatMessage = { id, roomId: guidedInitialState.room.id, senderId, senderName: sender.name, senderRuntime: sender.runtime, content: "", status: "streaming", replyTo: null, metadata: {}, createdAt: now, updatedAt: now };
      setState((current) => ({ ...current, agents: current.agents.map((agent) => agent.id === senderId ? { ...agent, status: "thinking" } : agent), messages: [...current.messages, message] }));
      const chunks = content.match(/.{1,18}(?:\s|$)/g) ?? [content];
      for (const chunk of chunks) { await wait(24 + Math.random() * 24); if (cancelled) return; setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === id ? { ...item, content: item.content + chunk, updatedAt: new Date().toISOString() } : item) })); }
      setState((current) => ({ ...current, agents: current.agents.map((agent) => agent.id === senderId ? { ...agent, status: "available" } : agent), messages: current.messages.map((item) => item.id === id ? { ...item, status: "complete" } : item) }));
    };
    void (async () => { for (const turn of guidedTurns) { if (cancelled) break; await stream(turn.id, turn.senderId, turn.content, turn.pause); } })();
    return () => { cancelled = true; guidedStarted.current = false; };
  }, [guided]);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }, [state.messages]);
  useEffect(() => { if (recipientId !== "all" && !runtimeAgents.some((agent) => agent.id === recipientId)) setRecipientId("all"); }, [recipientId, runtimeAgents]);

  async function send(event: FormEvent) {
    event.preventDefault(); const content = draft.trim(); if (!content || !roomId) return;
    const councilCommand = content.match(/^\/council\s+([\s\S]+)/i); if (councilCommand) { await convene(councilCommand[1].trim()); return; }
    setDraft(""); setError(null);
    if (showcase) return;
    const recipients = recipient ? [recipient] : runtimeAgents;
    if (!recipients.length) { setError("Add an available collaborator before sending."); return; }
    if (guided) {
      const now = new Date().toISOString(); const user = state.agents.find((agent) => agent.runtime === "human")!;
      const message: ChatMessage = { id: `guided-user-${Date.now()}`, roomId, senderId: user.id, senderName: user.name, senderRuntime: "human", content, status: "complete", replyTo: null, metadata: { audience: recipient ? "direct" : "room", recipientAgentIds: recipients.map((agent) => agent.id) }, createdAt: now, updatedAt: now };
      setState((current) => ({ ...current, messages: [...current.messages, message] }));
      const opus = recipients.find((agent) => agent.runtime === "claude-code" && agent.model === "opus");
      if (opus) {
        const replyId = `guided-opus-${Date.now()}`;
        setTimeout(() => {
          setState((current) => ({ ...current, agents: current.agents.map((agent) => agent.id === opus.id ? { ...agent, status: "thinking" } : agent), messages: [...current.messages, { id: replyId, roomId, senderId: opus.id, senderName: opus.name, senderRuntime: opus.runtime, content: "", status: "streaming", replyTo: message.id, metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
          const chunks = guidedOpusResponse.match(/.{1,18}(?:\s|$)/g) ?? [guidedOpusResponse]; let index = 0;
          const timer = setInterval(() => { const chunk = chunks[index++]; if (!chunk) { clearInterval(timer); setState((current) => ({ ...current, agents: current.agents.map((agent) => agent.id === opus.id ? { ...agent, status: "available" } : agent), messages: current.messages.map((item) => item.id === replyId ? { ...item, status: "complete" } : item) })); return; } setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === replyId ? { ...item, content: item.content + chunk, updatedAt: new Date().toISOString() } : item) })); }, 34);
        }, 900);
      }
      return;
    }
    try { const response = await fetch(`/api/rooms/${roomId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ senderId: state.agents.find((agent) => agent.runtime === "human")?.id ?? "riley", content, audience: recipient ? "direct" : "room", recipientAgentIds: recipients.map((agent) => agent.id), discussion: recipients.length > 1 && /\b(brainstorm|discuss|talk|rounds?|turns?)\b/i.test(content) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); if (data.dispatchErrors?.length) throw new Error(data.dispatchErrors.map((item: any) => item.error).join(" · ")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  // A council puts one question to every available collaborator: blind answers, a blind ranking, cross-examination, minutes.
  async function convene(question: string) {
    if (!question || !roomId || showcase) return; setError(null);
    if (runtimeAgents.length < 2) { setError("A council needs at least two available collaborators."); return; }
    setDraft("");
    try { const response = await fetch(`/api/rooms/${roomId}/councils`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, senderId: humanId, agentIds: runtimeAgents.map((agent) => agent.id) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); }
    catch (caught) { setDraft(question); setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  function renderMessages() {
    const rankingShown = new Set<string>();
    return state.messages.map((message) => {
      const council = typeof message.metadata.councilId === "string" ? councilById.get(message.metadata.councilId) : undefined;
      const role = message.metadata.councilRole;
      const time = timeLabel(message.createdAt);
      if (council && role === "question") return <CouncilOpening key={message.id} message={message} council={council} agents={state.agents} time={time} />;
      if (council && role === "ranking") {
        if (rankingShown.has(council.id)) return null;
        rankingShown.add(council.id);
        return <RankingBlock key={message.id} council={council} ballots={state.messages.filter((item) => item.metadata.councilId === council.id && item.metadata.councilRole === "ranking")} agents={state.agents} />;
      }
      if (role === "minutes") return <Minutes key={message.id} message={message} council={council} agents={state.agents} room={state.room} time={time} />;
      const sealed = role === "blind" && message.metadata.sealed === true && council?.phase === "blind" && message.status !== "error";
      const badge = role === "blind" ? "Blind answer" : role === "response" ? "Cross-examination" : undefined;
      const position = role === "response" ? council?.results.positions?.[message.senderId] : undefined;
      return <Message key={message.id} message={message} agents={state.agents} badge={badge} sealed={sealed} position={position} />;
    });
  }

  async function renameRoom() { const name = window.prompt("Room name", state.room.name)?.trim(); if (!name) return; const response = await fetch(`/api/rooms/${roomId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); if (response.ok) { const room = await response.json(); setRooms((items) => upsert(items, room)); setState((current) => ({ ...current, room })); } }
  async function archiveRoom() { await fetch(`/api/rooms/${roomId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archivedAt: new Date().toISOString() }) }); const next = rooms.filter((room) => room.id !== roomId); setRooms(next); if (next[0]) selectRoom(next[0].id); else await createNewRoom(); }

  return (
    <div className={`app-shell ${showcase ? "showcase-mode" : ""} ${participantsExpanded ? "dock-expanded" : "dock-collapsed"}`}>
      <header className="topbar" aria-label="Room controls">
        <div className="wordmark"><span className="wordmark-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 5v14M12 3v18M19 5v14M3 9h18M3 15h18" /></svg></span><span>Polychat</span></div>
        <div className="room-switcher">
          <button className="room-trigger" onClick={() => setRoomMenuOpen((open) => !open)} aria-expanded={roomMenuOpen}><span>{state.room.name}</span><i>⌄</i></button>
          <span className={`connection ${connection}`}><i />{connection}</span>
          {roomMenuOpen && <div className="room-menu">
            <div className="room-menu-head"><span>Saved rooms</span><button onClick={() => void createNewRoom()} aria-label="Create room">+</button></div>
            <div className="room-menu-list">{rooms.map((room) => <button key={room.id} className={room.id === roomId ? "selected" : ""} onClick={() => selectRoom(room.id)}><span><strong>{room.name}</strong><small>{room.projectCwd ? shortPath(room.projectCwd) : "Local council"}</small></span><i>{room.meetingStatus === "live" ? "LIVE" : ""}</i></button>)}</div>
            <div className="room-menu-actions"><button onClick={() => void renameRoom()}>Rename</button><button onClick={() => void archiveRoom()}>Archive</button></div>
          </div>}
        </div>
        <button className="quiet-button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-label={settingsOpen ? "Close context" : "Room context"}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></svg><span>{settingsOpen ? "Close context" : "Room context"}</span></button>
      </header>

      <div className={`workspace ${settingsOpen ? "with-context" : ""} ${participantsExpanded ? "participants-expanded" : "participants-collapsed"}`}>
        <aside className="participants" aria-label="Participants">
          <div className="section-label">Collaborators <span className="participant-count">{state.agents.length}</span></div>
          <div className="participant-list">{state.agents.map((agent) => <button key={agent.id} className={`participant ${inspectedAgent?.id === agent.id ? "selected" : ""} ${agent.status === "away" ? "away" : ""}`} onClick={() => { if (agent.runtime !== "human") { setInspectedAgentId(agent.id); setSettingsOpen(true); } }} disabled={agent.runtime === "human"} aria-label={`${agent.name}, ${modelLabel(agent)}, ${agent.status}`}>
            <span className={`avatar ${agent.runtime}`}><AgentMark runtime={agent.runtime} fallback={agent.name} /></span>
            <span className="participant-copy"><strong>{agent.name}</strong><small>{modelLabel(agent)}</small></span><span className={`presence ${agent.status}`} title={agent.status} />
          </button>)}</div>
          <button className="add-collaborator-button" onClick={() => !showcase && setAddOpen(true)} aria-label="Add collaborator" aria-disabled={showcase}><span>+</span><strong>Add collaborator</strong></button>
          <button className="participants-toggle" onClick={() => setParticipantsExpanded((expanded) => !expanded)} aria-expanded={participantsExpanded} aria-label={participantsExpanded ? "Collapse participant dock" : "Expand participant dock"}><span>{participantsExpanded ? "‹" : "›"}</span><strong>{participantsExpanded ? "Collapse" : "Expand"}</strong></button>
          <div className="room-principle"><span className="section-label">Room principle</span><p>Shared words, distinct minds. Each participant keeps their own memory, tools, and context.</p></div>
        </aside>

        <main className="conversation">
          <div className="room-status-line"><span className={`meeting-state ${sessionCouncil ? "live" : state.room.meetingStatus}`}>{sessionCouncil ? `Council · ${phaseLabel(sessionCouncil)}` : state.room.meetingStatus === "live" ? "Meeting live" : state.room.meetingStatus === "complete" ? "Meeting complete" : state.room.meetingStatus === "cancelled" ? "Meeting stopped" : "Room ready"}</span><span>{state.room.projectCwd ? shortPath(state.room.projectCwd) : "No shared project binding"}</span></div>
          <div className="transcript" ref={transcriptRef}>{state.messages.length ? renderMessages() : <EmptyRoom hasCollaborators={runtimeAgents.length > 0} onAdd={() => setAddOpen(true)} />}</div>
          <div className="composer-wrap">{error && <div className="composer-error" role="alert">{error}</div>}<form className="composer" onSubmit={send}>
            <div className="composer-input-row">
              <button className="composer-add" type="button" aria-label="Add collaborator" onClick={() => !showcase && setAddOpen(true)} disabled={showcase}>+</button>
              <textarea ref={composerRef} aria-label={recipient ? `Message ${recipient.name}` : "Message the room"} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={sessionCouncil ? "Council in session. Type stop to end it." : recipient ? `Message ${recipient.name}…` : "Message the room…"} rows={1} />
              <button className="send-button" aria-label="Send message" disabled={!draft.trim() || !runtimeAgents.length || showcase}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6" /></svg></button>
            </div>
            <div className="composer-toolbar">
            <div className="recipient-control"><button className="recipient-trigger" type="button" onClick={() => setRecipientMenuOpen((open) => !open)} aria-expanded={recipientMenuOpen}><RecipientMark agents={runtimeAgents} recipient={recipient} /><span><strong>{recipient?.name ?? "Everyone"}</strong></span><i>⌄</i></button>
              {recipientMenuOpen && <div className="recipient-menu"><button className={recipientId === "all" ? "selected" : ""} onClick={() => { setRecipientId("all"); setRecipientMenuOpen(false); }} type="button"><RecipientMark agents={runtimeAgents} /><span><strong>Everyone</strong><small>Invite the whole room</small></span></button>{runtimeAgents.map((agent) => <button key={agent.id} className={recipientId === agent.id ? "selected" : ""} onClick={() => { setRecipientId(agent.id); setRecipientMenuOpen(false); }} type="button"><RecipientMark agents={runtimeAgents} recipient={agent} /><span><strong>{agent.name}</strong><small>{modelLabel(agent)}</small></span></button>)}</div>}
            </div>
              <span className="composer-audience-status">{recipient ? `Only ${recipient.name} responds` : `${runtimeAgents.length} available`}</span>
              <button type="button" className="council-trigger" onClick={() => void convene(draft.trim())} disabled={!draft.trim() || runtimeAgents.length < 2 || Boolean(sessionCouncil) || showcase} title="Put this to everyone as a council: blind answers, a blind ranking, cross-examination, and minutes."><CouncilGlyph /><span>Council</span></button>
              <span className="composer-key-hint">↵ to send <span>· Shift ↵ for a new line</span></span>
            </div>
          </form></div>
        </main>

        {settingsOpen && <aside className="context-panel"><button className="context-handle" onClick={() => setSettingsOpen(false)} aria-label="Close room context">›</button><div className="context-heading"><span className="section-label">{inspectedAgent ? `What ${inspectedAgent.name} brings` : "Participant context"}</span><button onClick={() => setSettingsOpen(false)} aria-label="Close room context">×</button></div>{inspectedAgent ? <><div className="context-agent"><span className={`avatar ${inspectedAgent.runtime}`}><AgentMark runtime={inspectedAgent.runtime} fallback={inspectedAgent.name} /></span><div><strong>{inspectedAgent.name}</strong><small>{modelLabel(inspectedAgent)}{inspectedAgent.status === "away" ? " · away" : inspectedAgent.status === "thinking" ? " · replying" : ""}</small></div></div><MindCard roomId={roomId} agent={inspectedAgent} messages={state.messages} live={!presentation} /><button className="context-primary" onClick={() => setContextPickerOpen(true)}>Choose context</button><button className="context-danger" onClick={async () => { await fetch(`/api/rooms/${roomId}/participants/${inspectedAgent.id}`, { method: "DELETE" }); setSettingsOpen(false); }}>Remove from room</button></> : <div className="context-empty">Select a collaborator to inspect their working context.</div>}</aside>}
      </div>
      {!showcase && addOpen && <AddCollaborator roomId={roomId} defaultCwd={state.room.projectCwd ?? ""} onClose={() => setAddOpen(false)} guided={guided} onCreated={(agent) => { setState((current) => ({ ...current, agents: upsert(current.agents, agent) })); setInspectedAgentId(agent.id); if (agent.model === "opus" && agent.sessionId) setRecipientId(agent.id); }} />}
      {!showcase && contextPickerOpen && inspectedAgent && <ContextPicker roomId={roomId} agent={inspectedAgent} onClose={() => setContextPickerOpen(false)} guided={guided} onSelected={(agent) => setState((current) => ({ ...current, agents: upsert(current.agents, agent) }))} />}
    </div>
  );
}

function Message({ message, agents, badge, sealed, position }: { message: ChatMessage; agents: Agent[]; badge?: string; sealed?: boolean; position?: string }) {
  const recipientIds = Array.isArray(message.metadata.recipientAgentIds) ? message.metadata.recipientAgentIds.filter((id): id is string => typeof id === "string") : [];
  const recipientNames = recipientIds.map((id) => agents.find((agent) => agent.id === id)?.name).filter(Boolean);
  const audience = recipientNames.length > 1 ? "Everyone" : recipientNames[0];
  return <article className={`message ${message.senderRuntime} ${message.status}${sealed ? " sealed" : ""}`}><div className={`avatar ${message.senderRuntime}`}><AgentMark runtime={message.senderRuntime} fallback={message.senderName} /></div><div className="message-body"><header><strong>{message.senderName}</strong><span>{message.senderRuntime === "human" ? "You" : runtimeLabel[message.senderRuntime]}</span>{badge && <span className="council-badge">{badge}</span>}{position && <span className="position-chip">{position.charAt(0) + position.slice(1).toLowerCase()}</span>}{audience && !badge && <span className="message-audience">{audience}</span>}<time>{timeLabel(message.createdAt)}</time></header><div className={`message-content${badge && message.content && !sealed ? " rendered" : ""}`}>{sealed ? <span className="sealed-answer"><i aria-hidden="true" />{message.status === "streaming" ? "Answering privately" : "Sealed until everyone has answered"}</span> : badge && message.content ? <MarkdownLite text={message.content} /> : message.content || <span className="thinking-copy">Thinking<span>…</span></span>}</div></div></article>;
}
function EmptyRoom({ hasCollaborators, onAdd }: { hasCollaborators: boolean; onAdd: () => void }) { return <div className="empty-room"><div className="empty-mark">P</div><h1>{hasCollaborators ? "The room is listening." : "A room with actual continuity."}</h1><p>{hasCollaborators ? "Send a message to one collaborator or convene everyone for a council." : "Add a real Claude, Codex, Grok, or Kimi collaborator, then speak to one mind or convene the room."}</p>{!hasCollaborators && <button onClick={onAdd}>Add the first collaborator</button>}</div>; }
function RecipientMark({ agents, recipient }: { agents: Agent[]; recipient?: Agent }) { if (recipient) return <span className={`recipient-mark avatar ${recipient.runtime}`}><AgentMark runtime={recipient.runtime} fallback={recipient.name} /></span>; return <span className="recipient-stack">{agents.slice(0, 3).map((agent) => <span key={agent.id} className={`avatar ${agent.runtime}`}><AgentMark runtime={agent.runtime} fallback={agent.name} /></span>)}</span>; }
