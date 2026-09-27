import { execFileSync } from "node:child_process";
import type { ModelOption, RuntimeDescriptor } from "../../../shared/types.js";
import { listCodexProjects, listCodexSessions } from "../../codexContexts.js";
import type { RuntimeAdapter, RuntimeInvocationResult } from "../contracts.js";
import { basicProbe, findExecutable, spawnRuntime } from "../transports/process.js";
import { parseJsonLines, runtimeError, supervise } from "./helpers.js";

const presets: ModelOption[] = [
  { id: "current", label: "Configured default", name: "Configured default", detail: "Use Codex's current model" },
  { id: "gpt-5.6-sol", label: "GPT Sol", name: "GPT Sol", detail: "Frontier agentic coding model" },
  { id: "gpt-5.6-terra", label: "GPT Terra", name: "GPT Terra", detail: "Balanced agentic coding model" },
];
const descriptor: RuntimeDescriptor = {
  id: "codex", displayName: "Codex", lab: "OpenAI", minimumVersion: null,
  setupCommand: "brew install --cask codex", loginCommand: "codex login", updateCommand: "brew upgrade --cask codex",
  capabilities: { exactResume: true, modelDiscovery: false, arbitraryModels: true, projectDiscovery: true, transport: "jsonl", safety: "Codex read-only sandbox" }, presets,
};

function authenticated(executable: string | null) { if (!executable) return false; try { execFileSync(executable, ["login", "status"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; } }

export const codexAdapter: RuntimeAdapter = {
  id: "codex", descriptor,
  async probe() { const executable = findExecutable("codex", "codex"); return basicProbe({ runtime: "codex", command: "codex", minimum: null, authReady: () => authenticated(executable), login: descriptor.loginCommand, update: descriptor.updateCommand }); },
  async discoverModels() { return presets; },
  async searchProjects(query, limit = 80) { return listCodexProjects(query).slice(0, limit); },
  async listSessions(projectId, limit = 40) { return listCodexSessions(projectId, limit); },
  invoke({ agent, prompt, timeoutMs }, sink) {
    const executable = findExecutable("codex", "codex"); if (!executable) throw runtimeError("codex", "runtime_missing", "Codex is not installed.", false, descriptor.setupCommand);
    const modelArgs = agent.model && agent.model !== "current" ? ["--model", agent.model] : [];
    // Codex refuses folders outside a Git repository unless told otherwise, to protect changes it can't
    // undo. Polychat runs it read-only, so any project folder is safe to use.
    const args = agent.sessionId ? ["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', ...modelArgs, agent.sessionId, prompt] : ["exec", "--json", "--skip-git-repo-check", ...modelArgs, "-s", "read-only", prompt];
    const child = spawnRuntime(executable, args, agent.cwd ?? process.cwd()); child.stdin.end(); sink({ type: "response.started" });
    let stderr = ""; let text = ""; let sessionId = agent.sessionId;
    const parser = parseJsonLines((event) => { if (event.type === "thread.started" && typeof event.thread_id === "string") { sessionId = event.thread_id; sink({ type: "session.bound", sessionId }); } if (event.type === "item.completed" && event.item?.type === "agent_message") { text = String(event.item.text ?? text); sink({ type: "response.delta", text }); } });
    child.stdout.on("data", (chunk: Buffer) => parser.push(chunk)); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    const completion = new Promise<RuntimeInvocationResult>((resolve, reject) => { child.on("error", reject); child.on("close", (code) => { parser.flush(); if (code === 0 && text) resolve({ text, sessionId, metadata: { runtime: "codex", model: agent.model, sessionId } }); else reject(runtimeError("codex", code === null ? "invocation_cancelled" : "process_failed", stderr.trim() || `Codex exited with code ${code}.`, code !== null)); }); });
    return supervise("codex", child, completion, sink, timeoutMs);
  },
};
