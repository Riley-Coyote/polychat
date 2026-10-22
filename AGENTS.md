# Setting up Polychat

This file is for an agent that has been handed this repository and asked to set Polychat up for someone. Follow it top to bottom. Every command here was run on a clean configuration before it was written down.

Polychat puts a person's real coding agents (Claude Code, Codex, Grok Build, Kimi Code) in one shared, visible room on their own Mac. Each agent keeps its own project, instructions, memory and session; Polychat carries messages between them and shows the whole conversation in a local browser page. Nothing leaves the machine except what each agent's own CLI already sends to its own provider.

You do not need to clone this repository, run `npm install`, or build anything to use Polychat. The plugin ships prebuilt in `plugins/polychat/dist/`. Building is only for changing Polychat itself (see the end of this file).

## 1. Check the machine

Run these and compare against the table. Report anything missing to the person before going further.

```bash
sw_vers -productName
node --version
claude --version
codex --version
grok --version
kimi --version
```

| Requirement | Needed | Notes |
|---|---|---|
| macOS | Yes | Polychat stores data in `~/Library/Application Support/Polychat/`, opens rooms with `/usr/bin/open`, and sandboxes Kimi with macOS Seatbelt. Its health check fails on other systems. |
| Node.js 22.13 or newer | Yes | The broker uses the built-in `node:sqlite`. `node` must be on the `PATH` that Claude Code or Codex sees, since they launch the plugin with it. |
| Claude Code or Codex | At least one | These are the apps Polychat installs into, and the only ones that can host a meeting live. Having both is best: each can then bring the other into the room. |
| Grok Build 0.2.114+ | Optional | Joins rooms as a guest. |
| Kimi Code 0.27.0+ | Optional | Joins rooms as a guest, sandboxed read-only. |

If Node is too old or missing, suggest the person install the current LTS from nodejs.org or with their package manager (for example `brew install node`). Don't install system software without their go-ahead.

## 2. Install the plugin into each app that's present

Claude Code:

```bash
claude plugin marketplace add Riley-Coyote/polychat
claude plugin install polychat@polychat
```

Codex:

```bash
codex plugin marketplace add Riley-Coyote/polychat
codex plugin add polychat@polychat
```

Confirm with `claude plugin list` and `codex plugin list`; each should show `polychat@polychat` enabled.

The new tools only appear in a fresh session. You can't restart the app you're running in, so tell the person: restart Claude Code, or start a new Codex task, then come back.

## 3. Make sure every agent is signed in

Each CLI owns its own sign-in. Polychat never sees, stores or asks for credentials, and neither should you: never ask the person for an API key or type one for them. If an agent isn't signed in, have the person do it themselves:

| Agent | Sign in |
|---|---|
| Claude Code | run `claude` and use `/login`; `claude doctor` diagnoses problems |
| Codex | `codex login` |
| Grok Build | `grok login` |
| Kimi Code | `kimi login` |

## 4. Check that it works

In the fresh session, call the `polychat_doctor` tool and list every agent the person wants to use:

```json
{ "requiredRuntimes": ["claude-code", "codex"] }
```

The runtime names are `claude-code`, `codex`, `grok` and `kimi-code`.

`ok: true` means Polychat is ready. The first call also starts Polychat's small local server (the broker) on its own; nothing needs to run at login. Otherwise, read the result:

- `checks.nodeSupported: false`: Node is older than 22.13.
- `checks.broker: false`: the broker didn't start. Read `~/Library/Application Support/Polychat/broker.log`.
- A runtime with status `missing`: that CLI isn't installed or isn't on the `PATH`.
- `unauthenticated`: the person needs to sign in (step 3).
- `unsupported`: the CLI is older than the minimum; `grok update` or `kimi upgrade`.

## 5. Open the first room

Have the person ask in plain words, or invoke the skill directly:

- Claude Code: `/polychat:polychat Brainstorm this project with Codex.`
- Codex: `$polychat Ask Claude to challenge this plan.`

A browser tab opens on `http://127.0.0.1:4317` (or the next free port) and the agents start talking. For a decision, ask for a council: every agent answers blind, ranks the others' answers with names hidden, cross-examines, and the top-ranked one writes the minutes. Finished councils are saved to `~/Documents/council-records/polychat/`.

The full procedure the host agent follows is in [`plugins/polychat/skills/polychat/SKILL.md`](plugins/polychat/skills/polychat/SKILL.md).

## Other apps that speak MCP

The plugin's MCP server is a single file and can be added to any MCP-capable app, using an absolute path to the installed copy:

```json
{
  "mcpServers": {
    "polychat": {
      "command": "node",
      "args": ["/Users/NAME/.claude/plugins/cache/polychat/polychat/1.3.1/dist/polychat-mcp.cjs"]
    }
  }
}
```

The Codex copy lives at `~/.codex/plugins/cache/polychat/polychat/<version>/dist/polychat-mcp.cjs`. Point at an installed copy rather than a clone, since its version folder changes on update; check the real path with `ls` first.

Two limits in other apps. They get the tools but not the skill, so give the agent `SKILL.md` to read. And a live meeting host is labelled as Claude Code or Codex, because those are the only hosts Polychat knows. Polychat is tested in Claude Code and Codex; other apps are untested.

## Settings

All optional, set as environment variables for the app that runs Polychat:

| Variable | Default | What it does |
|---|---|---|
| `POLYCHAT_USER_NAME` | `You` | The person's name in rooms |
| `POLYCHAT_RECORDS_DIR` | `~/Documents/council-records/polychat` | Where council minutes are saved (inside the data folder's `records` if `POLYCHAT_DATA_DIR` is set) |
| `POLYCHAT_DATA_DIR` | `~/Library/Application Support/Polychat` | Rooms, transcripts, logs |
| `POLYCHAT_PORT` | `4317` | Preferred port; the next free one is used if it's taken |

## Updating and removing

Update:

```bash
claude plugin marketplace update polychat && claude plugin update polychat@polychat
codex plugin marketplace upgrade && codex plugin add polychat@polychat
```

Remove with `claude plugin uninstall polychat@polychat` or `codex plugin remove polychat@polychat`. Rooms and transcripts stay in `~/Library/Application Support/Polychat/`. Only delete that folder if the person explicitly asks, since it holds every saved conversation.

## Working on Polychat itself

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:mcp
```

`npm run build` writes the bundles into `plugins/polychat/dist/`, and those built files are committed, because that folder is what people install. Bump the version everywhere at once, since `claude plugin update` only sees a change when the version moves: `package.json` and the top of `package-lock.json`, both `plugins/polychat/.*-plugin/plugin.json` files, both marketplace files, `src/mcp/index.ts`, the health route in `src/server/index.ts`, and `scripts/smoke-mcp.mjs`.
