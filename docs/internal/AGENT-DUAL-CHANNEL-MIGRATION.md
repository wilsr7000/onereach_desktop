# Agent Dual-Channel Migration Guide

## Why

Reading bandwidth >> listening bandwidth. The Orb Unified UX redesign
splits agent responses into two channels:

- **`spokenSummary`** — short, voiced via TTS for voice-in turns
- **`visualText`** — richer text rendered in the chat scroll
- **`ui` / `html`** — optional micro-UI (declarative spec or pre-rendered)
- **`displayMode`** — `'inline'` (chat card) | `'modal'` (own window) | `undefined` (auto)

The user's UX brief: *"the user can read details and hear a general
summary. The most ideal use of communication bandwidth with a user will
be user talks, system returns Micro UI with text, and speaks a summary."*

## Backward compatibility

The bridge runs every agent result through `normalizeAgentResult` (see
[`lib/agent-result-normalize.js`](../../lib/agent-result-normalize.js)).
Legacy agents that only set `message` get:

```js
spokenSummary === visualText === message
```

That is exactly the right behavior for **Scenario 3** (simple
interactions). So unless your agent has a meaningful split between what
to read and what to say, **you don't need to change anything**.

## When you should migrate

Migrate an agent to the dual-channel contract when **one of these is
true**:

1. The agent returns a rich micro-UI (panel) where the user reads details
   in the panel — the spoken text should be a short summary, not the
   full data dump (Scenario 1).
2. The agent's response is too long to listen to comfortably (>8s of
   speech). Split into a 2-3 second spoken headline + the full text in
   `visualText`.
3. You want to explicitly mark `displayMode` rather than rely on the
   panel-size heuristic.

If none of these apply, leave the agent on the legacy `message` field.

## Patterns by scenario

### Scenario 1: voice-in, rich response (panel + summary)

Agent returns a panel for visual reading + a short spoken summary.

```js
return {
  success: true,
  message: shortSummary,            // legacy fallback (kept for unmigrated subscribers)
  spokenSummary: shortSummary,      // 1-2 sentences, voiced via TTS
  visualText: 'Daily brief shown',  // breadcrumb in chat (the panel carries detail)
  displayMode: 'modal',             // explicit override of the size heuristic
  ui,                                // declarative spec (lib/agent-ui-renderer)
  panelWidth: 480,
  panelHeight: 540,
  data: { fullSpeech, ... },        // expose the long form on data for analytics
};
```

The dayView modal carries all the detail. Spoken: *"Three meetings
today, two need prep."* Chat: *"Daily brief for today."* Modal: full
six-card stack the user can read at their own pace.

See [`packages/agents/daily-brief-agent.js`](../../packages/agents/daily-brief-agent.js)
for a worked example, including the `_computeShortSpokenSummary` helper
that derives a one-sentence headline from the contribution data.

### Scenario 2: text-in, rich response

When the user submits via text (chat panel), the bridge gates TTS off
automatically — `inputModality === 'text'` skips the speak call. Your
agent doesn't need to know whether input was voice or text. Just
provide both channels and the bridge handles routing.

For text-in tasks the orb chat shows: user's text → assistant
visualText + inline card or modal link. No TTS.

### Scenario 3: simple (spoken == visual)

Default for most short responses. Either:

- Set only `message` and let the shim duplicate it. **Cleanest, no
  change needed.**
- Or explicitly set `spokenSummary` AND `visualText` to the same
  string for clarity:

```js
return { success: true, message, spokenSummary: message, visualText: message };
```

[`packages/agents/weather-agent.js`](../../packages/agents/weather-agent.js)
uses the explicit form.

### Inline cards (small UIs)

If your micro-UI is small (`panelWidth < 400` and `panelHeight < 300`)
the heuristic picks `'inline'` and the panel renders as a card inside
the chat assistant turn — no separate window:

```js
return {
  success: true,
  message: 'Alarm set for 3pm.',
  ui: { type: 'alarmCard', time: '3pm' },
  // no panelWidth / panelHeight -> small -> inline by heuristic
};
```

To force inline regardless of size, set `displayMode: 'inline'`
explicitly.

## Proactive alerts

Agents that push proactive content (alarms, scheduled briefs, monitor
findings) **don't return a normal task result**. They use:

```js
const { pushProactiveAlert } = require('../../lib/voice-task-push');

pushProactiveAlert({
  agentId: 'critical-meeting-alarm',
  agentName: 'Meeting Alarm',
  spokenSummary: 'Sales sync starts in 2 minutes.',
  visualText: 'Sales sync (Acme) starts in 2 minutes. Conf A. Link: https://...',
  ui: { type: 'alarmCard', meeting: 'Sales sync (Acme)', whenISO: '...' },
  panelWidth: 380,
  panelHeight: 220,
  soundCue: { type: 'one-shot', name: 'attention' },
});
```

Proactive alerts:

- Always speak (override the voice-in-only TTS gate)
- Land in the chat scroll tagged `source: 'agent-proactive'`
- Pop a modal if the panel is "rich" (same heuristic as task results)
- Persist to `orb-chat-history.jsonl` so users can scroll back

See [`lib/voice-task-push.js`](../../lib/voice-task-push.js).

## Cancel + stop intents (Phase 5)

The orb registers two new function tools so the realtime model
classifies cancel / stop intent server-side and emits a tool call.
**No agent changes are needed.** Cancel triggers an exchange-wide task
abort + TTS flush. Stop just cuts TTS. Both add a chat breadcrumb.

## Migration checklist

- [ ] Decide the scenario (1, 2, or 3) for each `return` statement.
- [ ] If Scenario 1: split `spokenSummary` (short) + `visualText`
      (chat-friendly), set `displayMode: 'modal'`, keep `ui` /
      `panelWidth` / `panelHeight`.
- [ ] If Scenario 3 with inline UI: leave `message` only OR set
      `spokenSummary` + `visualText` explicitly to the same string.
- [ ] Keep the legacy `message` field on your return so any subscriber
      that hasn't migrated keeps working.
- [ ] If your agent emits proactive alerts (timers, monitors), route
      them through `pushProactiveAlert(...)` instead of calling
      voice-speaker directly.
- [ ] Add a unit test for the new return shape (see
      [`packages/agents/daily-brief-agent.test.js`](../../packages/agents/daily-brief-agent.test.js)
      style).

## Migrated agents

| Agent | Scenario | Status |
|---|---|---|
| `daily-brief-agent` | 1 (rich modal + headline) | ✅ migrated |
| `help-agent` | 1 (rich modal + headline) | ✅ migrated |
| `weather-agent` | 3 (simple, explicit) | ✅ migrated |
| `calendar-query-agent` | 1 (rich UI + summary) | ✅ migrated |
| `smalltalk-agent` | 3 (simple, shim) | works as-is |
| All others | 3 (simple, shim) | works as-is |

## See also

- [`/.cursor/plans/orb_chat_unified_ux_*.plan.md`](../../.cursor/plans/) — full design plan
- [`lib/agent-result-normalize.js`](../../lib/agent-result-normalize.js) — the contract shim
- [`lib/voice-task-push.js`](../../lib/voice-task-push.js) — proactive alert API
- [`lib/agent-ui-modal-manager.js`](../../lib/agent-ui-modal-manager.js) — modal lifecycle
- [`lib/orb-chat-history.js`](../../lib/orb-chat-history.js) — chat persistence
