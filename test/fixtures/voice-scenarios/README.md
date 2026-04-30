# Voice Scenarios

Fixture format for naturalness scenario tests. Each JSON file describes a
single scenario: feature-flag state, a sequence of timed steps, and the
assertions that should hold when the steps are done.

## When to add a scenario

- A new naturalness phase ships → add scenarios proving the new behavior is
  observable through TTS / mic events.
- A bug is reported → add a scenario that reproduces it, then fix the code
  until the scenario passes.
- The pipeline's contract changes → update or add scenarios so future
  regressions are caught.

Scenarios run via `npm run test:voice-scenarios` and through vitest in
[`test/unit/naturalness-baseline.test.js`](../../unit/naturalness-baseline.test.js).

## File format

```json
{
  "name": "short-kebab-name",
  "description": "One sentence on what this scenario proves.",
  "phase": "baseline | p1-confirmation | p3-pause | ...",
  "flags": { "calibratedConfirmation": false },
  "ttsWpm": 170,
  "steps": [
    { "type": "userSays", "text": "hello" },
    { "type": "wait", "ms": 100 },
    { "type": "systemSpeaks", "text": "hi there", "voice": "coral" },
    { "type": "assert", "ttsContains": "hi" }
  ]
}
```

### Top-level fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Human-readable slug; shown in test output. |
| `description` | yes | One-line explanation of what passes / fails. |
| `phase` | yes | `baseline` or the phase name (e.g. `p1-confirmation`). Used for grouping in reports. |
| `flags` | no | Object mapping naturalness flag names to booleans. Applied via env vars for the duration of the scenario. |
| `ttsWpm` | no | Words-per-minute rate the TTS mock uses for this scenario. Default 170. Lower values stretch durations out and make clock assertions easier to write. |
| `steps` | yes | Ordered list of steps. See below. |

### Step types

**User input (mic):**
- `{ "type": "userSays", "text": "...", "confidence": 1.0 }` -- emits a final transcript.
- `{ "type": "userSaysPartial", "text": "..." }` -- emits an interim (`final: false`) transcript.
- `{ "type": "userStreams", "partials": ["set", "set a", "set a timer"], "partialIntervalMs": 100 }` -- streams partials then a final; advances mic clock between partials.

**System output (TTS):**
- `{ "type": "systemSpeaks", "text": "...", "voice": "coral", "priority": 2 }` -- drives `tts.speak()`.
- `{ "type": "systemCancels" }` -- drives `tts.cancel()`.
- `{ "type": "systemPlaythrough" }` -- fast-forward past the currently playing utterance.

**Clock:**
- `{ "type": "wait", "ms": 250 }` -- advance *both* mic and TTS clocks by the same amount. Models real-world elapsed time.

**Custom hook:**
- `{ "type": "hook", "name": "myHook", "args": { "anything": true } }` -- invokes a named function from the `hooks` map passed to `runScenario`. Lets tests inject real pipeline calls without leaking them into JSON.

**Assertions:**
- `{ "type": "assert", "ttsContains": "timer" }`
- `{ "type": "assert", "ttsNotContains": "error" }`
- `{ "type": "assert", "ttsSpokenCount": 2 }`
- `{ "type": "assert", "ttsIsSpeaking": true }`
- `{ "type": "assert", "lastTtsCancelled": true }`
- `{ "type": "assert", "lastTtsPreempted": true }`
- `{ "type": "assert", "lastTtsPlayedMsLt": 500 }`
- `{ "type": "assert", "lastTtsPlayedMsGt": 100 }`
- `{ "type": "assert", "micEventCount": 3 }`
- `{ "type": "assert", "flagEnabled": "calibratedConfirmation" }`
- `{ "type": "assert", "flagDisabled": "bargeIn" }`
- `{ "type": "assert", "metaEquals": { "decision": "ack-and-dispatch", "stakes": "low" } }`

A single `assert` step may combine multiple keys -- all must hold for the
step to pass.

### Hooks and the `meta` scratch bag

`hook` steps invoke a function registered by the test file. Fixtures
themselves are JSON so they cannot carry code; the hook is where live
integration happens. Hooks receive `(args, ctx)` where `ctx` has
`{ tts, mic, meta, hooks }`.

Hooks can write to `ctx.meta` to expose non-TTS/non-mic state for
later assertions. Example: Phase 1's `pipelineSim` hook writes
`{ decision, stakes, reason, phrase, flagActive }` so fixtures can
assert against the policy decision directly without parsing TTS text.

Register hooks on the test side:

```js
import { pipelineSim } from '../harness/phase1-sim';
const result = await runScenario(scenario, { hooks: { pipelineSim } });
```

Use them from fixtures:

```json
{
  "type": "hook",
  "name": "pipelineSim",
  "args": {
    "intent": "delete all my emails",
    "executionType": "action",
    "winnerConfidence": 0.98
  }
}
```

## Running

```bash
# All scenarios, via vitest:
npm run test:voice-scenarios

# One file interactively:
npx vitest run test/unit/naturalness-baseline.test.js

# One scenario via env var:
SCENARIO=baseline/01-tts-capture npx vitest run test/unit/naturalness-baseline.test.js
```

## Directory layout

```
test/fixtures/voice-scenarios/
├── README.md                  <- this file
├── baseline/                  <- current behavior, should always pass
│   ├── 01-tts-capture.json
│   ├── 02-flag-defaults.json
│   ├── 03-flag-env-override.json
│   ├── 04-partial-streaming.json
│   └── 05-cancel-timing.json
├── p1-confirmation/           <- added when Phase 1 ships
└── ...
```

Scenarios in `baseline/` should never change their expectations except via a
deliberate contract change. They are the regression net -- anything that
breaks them is a bug, not a feature.
