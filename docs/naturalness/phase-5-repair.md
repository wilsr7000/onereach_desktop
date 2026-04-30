# Phase 5: Repair Memory

Learn phonetic corrections from the user and apply them transparently
on future transcriptions, so the same mishearing doesn't derail the
same command twice.

**Status:** shipped, always on (`repairMemory: true` by default).

## User-facing story

Before:
  You: "play jazz"
  App: (heard "play jess" -- no match, no result)
  You: "I meant jazz"
  App: (learns nothing, next time still mis-transcribes "jazz" as "jess")

After:
  You: "play jazz"
  App: (hears "play jess" -- fails to match)
  You: "I meant jazz"
  App: (learns jess -> jazz, persists the fix to Spaces)
  Later: You: "play jazz"
  App: (hears "play jess", the repair layer rewrites to "play jazz"
         before the router sees it -> works on the first try)

Undo, any time:

  You: "forget that fix"
  App: "OK, I'll forget that \"jess\" meant \"jazz\"."

Implicit undo via a reverse correction also works ("cycle detection"):

  (app learns jess -> jazz by mistake)
  You: "I meant jess" (after the next turn where the app rewrote jazz)
  App: (detects the inverse, deletes the bad fix without installing
        the reverse; no flip-flop)

## Architecture

```
STT transcript (Realtime API)
  -> voice-listener on transcription.completed
     -> repair-memory.applyFixes(text)    // rewrite learned mis-hearings
        -> broadcast "transcript" event with corrected text
           -> HUD / router / pipeline

User submits a task
  -> exchange-bridge.processSubmit(text)
     -> detectUndoCorrection(text)  // Shortcut 1
        -> if matched: unlearnLast() + speak ack + RETURN
     -> detectCorrection(text, priorUserText)  // Shortcut 2
        -> if matched: learnFix(heard, meant)  // cycle detection inside
                      (does NOT short-circuit; utterance flows on)
        -> autosave to Spaces ("gsx-agent/phonetic-fixes.json")
```

## Modules

| File | Purpose |
| - | - |
| `lib/naturalness/repair-memory.js` | In-memory Map of fixes with `learnFix`, `unlearnFix`, `unlearnLast`, `getLastLearned`, `applyFixes`, Spaces load/save. |
| `lib/naturalness/correction-detector.js` | `detectCorrection` (learn intent) + `detectUndoCorrection` (undo intent). |
| `lib/naturalness/repair-memory-singleton.js` | Shared instance. Lazy-loads from Spaces, auto-saves on every mutation, inert when flag off. |
| `voice-listener.js` | Calls `ensureLoaded()` on connect + applies fixes on `transcription.completed` before broadcasting. |
| `src/voice-task-sdk/exchange-bridge.js` | Runs undo + learn shortcuts early in `processSubmit`. Undo short-circuits; learn piggy-backs. |

## Detected learn patterns

| Pattern | Example | Needs prior turn? |
| - | - | - |
| `I said X not Y` | "I said jazz not jess" | no |
| `I meant X not Y` | "I meant jazz not jess" | no |
| `not Y, X` / `not Y I meant X` | "not jess, jazz" | no |
| `I meant X` / `I said X` / `no I meant X` | "I meant jazz" | yes |
| `actually X` | "actually jazz" | yes |
| `no it's X` / `no that was X` | "no that was alice" | yes |

When a prior turn is required, the detector tokenises the prior
utterance, strips common command verbs ("play", "call", "schedule",
"a", "the"...), and picks the LAST remaining token as the "heard"
value.

## Detected undo patterns

| Pattern | Example |
| - | - |
| `forget that fix / correction / learning / rule` | "forget that fix" |
| `forget the last fix / correction` | "forget the last correction" |
| `forget what you learned / learnt` | "forget what you learned" |
| `undo that / the last fix / correction` | "undo the last correction" |
| `never mind that / the last fix / correction` | "never mind that fix" |
| `that / the (last) fix / correction was wrong` | "the last fix was wrong" |

