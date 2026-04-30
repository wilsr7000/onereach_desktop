# HUD Core - Extraction Plan

Sequenced roadmap from "HUD logic embedded in exchange-bridge.js" to
"portable @onereach/hud-core package that any product can import."
Each pass extracts one coherent slice, adds tests, updates the
barrel, and wires the extracted version back into the desktop app
so the behavior stays stable.

## Current state (2026-04-18)

**Shipped -- ALL PHASES:** eleven modules behind the barrel.

| Phase | Module | Lines | Extraction cost | Value delivered |
| - | - | - | - | - |
| 1 | `task-command-router` | ~120 | NEW module, lifted from inline exchange-bridge code | Cancel/stop/repeat classifier now unit-tested and reusable |
| 1 | `voter-pool` | 104 | Already pure; re-export only | Formal inclusion under the portability contract |
| 1 | `council-adapter` | 224 | Already pure; re-export only | Same |
| 1 | `identity-correction` | 280 | Already pure-ish (imports log); re-export | Same |
| 2 | `conversation-continuity` | ~165 | NEW module, decision extracted from inline `_getConversationContinuityAgent` | Rolling-window continuity picker works against any win store + ships with a ready-to-use stateful tracker |
| 2 | `pending-state` | ~100 | NEW module, extracted from inline `hasPendingQuestion \|\| hasPendingConfirmation` | Formal `RoutingContext` shape consumers can share across network boundaries |
| 3 | `bid-protocol` | ~280 | NEW module, plain-JS mirror of the canonical `packages/task-exchange` TS types + early-close decision + timeout policy | Non-TS consumers (GSX flows, WISER, CLIs) can validate/build bid messages and decide auction close without pulling in the TS package |
| 4 | `winner-selection` | ~225 | NEW module, pure decisions extracted from `packages/agents/master-orchestrator.js` | Fast-path + multi-intent override + fallback usable without any LLM; plus defensive-upgraded bid validation |
| 5 | `task-decomposer` | ~235 | NEW module, decision + prompt + parsing extracted from `decomposeIfNeeded` in exchange-bridge. First module to introduce the `ai` port. | Split multi-task utterances via an injected `ai.json` adapter; works with a mock, degrades gracefully when no ai port provided |
| 6 | `dedup` | ~190 | NEW module, normalization + match predicate + reference tracker extracted from inline dedup block | Distributed consumers (Redis/DB-backed) implement the same small interface; single-process consumers use the shipped tracker |
| 7 | `result-consolidator` | ~175 | NEW module, pure transforms extracted from the inline `task:settled` handler in `exchange-bridge.js` | Canonical delivery-envelope shape (message fallback, panel detection, agent-name rule) usable by any consumer |

**Test surface:** 400+ passing assertions across nine HUD-core test
files. Legacy-equivalence tests lock behavioural identity with
pre-extraction inline code wherever applicable. The existing
`master-orchestrator.test.js` was updated to reflect one
defensive-upgrade test case (undefined bids now return the empty
decision instead of crashing).

**Production wiring:** `src/voice-task-sdk/exchange-bridge.js`
imports Phase 1 + 2 + 5 + 6 + 7 pieces via the barrel;
`packages/agents/master-orchestrator.js` imports Phase 4 pieces.
Phase 3 is schema formalization — the canonical TS shapes in
`packages/task-exchange/src/types/index.ts` stay authoritative; the
plain-JS mirror in `lib/hud-core/bid-protocol.js` exists so
downstream JS consumers (GSX flow steps, CLI harnesses, WISER) can
speak the same contract without depending on the TS package. State
(agentWinStats, conversationState, agent memory files) stays local;
decision logic is portable. Zero regressions in voice-scenarios or
agents suites.

**FINAL MILESTONE: HUD EXTRACTION COMPLETE.** Every decision in the
routing pipeline is now portable behind the barrel:

```
user input
  -> task-command-router / pending-state / identity-correction
  -> dedup (reject incremental-STT partials)
  -> task-decomposer (split composite utterances, via `ai` port)
  -> voter-pool (filter eligible agents)
  -> bid-protocol (build/validate messages, manage timeout)
  -> council-adapter (shape bids for the ranker)
  -> winner-selection (fast-path + LLM + override + fallback)
  -> conversation-continuity (track the winner)
  -> result-consolidator (shape the delivery envelope)
```

Two ports remain as the only host-side dependencies:
  - `ai` - for task decomposition and (optionally) winner tie-breaking
  - A KV-like store (Spaces shape) - for whatever persistence a
    consumer wants for continuity / dedup / results

Any Onereach product (GSX flow, WISER Playbooks, CLI) can now
assemble the full routing pipeline by importing `lib/hud-core`,
providing these two ports, and writing the host-specific plumbing
(WebSocket / HTTP / IPC / Spaces).

## Extraction principles (unchanged from the naturalness pass)

1. **Purity first.** A module graduates to the barrel only when it
   has zero host coupling, or when its host deps are converted to
   explicit ports.
2. **One extraction per pass.** Each code move gets its own
   barrel-consumer test proving external use works. Avoid
   multi-module passes -- they hide coupling.
3. **Keep the desktop app pointed at the extracted version.** If
   the barrel is correct, `exchange-bridge.js` can always import
   from it instead of from the old inline path. This eliminates
   the risk of "it worked in extraction but the app uses a stale
   copy."
4. **Don't invent ports until forced.** Every new port is a
   contract every consumer has to implement. Push back on ports
   with "make it a parameter" first.
5. **Behavior-preserving -> then improvements.** Extractions ship
   with an equivalence test against the pre-extraction logic.
   Improvements (better thresholds, new patterns) come in a
   separate commit.

## The roadmap

## What stays in the desktop app forever

Some HUD pieces are inherently client-coupled and shouldn't move:

- **WebSocket lifecycle to live agent processes** (`localAgentConnections`).
  This is where agents live; the HUD core just needs to *name* the
  agents, not own the sockets.
- **Electron IPC bridges** (`ipc-registry`, HUD API over ipcMain).
  Those are renderer-process contracts.
- **BrowserWindow / overlay orchestration.** Window management is
  Electron-only.
- **Screen / system-level capture hooks.** OS-bound.

The barrel's job is to define a clean seam between "HUD decisions
(portable)" and "HUD plumbing (per-product)." The ports doc records
the seam; each extraction narrows the portable side.

## Final delivered scope

Across all seven phases: ~2.0k LOC of module code + ~2.5k LOC of
tests, in eleven modules behind the barrel. Every phase followed
the same discipline: audit -> extract pure slice -> barrel -> tests
(with legacy-equivalence where applicable) -> wire desktop app
through barrel -> update docs. Zero regressions across the full
voice-scenarios + agents test suites on any pass.

## Next step: GSX flow conversion

With the barrel covering the full decision layer, **GSX flow
conversion** is now straightforward. The shape:

1. A GSX flow with an HTTP Gateway entry that receives
   `{ transcript, history, agents, context }`.
2. An Execute-JS step that `require('./lib/hud-core')` and walks
   the decision pipeline (task-command-router -> pending-state ->
   dedup -> task-decomposer -> voter-pool -> bid fan-out ->
   winner-selection -> result-consolidator).
3. The two ports (`ai`, a Spaces-like KV store) implemented via
   existing GSX step primitives.
4. Return the delivery envelope to the caller.

WISER Playbooks integrates the same way: `require('./lib/hud-core')`
from its task layer, implement the two ports against WISER's
existing infrastructure, done.

The work here -- small, incremental, test-fenced -- is the
foundation for getting every Onereach product onto the same
routing layer without a rewrite.
