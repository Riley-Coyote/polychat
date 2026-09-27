import type { Agent, ChatMessage, RoomState } from "../shared/types";

const createdAt = "2026-08-12T15:38:00.000Z";
const projectCwd = "/Users/riley/Documents/polyphonic";

const agents: Agent[] = [
  { id: "showcase-riley", name: "Riley", runtime: "human", model: null, cwd: projectCwd, sessionId: null, status: "available", createdAt, updatedAt: createdAt },
  { id: "showcase-codex", name: "GPT Sol", runtime: "codex", model: "gpt-5.6-sol", cwd: projectCwd, sessionId: "codex-mnemos-council", status: "available", createdAt, updatedAt: createdAt },
  { id: "showcase-claude", name: "Opus", runtime: "claude-code", model: "opus", cwd: projectCwd, sessionId: "claude-mnemos-council", status: "available", createdAt, updatedAt: createdAt },
  { id: "showcase-kimi", name: "Kimi", runtime: "kimi-code", model: "kimi-k2.5", cwd: projectCwd, sessionId: "kimi-mnemos-council", status: "available", createdAt, updatedAt: createdAt },
  { id: "showcase-grok", name: "Grok", runtime: "grok", model: "grok-code-fast-1", cwd: projectCwd, sessionId: "grok-mnemos-council", status: "available", createdAt, updatedAt: createdAt },
];

const entries: Array<{ id: string; senderName: string; senderRuntime: Agent["runtime"]; content: string; timestamp: string; recipients?: string[] }> = [
  { id: "showcase-message-1", senderName: "Riley", senderRuntime: "human", content: "Polyphonic’s first response still feels slow in long rooms. I want the UI streaming immediately without weakening continuity. Where’s the bottleneck?", timestamp: "2026-08-12T15:38:00.000Z", recipients: ["showcase-codex", "showcase-claude", "showcase-kimi", "showcase-grok"] },
  { id: "showcase-message-2", senderName: "GPT Sol", senderRuntime: "codex", content: "The trace points to context assembly, not generation. We rebuild and rank the full room history before opening the stream; the model is idle for roughly 1.4 seconds.", timestamp: "2026-08-12T15:39:00.000Z" },
  { id: "showcase-message-3", senderName: "Riley", senderRuntime: "human", content: "Kimi—can we cache that safely without serving stale context after another agent writes to the room?", timestamp: "2026-08-12T15:40:00.000Z", recipients: ["showcase-kimi"] },
  { id: "showcase-message-4", senderName: "Kimi", senderRuntime: "kimi-code", content: "Yes. Cache the immutable history prefix by event cursor, then append only the live tail. A new message invalidates the tail, not the expensive ranked prefix.", timestamp: "2026-08-12T15:41:00.000Z" },
  { id: "showcase-message-5", senderName: "Opus", senderRuntime: "claude-code", content: "I’d also separate perceived latency from total latency. Render the user turn and participant thinking state immediately; assemble context concurrently, then connect the native stream once ready.", timestamp: "2026-08-12T15:42:00.000Z" },
  { id: "showcase-message-6", senderName: "Riley", senderRuntime: "human", content: "Grok, pressure-test that. What breaks when Codex and Claude finish close together?", timestamp: "2026-08-12T15:43:00.000Z", recipients: ["showcase-grok"] },
  { id: "showcase-message-7", senderName: "Grok", senderRuntime: "grok", content: "Cursor races. If two completions share a stale prefix key, the second can miss the first. Key every snapshot to the committed room cursor and reject promotion unless it still matches head.", timestamp: "2026-08-12T15:44:00.000Z" },
];

const messages: ChatMessage[] = entries.map(({ id, senderName, senderRuntime, content, timestamp, recipients }) => ({
  id,
  roomId: "showcase-mnemos",
  senderId: agents.find((agent) => agent.runtime === senderRuntime)?.id ?? "showcase-riley",
  senderName,
  senderRuntime,
  content,
  status: "complete",
  replyTo: null,
  metadata: { showcase: true, audience: recipients ? (recipients.length === 1 ? "direct" : "room") : undefined, recipientAgentIds: recipients },
  createdAt: timestamp,
  updatedAt: timestamp,
}));

export const showcaseState: RoomState = {
  room: {
    id: "showcase-mnemos",
    name: "Polyphonic performance council",
    projectCwd,
    meetingStatus: "live",
    hostAgentId: "showcase-riley",
    hostExpiresAt: null,
    archivedAt: null,
    createdAt,
    updatedAt: "2026-08-12T15:45:00.000Z",
  },
  agents,
  messages,
  councils: [], eventCursor: 7,
};
