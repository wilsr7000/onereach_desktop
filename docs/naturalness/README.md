# Naturalness Roadmap

A multi-phase effort to make the voice + chat interaction with
Cap Chew feel natural: fewer pointless acks, a consistent personality,
graceful handling of pauses, real mid-speech interrupts, learned
phonetic fixes so the app stops re-tripping on the same mis-hearings,
and tone-matching so the assistant modulates with the user.

## Using the layer from another product

The naturalness layer is exported as a stable package with a single
entry point. See:

- **[ports.md](./ports.md)** - contracts for every host-provided
  dependency (speaker, spaces, log, now, ai, etc.)
- **[integration-guide.md](./integration-guide.md)** - step-by-step
  wiring for a new consumer (Node / WISER Playbooks / GSX flow / CLI)

TL;DR:

```js
const { createNaturalness } = require('./lib/naturalness'); // the barrel

const nat = createNaturalness({ ports: { spaces, getHistory, log } });
await nat.onConnect();

// STT path
const { text } = nat.onTranscriptFinal(rawTranscript);

// Task submission
const outcome = await nat.onUserTask(text);
if (outcome.handled) return;

// TTS path
const { text: adjusted } = nat.onBeforeSpeak(assistantReply);
await speaker.speak(adjusted);
```

## Status

| Phase | Feature | Status | Flag |
| - | - | - | - |
| 1 | Calibrated confirmation (ack / confirm / dispatch based on stakes + confidence) | Shipped, always on | none |
| 2 | Single Cap Chew voice for every agent | Shipped, always on | none |
| 2.5 | Handoff bridges between agent voices | Shipped (dormant under single-voice) | none |
| 3 | Pause detection (commit when the user is clearly done) | Shipped, always on | none |
| 4 | Barge-in (user interrupts TTS) | Shipped, always on | none |
| 5 | Repair memory (learn phonetic fixes + voice undo) | Shipped, always on | `repairMemory` (still honored for rollback) |
| 6 | Affect matching (classify user tone, adjust outgoing speech) | Shipped, always on | `affectMatching` (still honored for rollback) |
| 7 | Backchanneling | Not started / likely skipped | `backchanneling` |

Phases 1-4 previously shipped behind feature flags; at the
**always-on cutover** every Phase 1-4 flag was removed and the
features became the only behavior.

## Where the code lives

```
lib/
  naturalness-flags.js                    -- module exists for future phases; Phase 1-4 flags removed
  naturalness/
    confirmation-policy.js                -- Phase 1 pure decision function
    stakes-classifier.js                  -- Phase 1 low/med/high classifier
    confirmation-phrases.js               -- Phase 1 ack + confirm phrases
    confirmation-gate.js                  -- Phase 1 integration surface
    voice-resolver.js                     -- Phase 2 single-voice resolution
    agent-transition-tracker.js           -- Phase 2.5 ctx key -> last agent
    handoff-phrases.js                    -- Phase 2.5 bridge phrases (dormant)
    turn-taking.js                        -- Phase 3 pure heuristic policy
    utterance-classifier.js               -- Phase 3 LLM fallback
    pause-detector.js                     -- Phase 3 stateful orchestrator
    echo-filter.js                        -- Phase 4 token-overlap echo check
    barge-classifier.js                   -- Phase 4 stop/ack/command/unclear
    barge-detector.js                     -- Phase 4 stateful orchestrator
    barge-detector-singleton.js           -- Phase 4.5 shared instance
    repair-memory.js                      -- Phase 5 fix map + apply/learn + cycle detection + unlearn
    correction-detector.js                -- Phase 5 "I meant X" + "forget that fix" detection
    repair-memory-singleton.js            -- Phase 5 shared instance
    affect-classifier.js                  -- Phase 6 label user tone (neutral / frustrated / rushed / excited / hesitant / deliberate)
    response-modifier.js                  -- Phase 6 transform outgoing text per affect
    affect-tracker.js                     -- Phase 6 shared TTL-bounded affect store

voice-speaker.js                          -- Phase 4.5 notify detector on TTS start/end + Phase 6 adjust outgoing text
voice-listener.js                         -- Phase 3.5 pause detector + Phase 4.5 barge feed + Phase 5 apply fixes + Phase 5 boot-load
lib/exchange/voice-coordinator.js         -- Phase 2 Cap Chew voice resolution
src/voice-task-sdk/exchange-bridge.js     -- Phase 1 gate + Phase 2.5 handoff + Phase 5 learn/undo + Phase 6 record affect
```

## Feature flags

Only Phase 5-7 flags remain:

- `repairMemory` (default **on** -- cycle detection + voice undo make it self-correcting)
- `affectMatching` (default **on** -- conservative classifier + speaker opt-out keep it safe)
- `backchanneling` (default off -- likely skipped)

Override via env: `NATURAL_REPAIR_MEMORY=1`, etc.
Or via `settingsManager.get('naturalnessFlags')`.

## Tests

Every phase has unit tests for the pure modules and an integration
smoke test that mirrors the real wiring without booting Electron.

Run everything:

```bash
npm run test:voice-scenarios
```

## Per-phase details

- [Phase 1 - Calibrated confirmation](./phase-1-confirmation.md)
- [Phase 2 - Personality and handoffs](./phase-2-personality.md)
- [Phase 3 - Pause detection](./phase-3-pause.md)
- [Phase 4 - Barge-in](./phase-4-barge.md)
- [Phase 5 - Repair memory](./phase-5-repair.md)
- [Phase 6 - Affect matching](./phase-6-affect.md)
