# Naturalness - Port Contracts

The naturalness layer runs in any Node/Electron host that implements
these ports. All ports are OPTIONAL -- missing ports degrade the
corresponding phase to a no-op rather than crashing. Bring capabilities
online one at a time; start with the ports your product already has
and add the rest later.

> Design rationale: the port-and-adapter (hexagonal) shape keeps the
> naturalness core free of Electron, filesystem, or HTTP dependencies.
> A GSX flow, a CLI, a test harness, or a browser-only client can all
> satisfy these ports with whatever plumbing they already have.

## Port summary

| Port | Type | Required for | Default if missing |
| - | - | - | - |
| `speaker` | `{ speak, cancel }` | Phase 4 (barge-in), Phase 5 (undo ack) | No-op (TTS won't be cancelled on barge; undo won't speak back) |
| `ai` | `{ call }` | Phase 3 LLM fallback | Turn-taking uses heuristic only |
| `spaces` | `{ files: { read, write, delete } }` | Phase 5 repair-memory persistence | Fixes work in-memory only; lost on restart |
| `log` | `{ info, warn, error }` | All phases (observability) | Silent logger |
| `now` | `() => number` | All phases with TTL or timestamps | `Date.now` |
| `settingsManager` | `{ get, set }` | Flag resolution from user settings | Env var only |
| `getHistory` | `() => Array<{role, content}>` | Phase 5 prior-turn diff, Phase 6 recent-error detection | Returns `[]` (reduces affect sensitivity) |
| `submitTask` | `(text, options) => Promise` | Phase 4 re-submitting an interrupted command | Barge detector can still cancel, but command interrupts won't route to a new task |

## Port details

### `speaker`

The TTS side of the voice loop. Needed for two things:

1. **Cancelling in-flight TTS** when the user barges in.
2. **Speaking the repair-memory undo acknowledgment** ("OK, I'll forget that...").

```ts
interface Speaker {
  speak(text: string, options?: { skipAffectMatching?: boolean }): Promise<boolean>;
  cancel(): Promise<boolean>;
}
```

- `speak` must return (or resolve) truthy on success so the barge
  detector can chain additional actions on cancel.
- `cancel` is called synchronously from the barge detector; it should
  drop any queued audio AND signal upstream that TTS has stopped.
- `options.skipAffectMatching = true` on internal speak calls tells
  the naturalness layer NOT to run Phase 6 text adjustments. The
  undo ack opts in so its wording stays verbatim.

### `ai`

Used by Phase 3's utterance classifier when heuristics return
`'ambiguous'`. Expected shape matches the `lib/ai-service` in the
Onereach app; swap in any LLM client with the same contract.

```ts
interface AIService {
  call(
    prompt: string,
    options?: { model?: string; temperature?: number; jsonMode?: boolean }
  ): Promise<{ content: string }>;
}
```

- `content` must be a string. When JSON mode is used, content should
  still be a string of JSON; the classifier parses it.
- Network failures should throw. The classifier has a circuit
  breaker that opens after repeated errors and falls back to
  heuristic classification until the breaker half-opens again.
- Called at most ~1 time per user turn.

### `spaces`

Key-value JSON storage used by Phase 5 for cross-session persistence
of learned phonetic fixes. The scope/name parameters are namespaces.

```ts
interface Spaces {
  files: {
    read(scope: string, name: string): Promise<string | null>;
    write(scope: string, name: string, body: string): Promise<boolean>;
    delete(scope: string, name: string): Promise<boolean>;
  };
}
```

- `read` returns the raw JSON string, or `null` if the file doesn't
  exist. Malformed content is tolerated -- the repair-memory loader
  logs a warning and continues with an empty map.
- `write` is called fire-and-forget on every learn / unlearn, so
  implementations should batch/debounce if writes are expensive.
- Repair memory uses scope `"gsx-agent"` and name `"phonetic-fixes.json"`.
  A per-space variant is a Phase 5 follow-up.

### `log`

Observability hook. Must accept `(category: string, message: string, meta?: object)`.

```ts
interface Logger {
  info(category: string, message: string, meta?: object): void;
  warn(category: string, message: string, meta?: object): void;
  error(category: string, message: string, meta?: object): void;
}
```

- Naturalness uses the category `'naturalness'` for facade logs and
  `'voice'` for the direct per-phase modules.
