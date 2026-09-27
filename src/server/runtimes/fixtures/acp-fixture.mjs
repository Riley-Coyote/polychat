import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let pendingPermission = null;
let pendingRead = null;
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") { process.stdout.write("not-json\n"); send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }); return; }
  if (message.method === "session/prompt") { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } } } }); send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }); return; }
  if (message.method === "test/permission") { pendingPermission = message.id; send({ jsonrpc: "2.0", id: 991, method: "session/request_permission", params: { options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }] } }); return; }
  if (message.id === 991 && pendingPermission) { send({ jsonrpc: "2.0", id: pendingPermission, result: { outcome: message.result?.outcome } }); pendingPermission = null; }
  if (message.method === "test/read") { pendingRead = message.id; send({ jsonrpc: "2.0", id: 992, method: "fs/read_text_file", params: { path: message.params?.path, limit: 1 } }); return; }
  if (message.id === 992 && pendingRead) { send({ jsonrpc: "2.0", id: pendingRead, result: message.error ? { error: message.error.message } : { content: message.result?.content } }); pendingRead = null; }
});