Bare "never mind" / "forget it" / "undo" on their own are **not**
treated as repair-memory undo -- too ambiguous with task cancellation.
The user must mention "fix" / "correction" / "learning" / "rule" (or
"what you learned") to unambiguously target the repair memory.

## Safeguards

- **Cycle detection:** learning B→A when A→B already exists *removes*
  A→B instead of installing the inverse. Prevents flip-flop rewrites
  and lets the user walk back an auto-learn just by re-correcting.
- **Voice undo:** `unlearnLast()` removes the most recent fix and is
  wired to explicit undo phrases. The most recent fix is tracked by
  the store itself (`getLastLearned()`), so undo is always available
  even across sessions.
- **Poison-heard filter:** single-word corrections where the "heard"
  token is a common English word (`a`, `the`, `is`, `you`, `yes`, etc.)
  are rejected.
- **Word-boundary matching:** `jess` matches as a full word, never
  inside `jessica`.
- **Non-cascading apply:** every fix is matched against the ORIGINAL
  transcript text, then the chosen non-overlapping matches are
  spliced in a single pass. Longer matches win on span overlap. This
  guarantees fixes cannot feed each other even if cycle detection
  somehow misses a pair.
- **Capacity eviction (default 200 fixes):** least-recently-hit fixes
  are dropped past capacity; the just-learned entry is never evicted.
- **Hit counting:** every learn and every apply updates a counter, so
  the LRU policy tracks real usage.
- **Identical heard/meant rejected** so an already-correct transcript
  doesn't generate no-op fixes.

## Persistence

Fixes are stored in the user's Spaces at
`gsx-agent/phonetic-fixes.json`:

```json
{
  "version": 1,
  "savedAt": 1713811200000,
  "fixes": [
    { "heard": "jess", "meant": "jazz", "hits": 3, "lastHit": 1713811000000 }
  ]
}
```

Write-through autosaves happen on every `learnFix` / `unlearnFix` /
`unlearnLast` / `clear`, fire-and-forget so callers aren't blocked.
Voice-listener calls `ensureLoaded()` during connect so the first
transcript after startup has the user's fixes in memory.

## Disabling / rolling back

The feature is on by default, but can still be toggled via the
standard flag mechanism:

- `NATURAL_REPAIR_MEMORY=0` env var
- `settingsManager.naturalnessFlags.repairMemory = false`

Turning the flag off yields the inert singleton: `applyFixes` is a
pass-through, `learnFix` / `unlearnFix` / `unlearnLast` return
`{ added: false, reason: 'flag-off' }` / `{ removed: false, reason: 'flag-off' }`.

## Tests

| File | Coverage |
| - | - |
| `test/unit/repair-memory.test.js` | Map semantics, poison words, capacity, cycle detection, unlearnFix / unlearnLast / getLastLearned, non-cascading apply, Spaces roundtrip. |
| `test/unit/correction-detector.test.js` | Every learn pattern, every undo pattern, anti-pattern cases, defensive inputs. |
| `test/unit/repair-memory-integration.test.js` | Singleton lifecycle, flag gating (both ways), voice-listener slice, exchange-bridge slice, full learn/apply/undo loops, cycle-undo via reverse correction. |

Run: `npm run test:voice-scenarios`

## Known limitations / next steps

1. **Heuristic last-token pick:** when multiple non-verb tokens remain
   in the prior utterance, we default to the LAST one. Covers the
   common proper-noun correction case; ambiguous multi-content-word
   mishearings fall back to the explicit `I said X not Y` pattern.
2. **No undo by-name yet:** today `unlearnLast()` is the only voice
   path. A by-name undo (`"forget the jess fix"`) could target older
   entries. Follow-up work.
3. **Per-space scoping:** fixes are stored under `gsx-agent` today,
   spanning the whole user. A space-scoped variant (per playbook)
   could reduce cross-context collisions.
