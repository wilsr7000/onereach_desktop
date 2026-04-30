# Phase 1 — Calibrated Confirmation

Ship status: **shipped, always on** (flag removed at the always-on cutover).

> **Note (always-on cutover):** The `calibratedConfirmation` flag
> described elsewhere in this doc has been removed from the code
> base. The confirmation gate runs on every `task:assigned`. Env vars
> / settings with `calibratedConfirmation` are no longer read and can
> be deleted.

## What this phase does

Adds a confirmation layer between the auction winner and the agent's
execution. The layer decides one of three things for every task:

| Decision | When it fires | What the user hears |
|---|---|---|
| `dispatch` | Informational tasks, system agents, flag off | Nothing new (status quo) |
| `ack-and-dispatch` | Confident action tasks with low/medium stakes | One short phrase from the ack pool ("got it", "on it", "doing that now") before the agent runs |
| `confirm-first` | High stakes, low intent confidence, or shaky winner | A full confirmation question ("This would delete all your emails. That cannot be undone -- want me to continue?") |

The gate is off by default. It is activated per-user by setting
`naturalnessFlags.calibratedConfirmation = true` in settings, or per
process via `NATURAL_CALIBRATED_CONFIRMATION=1`.

## Architecture

```
exchange-bridge.js :: task:assigned handler
          |
          v
  lib/naturalness-flags .isFlagEnabled('calibratedConfirmation')
          |
          v (if on)
  lib/naturalness/confirmation-gate.evaluateConfirmationGate(...)
          |
          +--- lib/naturalness/stakes-classifier.classifyStakes(...)
          +--- lib/naturalness/confirmation-policy.decide(...)
          +--- lib/naturalness/confirmation-phrases.phraseForDecision(...)
          |
          v
  lib/naturalness/confirmation-gate.applyGateEffects(gate, { speak, logWarn })
          |
          v
  voice-speaker.speak(phrase, { voice })
```

### Files added (non-test)

- `lib/naturalness-flags.js` -- was Phase 0; now has its first production consumer.
- `lib/naturalness/confirmation-policy.js` -- pure decision table.
- `lib/naturalness/stakes-classifier.js` -- agent-declared > regex heuristic > default.
- `lib/naturalness/confirmation-phrases.js` -- ack pools + confirmation templates.
- `lib/naturalness/confirmation-gate.js` -- integration surface that wraps the three above.

### File modified

- `src/voice-task-sdk/exchange-bridge.js` -- the `task:assigned` handler now
  calls the gate before the existing deferred-ack logic, and suppresses the
  deferred ack if the gate spoke.

## Acceptance criteria

- [x] 100% of high-stakes action content triggers a confirmation phrase that
  mentions the consequence (e.g. "cannot be undone", "real money", "multiple
  people").
- [x] 0% of informational queries trigger an ack or confirmation.
- [x] System-type agents are never affected.
- [x] Medium-stakes actions require a winner with confidence >= 0.82 to avoid
  confirmation.
- [x] When the flag is off, the pipeline behaves identically to the pre-phase
  state.
- [x] Gate failures never block the pipeline (wrapped in try/catch).
- [x] The existing deferred-ack mechanism still fires for slow agents when
  the gate did NOT speak.
- [ ] **Deferred to Phase 1.5**: `confirm-first` currently narrates the
  confirmation but does NOT suspend execution pending a yes/no response.
  Today the user hears the warning and the task still proceeds. The real
  suspension flow requires reusing `emitNeedsInput` / `routePendingInput`
  and should only ship after interactive validation.

## How to test

### Unit

```bash
npm run test:voice-scenarios
```

Covers (all passing):

- 15 tests -- `naturalness-flags`
- 12 tests -- `tts-mock`
- 12 tests -- `mic-injector`
- 5 tests  -- `naturalness-baseline` scenarios (Phase 0)
- 19 tests -- `confirmation-policy`
- 23 tests -- `stakes-classifier`
- 19 tests -- `confirmation-phrases`
- 14 tests -- `confirmation-gate`
- 7 tests  -- `naturalness-phase1` scenarios
- 5 tests  -- `confirmation-gate-integration`

Total: **131 passing**.

### Scenario filter

```bash
# Run one Phase 1 fixture
SCENARIO=p1-confirmation/03-high-stakes-always-confirms \
  npx vitest run test/unit/naturalness-phase1.test.js
```

### Interactive (manual smoke)

1. Enable the flag:
   ```bash
   NATURAL_CALIBRATED_CONFIRMATION=1 npm run dev
   ```

2. Say any of the following and listen for the change:

   | Utterance | Expected |
   |---|---|
   | "what time is it" | No ack, direct answer |
   | "play some jazz" | Short ack before the agent plays music |
   | "schedule a meeting with alice tomorrow at 3" | "Want me to schedule..." if winner is shaky, otherwise an ack |
   | "delete all my emails" | Full warning about "cannot be undone", then task proceeds anyway (Phase 1.5 adds the real pause) |
   | "transfer 500 dollars to savings" | "real money" warning, then task proceeds |

3. Check logs for `[ConfirmationGate] decision` entries showing the
   decision + stakes + reason for each submitted task.

### Regression guard

`npm run test:voice-scenarios` MUST pass before every commit that touches
the Phase 1 modules. A failing baseline fixture means the pipeline
contract regressed.

## Rollback

Three levels:

- **Per-session**: unset `NATURAL_CALIBRATED_CONFIRMATION` or set to `0`.
- **Per-user**: clear `naturalnessFlags.calibratedConfirmation` in
  settings.
- **Code**: revert the patch in
  `src/voice-task-sdk/exchange-bridge.js` (the confirmation-gate block
  inside the `task:assigned` handler). The lib modules stay -- no other
  code depends on them.

## What's next (Phase 1.5)

Complete the confirm-first branch:

1. When `gate.decision === 'confirm-first'`, call
   `hudApi.emitNeedsInput({ taskId, prompt: gate.phrase, agentId: '__confirmation-gate__' })`
   instead of just logging.
2. Stash the task + winner + original handler continuation in a
   pending-confirmation map keyed by taskId.
3. Extend `routePendingInput` to route the `__confirmation-gate__`
   responses through a yes/no classifier (there is already
   `respondToInput` plumbing -- we just need a classifier).
4. On "yes": resume agent execution.
5. On "no" / "cancel": emit a lifecycle `cancelled` event with
   `reason: 'user declined confirmation'` and free the task.

Ship only after the acceptance criteria of Phase 1 have been
re-validated with real users -- specifically that the ack-and-dispatch
branch does not feel chatty in practice.
