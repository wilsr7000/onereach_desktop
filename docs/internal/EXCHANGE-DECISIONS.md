# Exchange-Agent Architecture — Decision Records

Authoritative log of architectural decisions for the voice-orb / exchange-agent
subsystem of the **full** app. New decisions append; superseded ones are marked,
not deleted. Same format as [lite/DECISIONS.md](../../lite/DECISIONS.md): ID,
Date, Status, Context, Decision, Consequences, Supersedes / Superseded-by.

`ADR-EX-NNN` numbering is distinct from Lite's `ADR-NNN` so the two logs never
collide. Companion design doc: [ORB-EXCHANGE-AGENTS.md](ORB-EXCHANGE-AGENTS.md).

---

## ADR-EX-001: Committed voice requests bypass every renderer input gate

- **Date**: 2026-07-02
- **Status**: Accepted
- **Context**: The daily brief failed on a *new* leak each release — orphaned to zero subscribers (5.0.18), an invalid idle→speaking transition (5.0.19), then the TTS echo cooldown (5.0.20). Every failure had the same root: the realtime model speaks a short reply on the user's turn, driving the orb speaking→idle, after which *some* mic-oriented router gate (phase, cooldown, noise, dedup) silently dropped the committed `handle_user_request`.
- **Decision**: A `function_call_transcript` is the model's structured tool call, not raw mic input. In `lib/orb/orb-event-router.js` it takes a single COMMITTED early-return that bypasses ALL gates (phase, cooldown, noise, dedup). Those gates exist only to filter raw mic audio; the handler's own same-turn dedup still prevents double-dispatch.
- **Consequences**:
  - The whack-a-mole ends: no router path can drop a committed request.
  - Raw-transcript echo/noise/dedup guards are unchanged (proven by tests).
  - Commit `1ec40a2`; regression tests in `orb-event-router.test.js`.

---

## ADR-EX-002: I/O surfaces are first-class relay agents behind one registry

- **Date**: 2026-07-02
- **Status**: Accepted
- **Context**: The intended architecture treats every I/O surface (voice, chat, modal) and the moderator as "just another agent that listens to the exchange." In reality they were behaviours scattered across `orb.html` and `exchange-bridge.js` with no shared identity, and each decision (who self-prompts, who may bid) was hardcoded ad hoc.
- **Decision**: Introduce `lib/exchange/relay-participants.js` — an enumerable registry of the relay agents (`voice-relay`, `chat`, `modal`, `exchange-manager`), each `bidExcluded`, each with a channels contract. It is the single source of truth for the self-handling set and bid-excluded ids. A shared pure brain, `lib/exchange/relay-core.js`, holds the inbound/outbound decisions (`classifyInbound`, `planOutbound`, `buildModalSubmit`, `shouldSurfaceNeedsInput`) that the relay agents delegate to.
- **Consequences**:
  - The four relay roles are named, testable modules with a common contract.
  - Consumers ask the registry, not a hardcoded list (`relay-core` sources its self-handling set from it).
  - Commits `3bbe835` (relay-core), `9d5c686` (registry).

---

## ADR-EX-003: The pop-out modal is a bidirectional channel

- **Date**: 2026-07-02
- **Status**: Accepted
- **Context**: An agent's standard response can render into a modal window, but the modal was output-only: user clicks/form-submits were ignored, so any agent that asked for input via a modal was a dead end. The inline command-hud panel already routed input back to its agent.
- **Decision**: The modal captures `[data-value]` clicks and form submits, sends `{value,label,field,agentId}` over `agent-ui:submit-input`, and the bridge converts it via `relay-core.buildModalSubmit` into `submitTask(text, {metadata.targetAgentId})` — the SAME correlation path (`routePendingInput`) the inline panel uses. The modal is one-shot (closes on submit); the voice relay remains the fallback prompter for subsequent turns, so the modal is deliberately NOT in the self-handling set.
- **Consequences**:
  - Modal content is a true channel: send info, request info, or both.
  - Answers resume the originating agent, correlated by pending state, not by surface.
  - Commit `e5b2ffa`; `buildModalSubmit` unit-tested.

