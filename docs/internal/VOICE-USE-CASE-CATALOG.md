# Voice Agent Use-Case Catalog — the standing eval suite

The canonical conversational flows the system must keep passing. Per the
testing directive (2026-08-05): **every case is verified through the TEXT
path** (`hudApi.submitTask` — the same pipeline the chat box uses; voice is
only transcription on top). Harness pattern: real event-bus + real
transcript-service against a spy or live bridge — see
`test/unit/text-chat-consent-flow.test.js`.

Status legend:
- ✅ automated — runs in `test/unit` today (pointer given)
- 🟡 partial — core mechanics tested, some steps not yet asserted end-to-end
- 🔴 not built — desired behavior; needs implementation before it can be tested

---

## The core ten

### UC-01 · Capability gap → system OFFERS to build (feasible)
**Given** no agent can handle the request (no confident bids, or bids that bust)
**When** the user asks ("set a timer for 4:09")
**Then** feasibility is assessed; if easy/medium the orb asks *"Want me to build it?"*, consent is registered as pending input, "yes" → playbook → build → verified outcome spoken honestly.
**Status:** ✅ pre-auction halt + post-settle re-check (`exchange-halt-capability-offer.test.js`, `gap-recheck.test.js`), consent reachability (`text-chat-consent-flow.test.js`), build+verify (`claude-code-agent-builder.test.js`). 🟡 one seam: full turn-by-turn text-path run of the whole chain in one test.

### UC-02 · Capability gap → does NOT offer (not feasible) → request backlog
**Given** the request needs capabilities the system fundamentally lacks
**When** the user asks
**Then** no build offer is made; the user hears an honest "can't, here's an alternative"; the request lands on the **Capability Wishlist** (Spaces) as backlog, with a `learning:capability-gap` event for the Agent Suggester's demand signals.
**Status:** 🟡 not_feasible → no-offer is tested (`agent-builder-claude-code.test.js`); wishlist/backlog write is best-effort and not asserted. Add: backlog item created + suggester later surfaces it.

### UC-03 · Agent exists → asks a follow-up → completes
**Given** a capable agent that needs one more detail
**When** the user asks, the agent asks back, the user answers (including one-word answers: "yes", "3pm", "the second one")
**Then** the answer reaches the SAME agent (never re-auctioned, never eaten by the mic filter), and the task completes.
**Status:** ✅ regression-pinned after the live "Yes." failure (`text-chat-consent-flow.test.js`); routing internals in bridge tests. 🟡 add: multi-turn adequacy loop (agent keeps asking → capped).

### UC-04 · Agent updates memory → completes → discloses the memory update
**Given** an interaction that teaches the system something durable
**When** the task completes
**Then** the fact is saved (agent memory / user profile) AND the user is told *what was remembered* ("I'll remember you prefer Celsius").
**Status:** 🔴 memory writes exist (learnFromInteraction, user-profile facts) but **disclosure is not implemented** — nothing tells the user a memory changed. Build: a `memoryUpdated` field on results → spoken suffix + HUD chip; then test via text path.

### UC-05 · Agent fails → fixes ITSELF with Claude Code → retries (max 3)
**Given** the winning agent errors at execution
**When** the failure is not transient (not rate-limit/timeout)
**Then** the system diagnoses, patches the agent via the Claude Code builder (playbook as spec), re-verifies, and retries the original request — up to 3 attempts, then honest failure + self-heal offer.
**Status:** 🔴 today: bust → backup agents → error-agent (`agentic-retry.js` retries the *task*, not the *agent*). The fix-the-agent loop is not built. Depends on the `agent:execution-failure` structured event + failure-streak tracker (flagged gap). This is the flagship self-heal case.

### UC-06 · Three agents answer → ONE sequenced response with visuals
**Given** a request that legitimately spans agents (e.g. daily brief: calendar + email + weather)
**When** contributions return
**Then** one composed spoken response in a sensible order + one visual panel (not three competing voices/windows).
**Status:** 🟡 daily-brief composition + dayView modal are tested (`daily-brief-*.test.js`); the council path (`council-runner/adapter`) has unit tests. Add: a text-path case asserting single-speech + single-panel invariant for a multi-contributor task.

### UC-07 · Multiple qualified, non-complementary agents → pick exactly one
**Given** several agents bid confidently on the same request
**When** the auction resolves
**Then** exactly one winner executes (dominance margin / orchestrator sanity check breaks ties); no duplicate execution, no double speech.
**Status:** ✅ auction core + confidence floor + counterfactual judge (`exchange-confidence-floor.test.js`, `unified-bidder.test.js`, judge tests). 🟡 add: explicit no-double-execution assertion on a contrived two-strong-bidders fixture.

### UC-08 · Bad answer → agent fixed automatically → re-tested
**Given** the winner returns a response graded bad (delivery-eval / reflector / counterfactual judge)
**When** the grade lands
**Then** the quality streak for that agent accrues; on threshold, the agent is rebuilt/patched from its playbook via Claude Code, re-verified, and the fix is announced.
**Status:** 🔴 grading exists and is tested (`delivery-eval.test.js`); the quality→heal wiring is not built (flagged gap). Pairs with UC-05.

