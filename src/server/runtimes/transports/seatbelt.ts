import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function seatbeltAvailable() { return existsSync("/usr/bin/sandbox-exec"); }

function quote(value: string) { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
function real(path: string) { try { return realpathSync(path); } catch { return path; } }

// Kimi may write only to its own state and to scratch space. The project, and everything else in the
// home folder, is read-only for the turn. Seatbelt matches resolved paths, so every path is resolved.
export function readOnlyProfile(home = homedir()) {
  const writable = [...new Set([join(home, ".kimi-code"), join(home, ".kimi"), "/private/tmp", "/private/var/folders", tmpdir()].map(real))];
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* ${writable.map((path) => `(subpath "${quote(path)}")`).join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))`;
}

export function sandboxedCommand(executable: string) {
  return { command: "/usr/bin/sandbox-exec", args: ["-p", readOnlyProfile(), executable, "acp"] };
}
