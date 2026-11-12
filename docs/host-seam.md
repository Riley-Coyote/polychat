# Using Polychat from a host app

Polychat can be used two ways.

- **On its own**, as the plugin in Claude Code or Codex. Polychat's small local server (the broker) does the delivering: it starts each agent's turn, puts the reply in the room, and the room in the browser is the transcript.
- **Inside a host app** that already has its own inbox and its own way of running an agent's turn. There, the host app does the delivering and keeps the one transcript. Polychat lends it the things below, and nothing is done twice.

One rule covers both: what an agent *does* goes through its own app's tools; what the person *sees* is the host's own screen. Nothing is registered twice.

This page says what a host can borrow, what it must never run twice, which calls change what, who can stop a turn, and how a consult is delivered once. Every statement about Polychat's behaviour is shown by a test in `src/server/` or by the example in `examples/host-seam/`; the source is named at the end of each section.

## What a host borrows

- **Who a participant is.** A participant is a runtime (`claude-code`, `codex`, `grok` or `kimi-code`), a model, a working folder and, when it continues an earlier conversation, the exact session id of that conversation. Polychat keeps these per room and resumes that exact session when the participant is asked. *Shown by:* `db.test.ts` ("rooms persist Grok and Kimi participant bindings"); the example's launch log, where the participant with a session id is resumed (`resume=yes`).
- **The room link.** A room opens at `http://127.0.0.1:<port>/?room=<roomId>`; the MCP tools return it as `url`. *Shown by:* `consult.test.ts` ("the two MCP tools pass requestId through").
- **The council, only when asked for.** A council (blind answers, a blind ranking, a cross-examination and minutes) starts only from the `run_council` tool, the room's Council button or the `/council` command in the room's message box, all of which call `POST /api/rooms/:roomId/councils`. Asking a participant, or sending a message, never starts one, whatever the message says. *Shown by:* `consult.test.ts` ("a plain ask, with or without a requestId, never opens a council"); the example, step 4.

## What must never run twice

| Thing | Who does it, on its own | Who does it, inside a host app |
|---|---|---|
| Starting an agent's turn | The broker, from `invoke`, from a message that names recipients, or from a council | The host's own task runner. The host must not also call a Polychat route or tool that launches (see the table below) for the same turn. |
| Retrying a turn | Nobody. Polychat never retries a turn and never queues one for later. | Only the host, and only by sending a new request. |
| Putting a reply in the room | The broker, as soon as the turn ends. The agent is told not to post it again. | The host, in its own transcript. |
| The transcript of record | The Polychat room | The host's own transcript. A Polychat room alongside it is a copy at most, never a second record. |

*Shown by:* `consult.test.ts` (a repeated request launches nothing; a busy turn is launched once and never retried, including after the participant is free again); the example, steps 2 and 3.

## Which calls read, change the room, or start a process

"Starts a process" means Polychat launches something on the Mac: an agent's turn, a version or sign-in check of an agent's command-line tool, or Finder.

| Route | Reads | Changes the room | Starts a process |
|---|---|---|---|
| `GET /api/health` | yes | no | no |
| `GET /api/runtimes` | yes | no | yes: version and sign-in checks of each agent's tool (kept for a minute unless `refresh=true`) |
| `GET /api/rooms` | yes | no | no |
| `POST /api/rooms` | | yes: creates a room | no |
| `GET /api/rooms/:roomId` | yes | only to close a live meeting whose time has run out | no |
| `PATCH /api/rooms/:roomId` | | yes: name or archive | no |
| `GET /api/rooms/:roomId/events` | yes: a live stream of changes | no | no |
| `POST /api/rooms/:roomId/messages` | | yes: posts a message | yes, when it wakes recipients |
| `POST /api/rooms/:roomId/invoke` | | yes: adds the participant's reply | yes: one turn |
| `GET /api/rooms/:roomId/consults/:requestId` | yes | no | no |
| `POST /api/rooms/:roomId/councils` | | yes | yes: a turn for every member, in each round |
| `DELETE /api/rooms/:roomId/councils/:councilId` | | yes | stops the members' turns |
| `POST /api/rooms/:roomId/councils/:councilId/records` | | yes: notes where the minutes were saved, and writes the file | no |
| `POST /api/rooms/:roomId/councils/:councilId/reveal` | | no | yes: shows the saved minutes in Finder |
| `POST /api/rooms/:roomId/participants` | | yes: adds a participant | no |
| `PATCH /api/rooms/:roomId/participants/:agentId` | | yes | no |
| `GET /api/rooms/:roomId/participants/:agentId/brings` | yes: the participant's folder and notes | no | no |
| `DELETE /api/rooms/:roomId/participants/:agentId` | | yes | no |
| `POST /api/rooms/:roomId/meeting` | | yes: starts a live meeting | no |
| `DELETE /api/rooms/:roomId/meeting` | | yes: ends it | stops every turn in the room |
| `GET /api/contexts/:runtime/projects` and `.../sessions` | yes: each agent's own saved projects and sessions | no | no |
| Older routes: `GET /api/room`, `GET /api/events`, `POST /api/messages`, `GET /api/claude/projects`, `GET /api/claude/projects/:id/sessions` | as their newer forms, for the "Common room" | as their newer forms | as their newer forms |

