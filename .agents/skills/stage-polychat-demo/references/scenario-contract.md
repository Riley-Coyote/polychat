# Guided scenario contract

Use this compact shape when adapting `src/client/guidedDemo.ts` or extracting a future scenario registry.

## Required scene fields

- `slug`: stable URL-safe identifier
- `room`: neutral room name, project path, live host
- `openingMessage`: the user's exact natural request
- `initialAgents`: human, host, and simulated peers; omit the late collaborator
- `turns`: ordered sender, delay, and substantive response content
- `lateCollaborator`: runtime, model, display name, project, sessions, grounded reply

## Conversation roles

Assign roles by reasoning function:

| Role | Contribution |
|---|---|
| Host | Propose, connect, revise, synthesize |
| Product/continuity critic | Challenge meaning, guarantees, and user trust |
| Implementation specialist | Improve data flow, caching, protocols, and measurement |
| Adversarial reviewer | Find concurrency, recovery, security, and stale-state failures |
| Late contextual expert | Reconcile the room with prior project decisions |

Vary roles with the topic; do not hardcode roles to provider brands.

## Timing defaults

- Initial host thinking delay: 0.8–1.5 seconds
- Peer thinking delay: 0.9–2.0 seconds
- Text chunks: roughly 12–24 characters
- Chunk interval: roughly 24–50 milliseconds
- Pause between paragraphs: modest but visible
- Total initial council: 35–75 seconds
- Late collaborator response: 15–35 seconds

Prefer stable bounded timing to random delays that could derail a take.

## Writing checks

- Include concrete file, state, protocol, metric, or failure-boundary language where appropriate.
- Make later turns quote, challenge, or refine earlier claims.
- Avoid identical response structures across participants.
- Avoid instant consensus.
- End the initial council with one unresolved boundary that motivates adding the late collaborator.
- Make the late response reveal why exact-session context matters.

## Safety and isolation

- Keep guided state in memory and reset on navigation.
- Do not write simulated content to SQLite or native runtime sessions.
- Do not probe authentication or consume provider tokens.
- Do not add visible demo labels to Polychat.
- Preserve normal routes and `$council` behavior.
- Ensure any public caption or narration can disclose that peer responses were simulated.

## Recording choreography

1. Prepare a long, relevant pre-roll response in the host chat if needed.
2. Begin recording.
3. User sends the natural request to convene the named peers.
4. Host opens Polychat and the council streams.
5. User asks the host for an interim synthesis if desired.
6. User manually adds the late collaborator and selects an exact session.
7. User sends a direct pressure-test request.
8. Late collaborator streams the contextual response.
9. End on the active room or host synthesis.

