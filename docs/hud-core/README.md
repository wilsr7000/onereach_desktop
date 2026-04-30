# HUD Core - Extraction Roadmap

The HUD (heads-up display / agent-routing) layer is the coupling
point between voice input, agent orchestration, and product-specific
surfaces (desktop UI, WISER Playbooks, a GSX flow). The goal is to
move the *decision logic* out of the desktop app's `exchange-bridge.js`
and into a portable `@onereach/hud-core` package that any consumer
(client, server, CLI) can import.

This directory is that package. The surrounding docs describe the
contract, the ports, and the work that's already done vs. still
pending.

## Quick links

- **[ports.md](./ports.md)** - host-provided dependencies the full
  HUD extraction will need
- **[extraction-plan.md](./extraction-plan.md)** - what's done, what's
  next, sequenced

## What's in the package today

**ALL PHASES SHIPPED.** Phases 1 + 2 + 3 + 4 + 5 + 6 + 7 through the
stable barrel at `lib/hud-core/index.js`:

| Module | Purpose | Status |
| - | - | - |
| `task-command-router` | Classify cancel/stop/repeat/undo as a critical command vs. agent intent | Phase 1 - NEW, fully extracted (was inline in exchange-bridge) |
| `voter-pool` | Space-scoped agent eligibility filter | Phase 1 - pre-existing pure module; re-exported |
| `council-adapter` | Transform agent bids -> consolidator evaluation shape | Phase 1 - pre-existing pure module; re-exported |
| `identity-correction` | Detect "I don't live in X" / "I'm in Y" corrections | Phase 1 - pre-existing pure-ish module; re-exported |
| `conversation-continuity` | Pick the most recent winning agent inside a rolling window | Phase 2 - NEW, decision extracted from inline `_getConversationContinuityAgent`. Ships with both a pure function and a stateful tracker. |
| `pending-state` | Classify whether an utterance answers an open question / confirmation | Phase 2 - NEW, extracted from the inline `hasPendingQuestion \|\| hasPendingConfirmation` check. Formalises the `RoutingContext` contract. |
| `bid-protocol` | Schemas + validators + builders for BidRequest/BidResponse/Bid, plus the early-close + timeout policy | Phase 3 - NEW, mirrors the canonical `packages/task-exchange/src/types/index.ts` shape in plain JS for non-TS consumers. |
| `winner-selection` | Fast-path + multi-intent override + fallback for choosing the winning bid(s) | Phase 4 - NEW, extracted pure decisions from `packages/agents/master-orchestrator.js`. LLM + memory feedback stay in the orchestrator. |
| `task-decomposer` | Detect composite requests + split into sub-tasks via an LLM call | Phase 5 - NEW, extracted from `decomposeIfNeeded` in exchange-bridge. First module to use the `ai` port. |
| `dedup` | Detect duplicate / prefix-match submissions from incremental STT | Phase 6 - NEW, extracted from the inline dedup block in exchange-bridge. Ships with pure predicates + a reference in-memory tracker. |
| `result-consolidator` | Shape a raw agent result into the canonical delivery envelope (message fallback, panel detection, agent-name rule) | Phase 7 - NEW, extracted from the inline `task:settled` handler. |

All eleven are:
- Pure JavaScript (no Electron, no I/O, no network)
- Deterministic on input
- Safe to call from any runtime: Node, browser, GSX flow, CLI

## Using the package

External consumers import ONLY from `lib/hud-core` (the barrel):

