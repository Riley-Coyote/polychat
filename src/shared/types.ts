export type Runtime = "human" | "claude-code" | "codex";
export type MessageStatus = "complete" | "streaming" | "error";
export type ParticipantStatus = "available" | "thinking" | "offline" | "away";
export type MeetingStatus = "idle" | "live" | "complete" | "cancelled";

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

export interface RoomState {
  room: Room;
  agents: Agent[];
  messages: ChatMessage[];
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
  | { type: "agent.removed"; agentId: string };

export type RoomEvent = RoomEventPayload & { eventId: number; roomId: string };
