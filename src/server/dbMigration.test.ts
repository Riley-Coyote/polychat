import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("v1 database migrates once with a backup and preserved records", () => {
  const directory = mkdtempSync(join(tmpdir(), "polychat-migration-")); const path = join(directory, "polychat.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL CHECK(runtime IN ('human','claude-code','codex')), model TEXT, cwd TEXT, session_id TEXT, status TEXT NOT NULL DEFAULT 'available', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO agents VALUES ('legacy-agent','Legacy Codex','codex','current','/tmp',NULL,'available','2026-01-01','2026-01-01');`);
  legacy.close();
  const moduleUrl = `${pathToFileURL(join(process.cwd(), "src/server/db.ts")).href}?migration=${Date.now()}`;
  execFileSync(process.execPath, ["--import", "tsx", "--eval", `await import(${JSON.stringify(moduleUrl)})`], { cwd: process.cwd(), env: { ...process.env, POLYCHAT_DATA_DIR: directory, POLYCHAT_LEGACY_DATA_DIR: directory }, stdio: "pipe" });
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  assert.equal((migrated.prepare("SELECT name FROM agents WHERE id = 'legacy-agent'").get() as { name: string }).name, "Legacy Codex");
  const schema = (migrated.prepare("SELECT sql FROM sqlite_master WHERE name='agents'").get() as { sql: string }).sql;
  assert.match(schema, /'grok'/); assert.match(schema, /'kimi-code'/); migrated.close();
  assert.equal(existsSync(join(directory, "polychat.db.pre-v1.1.bak")), true);
  execFileSync(process.execPath, ["--import", "tsx", "--eval", `await import(${JSON.stringify(`${moduleUrl}&again=1`)})`], { cwd: process.cwd(), env: { ...process.env, POLYCHAT_DATA_DIR: directory, POLYCHAT_LEGACY_DATA_DIR: directory }, stdio: "pipe" });
  rmSync(directory, { recursive: true, force: true });
});
