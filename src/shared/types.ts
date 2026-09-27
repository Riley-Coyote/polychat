export type RuntimeId = "claude-code" | "codex" | "grok" | "kimi-code";
export type Runtime = "human" | RuntimeId;
export type MessageStatus = "complete" | "streaming" | "error";
export type ParticipantStatus = "available" | "thinking" | "offline" | "away";
export type MeetingStatus = "idle" | "live" | "complete" | "cancelled";
export type RuntimeProbeStatus = "available" | "missing" | "unsupported" | "unauthenticated" | "ready" | "error";
export type RuntimeErrorCode = "runtime_missing" | "runtime_unsupported" | "runtime_unauthenticated" | "model_unavailable" | "session_not_found" | "session_mismatch" | "permission_denied" | "invocation_busy" | "invocation_timeout" | "invocation_cancelled" | "protocol_error" | "process_failed";

export interface ModelOption {
  id: string;
  label: string;
  detail: string;
  name: string;
}

export interface RuntimeCapabilities {
  exactResume: boolean;
  modelDiscovery: boolean;
  arbitraryModels: boolean;
  projectDiscovery: boolean;
  transport: "jsonl" | "acp";
  safety: string;
}

export interface RuntimeDescriptor {
  id: RuntimeId;
  displayName: string;
  lab: string;
  minimumVersion: string | null;
  setupCommand: string;
  loginCommand: string;
  updateCommand: string;
  capabilities: RuntimeCapabilities;
  presets: ModelOption[];
}

export interface RuntimeProbe {
  runtime: RuntimeId;
  status: RuntimeProbeStatus;
  installed: boolean;
  authenticated: boolean;
  supported: boolean;
  version: string | null;
  executable: string | null;
  message: string;
  action: string | null;
}

export interface RuntimeCatalogEntry {
  descriptor: RuntimeDescriptor;
  probe: RuntimeProbe;
  models: ModelOption[];
}

export interface StructuredRuntimeError {
  code: RuntimeErrorCode;
  runtime: RuntimeId;
  message: string;
  retryable: boolean;
  action?: string;
}

export interface Room {
  id: string;
  name: string;
  projectCwd: string | null;
  meetingStatus: MeetingStatus;
  hostAgentId: string | null;
  hostExpiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  runtime: Runtime;
  model: string | null;
  cwd: string | null;
  sessionId: string | null;
  status: ParticipantStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderRuntime: Runtime;
  content: string;
  status: MessageStatus;
  replyTo: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// A council runs in four phases: blind answers, a blind ranking with authors hidden, a named
// cross-examination, and minutes written by the member the blind ranking placed first.
export type CouncilPhase = "blind" | "ranking" | "responding" | "minutes" | "complete" | "cancelled" | "failed";
export type CouncilMessageRole = "question" | "blind" | "ranking" | "response" | "minutes";
export type CouncilPosition = "HELD" | "SHARPENED" | "CHANGED";

export interface CouncilResults {
  labels?: Record<string, string>;
  ballots?: Record<string, string[]>;
  points?: Record<string, number>;
  order?: string[];
  firstPlaceVotes?: Record<string, string[]>;
  selfPreference?: string[];
  positions?: Record<string, CouncilPosition>;
}

export interface Council {
  id: string;
  roomId: string;
  question: string;
  agentIds: string[];
  phase: CouncilPhase;
  results: CouncilResults;
  chairAgentId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoomState {
  room: Room;
  agents: Agent[];
  messages: ChatMessage[];
  councils: Council[];
  eventCursor: number;
}

export interface InvokeRequest {
  agentId: string;
  prompt: string;
  senderId?: string;
  roomId?: string;
}

export interface ProjectContext {
  id: string;
  runtime: Exclude<Runtime, "human">;
  name: string;
  cwd: string;
  parentPath: string;
  updatedAt: string;
  sessionCount: number;
  hasMemory: boolean;
  exists: boolean;
}

export interface SessionContext {
  id: string;
  title: string;
  preview: string;
  lastPrompt: string;
  branch: string | null;
  createdAt: string | null;
  updatedAt: string;
  size: number;
  isSidechain: boolean;
  source: string | null;
}

export type ClaudeProjectContext = ProjectContext;
export type ClaudeSessionContext = SessionContext;

export type RoomEventPayload =
  | { type: "room.updated"; room: Room }
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.removed"; agentId: string }
  | { type: "council.updated"; council: Council }
  | { type: "runtime.updated"; runtime: RuntimeCatalogEntry };

export type RoomEvent = RoomEventPayload & { eventId: number; roomId: string };