```js
const {
  // Task command router (Phase 1)
  classifyTaskCommand,
  isCriticalCommand,
  // Agent eligibility (Phase 1)
  voterPool,
  // Bid -> evaluation transform (Phase 1)
  councilAdapter,
  // Identity correction (Phase 1)
  identityCorrection,
  // Conversation continuity (Phase 2)
  pickContinuityAgent,
  createContinuityTracker,
  // Pending state classifier (Phase 2)
  classifyPendingState,
  shouldRouteToPendingStateHandler,
  normalizeRoutingContext,
  // Bid protocol (Phase 3)
  isValidBid,
  isValidBidRequest,
  isValidBidResponse,
  buildBidRequest,
  buildBidResponse,
  normalizeBid,
  computeBidDeadline,
  shouldCloseAuctionEarly,
  createTimeoutPolicy,
  BID_TIERS,
  // Winner selection (Phase 4)
  pickWinnerFastPath,
  fallbackSelection,
  applyMultiIntentOverride,
  hasMultiIntent,
  validateWinners,
  // Task decomposer (Phase 5)
  createTaskDecomposer,
  // Dedup (Phase 6)
  createDedupTracker,
  normalizeTranscript,
  isDuplicateSubmission,
  // Result consolidator (Phase 7)
  buildDeliveryEnvelope,
  extractDeliveryMessage,
  extractLearningMessage,
  hasPanel,
  agentIdToDisplayName,
} = require('./lib/hud-core');

// Is this utterance a system command?
if (isCriticalCommand(userText)) {
  await router.handle(userText);
  return; // don't route to agents
}

// Filter which agents should bid
const eligible = voterPool.filterEligibleAgents(allAgents, task);

// After bidding, shape bids for the consolidator
const evaluations = councilAdapter.bidsToEvaluations(bids, {
  criteria: task.criteria,
  confidenceFloor: 0.5,
});

// Did the user just correct their location?
const correction = identityCorrection.detectIdentityCorrection(userText);
if (correction) { /* update stored identity */ }

// Multi-turn state: was there an open question the user is now answering?
if (shouldRouteToPendingStateHandler(conversationState.getRoutingContext())) {
  return await router.handle(userText);
}

// Conversation continuity: give the last winning agent priority
// on the next turn if they won recently.
const tracker = createContinuityTracker({ windowMs: 120_000 });
tracker.recordWin(winningAgent.id);
// ...next turn
const continuation = tracker.pickContinuityAgent();
if (continuation) priorityAgents = [continuation.agentId];

// Build a bid request to fan out to the eligible agent pool.
const deadline = computeBidDeadline({ windowMs: 2000 });
const req = buildBidRequest({
  auctionId,
  task,
  context: { queueDepth: 0, conversationHistory, conversationText: '', participatingAgents: eligible.map(a => a.id) },
  deadline,
});
// Track the auction with a timeout policy; close early when all bids in.
const tp = createTimeoutPolicy({ windowMs: 2000 });
// ...fan out req, collect bid responses, validate each via isValidBidResponse...
// ...tp.shouldClose(received.length, eligible.length) short-circuits...

// Pick a winner. Fast-path returns a decision when the bids are
// empty / single / dominant; null means an LLM tie-breaker is
// needed. No-LLM consumers fall straight through to fallbackSelection.
const fastDecision = pickWinnerFastPath(bids);
const winners = fastDecision
  ? fastDecision
  : (await llmDecide(task, bids)) ?? fallbackSelection(bids);
// If the LLM returned multi-winners on a simple task, collapse.
const corrected = applyMultiIntentOverride(winners, task.content);

// Decompose multi-task utterances before routing (needs ai port).
const decomposer = createTaskDecomposer({ ai: myAiPort });
const d = await decomposer.decomposeIfNeeded(userText);
if (d.isComposite) {
  for (const sub of d.subtasks) await submitTask(sub);
  return;
}

// Drop incremental-STT duplicates before they hit the auction.
const dedupTracker = createDedupTracker();
const { duplicate } = dedupTracker.check(userText);
if (duplicate) return;  // already processing this request
dedupTracker.record(userText);

// After the agent executes, consolidate the raw result into a
// standardized delivery envelope the client speaks + renders.
const envelope = buildDeliveryEnvelope(agentExecutionResult, {
  taskId: task.id,
  agentId: corrected.winners[0],
});
if (envelope.message) await speaker.speak(envelope.message);
if (envelope.hasPanel) ui.render(envelope.html);
```

See `test/unit/hud-core-barrel.test.js` for runnable examples.

## What's NOT in the package (yet)

Most of the HUD pipeline is still coupled to the desktop app's
singletons (the exchange instance, router instance, conversation
history store, task store, ipc/log queues). Extraction is incremental;
each pass moves one more piece behind the barrel.

See `extraction-plan.md` for the sequenced roadmap.

## Why it matters

Every product that wants the "talk to it like a person, it routes to
the right agent" experience currently has to either:
1. Fork this whole app, OR
2. Rebuild the agent-routing logic from scratch.

Both are bad. The portable `hud-core` package is the third option:
implement the handful of host ports listed in `ports.md`, then get
the desktop app's proven routing behavior for free.
