# Phase 2 — Personality and Voice Handoffs

Ship status: **shipped, always on** (flags removed at the always-on cutover).

> **Note (always-on cutover):** The `personalityCapChew` flag is gone.
> The app ships single Cap Chew voice for every agent; the multi-voice
> cast described below is dormant code, retained only so a future
> revert is easy. The `handoffBridge` flag is also gone; under single-
> voice mode there is no voice change to bridge, so
> `buildHandoffPhrase()` always returns null.
>
> Runtime config still honored:
> - `CAP_CHEW_VOICE` env var / `settingsManager.capChewVoice` setting
>   selects the single voice (default `coral`).

## What this phase does

Introduces the voice personality layer and the infrastructure for
multi-voice handoffs.

Two personality modes are now supported. The choice between them is a
product call the user can make at any time by toggling the flag.

| Mode | Flag state | What the user hears |
|---|---|---|
| **Multi-voice cast** (default) | `personalityCapChew = false` | Each agent keeps its distinct voice (e.g. DJ=ash, Time=sage, Search=echo). Optional handoff bridges can soften transitions between different voices. |
| **Single Cap Chew voice** | `personalityCapChew = true`  | Every agent speaks with the same voice regardless of agent identity. Agent identity becomes visual/UI only. |

Default Cap Chew voice is `coral` (clear, professional, articulate).
Overridable per session via `CAP_CHEW_VOICE=<alloy|ash|ballad|coral|echo|sage|shimmer|verse>`
or persistently via `settingsManager.get('capChewVoice')`.

## Architecture

```
voice-coordinator.getAgentVoice(agentId, agent)
          |
          v
  naturalness-flags.isFlagEnabled('personalityCapChew')
          |
   flag on +---------+  flag off
          |         |
          v         v
   voice-resolver   (existing resolution order)
   .getCapChewVoice         agent.voice -> registry -> defaults
```

Handoff bridges are a separate, optional concern that only matters
when the flag is OFF:

```
tracker.getLastAgent(contextKey)    -- who spoke last
          v
buildHandoffPhrase(fromAgentId, toAgentId, fromAgent, toAgent)
          v
  null if: no prior agent, same agent, or flag ON
  phrase if: different agent in multi-voice mode
```

### Files added (non-test)

- `lib/naturalness/voice-resolver.js` -- decides Cap Chew vs
  agent-specific voice; resolves `CAP_CHEW_VOICE` from env > settings >
  default.
- `lib/naturalness/handoff-phrases.js` -- generates transition bridges
  for multi-voice mode ("passing you to calendar", "one sec").
- `lib/naturalness/agent-transition-tracker.js` -- in-memory TTL map
  remembering which agent spoke last per context key.

### File modified

- `lib/exchange/voice-coordinator.js` -- `getAgentVoice()` now calls the
  naturalness voice-resolver first. When the flag is OFF, behavior is
  unchanged. When ON, returns the Cap Chew voice. All six call sites
  across `exchange-bridge.js` inherit the behavior automatically.

### Phase 2.5 wired in

- `src/voice-task-sdk/exchange-bridge.js` -- the `task:assigned` handler
  now runs a handoff bridge block **before** the Phase 1 confirmation
  gate. Sequence per turn (multi-voice mode):
  1. `tracker.getLastAgent(toolId)` -> prior agent id, if any
  2. `buildHandoffPhrase()` -> bridge text or null
  3. If phrase: `voiceSpeaker.speak(phrase, { voice: outgoingVoice })`
  4. `tracker.recordAgent(toolId, winner.agentId)` (always)
  5. Phase 1 confirmation gate runs next; if the gate's decision would
     be `ACK` and the bridge already spoke, the ACK is suppressed to
     avoid "passing you to calendar" + "got it" back-to-back. A
     `CONFIRM` decision still fires (safety-critical).
  6. Deferred agent ack is suppressed when the bridge OR gate already
     spoke.

## Acceptance criteria

- [x] Flag OFF: every agent's voice resolution matches the pre-Phase-2
  behavior. Verified by `npm run test:agents` (199/199 pass).
- [x] Flag ON: every `getAgentVoice()` call returns the Cap Chew
  voice regardless of agent.voice, registry entry, or default map.
- [x] `CAP_CHEW_VOICE` env var overrides the default coral voice.
- [x] Invalid voice values in env or settings are rejected and the
  safe default is used.
- [x] Handoff bridges correctly detect "same agent" (no bridge) vs
  "different agent" (bridge) vs "flag ON" (no bridge).
- [x] Agent transition tracker respects a 5-minute TTL by default,
  overridable per-instance, and never leaks state across scenarios.
