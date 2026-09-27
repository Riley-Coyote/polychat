import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeErrorCode, RuntimeId } from "../../../shared/types.js";
import { PolychatRuntimeError, type RunningInvocation, type RuntimeEvent, type RuntimeInvocationResult } from "../contracts.js";
import { terminate } from "../transports/process.js";

export function runtimeError(runtime: RuntimeId, code: RuntimeErrorCode, message: string, retryable = false, action?: string) {
  return new PolychatRuntimeError({ code, runtime, message, retryable, ...(action ? { action } : {}) });
}

export function supervise(
  runtime: RuntimeId,
  child: ChildProcessWithoutNullStreams,
  completion: Promise<RuntimeInvocationResult>,
  sink: (event: RuntimeEvent) => void,
  timeoutMs: number,
  gracefulCancel?: () => void | Promise<void>,
): RunningInvocation {
  let cancelled = false;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, timeoutMs);
  deadline.unref();
  const guarded = completion.catch((error) => {
    if (timedOut) throw runtimeError(runtime, "invocation_timeout", `The ${runtime} turn exceeded ${Math.ceil(timeoutMs / 1000)} seconds.`, true);
    if (error instanceof PolychatRuntimeError) throw error;
    throw runtimeError(runtime, cancelled ? "invocation_cancelled" : "process_failed", error instanceof Error ? error.message : String(error), !cancelled);
  }).finally(() => clearTimeout(deadline));
  return {
    completion: guarded,
    async cancel(reason = "Invocation cancelled.") {
      cancelled = true;
      try { await gracefulCancel?.(); } catch { /* Process termination remains the cleanup boundary. */ }
      terminate(child);
      sink({ type: "runtime.status", status: reason });
    },
  };
}

export function parseJsonLines(onEvent: (event: Record<string, any>) => void) {
  let buffer = "";
  return {
    push(chunk: Buffer | string) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onEvent(JSON.parse(line) as Record<string, any>); } catch { /* Vendor output may contain non-event lines. */ }
      }
    },
    flush() {
      if (!buffer.trim()) return;
      try { onEvent(JSON.parse(buffer) as Record<string, any>); } catch { /* Ignore incomplete final output. */ }
      buffer = "";
    },
  };
}
