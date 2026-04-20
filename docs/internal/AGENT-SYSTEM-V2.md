# Agent System v2 -- Adoption Guide

> Companion to [LEARNING-SUBSYSTEMS.md](LEARNING-SUBSYSTEMS.md) and the
> multi-phase plan at `.cursor/plans/agent-system-upgrade-phases_*.plan.md`.
> Released v4.9.0.

This document is the short version: "what is Agent System v2, and how
do I use it?"

---

## What's new

Seven additive capabilities, **all on by default in v4.9.0**. The
system is one system -- there is no "legacy path" running in parallel.
The feature-flag module survives solely as a runtime opt-out in case a
deployment needs to disable one specific capability without a code
change.

| Capability | Flag (all default ON) | What it does |
|---|---|---|
| Foundation | `typedTaskContract` | Task state lives in `lib/exchange/task-store` with a durable lifecycle timeline via `agent-stats.recordTaskLifecycle`. |
| Council | `councilMode` | When `task.variant === 'council'`, dispatches to `lib/exchange/council-runner` instead of the single-winner auction. Weighted aggregation + conflict detection via `lib/evaluation/consolidator`. |
| Learned weights | `learnedWeights` | In `unified-bidder.selectWinner`, raw confidence is multiplied by `getLearnedWeight(agentId)` (0.5 - 1.5, or 1.0 for cold-start agents) before the 0.5 threshold check. |
| Role-based voter pool | `roleBasedVoterPool` | When `task.spaceId` is set, only agents whose `defaultSpaces` include the space AND generalists (no declared `defaultSpaces`) bid. |
| Variant selector | `variantSelector` | When the caller doesn't set `task.variant`, a cheap cached LLM micro-call classifies the task as `winner` / `council` / `lead_plus_probers`. |
| Per-criterion bidding | `perCriterionBidding` | Bid prompt grows a CRITERIA block when `task.criteria` is set; agents return per-criterion scores alongside the overall confidence. |
| Bid-time clarification | `bidTimeClarification` | Agents with `canProbeAtBidTime: true` may emit `needsClarification` in a bid to pause the auction for a single user answer. |
| Adequacy loop | `adequacyLoop` | Agents can declare `needsInput.adequacy.maxTurns` so `routePendingInput` tracks turn counts and falls back gracefully when the loop doesn't converge. |
| HTTP Gateway | `httpGateway` | Exposes `POST /submit-task`, `GET /events/:taskId` (SSE), `POST /respond-input`, `POST /select-disambiguation`, `POST /cancel-task`, `GET /health` on 127.0.0.1:47293. Started from `main.js` at app boot. |

---

## Opting OUT of a specific capability

Only needed if something in your environment misbehaves. Three ways:

Env var (takes precedence over everything):

```bash
AGENT_SYS_COUNCIL_MODE=0 npm start
```

Settings store (persisted across restarts):

```js
// in the renderer console
global.settingsManager.set('agentSystemFlags', { councilMode: false });
```

Umbrella off (kills everything new at once -- emergency only):

```bash
AGENT_SYS_AGENT_SYS_V2=0 npm start
```

The umbrella off wins over per-flag settings, so a user who wants
vanilla behavior can set it in one place and not think about the rest.

---

## Submitting a council-style task

The common case: evaluate something against a rubric.

```js
const hudApi = require('./lib/hud-api');

const result = await hudApi.submitTask(
  'Review this plan: rebuild the onboarding flow in Q4',
  {
    toolId: 'command-hud',
    variant: 'council',          // skip the single-winner auction
    rubric: 'plan_review',        // auto-expands to 6 criteria
    weightingMode: 'uniform',    // or 'contextual' | 'learned' | 'user_biased'
  }
);

console.log(result.data.aggregateScore); // 0-100 weighted
console.log(result.data.conflictCount);  // how many criteria had >=20 spread
// result.ui is a HUD spec -- rendered automatically by the command HUD
```

Named rubrics available today (in `lib/task-rubrics/`):

- `plan_review` -- clarity, feasibility, specificity, risk, completeness, coherence
- `plan_proposal` -- problem_clarity, approach_fit, novelty, effort, risk_awareness
- `decision_record` -- rationale, alternatives, reversibility, stakeholders, followup
- `meeting_outcome` -- notes_quality, decisions_captured, action_items, unresolved, priority
- `code_generation` / `code_refactor` / `bug_fix` / `test_generation` (pre-existing)
- `documentation`

Passing explicit criteria overrides the rubric:

```js
await hudApi.submitTask('custom eval', {
  variant: 'council',
  criteria: [
    { id: 'timeliness', label: 'Timeliness', weight: 0.4 },
    { id: 'cost', label: 'Cost', weight: 0.6 },
  ],
});
```

