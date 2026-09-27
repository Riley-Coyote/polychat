import { existsSync } from "node:fs";

export function seatbeltAvailable() { return existsSync("/usr/bin/sandbox-exec"); }

function quote(value: string) { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }

export function readOnlyProjectProfile(projectCwd: string) {
  return `(version 1)\n(allow default)\n(deny file-write* (subpath "${quote(projectCwd)}"))`;
}

export function sandboxedCommand(executable: string, projectCwd: string) {
  return { command: "/usr/bin/sandbox-exec", args: ["-p", readOnlyProjectProfile(projectCwd), executable, "acp"] };
}
