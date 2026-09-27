import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { ModelOption, RuntimeDescriptor } from "../../../shared/types.js";
import { listGrokProjects, listGrokSessions } from "../../grokContexts.js";
import type { RuntimeAdapter, RuntimeInvocationResult } from "../contracts.js";
import { basicProbe, findExecutable, spawnRuntime } from "../transports/process.js";
import { appendSegment, parseJsonLines, runtimeError, supervise } from "./helpers.js";

const presets: ModelOption[] = [
  { id: "current", label: "Configured default", name: "Configured default", detail: "Use Grok Build's configured model" },
  { id: "grok-code-fast-1", label: "Grok Code Fast", name: "Grok Code Fast", detail: "Fast coding-focused Grok model" },
];
const descriptor: RuntimeDescriptor = {
  id: "grok", displayName: "Grok Build", lab: "xAI", minimumVersion: "0.2.114",
  setupCommand: "curl -fsSL https://grok.com/install.sh | sh", loginCommand: "grok login", updateCommand: "grok update",
  capabilities: { exactResume: true, modelDiscovery: true, arbitraryModels: true, projectDiscovery: true, transport: "jsonl", safety: "Grok plan mode and read-only sandbox" }, presets,
};

function discoveredModels(executable: string): ModelOption[] {
  try {
    const output = execFileSync(executable, ["models"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    const found = output.split("\n").map((line) => line.match(/(?:^\s*[*›>\-]\s*|Default model:\s*)([a-z0-9][a-z0-9._/-]+)/i)?.[1]).filter((id): id is string => Boolean(id));
    return [...new Set(found)].map((id) => ({ id, label: id, name: id, detail: "Discovered from Grok Build" }));
  } catch { return []; }
}

export function eventText(event: Record<string, any>) {
  // Grok Build 1.0 streams the reply as {type: "text", data} pieces, and its reasoning as "thought" events, which stay hidden.
  if (event.type === "text" && typeof event.data === "string") return { mode: "delta" as const, text: event.data };
  if (typeof event.delta?.text === "string") return { mode: "delta" as const, text: event.delta.text };
  if (event.type === "content_block_delta" && typeof event.delta?.text === "string") return { mode: "delta" as const, text: event.delta.text };
  const content = event.message?.content ?? event.content;
  if (typeof content === "string") return { mode: "snapshot" as const, text: content };
  if (Array.isArray(content)) {
    const text = content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("");
    if (text) return { mode: "snapshot" as const, text };
  }
  if ((event.type === "result" || event.type === "assistant") && typeof event.result === "string") return { mode: "snapshot" as const, text: event.result };
  return null;
}

function grokFailure(stderr: string, code: number | null) {
  const clean = stderr.replace(/\u001b\[[0-9;]*m/g, "");
  if (/usage balance exhausted|402 Payment Required/i.test(clean)) return runtimeError("grok", "process_failed", "Grok Build usage balance is exhausted. Add usage in your xAI account, then retry.", false);
  if (/not authenticated|token expired|re-authentication required/i.test(clean)) return runtimeError("grok", "runtime_unauthenticated", "Grok Build needs a fresh sign-in.", false, descriptor.loginCommand);
  const internal = [...clean.matchAll(/Internal error:\s*\{[\s\S]*?"message":\s*"([^"]+)"/g)].at(-1)?.[1];
  return runtimeError("grok", code === null ? "invocation_cancelled" : "process_failed", internal ?? clean.trim().split("\n").filter(Boolean).at(-1) ?? `Grok Build exited with code ${code}.`, code !== null);
}

export const grokAdapter: RuntimeAdapter = {
  id: "grok", descriptor,
  async probe() { const executable = findExecutable("grok", "grok"); const authReady = () => { if (!executable || !existsSync(join(homedir(), ".grok", "auth.json"))) return false; const result = spawnSync(executable, ["models"], { encoding: "utf8", timeout: 15_000 }); return result.status === 0 && !/not authenticated|token expired|re-authentication required/i.test(`${result.stdout}\n${result.stderr}`); }; return basicProbe({ runtime: "grok", command: "grok", minimum: descriptor.minimumVersion, authReady, login: descriptor.loginCommand, update: descriptor.updateCommand }); },
  async discoverModels() { const executable = findExecutable("grok", "grok"); return executable ? [...presets, ...discoveredModels(executable).filter((option) => !presets.some((preset) => preset.id === option.id))] : presets; },
  async searchProjects(query, limit = 80) { return listGrokProjects(query).slice(0, limit); },
  async listSessions(projectId, limit = 40) { return listGrokSessions(projectId, limit); },
  invoke({ agent, prompt, timeoutMs }, sink) {
    const executable = findExecutable("grok", "grok"); if (!executable) throw runtimeError("grok", "runtime_missing", "Grok Build is not installed.", false, descriptor.setupCommand);
    const sessionId = agent.sessionId ?? randomUUID();
    const args = ["--output-format", "streaming-json", "--permission-mode", "plan", "--sandbox", "read-only", "--disable-web-search", "--no-subagents", "--deny", "Edit", "--deny", "Bash", "--deny", "MCPTool", "--deny", "WebFetch", "--deny", "WebSearch", "--cwd", agent.cwd ?? process.cwd()];
    if (agent.model && agent.model !== "current") args.push("--model", agent.model);
    if (agent.sessionId) args.push("--resume", agent.sessionId); else args.push("--session-id", sessionId);
    args.push("-p", prompt);
    const child = spawnRuntime(executable, args, agent.cwd ?? process.cwd()); child.stdin.end(); sink({ type: "response.started" }); if (!agent.sessionId) sink({ type: "session.bound", sessionId });
    let stderr = ""; let text = ""; let newSegment = false;
    const parser = parseJsonLines((event) => { if (event.type === "tool_call") { newSegment = true; return; } const next = eventText(event); if (!next || !next.text) return; text = next.mode === "delta" ? appendSegment(text, next.text, newSegment) : next.text; newSegment = false; sink({ type: "response.delta", text }); });
    child.stdout.on("data", (chunk: Buffer) => parser.push(chunk)); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    const completion = new Promise<RuntimeInvocationResult>((resolve, reject) => { child.on("error", reject); child.on("close", (code) => { parser.flush(); if (code === 0 && text) resolve({ text, sessionId, metadata: { runtime: "grok", model: agent.model, sessionId, safety: "read-only" } }); else reject(grokFailure(stderr, code)); }); });
    return supervise("grok", child, completion, sink, timeoutMs);
  },
};
