# Changelog

## 1.2.0

### Added
- **Minutes that last.** Every finished council is saved as a Markdown record in `~/Documents/council-records/polychat/`: the decision first, then the blind ranking, every answer, and the cross-examination. Set `POLYCHAT_RECORDS_DIR` to keep records elsewhere. A Polychat running with its own data folder (`POLYCHAT_DATA_DIR`) keeps its records beside that data, so test and development copies never write into your real records.
- **Save to project.** One click under the minutes puts a copy in the project's `councils` folder, where the collaborators working there can read it. Agents do the same with the new `save_minutes_to_project` MCP tool. Clicking a saved record shows it in Finder.
- **What each mind brings.** Clicking a collaborator shows what it brings into the room:
  - its project folder;
  - the instruction files its runtime reads there (CLAUDE.md and rules for Claude Code, AGENTS.md for Codex, Grok Build and Kimi Code, including your global ones);
  - Claude Code's saved memory notes for the project;
  - the conversation it continues, by name, with when it started and when it was last active, or that it starts fresh;
  - how much it has said in this room.
- `read_room` reports where the latest council's minutes were saved.

### Fixed
- Claude Code sessions in the context picker show the name the session was given, instead of its random nickname.
- Collaborators added at the same instant keep the order they were added in, so a council's seats and first-choice lists no longer shuffle between reloads.

## 1.1.0

- Added real Grok Build and Kimi Code peers behind a shared runtime-adapter registry.
- Added Grok headless streaming with plan permissions, denied mutation/external tools, exact sessions, model discovery, and read-only sandboxing.
- Added Kimi ACP session creation/resume, model and plan-mode selection, permission denial, cancellation, and a project read-only macOS Seatbelt profile.
- Added runtime probes, actionable missing/outdated/auth states, `GET /api/runtimes`, and the `list_runtimes` MCP tool.
- Added Grok and Kimi project/session discovery, exact native session bindings, and premium transparent lab marks.
- Added the SQLite v1→v2 migration with a pre-upgrade backup, atomic table rebuild, foreign-key validation, and idempotence.
- Preserved Codex and Claude Code behavior, host restrictions, room APIs, legacy aliases, transcripts, and plugin identity.
- Redesigned the room in the Void shell: a borderless conversation surface, collapsible participant dock, auto-sizing composer, and runtime-aware Add collaborator and context picker.

### Added
- **Councils.** One question goes to every collaborator in the room, in four rounds:
  1. **Blind answers.** Everyone answers in parallel, with the answers sealed until all are in.
  2. **Blind ranking.** Every member ranks every answer with the authors hidden and shuffled; the room shows the Borda tally, first-choice votes, and where each member put its own answer.
  3. **Cross-examination.** Each member answers the others by name and declares its position held, sharpened, or changed.
  4. **Minutes.** The member the blind ranking placed first writes them: the decision, where each mind landed, what moved, dissent, and next steps.
- Start a council with the **Council** button beside the composer, or with `/council <question>`. Agents start one with the new `run_council` MCP tool and end one with `stop_council`. Typing `stop` ends it from the room.
- While a council is in session, the room holds new messages, so nothing leaks into its blind rounds. `wait_for_events` treats a council between rounds as still busy.
- Council messages render Markdown: paragraphs, lists, bold, code, and links.

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