### UC-09 · Broken agent detected → proactive rebuild offer (self-heal loop)
**Given** an agent that fails contract validation or has an unservable config
**When** it registers (boot or hot-connect)
**Then** the orb proactively offers a rebuild once per agent per session (deferred while another question is pending); "yes" rebuilds in place from the playbook and reports the verified outcome.
**Status:** ✅ `self-heal.test.js`, `agent-builder-selfheal.test.js`, bridge invariants. 🟡 live-fire pass in the app still outstanding.

### UC-10 · Feature-add: "add X to my Y agent" → updated in place → verified
**Given** an existing custom agent
**When** the user asks to extend/fix it by name
**Then** the builder proposes a modify consent carrying the current definition, updates the SAME agent (id/version history preserved), verifies, and reports honestly.
**Status:** ✅ `agent-builder-selfheal.test.js` (modify/rebuild + updateAgentId). 🟡 text-path turn-by-turn version.

---

## Additional standing cases (recommended)

### UC-11 · User-authored playbook drives the build
"playbook" at consent → WISER opens prefilled with the local-agent template → user authors → "build the agent from my playbook" → built verbatim from the authored spec.
**Status:** ✅ `agent-builder-from-playbook.test.js`.

### UC-12 · Agent Suggester: empty profile → interview → menu
No work profile → 3-question interview → profile saved (cross-agent) → suggestion menu grounded in gaps/conversation/chat history, roster collisions filtered, one-click Build.
**Status:** ✅ `agent-suggester-agent.test.js`, `agent-suggest.test.js`.

### UC-13 · Dual-channel consistency: spoken numbers == visual numbers
Whatever the voice claims ("3 meetings left"), the panel must decompose to the same count (done/blocks labeled, not silently included).
**Status:** ✅ for daily brief (`daily-brief-count-consistency.test.js`). Extend the invariant to any agent that speaks a count while showing a list.

### UC-14 · Timezone correctness at the edges
Evening requests (post-5PM Pacific) must resolve "today/tomorrow" to the LOCAL day everywhere (LLM prompts, cache keys, ranges).
**Status:** ✅ (`daily-brief-count-consistency.test.js` TZ block + source invariant banning UTC day-slices).

### UC-15 · Delivery guarantee: rich results always land somewhere visible
A voice task with visual payload must open a real window (modal escalation), and every settle gets a delivery verdict; silent failure = error event + spoken fallback.
**Status:** ✅ (`delivery-eval.test.js`, modal-render/panel-forwarding tests).

### UC-16 · Mic-noise protection WITHOUT pending state
Stray fragments ("um", "yes" with no question pending, multi-script hallucinations) are filtered with a gentle clarification — never dispatched.
**Status:** ✅ (`text-chat-consent-flow.test.js` idle cases + filter tests). The complement of UC-03.

### UC-17 · Cancel / barge-in mid-flow
"Never mind" / interruption cancels the in-flight task; LATE results after cancel are suppressed (no zombie speech minutes later).
**Status:** 🟡 router cancel + late-result suppression exist in bridge; barge-detector has 89 tests. Add a text-path case: submit → cancel → late settle → assert silence.

### UC-18 · Dependency-down visibility (no silent degradation)
A tool/agent whose backend is unavailable (e.g. Neo4j unconfigured — live on this machine) must fail VISIBLY with a next step ("configure in Settings"), feeding the self-heal/gap flow — never a shrug.
**Status:** 🔴 tools return `{error}` but the spoken UX for dependency-down isn't asserted anywhere. Add: events_add with no graph creds → honest spoken guidance.

### UC-19 · Pending-input isolation (no hijack)
When agent A awaits an answer and a proactive flow wants to ask something else, the user's reply must reach the agent they were actually answering.
**Status:** 🟡 self-heal defers when busy (tested); gap-recheck clears the dead-end pending (source-pinned). Add a two-pending text-path case.

### UC-20 · Budget-blocked build → honest decline + free alternative
Build consent at the daily cap → refused with the reason + Playbooks (no-cost) offer, never a silent failure or a surprise charge.
**Status:** ✅ (`claude-code-agent-builder.test.js`, `agent-builder-claude-code.test.js` budget cases).

---

## Roadmap order for the 🔴s
1. **UC-05 + UC-08** (agent self-fix on failure/bad-grade, ≤3 attempts) — closes the loop the self-heal system was built for; needs `agent:execution-failure` events + per-agent failure/quality streaks feeding the existing rebuild-offer/rebuild machinery, plus an autonomous (no-consent) mode gated by a setting.
2. **UC-04** (memory-update disclosure) — small: result field + spoken suffix.
3. **UC-18** (dependency-down UX) — small: standard error phrasing + settings pointer.

Run the whole catalog: `npx vitest run test/unit` (each ✅ names its file).
When adding a conversational feature, add its UC here and its flow test in the
text-chat harness — unit tests alone do not count as coverage for pipeline
behavior.
