# Phase 4 — Barge-In

Ship status: **shipped, always on** (flag removed at the always-on cutover).

> **Note (always-on cutover):** The `bargeIn` flag is gone. The full
> barge pipeline (TTS lifecycle notifications + transcription-delta
> feeding + echo filter + classifier) runs on every voice session.
> `NATURAL_BARGE_IN` env vars / settings are no longer read. The mic-
> gating fallback that used to clear the input buffer during TTS has
> also been deleted.

## What this phase does

Lets the user interrupt the assistant mid-speech. Today the Realtime
API's server-side VAD is the only barge mechanism, and the desktop
app actively gates the mic while TTS plays to prevent self-listening.
Phase 4 adds a real barge-in pipeline: user speech heard while TTS is
playing (or within a short grace window after) triggers a classified
interruption.

### Three classifications

| Kind | Example | Effect |
|---|---|---|
| **stop** | "stop", "wait", "cancel", "hold on", "actually" | cancel TTS; do NOT auto-submit |
| **command** | "what about tomorrow", "play some jazz", "schedule a meeting" | cancel TTS; AUTO-SUBMIT the text as a fresh task |
| **ack** | "yeah", "uh-huh", "okay", "right" | **NOT** a barge — backchannel; TTS continues |

Plus two pre-filter suppressions before classification:

- **echo**: mic catching TTS leakage. If the user partial's tokens are
  all present in the current TTS text (and no hard barge marker
  appears), the partial is discarded as echo.
- **cooldown**: after a barge fires, a second attempted barge within
  500ms is suppressed to avoid storm-fire when the user keeps talking.

## Architecture

```
voice-speaker.js --- onTtsStart/onTtsUpdate/onTtsEnd ---> BargeDetector
                                                              |
voice-listener.js --- onUserPartial ----------------------->  |
                                                              v
                                                         echo-filter
                                                              |
                                                        (passes)
                                                              v
                                                       barge-classifier
                                                              |
                                            stop / command / unclear -> onBargeIn
                                                          ack -> suppressed
```

### Files added (non-test)

- `lib/naturalness/echo-filter.js` — pure fn `isLikelyEcho(candidate, ttsText)`.
  Token-level Jaccard + full-subset detection + hard-barge token override.
- `lib/naturalness/barge-classifier.js` — pure fn `classifyBarge(text)`.
  Phrase tables for stop / ack, command lead tokens, deterministic.
- `lib/naturalness/barge-detector.js` — stateful orchestrator; event
  API `onTtsStart / onTtsUpdate / onTtsEnd / onUserPartial / reset`;
  grace window + cooldown timing; injectable clock.

### Files modified (Phase 4.5)

- **[`lib/naturalness/barge-detector-singleton.js`](../../lib/naturalness/barge-detector-singleton.js)** (new) — shared
  detector instance with wired callbacks:
  - `onBargeIn` → cancel TTS via `voice-speaker.cancel()`; for
    `kind: 'command'`, also submit the user text as a new task via
    `hud-api.submitTask(text, { toolId: 'voice', metadata: { barged: true } })`.
  - `onEchoSuppressed` + `onIgnored` → log for diagnostics.
  - Dependency-inject speaker + submitTask + log for tests via
    `configureBargeDetector()`; `resetSharedBargeDetector()` for test
    isolation.
- **`voice-speaker.js`** — added `_notifyBargeDetector(method, text)`
  helper that lazy-requires the singleton only when `bargeIn` flag is
  on. Wired into `_doSpeak` (start + completion + error) and
  `_doCancel` so the detector always has accurate TTS lifecycle state.
  The helper swallows errors: the barge layer must never block TTS.
- **`voice-listener.js`** — three event-case edits guarded by
  `isFlagEnabled('bargeIn')`:
  - `speech_started`: when flag on + TTS playing, keep the input
    buffer instead of clearing it. This lets the Realtime API
    transcribe the user's potential interrupt.
  - `speech_stopped`: when flag on + TTS playing, process the event
    normally instead of ignoring.
  - `transcription.delta`: when flag on + TTS playing, accumulate a
    separate `_bargePartial` and feed cumulative text to the shared
    detector via `onUserPartial()`. The accumulator resets on
    `speech_started` and `transcription.completed`.

## Acceptance criteria

- [x] Hard barge words ("stop", "wait", "actually", "cancel", "nevermind",
  "hold", "pause", "shut", "quiet", "enough") always win over the echo
  filter when present in user speech but not in TTS.
- [x] User partials that are strict subsets of TTS content are rejected
  as echo (mic leak).
- [x] Short acks (yeah / uh-huh / okay / right / sure / mm-hmm /
  gotcha / etc.) never fire a barge.
- [x] Commands mid-TTS fire with `kind: 'command'` and carry the full
  text so the caller can submit it as a new task.
- [x] Stops mid-TTS fire with `kind: 'stop'` and carry no task intent.
- [x] Barges arriving within 300ms after `onTtsEnd` still fire
  (grace window for echo tails and client latency).
- [x] After a barge fires, subsequent user partials within 500ms are
  suppressed (`kind: 'cooldown'`).
