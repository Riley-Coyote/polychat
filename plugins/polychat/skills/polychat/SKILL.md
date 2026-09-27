---
name: polychat
description: Open a visible, saved Polychat room where the user's real agent runtimes (Codex, Claude Code, Grok Build, Kimi Code) talk together in one transcript, each keeping its own project context and memory. Use when the user mentions Polychat, asks Codex, Claude, Grok, or Kimi to discuss, debate, or brainstorm together, wants another agent's project or exact session brought into the conversation, or wants to resume a saved Polychat room. Not for a simulated panel of perspectives inside a single session.
---

# Polychat

Use Polychat as connective tissue between real runtime contexts. Keep the browser transcript visible and each participant's private memory distinct.

## Start or resume

1. Resolve runtime names first: Grok or Grok Build means `grok`; Kimi or Kimi Code means `kimi-code`; Claude means `claude-code`; Codex means `codex`. Run `polychat_doctor` with every explicitly requested runtime in `requiredRuntimes`. Stop with its actionable failed check if a requested peer is not ready. Never silently substitute another runtime.
2. If the user explicitly identifies a saved room, use `list_rooms` and `read_room`. Otherwise create a new room named from the agenda with `create_room`.
3. Infer the invoking host from the current runtime. Register it with `start_meeting`, using the current working directory and a 20-minute maximum.
4. Resolve invited peers:
   - Honor explicit runtime, model, project path, and session ID first.
   - Otherwise search with `search_contexts` using the project or work name.
   - Reuse a saved binding only when resuming its room.
   - Use the current working directory for a new peer when no prior context was requested.
   - Ask the user to choose when multiple context results plausibly match. Never silently resume an ambiguous session.
   - Default to one Opus Claude Code peer when Codex hosts, or one configured Codex peer when Claude hosts.
   - Grok Build and Kimi Code are broker-managed peers only. They cannot become the live host.
5. Add peers with `configure_participant`. A participant is only a runtime, model, project directory, optional exact session, and display name.
6. Call `open_room`. In Codex, prefer navigating the returned local URL with the in-app Browser tool when it is available; otherwise rely on the macOS browser opened by the tool.

## Conduct the meeting

1. Post the agenda visibly as the live host with `send_message` and no recipients.
2. Run two rounds by default. In each round, call `invoke_participant` once for each peer, sequentially, including mixed Claude, Codex, Grok, and Kimi rooms.
3. After each invocation, call `wait_for_events` and then `read_room`. Incorporate new browser messages before the next contribution.
4. Between rounds, reason as the active host and post a concise visible response that connects, challenges, or redirects the discussion.
5. Honor an explicit number of turns or rounds, but never exceed 12 peer contributions or 20 minutes.
6. Treat a visible human request to stop as cancellation after the current reply. Do not begin another runtime turn.
7. Keep all peer work read/plan-oriented. Do not ask broker-managed peers to edit files or perform external actions.
8. End with a host synthesis posted visibly to the room, then call `end_meeting`. On failure or interruption, still call `end_meeting` with cancellation when possible.

After the meeting ends, explain that the exact host task is now marked away while broker-managed peers remain available in the browser.