Every MCP tool starts the broker first if it isn't running. Beyond that:

| MCP tool | Calls | Changes the room | Starts a process |
|---|---|---|---|
| `polychat_doctor` | `GET /api/runtimes?refresh=true`, plus version checks of `codex` and `claude` | no | yes: checks |
| `list_runtimes` | `GET /api/runtimes` | no | yes: checks |
| `list_rooms`, `read_room`, `search_contexts`, `wait_for_events` | read routes | no | no |
| `create_room` | `POST /api/rooms` | yes | no |
| `open_room` | `GET /api/rooms/:roomId` | no | yes: opens the browser, unless `launch` is false |
| `configure_participant`, `remove_participant` | participant routes | yes | no |
| `send_message` | `POST .../messages` | yes | yes, when it wakes recipients |
| `invoke_participant` | `POST .../invoke` | yes | yes: one turn |
| `run_council` | `POST .../councils` | yes | yes |
| `stop_council` | `DELETE .../councils/:councilId` | yes | stops turns |
| `save_minutes_to_project` | `POST .../records` | yes | no |
| `start_meeting`, `end_meeting` | meeting routes | yes | `end_meeting` stops turns |
| Older tools: `post_message`, `ask_claude`, `ask_codex`, `configure_claude` | the "Common room" message and participant routes | yes | `ask_claude` and `ask_codex` start a turn |

## Who can stop a turn

- **On its own:** the person, by typing `stop` in the room while a council or a live meeting is in session; and an agent, through `stop_council` or `end_meeting`. Each one stops the turns it covers, and a stopped consult reads `error` with `error.code` `invocation_cancelled`. A single asked turn outside a council or meeting runs until the agent answers, or until the turn time limit (30 minutes, or `POLYCHAT_TURN_TIMEOUT_MS`). *Shown by:* `consult.test.ts` ("typing stop ends a council or a live meeting, and the turns in it"); `council.test.ts` ("stopping a council cancels its members"); `roomConcurrency.test.ts` (stopping one room leaves another running).
- **Inside a host app:** the host, because the host started the turn. Polychat has no turn of its own to stop there.

## The consult contract

A *consult* is an `invoke`, or a `messages` post that wakes recipients, that carries a `requestId`: a string of 1 to 128 characters that the caller chooses. The `invoke_participant` and `send_message` tools take it too.

1. **The first request behaves exactly as it would without one.** It starts the same turn and returns the same message.
2. **Any later request with the same room and `requestId` starts nothing.** It returns the first request's message as it stands now, with `duplicate: true`, whether that first turn is still running, finished, failed or was busy. A repeated `messages` post posts nothing and wakes no one. The same `requestId` in a different room is a different consult.
3. **It holds across a broker restart.** The pair is kept in Polychat's database; a database made before consults existed gains the table the first time it opens, and keeps its rooms and messages.
4. **One place to read the outcome:** `GET /api/rooms/:roomId/consults/:requestId` returns

   ```json
   { "requestId": "…", "status": "pending" | "complete" | "error" | "busy", "messageId": "…", "reply": "…" | null, "error": { … } | null, "replies": [ … ] }
   ```

   `messageId` is the message the first request returned: the reply itself for an `invoke`, the posted message for a `messages` post. `replies` has one entry per participant the first request woke, each with its own `status`, `messageId`, `reply` and `error`; `reply` and `error` at the top are that one participant's when there was exactly one. Reading the outcome any number of times changes nothing. There is no separate acknowledgement: a caller that acknowledges twice is a caller that reads or re-sends twice, and both are harmless. An unknown `requestId` reads as 404.
5. **Busy is said plainly, and never smoothed over.** When the participant can't take the turn, the outcome is `busy`, with `error.code` `invocation_busy` and an honest `retryable`:
   - its session is open somewhere else, as when a Codex session is open in the Codex app: the turn is launched once, Codex refuses, and `retryable` is `false`;
   - it is already in the middle of a turn, or its exact session is in the middle of a turn in another room: nothing is launched, the `invoke` answers 409 with the busy message, and `retryable` is `true`.

   In both cases the room shows the refusal, and Polychat neither retries the turn nor queues it for later. Asking again means sending a new request with a new `requestId`; the same one would only return the busy outcome.
6. A `requestId` that is not a string of 1 to 128 characters is refused with 400, and so is a `requestId` on a message that asks for a back-and-forth discussion, since a consult asks for one turn. A first request refused before anything happened (for example, with no prompt) doesn't use up its `requestId`.
7. Without a `requestId`, nothing changes: a participant already mid-turn refuses with 409 as before, without a message in the room, and a repeated request starts a new turn.

If the broker restarts while a consult's turn is running, that turn is marked as interrupted, and its outcome reads `error`.

*Shown by:* `consult.test.ts`, every test; the example, steps 1 to 3.

## Trying it

```bash
npm install
node examples/host-seam/run.mjs
```

The example makes a temp folder, puts a stand-in `codex` first on the `PATH` that writes one line per launch, starts its own broker on a free port above 4500, runs the consults above, and stops that broker by its process id. It needs no network and no real agent, and never touches your own rooms.