- [x] Real pipeline integration of handoff bridges via Phase 2.5:
  - [x] Bridge fires before Phase 1 confirmation gate so the outgoing
    voice plays the bridge, then the incoming voice speaks the ack or
    confirmation.
  - [x] Phase 1 ACK is suppressed when the bridge already spoke.
  - [x] Phase 1 CONFIRM still fires for safety (never suppressed).
  - [x] Deferred agent ack is suppressed when the bridge spoke.
  - [x] Bridge is opt-in behind `handoffBridge` flag (default off) so
    multi-voice users who have been running the app do not hear
    surprise transition phrases after an update.

## How to test

### Unit + scenario

```bash
npm run test:voice-scenarios
```

Covers (all passing):

- Phase 0 harness: 44 tests
- Phase 1 confirmation: 87 tests
- Phase 2 personality: 56 tests + 5 scenarios

### Agent regression

```bash
npm run test:agents
```

Should remain **199/199** after the voice-coordinator edit.

### Interactive (manual smoke)

**Single-voice mode (Phase 2):**
```bash
NATURAL_PERSONALITY_CAP_CHEW=1 npm run dev
```
Say utterances that would normally route to different agents. Every
response should use the Cap Chew voice (coral by default).

**Multi-voice mode with handoff bridges (Phase 2.5):**
```bash
NATURAL_HANDOFF_BRIDGE=1 npm run dev
```
Say something that routes to agent A, then immediately something
that routes to agent B. Before B speaks, you should hear a short
phrase ("passing you to weather", "one sec", etc.) in **A's** voice.

**Custom Cap Chew voice:**
```bash
NATURAL_PERSONALITY_CAP_CHEW=1 CAP_CHEW_VOICE=sage npm run dev
```

**Combine flags:** the two personality modes are mutually exclusive
by design. When `personalityCapChew` is ON, the handoff bridge
always returns null (single-voice; no transition to bridge).

**Persistent override via settings** (runs in an Electron devtools
console or via a settings file):
```js
global.settingsManager.set('naturalnessFlags', {
  personalityCapChew: true,   // or handoffBridge: true for multi-voice
});
global.settingsManager.set('capChewVoice', 'echo');
```

### Focus a single scenario

```bash
SCENARIO=p2-personality/03-multi-voice-handoff-fires \
  npx vitest run test/unit/naturalness-phase2.test.js
```

## The decision

Both modes ship today. Whichever you prefer is a runtime flag flip
away, not a code change.

Suggested path:

1. Turn on Cap Chew via `NATURAL_PERSONALITY_CAP_CHEW=1` and use the
   app for a full day.
2. Turn it off and use the app for a full day in multi-voice mode.
3. Pick the mode that felt more natural. Make it the default by
   changing the DEFAULT_FLAGS entry in `lib/naturalness-flags.js`
   from `false` to `true` (or leaving it at `false`).
4. If single-voice wins, keep the multi-voice bridges code in-place as
   a fallback -- they're guarded by the same flag and have no cost
   when unused.

## Rollback

Three levels (same pattern as Phase 1):

- **Per session**: `unset NATURAL_PERSONALITY_CAP_CHEW`.
- **Per user**: remove `naturalnessFlags.personalityCapChew` from
  settings.
- **Code**: the only production edit is the `getAgentVoice()` prelude
  in `lib/exchange/voice-coordinator.js`. Revert that block and the
  lib modules become dead weight (no other consumers). Tests will
  still pass because the resolver module is still valid on its own.

## What's next

Phase 2 + Phase 2.5 are both live. Future refinements that are NOT
ready to ship:

- **Debounce orchestrator chains.** Orchestrator-led compound requests
  can dispatch several sub-agents in quick succession. Each dispatch
  currently triggers its own handoff bridge candidate. A debounce
  policy ("one bridge per N seconds", or "no bridge for sub-agents of
  the same orchestrator") is worth adding once we observe interactive
  behavior.
- **Named-bridge customization.** The name extraction in
  `buildHandoffPhrase` strips " Agent" suffix and collapses calendar
  sub-agents to "calendar". More nuanced rules (e.g. "search agent"
  -> "search" only if it has a web search indicator) may help.
- **Per-user phrase style.** The current pools are a single default.
  We might surface a style setting ("minimal" = "one sec" only;
  "verbose" = always say the incoming agent name).

## Appendix: voice personalities (from VOICE-GUIDE.md)

| Voice | Personality | Best for |
|---|---|---|
| alloy | Neutral, balanced, versatile | General purpose, help systems |
| ash | Warm, friendly, personable | Music, entertainment, social |
| ballad | Expressive, storytelling, dramatic | Creative, narrative content |
| coral | Clear, professional, articulate | Business, scheduling, **Cap Chew default** |
| echo | Deep, authoritative, knowledgeable | Search, education, experts |
| sage | Calm, wise, measured | Time, spelling, precision |
| shimmer | Energetic, bright, enthusiastic | Motivation, fitness |
| verse | Natural, conversational, relatable | Weather, casual chat |