- [x] Detector state is resettable; `totalBarges` counter tracks across
  a single detector instance for diagnostics.
- [x] Callback errors in `onBargeIn` do not corrupt detector state.
- [x] Phase 4.5: wired into voice-speaker + voice-listener behind the
  `bargeIn` flag.
  - [x] Mic buffer is kept (not cleared) when flag on + TTS playing,
    so the user's interrupt actually reaches transcription.
  - [x] TTS lifecycle (`onTtsStart` / `onTtsEnd`) is propagated to
    the detector at every entry + exit point of `_doSpeak` /
    `_doCancel`, including error paths.
  - [x] `voice-speaker.cancel()` is called on any barge (`stop` /
    `command` / `unclear`); `command` barges additionally submit the
    user text as a new task.
  - [x] `submitTask` failures after a successful cancel are logged
    but do not propagate (user still hears silence; task may retry
    manually).
  - [x] 199 agent tests unaffected.

## Latency budget (for 4.5 integration)

- User speech → detector evaluation: ≤ 20ms (pure function).
- Detector → `voice-speaker.cancel()`: ≤ 50ms (single event loop hop).
- TTS silence after `cancel()`: ≤ 200ms (depends on the speech queue
  implementation; may need to truncate the pending audio buffer).
- **Total p95 budget**: 300ms from start of user speech to TTS silent.
  The acceptance target in the overall plan.

## How to test

### Unit + scenarios

```bash
npm run test:voice-scenarios
```

Phase 4 adds:

- `echo-filter.test.js`       — 27 tests
- `barge-classifier.test.js`  — 47 tests
- `barge-detector.test.js`    — 21 tests
- `naturalness-phase4.test.js` — 9 scenario runs

### Focused scenario

```bash
SCENARIO=p4-barge/04-echo-suppressed \
  npx vitest run test/unit/naturalness-phase4.test.js
```

### Interactive smoke

```bash
NATURAL_BARGE_IN=1 npm run dev
```

| Say during TTS | Expected |
|---|---|
| "stop" | TTS cancels, no new task |
| "wait, actually..." | TTS cancels, treated as stop (text not submitted) |
| "what about tomorrow" | TTS cancels, new task with that text |
| "yeah" / "mm-hmm" | TTS keeps going |
| [nothing] | TTS continues normally |

Look for log entries:
- `[BargeDetector] barge fired` — user speech classified as interrupt
- `[BargeDetector] echo suppressed` — mic caught TTS leakage, filtered out
- `[BargeDetector] ignored` — ack, cooldown, or no-TTS state

## Things to interactively validate

- **False-positive rate** on a noise corpus — aim < 2%. In particular:
  room noise during TTS should not trigger a cancel. Watch the logs
  for `[BargeDetector] echo suppressed` vs `[BargeDetector] barge
  fired` counts during idle play.
- **Latency** — p95 user-speech → TTS-silence under 300ms. Measure
  the delta between "user started speaking" and "TTS audio actually
  stopped".
- **Comfort** — users perceive "I can actually interrupt now" without
  also feeling "the assistant cuts itself off too eagerly".
- **Ack handling** — "yeah" / "right" during TTS should not stop it.
  If users consistently report unwanted stops, widen `ACK_PHRASES` in
  `lib/naturalness/barge-classifier.js`.
- **Streaming chunk sensitivity** — the first classifiable partial
  wins due to cooldown suppression. For piecewise streaming ("what "
  then "about " then "tomorrow"), the submitted task is just "what".
  The integration test documents this limitation; in practice the
  Realtime API batches multi-word deltas so it's rarely a problem.
- **Transcript server latency** — if the Realtime API partial
  transcripts lag too much, the barge may feel sluggish; consider a
  local VAD-only detection for hard barge words (future Phase 4.6).
- **TTS cancel latency** — `voice-speaker.cancel()` flushes the
  speechQueue; the renderer also needs to clear its audio buffer
  (already wired via `clear_audio_buffer` broadcast).

## Rollback

- Per session: `unset NATURAL_BARGE_IN`. With the flag off, every
  wired block short-circuits. The original mic-gating logic resumes
  (buffer cleared on speech_started, speech_stopped ignored) and the
  detector is never touched.
- Per user: clear `naturalnessFlags.bargeIn` in settings.
- Code: revert the `_notifyBargeDetector` helper + call sites in
  `voice-speaker.js`, the three case-block edits in `voice-listener.js`,
  and remove `lib/naturalness/barge-detector-singleton.js`. The
  detector + classifier + echo-filter modules become inert but are
  otherwise harmless.

## Dependencies on other phases

- **Phase 3 (pause detection)** — not a strict dependency; barge-in
  uses its own state machine. But the two phases share conceptual
  ground: both depend on tight cooperation between the voice listener
  and the voice speaker. Validating Phase 3 interactively first will
  de-risk Phase 4.
- **Phase 2 (personality)** — independent; voice selection still
  flows through `voice-coordinator.getAgentVoice()` exactly as today.

Once 4.5 ships, this is the largest single naturalness win available
to the app.