---

## ADR-EX-004: The voice relay surfaces needs-input from ANY agent

- **Date**: 2026-07-02
- **Status**: Accepted
- **Context**: The orb only entered follow-up listen for a `needsInput` tagged `toolId==='orb'`, so a proactive/background agent (e.g. a meeting alarm needing a decision) could never reach the user through the orb. The orb is the primary user-relay and should be able to voice any agent's request.
- **Decision**: `relay-core.shouldSurfaceNeedsInput` replaces the orb-only filter: surface for orb-owned turns, proactive requests, and any tool that is not a self-prompting interactive surface (per the registry). Correlation is unaffected — the answer routes back by the agent's pending state, not by which surface prompted.
- **Consequences**:
  - Any agent can prompt the user at any time (UC5), matching "the orb listens to the exchange like every other agent."
  - The orb defers only to surfaces that self-prompt, avoiding double-prompts.
  - Commit `9c482eb`; wired in `orb.html` with a safe fallback.

---

## ADR-EX-005: A moderator agent keeps the exchange healthy and clear

- **Date**: 2026-07-02
- **Status**: Accepted
- **Context**: The exchange was a persistent ledger — tasks were marked SETTLED but never removed, so the task map grew unbounded. The intended model is "all activity is a task; tasks are removed when done." There was no moderator/traffic-cop watching exchange health.
- **Decision**: Add `lib/exchange/exchange-manager.js`, a moderator that on a 60s tick prunes terminal tasks (settled/cancelled/dead_letter/halted) past a 5-minute TTL, flags stuck tasks (assigned/waiting too long), and reports a health summary. The decision logic (`planMaintenance`) is pure and unit-tested; the runtime binds to the exchange via two new additive accessors (`listTasks`/`removeTask`). Fully guarded — a moderator failure never touches task flow.
- **Consequences**:
  - The exchange self-clears toward empty, as the vision requires.
  - Stuck auctions become observable instead of silent.
  - The `Task` accessors are additive (dist is gitignored + rebuilt by `tsc`).
  - Commit `310b3f4`; 15 tests.

---

## ADR-EX-006: Relay agents stay on privileged IPC; WebSocket-peer transport deferred

- **Date**: 2026-07-02
- **Status**: Accepted
- **Context**: A full realization of "the orb is just another agent listening to the exchange" would register the orb as a WebSocket peer on the exchange (port 3456), like every bidding agent, instead of using the privileged `hud-api:submit-task` IPC path. That transport swap is a large, higher-risk refactor (connection lifecycle, reconnection, result routing) for little user-visible benefit — the functional essence (any agent can reach the user; proactive prompts; correlation) is already delivered via ADR-EX-002/004.
- **Decision**: Keep the relay agents on privileged IPC for now. Formalize their identity and contract via the registry (ADR-EX-002) so consumers depend on the abstraction, not the transport. Revisit the IPC→WebSocket-peer swap only if a concrete need arises (e.g. relocating the orb to a separate process, or an agent-to-orb interaction the IPC path can't express).
- **Consequences**:
  - Lower risk now; the working dispatch/answer plumbing is untouched.
  - The registry is the seam: a later transport swap is consumer-invisible.
  - Honest debt: the orb is a contract-level peer, not yet a transport-level peer.
- **Superseded-by**: (none yet — reopen if the transport swap is scheduled.)

---

## Follow-ups (not yet decided)

- Emit `proactive: true` on background `needsInput` so the flag path in `shouldSurfaceNeedsInput` is exercised end-to-end (today the `!selfHandling` branch already surfaces them).
- Consider routing disambiguation/halt handling as first-class exchange tasks (today it is inline in the halt handler).
- Master-evaluator remains an external callback rather than an exchange-elected judge; revisit only if agent-autonomy in selection becomes a goal.
