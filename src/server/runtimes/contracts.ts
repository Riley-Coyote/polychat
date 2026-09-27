import type { Agent, ModelOption, ProjectContext, RuntimeDescriptor, RuntimeId, RuntimeProbe, SessionContext, StructuredRuntimeError } from "../../shared/types.js";

export type RuntimeEvent =
  | { type: "response.started" }
  | { type: "response.delta"; text: string }
  | { type: "session.bound"; sessionId: string }
  | { type: "runtime.status"; status: string }
  | { type: "response.completed"; text: string; metadata?: Record<string, unknown> }
  | { type: "response.failed"; error: StructuredRuntimeError };

export interface RuntimeInvocationRequest {
  agent: Agent;
  prompt: string;
  timeoutMs: number;
}

export interface RuntimeInvocationResult {
  text: string;
  sessionId: string | null;
  metadata: Record<string, unknown>;
}

export interface RunningInvocation {
  completion: Promise<RuntimeInvocationResult>;
  cancel(reason?: string): Promise<void>;
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly descriptor: RuntimeDescriptor;
  probe(signal?: AbortSignal): Promise<RuntimeProbe>;
  discoverModels(signal?: AbortSignal): Promise<ModelOption[]>;
  searchProjects(query: string, limit?: number): Promise<ProjectContext[]>;
  listSessions(projectId: string, limit?: number): Promise<SessionContext[]>;
  invoke(request: RuntimeInvocationRequest, sink: (event: RuntimeEvent) => void): RunningInvocation;
}

export class PolychatRuntimeError extends Error {
  constructor(readonly detail: StructuredRuntimeError) { super(detail.message); }
}
