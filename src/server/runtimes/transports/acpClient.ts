import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type JsonObject = Record<string, any>;

export class AcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private updateHandler: (params: JsonObject) => void = () => undefined;
  stderr = "";

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => { if (line.trim()) this.receive(line); });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => this.rejectAll(new Error(this.stderr.trim() || `ACP runtime exited with code ${code}`)));
  }

  onUpdate(handler: (params: JsonObject) => void) { this.updateHandler = handler; }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject) { this.write({ jsonrpc: "2.0", method, params }); }

  close() {
    if (this.child.exitCode !== null || this.child.killed) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 5000);
    timer.unref();
  }

  private receive(line: string) {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "session/update") { this.updateHandler(message.params ?? {}); return; }
    if (typeof message.id === "number" && message.method) void this.reverseRequest(message);
  }

  private async reverseRequest(message: JsonObject) {
    try {
      if (message.method === "session/request_permission") {
        const options = Array.isArray(message.params?.options) ? message.params.options : [];
        const rejected = options.find((option: JsonObject) => String(option.kind).startsWith("reject"));
        const result = rejected ? { outcome: { outcome: "selected", optionId: rejected.optionId } } : { outcome: { outcome: "cancelled" } };
        this.write({ jsonrpc: "2.0", id: message.id, result }); return;
      }
      if (message.method === "fs/read_text_file") {
        const path = String(message.params?.path ?? "");
        const text = readFileSync(path, "utf8");
        const line = Math.max(1, Number(message.params?.line ?? 1)); const limit = Math.max(1, Number(message.params?.limit ?? Number.MAX_SAFE_INTEGER));
        const content = text.split("\n").slice(line - 1, line - 1 + limit).join("\n");
        this.write({ jsonrpc: "2.0", id: message.id, result: { content } }); return;
      }
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Polychat read-only client does not implement ${message.method}.` } });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private write(message: JsonObject) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  private rejectAll(error: Error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
}
