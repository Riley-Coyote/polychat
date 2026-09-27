# Changelog

## 1.1.0

- Added real Grok Build and Kimi Code peers behind a shared runtime-adapter registry.
- Added Grok headless streaming with plan permissions, denied mutation/external tools, exact sessions, model discovery, and read-only sandboxing.
- Added Kimi ACP session creation/resume, model and plan-mode selection, permission denial, cancellation, and a project read-only macOS Seatbelt profile.
- Added runtime probes, actionable missing/outdated/auth states, `GET /api/runtimes`, and the `list_runtimes` MCP tool.
- Added Grok and Kimi project/session discovery, exact native session bindings, and premium transparent lab marks.
- Added the SQLite v1→v2 migration with a pre-upgrade backup, atomic table rebuild, foreign-key validation, and idempotence.
- Preserved Codex and Claude Code behavior, host restrictions, room APIs, legacy aliases, transcripts, and plugin identity.
- Redesigned the room in the Void shell: a borderless conversation surface, collapsible participant dock, auto-sizing composer, and runtime-aware Add collaborator and context picker.

### Security
- The broker now answers only requests addressed to this machine from this machine's own pages. A web page can no longer reach it through a DNS name pointed at 127.0.0.1 or by posting to it cross-site.
- Kimi's Seatbelt profile now denies writes everywhere except Kimi's own state and scratch space. Before, it denied writes only inside the project folder.
- File reads the broker serves to Kimi are limited to the project folder, including through `..` and symlinks.

### Fixed
- Grok Build 1.0 replies appear again. Its stream now sends reply text as `text` events, which Polychat didn't recognize, so every Grok turn ended empty. Its reasoning (`thought` events) stays hidden.
- Codex participants work in folders that aren't Git repositories. Codex refuses those by default to protect changes it can't undo; Polychat always runs it read-only.
- Replies that resume after a tool call (Claude Code and Grok) start a new paragraph instead of running into the previous sentence.
- An expired Kimi sign-in now says so, with the `kimi login` fix, instead of a bare "Authentication required". Kimi's readiness check only looks for a credentials file, so it can report ready while the sign-in behind it has lapsed.

### Changed
- The skill is now `polychat` (`$polychat` in Codex, `/polychat:polychat` in Claude Code), so it no longer shares the name `council` with PolyClaude's in-session council.
- The `stage-polychat-demo` recording skill moved out of the shipped plugin into the repository (`.agents/skills`, linked for Claude Code from `.claude/skills`), because it edits source files that installed copies don't have.
- `polychat_doctor` now requires Node 22.13 or later, the first Node 22 release with `node:sqlite` enabled by default.
- CI no longer runs the skill and plugin validators, which depend on tools that exist only on developer machines.

Minimum optional peer versions are Grok Build 0.2.114 and Kimi Code 0.27.0. Missing optional peers do not make the broker unhealthy.
