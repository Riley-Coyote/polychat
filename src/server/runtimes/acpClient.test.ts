import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { AcpClient } from "./transports/acpClient.js";

test("ACP client correlates requests, tolerates malformed lines, streams chunks, and denies permissions", async () => {
  const client = new AcpClient(process.execPath, [join(process.cwd(), "src/server/runtimes/fixtures/acp-fixture.mjs")], process.cwd());
  let streamed = ""; client.onUpdate((params) => { streamed += params.update?.content?.text ?? ""; });
  try {
    const initialized = await client.request("initialize", {}); assert.equal(initialized.protocolVersion, 1);
    const permission = await client.request("test/permission", {}); assert.deepEqual(permission.outcome, { outcome: "selected", optionId: "reject-once" });
    const prompt = await client.request("session/prompt", {}); assert.equal(prompt.stopReason, "end_turn"); assert.equal(streamed, "fixture response");
  } finally { client.close(); }
});
