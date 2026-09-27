---
name: stage-polychat-demo
description: This skill should be used when the user asks to "record a Polychat demo", "stage a simulated council", "prepare a guided agent demo", "make product theater", "demo unavailable agents", or create a browser-visible walkthrough where Codex or Claude opens Polychat, simulated peers stream a realistic discussion, and the user manually adds a context-bound collaborator.
---

# Stage Polychat Demo

Stage a repeatable product recording through the real Polychat interface while replacing unavailable peer turns with deterministic local simulation. Keep actual room UI, streaming, thinking states, routing, collaborator selection, and context selection functional. Never write simulated participants or messages into normal saved rooms.

## Establish the scene

1. Capture or infer:
   - natural host request spoken during recording
   - project and concrete problem under discussion
   - initial peer cast and provider identities
   - live host identity
   - late-arriving collaborator and model
   - project and exact session shown in the context picker
   - desired recording length and pacing
2. Prefer one technical decision with real tradeoffs over a broad brainstorm.
3. Read `references/scenario-contract.md` before authoring or replacing a scenario.
4. Keep the normal product free of visible demo labels, control panels, watermarks, or explanatory chrome. Leave disclosure to the user's surrounding caption or narration.

## Build efficiently

1. Inspect the current guided-demo implementation before editing:
   - `src/client/guidedDemo.ts`
   - guided-mode branches in `src/client/App.tsx`
   - guided flows in `src/client/AddCollaborator.tsx`
   - guided flows in `src/client/ContextPicker.tsx`
2. Reuse the existing guided transport and UI behavior. Change scenario data and the smallest necessary generic hooks; do not add another parallel showcase system.
3. Keep all presentation data in memory. Do not call normal room, participant, message, context, or runtime endpoints from guided mode.
4. Give the scene a stable URL such as `/?guided=<scenario-slug>` and make each fresh navigation start from the opening user turn.
5. Use the production participant cards, lab marks, transcript, composer, recipient routing, context picker, and browser surface without restyling them for the recording.

## Write believable collaboration

1. Give each peer a distinct analytical role rather than a different writing gimmick.
2. Write substantial native-agent turns: several paragraphs, occasional lists, implementation detail, caveats, and explicit references to earlier contributions.
3. Create real movement:
   - host proposes a concrete spec
   - one peer challenges product or continuity semantics
   - one peer improves implementation mechanics
   - one peer attacks races and failure modes
   - host revises the recommendation in response
4. Allow disagreement before convergence. Avoid four interchangeable endorsements or uniformly concise marketing copy.
5. Stream text in small variable chunks with participant-specific thinking delays. Keep timing deterministic enough to rehearse reliably and quick enough for a recording.
6. Make visible message routing meaningful. Show at least one message to Everyone and one direct message to a named participant.

## Stage the late collaborator

1. Leave the late collaborator absent from the initial room.
2. Keep **Add collaborator** active in guided mode.
3. Populate the real four-step flow with a ready runtime, plausible model choices, the project, and two or three exact-session choices.
4. Make session titles, prompts, paths, recency, and continuity details specific to the scenario.
5. After context attachment, select the new collaborator as the composer recipient.
6. Stream a substantial follow-up that uses both the room discussion and facts implied by the selected project session.

## Rehearse and present

1. Run typecheck, build, and the relevant test suite.
2. Open the guided URL in the in-app Browser and verify:
   - initial room and cast
   - thinking and streaming transitions
   - long responses and automatic scrolling
   - participant marks and presence states
   - add-collaborator model selection
   - project and exact-session selection
   - direct message to the late collaborator
   - streamed contextual response
   - no console warnings or errors
3. Close the rehearsal tab so the next navigation begins clean.
4. If the user wants prior conversation hidden in the recording, provide a screen-filling, relevant normal response before the take.
5. Wait for the user's natural invocation. Respond briefly in the host chat, open the guided URL visibly, and leave the streaming room as a browser handoff.
6. Do not mention simulation, guided mode, staging, or demo machinery during the recorded interaction unless the user explicitly asks. Never claim the simulated peer turns were live runtime calls outside the performance context.

## Preserve the reusable boundary

Keep the production runtime adapters unchanged. Use guided mode only for recording scenarios whose unavailable peers must be simulated. When real runtime access is available, use `$council` instead.

