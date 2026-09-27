import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption, RuntimeDescriptor } from "../../../shared/types.js";
import { listKimiProjects, listKimiSessions } from "../../kimiContexts.js";
import type { RuntimeAdapter, RuntimeInvocationResult } from "../contracts.js";
import { AcpClient } from "../transports/acpClient.js";
import { basicProbe, findExecutable } from "../transports/process.js";
import { sandboxedCommand, seatbeltAvailable } from "../transports/seatbelt.js";
import { runtimeError, supervise } from "./helpers.js";

const presets: ModelOption[] = [
  { id: "current", label: "Configured default", name: "Configured default", detail: "Use Kimi Code's configured model" },
  { id: "kimi-for-coding", label: "Kimi for Coding", name: "Kimi for Coding", detail: "Kimi's coding model preset" },
];
const descriptor: RuntimeDescriptor = {
  id: "kimi-code", displayName: "Kimi Code", lab: "Moonshot AI", minimumVersion: "0.27.0",
  setupCommand: "curl -L code.kimi.com/install.sh | bash", loginCommand: "kimi login", updateCommand: "kimi upgrade",
  capabilities: { exactResume: true, modelDiscovery: true, arbitraryModels: true, projectDiscovery: true, transport: "acp", safety: "ACP plan mode, denied permissions, and macOS Seatbelt" }, presets,
};

function hasAuth() { const root = join(homedir(), ".kimi-code"); return existsSync(join(root, "credentials", "kimi-code.json")) || existsSync(join(root, "oauth", "kimi-code.json")); }
function configuredModels() {
  const path = join(homedir(), ".kimi-code", "config.toml"); if (!existsSync(path)) return [];
  try { return [...readFileSync(path, "utf8").matchAll(/^\[models\."?([^\]"]+)"?\]/gm)].map((match) => match[1]); } catch { return []; }
}
function chunkText(update: Record<string, any>) {
  const item = update.update ?? update;
  if (item.sessionUpdate !== "agent_message_chunk" && item.type !== "agent_message_chunk") return "";
  const content = item.content;
  if (typeof content === "string") return content;
  if (content?.type === "text" && typeof content.text === "string") return content.text;
  return "";
}
function optionIds(value: any): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(optionIds);
  return [...(typeof value.id === "string" ? [value.id] : []), ...Object.values(value).flatMap(optionIds)];
}

export const kimiAdapter: RuntimeAdapter = {
  id: "kimi-code", descriptor,
  async probe() {
    const base = basicProbe({ runtime: "kimi-code", command: "kimi", minimum: descriptor.minimumVersion, authReady: hasAuth, login: descriptor.loginCommand, update: descriptor.updateCommand });
    if (base.status === "ready" && !seatbeltAvailable()) return { ...base, status: "unsupported", supported: false, message: "macOS Seatbelt is unavailable, so Kimi cannot be safely launched read-only.", action: null };
    return base;
  },
  async discoverModels() { return [...presets, ...configuredModels().filter((id) => !presets.some((preset) => preset.id === id)).map((id) => ({ id, label: id, name: id, detail: "Configured in Kimi Code" }))]; },
  async searchProjects(query, limit = 80) { return listKimiProjects(query).slice(0, limit); },
  async listSessions(projectId, limit = 40) { return listKimiSessions(projectId, limit); },
  invoke({ agent, prompt, timeoutMs }, sink) {
    const executable = findExecutable("kimi-code", "kimi"); if (!executable) throw runtimeError("kimi-code", "runtime_missing", "Kimi Code is not installed.", false, descriptor.setupCommand);
    if (!hasAuth()) throw runtimeError("kimi-code", "runtime_unauthenticated", "Kimi Code is installed but not signed in.", false, descriptor.loginCommand);
    if (!seatbeltAvailable()) throw runtimeError("kimi-code", "runtime_unsupported", "Kimi requires macOS Seatbelt for read-only council turns.");
    const cwd = agent.cwd ?? process.cwd(); const launch = sandboxedCommand(executable, cwd); const client = new AcpClient(launch.command, launch.args, cwd);
    let sessionId = agent.sessionId; let text = ""; let cancelled = false;
    client.onUpdate((update) => { const delta = chunkText(update); if (delta) { text += delta; sink({ type: "response.delta", text }); } });
    const completion = (async (): Promise<RuntimeInvocationResult> => {
      sink({ type: "response.started" });
      const initialized = await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false } });
      await client.request("authenticate", { methodId: "login" });
      let session: any;
      if (sessionId) {
        const canResume = Boolean(initialized.agentCapabilities?.sessionCapabilities?.resume);
        try { session = await client.request(canResume ? "session/resume" : "session/load", { sessionId, cwd, mcpServers: [] }); }
        catch { session = await client.request("session/load", { sessionId, cwd, mcpServers: [] }); }
      } else {
        session = await client.request("session/new", { cwd, mcpServers: [] }); sessionId = session.sessionId;
        if (!sessionId) throw runtimeError("kimi-code", "protocol_error", "Kimi ACP did not return a session ID.");
        sink({ type: "session.bound", sessionId });
      }
      const ids = optionIds(session.configOptions ?? initialized.agentCapabilities?.configOptions).map((id) => id.toLowerCase());
      let planSelected = false;
      if (ids.some((id) => id === "mode" || id.includes("plan"))) {
        try { await client.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" }); planSelected = true; } catch { /* Compatibility method below. */ }
      }
      if (!planSelected) { try { await client.request("session/set_mode", { sessionId, modeId: "plan" }); planSelected = true; } catch { /* Guarded below. */ } }
      if (!planSelected) throw runtimeError("kimi-code", "permission_denied", "Kimi ACP could not enter plan mode; Polychat refused to continue.");
      if (agent.model && agent.model !== "current") { try { await client.request("session/set_config_option", { sessionId, configId: "model", value: agent.model }); } catch (error) { throw runtimeError("kimi-code", "model_unavailable", `Kimi rejected model ${agent.model}: ${error instanceof Error ? error.message : String(error)}`); } }
      await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, timeoutMs);
      if (cancelled) throw runtimeError("kimi-code", "invocation_cancelled", "Kimi invocation was cancelled.");
      if (!text) throw runtimeError("kimi-code", "protocol_error", client.stderr.trim() || "Kimi ACP completed without an agent message. Run kimi doctor, then retry.", true, "kimi doctor");
      return { text, sessionId, metadata: { runtime: "kimi-code", model: agent.model, sessionId, safety: "seatbelt-read-only" } };
    })().finally(() => client.close());
    return supervise("kimi-code", client.child, completion, sink, timeoutMs, async () => { cancelled = true; if (sessionId) client.notify("session/cancel", { sessionId }); });
  },
};
