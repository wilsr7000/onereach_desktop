# Voice Orb — Functionality & Implementation Evaluation

A reference map of what the voice orb does, how each piece is implemented, and
why the current design is a solid example of natural voice interaction. Written
2026-07-01 after the "daily brief did nothing" hardening pass.

## Architecture in one picture

Two decoupled channels — this is the core mental model:

```
DISPATCH (request in) ─ never depends on the answer channel
  mic → voice-listener (WS → OpenAI Realtime) → handle_user_request tool call
    → broadcast 'function_call_transcript'
      → orb renderer handleFunctionCallTranscript → agentHUD.submitTask → exchange
      └ OR (no renderer subscribed) → voice-listener dispatches to the exchange directly

ANSWER (result out) ─ two sub-paths
  (A) async agent results (daily brief, most real work):
        exchange task:settled → voice-speaker.speak()  [audio_wav, taskResult:true]
        — independent of the realtime socket; plays even if the orb is idle
  (B) synchronous replies (clarifications, cached): orb → respondToFunction(callId, text)
        → voice-listener writes function_call_output → realtime model voices it
```

Main process owns the realtime socket + TTS; the renderer owns UI state. Keeping
dispatch independent of the answer channel is what makes the pipeline robust.

## Functionality inventory + implementation assessment

| Capability | Where | Assessment |
|---|---|---|
| Speech-to-text (realtime) | `voice-listener.js` (OpenAI Realtime `gpt-realtime-2`) | Solid. Clean event switch; usage/budget tracked. |
| Request routing (tool call) | `voice-listener.js` `handle_user_request` → `function_call_transcript` | Solid after hardening (orphan dispatch fallback). |
| Agent dispatch | `orb.html` `agentHUD.submitTask` → `hud-api.processSubmit` → exchange | Solid; single canonical submit path shared by renderer + main. |
| TTS — async results | `voice-speaker.js` (`SpeechQueue`, OpenAI TTS) via `audio_wav` | Solid; independent channel, survives orb-idle via `taskResult:true`. |
| TTS — sync replies | realtime `response.create` via `respondToFunctionCall` | Solid; affect-tuned; empty result = silent ack (no double audio). |
| Orb state machine | `lib/orb/orb-state.js` (`VALID_TRANSITIONS`) | Solid; explicit phases + guarded transitions. |
| Event routing | `lib/orb/orb-event-router.js` (OUTPUT / LIFECYCLE / COMMITTED / INPUT) | Solid after de-gate; committed requests bypass phase gate. |
| Barge-in / turn-taking | `lib/naturalness/barge-detector.js` (+ echo-filter, classifier) | **Strong example.** Grace window, cooldown, echo suppression, ack-vs-stop classification (backchannels don't interrupt). 89 tests. |
| Affect matching | `lib/naturalness/affect-tracker.js` → tone-steered `response.create` | Good; feature-flagged; steers vocal tone to user state. |
| Repair memory | `lib/naturalness/repair-memory` | Good; applies learned phonetic fixes to transcripts. |
| Realtime resilience | `voice-listener.js` reconnect + `openai-adapter` keepalive | Solid; jittered backoff, generation-stale detection, WS ping. |
| Connection lifecycle (renderer) | `lib/orb/orb-lifecycle.js` | Solid; recoverable drops don't force-idle a live turn. |
| Never-silent guarantee | `lib/orb/orb-resilience.js` (dead-end spoken fallback) | Good; a timed-out turn speaks a retry prompt. |
| Mic-permission UX | `orb.html` + `speech:open-mic-settings` | Good; denial → actionable prompt → opens the Microphone setting. |
| Auth logging | `logAuthEvent` → central event manager (60+ `auth:*` events) | Strong; structured, troubleshoot-friendly. |

## The turn contract (test-locked invariants)

These are pinned by `test/unit/orb-voice-turn-contract.test.js` (real state
machine + real router) so they can't silently regress:

1. A committed request (`function_call_transcript`) is delivered to its handler
   **even while speaking or idle** — never phase-dropped. It's the model's
   authoritative tool call, not raw mic input.
2. A non-committed input (`transcript`) is **still phase-gated** — the de-gate
   is narrow, not a hole.
3. Async result audio (`audio_wav`) is delivered **regardless of phase**.
4. The state machine permits `idle → speaking` so an async result can play
   after the orb has returned to idle.

## Silent-failure classes that were closed

The "daily brief did nothing" reports were three distinct silent-loss paths,
each now fixed and tested:

- **Orphaned request** — the orb unsubscribed microseconds before the tool call
  landed, so the broadcast reached zero subscribers. Fix: `voice-listener`
  dispatches to the exchange directly from main when there are no subscribers.
- **Phase-dropped request** — the router gated `function_call_transcript` behind
  `canAcceptInput()`, dropping it while the orb briefly spoke/idled. Fix: router
  exempts committed requests from the phase gate.
- **Dropped result** — the async result tried `idle → speaking`, which the state
  machine rejected. Fix: allow that transition.

Transport-level resilience (reconnect + TTS fallback for a dead/stale realtime
slot) was added first, but note the above were **dispatch/playback** bugs, not
transport bugs — the 1005 socket drop was a red herring.

## What makes this a good example

- **Decoupled channels**: request dispatch never depends on the answer channel,
  so a broken/absent realtime session can't eat a request.
- **Authoritative vs advisory input**: committed tool calls bypass phase gating;
  raw mic input stays gated. The distinction prevents both silent loss and echo.
- **Never end in silence**: watchdog + dead-end fallback guarantee the user
  always hears something.
- **Naturalness as a first-class layer**: barge-in classification, affect,
  repair-memory are separated, flagged, and unit-tested rather than tangled into
  the transport.
- **Executable contracts**: cross-module invariants are pinned by tests, not
  just comments.

## Remaining opportunities

- A full simulated voice-turn harness that also drives the `orb.html` handler
  logic (currently the handlers aren't extracted, so only state+router compose
  in tests).
- Notarized releases (unnotarized auto-update resets the mic TCC grant on some
  updates — the mic-UX work mitigates but doesn't remove this).
