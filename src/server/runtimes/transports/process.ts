import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { RuntimeId, RuntimeProbe } from "../../../shared/types.js";

const knownPaths: Partial<Record<RuntimeId, string[]>> = {
  grok: [join(homedir(), ".grok", "bin", "grok")],
  "kimi-code": [join(homedir(), ".kimi-code", "bin", "kimi")],
};

export function findExecutable(runtime: RuntimeId, command: string) {
  const candidates = [
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command))),
    ...(knownPaths[runtime] ?? []),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function firstLine(command: string, args: string[], timeout = 5000) {
  try { return execFileSync(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0] || null; }
  catch { return null; }
}

export function versionNumber(value: string | null) {
  return value?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function versionAtLeast(version: string | null, minimum: string | null) {
  if (!minimum) return true;
  if (!version) return false;
  const left = version.split(".").map(Number); const right = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

export function basicProbe(input: { runtime: RuntimeId; command: string; versionArgs?: string[]; minimum: string | null; authReady: () => boolean; login: string; update: string }): RuntimeProbe {
  const executable = findExecutable(input.runtime, input.command);
  if (!executable) return { runtime: input.runtime, status: "missing", installed: false, authenticated: false, supported: false, version: null, executable: null, message: `${input.command} is not installed.`, action: input.update };
  const version = versionNumber(firstLine(executable, input.versionArgs ?? ["--version"]));
  if (!versionAtLeast(version, input.minimum)) return { runtime: input.runtime, status: "unsupported", installed: true, authenticated: input.authReady(), supported: false, version, executable, message: `Version ${version ?? "unknown"} is below the supported minimum ${input.minimum}.`, action: input.update };
  const authenticated = input.authReady();
  if (!authenticated) return { runtime: input.runtime, status: "unauthenticated", installed: true, authenticated: false, supported: true, version, executable, message: "Installed, but no local authentication was found.", action: input.login };
  return { runtime: input.runtime, status: "ready", installed: true, authenticated: true, supported: true, version, executable, message: "Ready", action: null };
}

export function spawnRuntime(command: string, args: string[], cwd: string) {
  return spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
}

export function terminate(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5000);
  timer.unref();
}
