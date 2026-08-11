import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "plugins", "polychat", "dist");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(root, "dist"), target, { recursive: true });
