# Phase 6: Affect Matching

Detect the user's emotional tone from their utterance and nudge
outgoing speech to match. Frustrated users get empathy; rushed users
get trimmed responses; excited users get matched energy.

**Status:** shipped, always on (`affectMatching: true` by default).

## User-facing story

Before (every turn sounds the same):
  You: (frustrated) "ugh, this is broken again, seriously"
  App: "OK, so let me check your account..."

After (the assistant adjusts):
  You: (frustrated) "ugh, this is broken again, seriously"
  App: "Got it - checking your account."

  You: (rushed) "QUICK what time is it hurry"
  App: "It's 3:42. Your next meeting is at 4." *(trimmed from a 5-sentence response)*

  You: (excited) "yes! finally it worked!"
  App: "Nice! Your task is done."

## Architecture

```
User turn:
  exchange-bridge.processSubmit(text)
    -> classifyAffect({ text, recentErrors, recentRepeat })
       -> if label !== 'neutral': affectTracker.record(affect)

Assistant reply (any speech path):
  voice-speaker._doSpeak(text, metadata)
    -> if !metadata.skipAffectMatching:
         affect = affectTracker.get()           // null if no recent affect or TTL expired
         text   = adjustResponse({ text, affect })
    -> stream TTS with (possibly) adjusted text
```

One chokepoint at the speaker level -- every outgoing TTS gets
adjusted automatically. Fixed-wording system prompts (like the
Repair Memory undo ack) opt out with `skipAffectMatching: true`.

## Modules

| File | Purpose |
| - | - |
| `lib/naturalness/affect-classifier.js` | Pure text-only classifier. Returns `{ label, confidence, signals }`. |
| `lib/naturalness/response-modifier.js` | Pure text transformer. Returns `{ text, modified, transforms }`. |
| `lib/naturalness/affect-tracker.js` | Shared singleton, TTL-bounded last-non-neutral-affect store. |
| `src/voice-task-sdk/exchange-bridge.js` | Input side: detect + record on every user turn. |
| `voice-speaker.js` | Output side: look up + transform on every outgoing TTS. |

## Affect labels

| Label | Typical signals |
| - | - |
| `neutral` | default; no strong signal (most turns) |
| `frustrated` | profanity, "ugh", "seriously", "stop doing that", recent errors, repeated request |
| `rushed` | "quick", "hurry", "asap", ALL CAPS short phrase |
| `excited` | "yes!!", "awesome!", "amazing!!!", multi-exclaim |
| `hesitant` | multiple hedges ("um", "maybe", "I guess") |
| `deliberate` | long verbose utterance with exploratory phrasing ("could you show me", "how would I", "what if") |

Classifier is **conservative by design** -- `neutral` is the default
and non-neutral labels require a minimum score (`MIN_SCORE = 3`).
Single-signal utterances stay neutral. Ambiguous single-word
profanity like "ugh" alone *is* strong enough (that's the one
exception).

Priority order when multiple labels score equal:
`frustrated > rushed > excited > hesitant > deliberate`.

## Response adjustments

| Affect | Transform(s) |
| - | - |
| `frustrated` | Strip filler opening ("OK, so let me..."), prepend empathy ("Got it - ") |
| `rushed` | Strip filler, cap response at 2 sentences |
| `excited` | Prepend energy prefix ("Nice! ", "Awesome! ") |
| `hesitant` | No change (adding scaffolding can feel patronising) |
| `deliberate` | No change (preserve verbosity the user is clearly consuming) |
| `neutral` / unknown | No change |

All modifications are **idempotent**: already-prefixed text isn't
re-prefixed, so back-to-back frustrated turns don't stack "Got it -
Got it - Got it - ...".

## Tracker rules

The tracker is the bridge between user-side classification and
assistant-side adjustment. It holds the most recent non-neutral
affect, TTL-bounded.

- **Ignores `neutral`:** one calm follow-up turn doesn't erase a
  detected frustration -- the assistant stays attentive until TTL.
- **Priority-aware replacement:** an in-TTL higher-priority affect
  (e.g., `frustrated`) is never overwritten by a lower-priority one
  (`hesitant`). Equal priority replaces (newer wins).
- **TTL decay:** default 60s. After decay, any new non-neutral affect
  (regardless of priority) becomes the current value.
- **Defensive copies:** `get()` returns a snapshot without internal
  timestamps so callers can't mutate tracker state.

## Opt-out

Fixed-wording assistant phrases that must be spoken verbatim -- the
Repair Memory undo ack, for instance -- pass `skipAffectMatching: true`
to `speaker.speak()`:

```js
speaker.speak("OK, I'll forget that \"jess\" meant \"jazz\".", {
  skipAffectMatching: true,
});
```

## Enabling / disabling

Default is ON. To disable:

- `NATURAL_AFFECT_MATCHING=0` env var
- `settingsManager.naturalnessFlags.affectMatching = false`

When the flag is off, both the classifier call site (in
exchange-bridge) and the modifier call site (in voice-speaker) skip
the entire pipeline. The tracker is unaffected either way -- it just
won't receive writes.

## Tests

| File | Coverage |
| - | - |
| `test/unit/affect-classifier.test.js` | Every label, neutral-default discipline, priority tie-breaking, defensive inputs, returned shape invariants. |
| `test/unit/response-modifier.test.js` | Each affect's transforms, idempotence, opt-out, no-op paths. |
| `test/unit/affect-tracker.test.js` | Record / get, TTL decay, priority replacement, clear, configurable clock. |
| `test/unit/affect-matching-integration.test.js` | Full loop mirrors (user turn -> record -> assistant speak -> adjust). Frustration persists through neutral follow-ups, rushed trims long replies, skipAffectMatching bypasses. |

Run: `npm run test:voice-scenarios`

## Known limitations / next steps

1. **Text-only signals.** Acoustic features (pitch, speed, volume)
   would improve classification but aren't exposed by the OpenAI
   Realtime API. A future phase could integrate a local prosody
   analyser.
2. **Lexicon is English-only.** Non-English users will see mostly
   `neutral` classifications. Localised lexicons are a follow-up.
3. **No LLM fallback.** The classifier is pure regex/lexicon; when
   a turn has ambiguous signals (e.g., sarcasm), we default to
   `neutral`. A Phase 3-style LLM tiebreaker could help but adds
   latency.
4. **Hesitant / deliberate do nothing.** Hesitant could prompt slower
   TTS pacing (if the API exposes speed) or a reassurance prefix.
   Deliberate could suppress filler strip. Both kept no-op until we
   have dogfood data.
5. **No observability surface.** Logs go to the standard log queue,
   but there's no UI showing "current detected affect: frustrated".
   A dev-only overlay could help tune thresholds.
