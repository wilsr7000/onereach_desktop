# Phase 3 — Natural Pause Detection

Ship status: **retired in the GA Realtime API 2 migration (May 2026)**.

> **Note (Realtime API 2 cutover):** The custom pause detector is no longer
> wired into `voice-listener.js`. The GA Realtime API ships `semantic_vad`
> which decides turn boundaries model-side, removing the need for our
> 100 ms silence ticker and LLM classifier path. The detector code at
> `lib/naturalness/pause-detector.js` remains in the tree for unit tests
> and possible reuse but is dead code for the orb's listener path.
>
> If `semantic_vad` ever regresses, swap `audio.input.turn_detection` in
> `voice-listener.js` back to `{ type: 'server_vad', threshold: 0.6,
> silence_duration_ms: 1200 }` and re-wire `_ensurePauseDetector` /
> `_startSilenceTicker` calls from the git history (commit before the
> Realtime 2 migration).
>
> The historical notes below are kept verbatim so the design intent isn't
> lost.

## What this phase does

Replaces the all-or-nothing silence-based end-of-turn ("commit after 1.2s
of silence") with a dynamic policy that commits earlier when the
utterance looks complete and later when it looks like the user is
pausing mid-thought. The OpenAI Realtime API's server-side VAD remains
the floor; this layer can only commit *earlier* via `input_audio_buffer.commit`.

### Three decision bands

| Classification | Example | Commit window |
|---|---|---|
| **Complete** (fast-path) | "what time is it", "play some jazz", "cancel" | `fastFinalizeMs` (default **400ms**) |
| **Incomplete** | "call alice and...", "set the...", "uh" | hold until **maxWaitMs** (default **1100ms**) |
| **Ambiguous** | "meeting tomorrow", "jazz music" | wait **waitMs** (default **700ms**), then consult the LLM classifier |

All three thresholds are below the current 1200ms server VAD floor, so
the policy only tightens things; nothing ever takes longer than today.

## Architecture

```
voice-listener.js (Phase 3.5 integration point)
         |
         v
   PauseDetector (lib/naturalness/pause-detector.js)
         |
   +-----+-----+
   |           |
   v           v
turn-taking   utterance-classifier
(regex +       (LLM-backed, cached,
 policy table)  circuit-broken)
```

### Files added (non-test)

- `lib/naturalness/turn-taking.js` — pure decision function; regex
  tables for "complete", "incomplete", and single-word fast-paths;
  returns `{action, reason, classification, hitMaxWait}`.
- `lib/naturalness/utterance-classifier.js` — LLM-backed async
  completeness check. Cache (2s TTL), circuit breaker (3 failures →
  10s open). AI is injected so tests never call OpenAI.
- `lib/naturalness/pause-detector.js` — stateful orchestrator. Feed it
  `onPartial`, `setSilence`, `resetOnSpeech`; call `evaluate()` to run
  the policy; receive `onCommitReady` once per turn.

### File modified (Phase 3.5)

- `voice-listener.js` — added pause-detector state + helpers and
  hooks into the existing event dispatch. Sequence per turn:
  1. `input_audio_buffer.speech_started` → `detector.resetOnSpeech()`,
     accumulator cleared, ticker stopped.
  2. Each `conversation.item.input_audio_transcription.delta` →
     accumulator grows, `detector.onPartial(accumulatedText)`.
  3. `input_audio_buffer.speech_stopped` → start silence ticker at
     100ms intervals. Each tick: `detector.setSilence(elapsed)` then
     `await detector.evaluate()`. Single-flight lock prevents
     concurrent LLM calls stacking up.
  4. If the detector's `onCommitReady` fires, `commitAudio()` runs
     (sends `input_audio_buffer.commit` to the server), ticker stops,
     accumulator clears.
  5. `conversation.item.input_audio_transcription.completed` → server
     committed the turn. Ticker stops, accumulator clears, detector
     resets. This handles both "we committed first" and "server hit
     its 1200ms VAD floor before we did".
  6. The detector is **lazy-initialized** on the first
     `speech_started` when the flag is on. Zero cost when flag off.

## Acceptance criteria

- [x] Fast-path partials (complete utterances, single-word commands)
  commit at 400ms silence.
- [x] Incomplete partials (trailing conjunctions, hanging articles,
  bare fillers) are held through long pauses, committing only at the
  1100ms ceiling — below the 1200ms server VAD floor, so the server
  cannot pre-empt us.
- [x] Ambiguous partials past 700ms consult the LLM classifier; if the
  LLM says "complete" with confidence ≥ 0.6 we commit, otherwise we
  hold.
- [x] LLM failures do not block the turn; the circuit breaker keeps
  costs bounded under burst failures.
- [x] Once a turn commits, the detector is idempotent until `resetOnSpeech`
  or `reset` is called.
- [x] Mid-utterance silence that never exceeds `fastFinalizeMs` never
  triggers commit.
- [x] All existing agent tests (199) unaffected.
- [x] Phase 3.5 integration in `voice-listener.js`:
  - [x] Detector lazy-initialized on first speech burst when flag on.
  - [x] Partial transcripts accumulated across delta events.
  - [x] Silence ticker at 100ms, single-flight so slow LLM calls don't
    queue up.
  - [x] Commit fires early on complete partials; server's 1200ms VAD
    remains the backstop.
  - [x] `speech_started` resets cleanly so user resuming doesn't
    auto-commit a half-utterance.
  - [x] `transcription.completed` resets for the next turn regardless
    of who committed first.

## How to test

### Unit + scenarios

```bash
npm run test:voice-scenarios
```

Phase 3 adds:

- `turn-taking.test.js`        — 55 tests
- `utterance-classifier.test.js` — 12 tests
- `pause-detector.test.js`       — 16 tests
- `naturalness-phase3.test.js`   — 7 scenario runs

### Focused scenario

```bash
SCENARIO=p3-pause/05-ambiguous-consults-llm-and-commits \
  npx vitest run test/unit/naturalness-phase3.test.js
```

### Interactive smoke

```bash
NATURAL_PAUSE_DETECTION=1 npm run dev
```

Say the following slowly and listen for a tightening of end-of-turn:

| Utterance | Expected behavior |
|---|---|
| "what time is it" [pause] | commits ~400ms, quick response |
| "cancel" | commits near-instantly |
| "call alice and... [long pause]" | stays listening, commits at ~1100ms if nothing follows |
| "call alice and... [short pause] ...bob" | resumes and commits on completion |
| "morning brief" [pause] | LLM decides; usually commits at ~700ms |

## What to validate interactively

With `NATURAL_PAUSE_DETECTION=1` running live:

- The LLM classifier's `fast` profile (Haiku-tier) returns in under
  ~250ms so the ambiguous path doesn't feel laggy. Look for
  `[PauseDetector] consulting LLM classifier` log entries and check
  the turnaround time.
- `fastFinalizeMs = 400` is not too aggressive for users who pause
  briefly before the last word. If this is a problem, tune via
  `thresholds` passed to `createPauseDetector` in voice-listener.js
  (currently uses defaults).
- The classifier's circuit breaker doesn't flip open during normal
  rate-limit friction. Watch for `circuit-open` in the detector's
  classifier diagnostics.
- Concurrent-evaluation guard holds under burst speech. We hold the
  lock inside the silence ticker so only one `evaluate()` runs at a
  time; if the LLM takes > 100ms, subsequent ticks are skipped.

## Rollback

- Per session: `unset NATURAL_PAUSE_DETECTION`. With the flag off,
  `_ensurePauseDetector()` returns null and every event hook is a
  no-op. Existing server-VAD behavior at 1200ms silence is unchanged.
- Per user: clear `naturalnessFlags.pauseDetection` in settings.
- Code: revert the constructor fields, helper methods, and event-case
  edits in `voice-listener.js`. The `lib/naturalness/pause-detector.js`
  + `turn-taking.js` + `utterance-classifier.js` modules become inert
  (no other consumers) but stay harmless.

## Foundation for Phase 4 (barge-in)

Phase 3 gives us the state machine and the event API Phase 4 needs.
Barge-in reuses:

- `onPartial` during TTS playback to detect new user speech.
- `resetOnSpeech` to start a fresh turn when the user interrupts.
- The same `evaluate()` policy to decide when the interruption itself
  is a complete new command.

Do not ship Phase 4 before Phase 3.5 has been running in production
for at least a few days; pause detection is the easier of the two and
exercises the same plumbing.