- Every log call carries a meta object; none are error-throwing code
  paths.
- A silent logger (`() => {}` for every method) is the default and
  is safe for production if observability lives elsewhere.

### `now`

```ts
type Now = () => number; // epoch milliseconds
```

Used by:
- Phase 2.5 agent transition tracker (TTL on last-agent records)
- Phase 4 barge detector (grace window + cooldown)
- Phase 5 repair memory (LRU timestamps)
- Phase 6 affect tracker (TTL on recorded affect)

Injecting a controlled clock is how every test file achieves
determinism. Default is `Date.now`.

### `settingsManager`

Optional. When present, flag resolution (see `naturalness-flags.js`)
consults it for user-level overrides BEFORE falling back to
`DEFAULT_FLAGS`. Environment variables always take precedence.

```ts
interface SettingsManager {
  get(key: string): any;
  set(key: string, value: any): void;
}
```

Expected key: `naturalnessFlags`. Expected value shape:
`{ [flagName: string]: boolean }`.

### `getHistory`

```ts
type GetHistory = () => Array<{ role: string; content: string }>;
```

Returns recent conversation turns in chronological order. The
naturalness layer uses this for:

- Phase 5: finding the prior user turn to diff against a correction.
- Phase 6: detecting recent error turns (boosts the `frustrated`
  score) and detecting a repeat-request pattern.

`role` values are the standard `'user' | 'assistant' | 'system'`.
`content` is the plain-text transcript of the turn.

### `submitTask`

Needed for Phase 4 command interrupts. When the user barges in with
a new command during TTS playback, the detector:

1. Calls `speaker.cancel()` to stop current speech.
2. Calls `submitTask(interruptText, { metadata: { barged: true } })`
   to route the interrupt as a fresh task.

```ts
interface SubmitTask {
  (text: string, options?: {
    metadata?: { barged?: boolean; [k: string]: any };
  }): Promise<any>;
}
```

The return value is ignored by the naturalness layer; submit
semantics are entirely up to the host.

## Wiring hooks

The facade returned by `createNaturalness({ ports })` exposes six
entry points. Each maps to a specific moment in a voice/chat loop.

| Method | When to call | What it does |
| - | - | - |
| `onConnect()` | At the start of a session (WebSocket open, CLI start, etc.) | Kicks off Spaces load for repair memory so the first transcript has learned fixes available. Returns `Promise<boolean>`. |
| `onTranscriptFinal(text)` | Each time a final STT transcript is produced | Applies learned phonetic fixes. Returns `{ text, appliedCount, applied[] }`. Pass the returned `text` to your downstream pipeline. |
| `onUserTask(text, { history? })` | Each time the user submits a task / command | Runs undo shortcut -> learn shortcut -> affect record. Returns `{ handled, shortcut?, ackText?, correction?, affect? }`. If `handled: true`, SKIP normal routing for this turn. |
| `onBeforeSpeak(text, options?)` | Before every TTS `speak` call | Applies affect-match text transforms. Returns `{ text, modified, transforms }`. Pass `{ skipAffectMatching: true }` on internal/system phrases that must stay verbatim. |
| `onTtsLifecycle(phase, text?)` | When TTS starts, ends, or updates its visible text | Feeds the barge detector's internal state machine. `phase` is `'start'`, `'update'`, or `'end'`. |
| `onUserPartial(text)` | Each time the STT emits an incremental partial AND TTS is playing | Feeds the barge detector + the pause detector (if wired). |

## Minimum viable wiring

The smallest useful integration needs only `spaces` (Phase 5 persistence)
and the user-turn hook:

```js
const { createNaturalness } = require('@onereach/naturalness'); // or ./lib/naturalness

const nat = createNaturalness({
  ports: { spaces: mySpaces },
});

await nat.onConnect();

// STT path
const { text } = nat.onTranscriptFinal(rawTranscript);

// Task submission
const outcome = await nat.onUserTask(text, { history: myHistory });
if (outcome.handled) return; // undo was spoken; don't route
// ... normal routing ...

// TTS path
const { text: spoken } = nat.onBeforeSpeak(assistantReply);
await mySpeaker.speak(spoken);
```

This gives you Phase 5 repair memory + Phase 6 affect classification
at a minimum. Adding `speaker` + `submitTask` turns on Phase 4
barge-in. Adding `ai` turns on Phase 3's LLM pause fallback.