---

## Declaring agent expertise

On the agent registration (e.g. `packages/agents/my-agent.js`):

```js
module.exports = {
  id: 'my-agent',
  name: 'My Agent',
  // ...standard fields...

  // Self-declared per-criterion confidence in [0, 1]. Council mode
  // uses these during bid evaluation; the per-criterion prompt block
  // surfaces the agent's expertise so the LLM calibrates its scores.
  expertise: {
    clarity: 0.9,
    risk: 0.4,
    feasibility: 0.7,
  },

  // Optional: opt into the bid-time clarification protocol. When a
  // task carries criteria AND the bidTimeClarification flag is on,
  // this agent's bid may include:
  //   { needsClarification: { question: 'What is X?', blocks: 'criterion-id' } }
  // The auction will pause, ask the user, and re-poll with the answer.
  canProbeAtBidTime: true,
};
```

The registry validates both fields at load time; typos (non-number
scores, invalid keys, non-boolean `canProbeAtBidTime`) fail loudly.

---

## Making an agent work well in council mode

1. **Declare expertise** matching the rubric you expect tasks to use.
2. **Score per-criterion** inside your `execute()` when the task has
   `criteria`. The bid prompt already asks for per-criterion scores;
   your execution output can expand on them.
3. **Mark `executionType: 'informational'`** if you're safe to run in
   parallel with other council members (no side effects). Council
   mode only executes informational agents by default; action agents
   still bid but don't fan out writes.
4. **Keep your `acks` specific** -- several agents running in parallel
   means the orb may play several acks.
5. **If your agent needs user input to score a criterion, opt into
   `canProbeAtBidTime`** so you can pause for clarification instead
   of guessing.

---

## Adequacy loop (Phase 5)

When your agent needs to keep asking until the answer is usable:

```js
async execute(task) {
  const userInput = task.context?.userInput;
  if (!isUsable(userInput)) {
    return {
      needsInput: {
        prompt: 'What is the target audience?',
        adequacy: {
          requires: 'a specific demographic',
          maxTurns: 3,
          retryPrompt: 'Could you be more specific? e.g. "engineers at mid-size startups"',
        },
      },
    };
  }
  // ... do the thing ...
}
```

The tracker counts turns. After `maxTurns` the loop breaks with a
graceful "I couldn't get a clear answer after N attempts" fallback
you can leave to the system or override by returning a result
earlier. See [lib/exchange/adequacy-tracker.js](../../lib/exchange/adequacy-tracker.js).

---

## HTTP Gateway

For CLI tools, web dashboards, and future flow-runtime integration:

```bash
# In main process init (Electron):
const { startAgentGateway } = require('./lib/agent-gateway');
await startAgentGateway(); // 127.0.0.1:47293

# From any HTTP client:
curl -X POST http://127.0.0.1:47293/submit-task \
  -H 'Content-Type: application/json' \
  -d '{"text":"Evaluate this plan","variant":"council","rubric":"plan_review"}'

# Subscribe to the event stream (replays past timeline + live):
curl -N http://127.0.0.1:47293/events/<taskId>
```

Health check: `GET /health` returns pid + subscriber counts.

---

## Observability

- Every auction writes lifecycle events to the durable task timeline
  (`userData/agents/task-timeline.json`). Read with
  `getAgentStats().getTaskTimeline(taskId)`.
- Every bid is recorded in `bid-history.json`. Read with
  `getAgentStats().getBidHistory(limit)`.
- Every outcome (winner + success/failure + duration) fans out to the
  three learning stores via [lib/learning/index.js](../../lib/learning/index.js)
  `recordBidOutcome`.
- `getAgentSnapshot(agentId)` composes current stats + learned weight +
  meta-learning memory for diagnostic UIs.

---

## Decision tree: which variant?

```
Is the user asking to DO something (command)?
  -> 'winner' (default; single-agent execution)

Is the user asking the system to JUDGE or SCORE something?
  -> 'council' with an appropriate rubric

Is the user asking for an OPEN-ENDED interview / exploration?
  -> 'lead_plus_probers' (experimental; lead agent + probe suggestions)

Can't tell? Have no opinion?
  -> Leave `variant` unset. If the `variantSelector` flag is on, the
     system will ask a fast LLM to pick one.
```

---

## Related docs

- [LEARNING-SUBSYSTEMS.md](LEARNING-SUBSYSTEMS.md) -- boundary between
  `lib/meta-learning` (weighting / governance) and `lib/agent-learning`
  (improvement loop / memory curation).
- `.cursor/plans/agent-system-upgrade-phases_*.plan.md` -- the plan
  this work was built from.
- [PUNCH-LIST.md](../../PUNCH-LIST.md) -- per-phase change summaries
  under "Recently Completed".
