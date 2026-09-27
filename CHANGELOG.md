# Changelog

## 1.1.0

- Added real Grok Build and Kimi Code peers behind a shared runtime-adapter registry.
- Added Grok headless streaming with plan permissions, denied mutation/external tools, exact sessions, model discovery, and read-only sandboxing.
- Added Kimi ACP session creation/resume, model and plan-mode selection, permission denial, cancellation, and a project read-only macOS Seatbelt profile.
- Added runtime probes, actionable missing/outdated/auth states, `GET /api/runtimes`, and the `list_runtimes` MCP tool.
- Added Grok and Kimi project/session discovery, exact native session bindings, and premium transparent lab marks.
- Added the SQLite v1→v2 migration with a pre-upgrade backup, atomic table rebuild, foreign-key validation, and idempotence.
- Preserved Codex and Claude Code behavior, host restrictions, room APIs, legacy aliases, transcripts, and plugin identity.

Minimum optional peer versions are Grok Build 0.2.114 and Kimi Code 0.27.0. Missing optional peers do not make the broker unhealthy.
