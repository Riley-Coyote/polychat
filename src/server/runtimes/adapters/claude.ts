import { execFileSync } from "node:child_process";
import type { ModelOption, RuntimeDescriptor } from "../../../shared/types.js";
import { listClaudeProjects, listClaudeSessions } from "../../claudeContexts.js";
import type { RuntimeAdapter, RuntimeInvocationResult } from "../contracts.js";
import { basicProbe, findExecutable, spawnRuntime } from "../transports/process.js";
import { parseJsonLines, runtimeError, supervise } from "./helpers.js";

const presets: ModelOption[] = [
  { id: "opus", label: "Opus", name: "Opus", detail: "Claude Code's most capable configured model" },
  { id: "sonnet", label: "Sonnet", name: "Sonnet", detail: "Fast, balanced Claude Code model" },
  { id: "current", label: "Configured default", name: "Configured default", detail: "Use Claude Code's current model" },
];

const descriptor: RuntimeDescriptor = {
  id: "claude-code", displayName: "Claude Code", lab: "Anthropic", minimumVersion: null,
  setupCommand: "npm install -g @anthropic-ai/claude-code", loginCommand: "claude auth login", updateCommand: "claude update",
  capabilities: { exactResume: true, modelDiscovery: false, arbitraryModels: true, projectDiscovery: true, transport: "jsonl", safety: "Claude plan permission mode" }, presets,
};

function authenticated(executable: string | null) {
  if (!executable) return false;
  try { execFileSync(executable, ["auth", "status", "--json"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
}

export const claudeAdapter: RuntimeAdapter = {
  id: "claude-code", descriptor,
  async probe() { const executable = findExecutable("claude-code", "claude"); return basicProbe({ runtime: "claude-code", command: "claude", minimum: null, authReady: () => authenticated(executable), login: descriptor.loginCommand, update: descriptor.updateCommand }); },
  async discoverModels() { return presets; },
  async searchProjects(query, limit = 80) { return listClaudeProjects(query).slice(0, limit); },
  async listSessions(projectId, limit = 40) { return listClaudeSessions(projectId, limit); },
  invoke({ agent, prompt, timeoutMs }, sink) {
    const executable = findExecutable("claude-code", "claude");
    if (!executable) throw runtimeError("claude-code", "runtime_missing", "Claude Code is not installed.", false, descriptor.setupCommand);
    const sessionId = agent.sessionId ?? crypto.randomUUID();
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "plan"];
    if (agent.model && agent.model !== "current") args.push("--model", agent.model);
    if (agent.sessionId) args.push("--resume", agent.sessionId); else args.push("--session-id", sessionId);
    const child = spawnRuntime(executable, args, agent.cwd ?? process.cwd()); child.stdin.end();
    sink({ type: "response.started" }); if (!agent.sessionId) sink({ type: "session.bound", sessionId });
    let stderr = ""; let text = ""; let resultText = "";
    const parser = parseJsonLines((event) => {
      if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") { text += String(event.event.delta.text ?? ""); sink({ type: "response.delta", text }); }
      if (event.type === "assistant" && !text && Array.isArray(event.message?.content)) { text = event.message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""); if (text) sink({ type: "response.delta", text }); }
      if (event.type === "result" && typeof event.result === "string") resultText = event.result;
    });
    child.stdout.on("data", (chunk: Buffer) => parser.push(chunk)); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    const completion = new Promise<RuntimeInvocationResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => { parser.flush(); const finalText = text || resultText; if (code === 0 && finalText) resolve({ text: finalText, sessionId, metadata: { runtime: "claude-code", sessionId } }); else reject(runtimeError("claude-code", code === null ? "invocation_cancelled" : "process_failed", stderr.trim() || `Claude Code exited with code ${code}.`, code !== null)); });
    });
    return supervise("claude-code", child, completion, sink, timeoutMs);
  },
};
