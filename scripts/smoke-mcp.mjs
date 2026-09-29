import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const client = new Client({ name: "polychat-release-smoke", version: "1.3.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(process.cwd(), "dist", "polychat-mcp.cjs")],
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const required = [
    "polychat_doctor", "list_runtimes", "list_rooms", "create_room", "open_room", "read_room",
    "search_contexts", "configure_participant", "remove_participant",
    "start_meeting", "send_message", "invoke_participant", "wait_for_events",
    "run_council", "stop_council", "save_minutes_to_project", "end_meeting",
  ];
  const missing = required.filter((name) => !tools.some((tool) => tool.name === name));
  if (missing.length) throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  const doctor = await client.callTool({ name: "polychat_doctor", arguments: {} });
  if (doctor.isError) throw new Error("polychat_doctor returned an MCP error");
  console.log(`MCP smoke passed: ${tools.length} tools; doctor responded.`);
} finally {
  await client.close();
}
