import type { ProjectContext, RuntimeCatalogEntry, RuntimeId } from "../../shared/types.js";
import type { RuntimeAdapter } from "./contracts.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { kimiAdapter } from "./adapters/kimi.js";

const adapters = [claudeAdapter, codexAdapter, grokAdapter, kimiAdapter] as const;
const registry = new Map<RuntimeId, RuntimeAdapter>(adapters.map((adapter) => [adapter.id, adapter]));
let catalogCache: { expiresAt: number; value: RuntimeCatalogEntry[] } | null = null;

export const runtimeIds = adapters.map((adapter) => adapter.id);
export function isRuntimeId(value: unknown): value is RuntimeId { return typeof value === "string" && registry.has(value as RuntimeId); }
export function getRuntimeAdapter(runtime: RuntimeId) { const adapter = registry.get(runtime); if (!adapter) throw new Error(`Unknown runtime: ${runtime}`); return adapter; }
export function rankProjects(projects: ProjectContext[], query: string) {
  const needle = query.trim().toLowerCase(); if (!needle) return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const score = (project: ProjectContext) => { const cwd = project.cwd.toLowerCase(); const name = project.name.toLowerCase(); if (cwd === needle) return 600; if (name === needle) return 500; if (name.startsWith(needle)) return 400; if (cwd.startsWith(needle)) return 300; if (name.includes(needle)) return 200; if (cwd.includes(needle)) return 100; return 0; };
  return [...projects].sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function runtimeCatalog(refresh = false) {
  if (!refresh && catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  const value = await Promise.all(adapters.map(async (adapter) => {
    const probe = await adapter.probe().catch((error) => ({ runtime: adapter.id, status: "error" as const, installed: false, authenticated: false, supported: false, version: null, executable: null, message: error instanceof Error ? error.message : String(error), action: null }));
    const models = probe.status === "ready" ? await adapter.discoverModels().catch(() => adapter.descriptor.presets) : adapter.descriptor.presets;
    return { descriptor: adapter.descriptor, probe, models };
  }));
  value.sort((left, right) => Number(right.probe.status === "ready") - Number(left.probe.status === "ready"));
  catalogCache = { expiresAt: Date.now() + 60_000, value }; return value;
}
