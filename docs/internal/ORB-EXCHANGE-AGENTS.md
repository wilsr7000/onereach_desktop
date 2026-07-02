# Exchange-Centric Agent Architecture — Roles, Flows, Build Plan

Status: **in progress** (incremental, loop-driven). Each piece lands complete + tested.
Owner: voice-orb / exchange refactor. Related: [ORB-VOICE-INTERACTION.md](ORB-VOICE-INTERACTION.md).

## Goal

Move the voice/text/modal surfaces from **special-cased plumbing** to **first-class
exchange participants**, so the system matches the intended model:

> The exchange is the center of orchestration. Every I/O surface (voice, chat,
> modal) is *just another agent* that listens to the exchange and relays
> information to/from the user. A moderator agent keeps the exchange healthy and
> clear. All activity is a task; tasks are removed when done.

This is a *hardening* refactor, not a rewrite. The auction/bidding core, intent
rewriting, followup correlation, and chat persistence are already correct (see
scorecard below) and stay. We generalize the I/O edge and close two real gaps.

## Current-state scorecard (verified 2026-07-02, 5 exploration passes)

| Requirement | State |
|---|---|
| Voice transcribed → same pipeline as typed text | ✅ (`submitTask`→`processSubmit`) |
| Spoken responses also written to chat history | ✅ (`task:settled` → `role:'assistant'`) |
| Chat history persists across relaunches | ✅ (`lib/orb-chat-history.js`, JSONL) |
| Utterance posted with context + rewritten intent + confidence | ✅ (`normalizeIntent`) |
| Agents bid with rationale + confidence | ✅ (0.5 floor, 100% LLM) |
| Disambiguate when unclear / no bidders | ✅ (`exchange:halt` handler) |
| Followup routed back to the initiating agent | ✅ **strong** (`TranscriptService` pending, keyed by `agentId`) |
| Standard response format (modal+spoken+typed) | ✅ (`normalizeAgentResult`) |
| Modal/UI input → text → back to originating agent | 🟡 inline HUD ✅ / **pop-out modal ❌ output-only** |
| Orb is a peer that listens to the exchange | ❌ privileged IPC tool; sees only its own tasks |
| Exchange self-clears; moderator agent | 🟡 central-ish w/ bypasses; ❌ tasks never pruned; ❌ no moderator |

## Target roles (each a modular participant)

All four I/O agents implement one small interface — a **RelayParticipant** — that
differs only in input source and output channel. They are `bidExcluded` (they
relay, they don't bid on user work).

| Role | Owns | Inbound | Outbound |
|---|---|---|---|
| **Voice Relay Agent** | mic + TTS (`voice-listener`, `voice-speaker`) | speech → transcript → task | result `spokenSummary` → speech; enters listen on `needsInput` |
| **Chat Agent** | text chat surface + persistence | typed text → task | result `visualText` → chat history (persisted) |
| **Modal Agent** | pop-out `ui`/`html` windows | modal UI interaction → text (correlated) | result `html`/`ui` → modal window |
| **Exchange Manager Agent** | exchange health + lifecycle | — (watches feed) | prunes SETTLED tasks; meta-tasks (re-sort, evict stuck); health/liveness |

Existing task agents (daily-brief, calendar, meeting-monitor, …) are unchanged.

### The RelayParticipant interface (shared brain = `lib/exchange/relay-core.js`)

Pure, side-effect-free decision functions the three I/O agents share:

- `classifyInbound({ source, text, interaction, awaitingAgentId })` → a
  submission descriptor: whether to submit, the text to submit, and the
  correlation (`targetAgentId`) so a modal choice or a followup answer returns to
  the agent that asked. Converts a **modal interaction** (`{value,label,field,agentId}`)
  into a text utterance — this is the modal-agent's core and the missing input path.
- `planOutbound(normalizedResult, { voiceMode })` → a channel plan:
  `{ speak, chat, modal, listenAfter }` — which of the three channels to drive for
  a given normalized agent result, and whether to re-open the mic (followup).

`planOutbound` consumes an already-`normalizeAgentResult`-normalized object; it
does not duplicate normalization. `classifyInbound` is new (the inbound edge was
never unified). Both are pure → unit-tested without Electron.

## Use-case flows

### UC1 — Daily brief (voice, happy path)
1. Voice Relay: speech → `classifyInbound({source:'voice'})` → submit utterance (no correlation).
2. Exchange: `normalizeIntent` rewrite → bid auction → `daily-brief-agent` wins → executes.
3. Result normalized. `planOutbound` → speak `spokenSummary`, append `visualText` to chat, render `ui` (dayView) as modal. `listenAfter:false`.
4. Voice Relay speaks; Chat Agent persists; Modal Agent shows the day view.

### UC2 — Typed request (chat, voice off)
1. Chat Agent: typed text → `classifyInbound({source:'text'})` → submit.
2. …auction…; `planOutbound({voiceMode:false})` → chat only (no speak).

### UC3 — Followup question (multi-turn)
1. Agent returns `needsInput:{agentId,prompt}`. Exchange stores pending (keyed by `agentId`) — task stays open.
2. `planOutbound` → speak/type the prompt, `listenAfter:true`.
3. Voice Relay enters listen (or Chat Agent shows an input affordance).
4. User answers → `classifyInbound({awaitingAgentId})` sets `targetAgentId` → `routePendingInput` re-executes **that** agent. No new auction.

### UC4 — Modal input (the gap)
1. Modal Agent renders an interactive `ui` (buttons/form) from `agentId`.
2. User clicks/submits → Modal Agent captures `{value,label,agentId,field}`.
3. `classifyInbound({source:'modal',interaction})` → text + `targetAgentId:agentId`.
4. → `routePendingInput` → originating agent resumes. Same correlation path as UC3.

### UC5 — Proactive prompt (any agent, any time)
1. A background agent (meeting-alarm) emits `needsInput`/announce for a task the user never started.
2. Exchange Manager routes it to the Voice/Chat relay via a **global** needs-input feed.
3. Relay prompts the user even with no active user turn. (Today the orb can't hear this — the ❌ above.)

### UC6 — Task lifecycle / self-clearing
1. On `task:settled`/`cancelled`, Exchange Manager removes the task from the active map (archives to log).
2. Health watchdog: stuck-task eviction, heartbeat liveness; exposes exchange health.

## Build plan (ordered; each item is independently testable)

- [x] **0. Design** — this document.
- [x] **1. `lib/exchange/relay-core.js`** — pure `classifyInbound` + `planOutbound` (+ `buildModalSubmit`) + 21 tests. Commit `3bbe835`.
- [x] **2. Modal Agent bidirectional input** — `agent-ui-modal.html` delegated click/submit handler → `preload` `submitInput` → `agent-ui:submit-input` IPC → `relay-core.buildModalSubmit` → `submitTask(metadata.targetAgentId)` → `routePendingInput`. Closes UC4. Same correlation path as the inline HUD panel. `buildModalSubmit` unit-tested.
- [ ] **3. Global needs-input feed** — Voice/Chat relay subscribe to *all* `needsInput`, not just own tasks. Closes UC5 (behavioral). Tests. ← *next iteration*
- [ ] **4. Exchange Manager Agent** — settled-task pruning + health watchdog (UC6). Tests.
- [ ] **5. Register I/O surfaces as `bidExcluded` participants** — orb/chat/modal become true exchange peers (Option A). Tests.
- [ ] **6. ADRs** — formalize the RelayParticipant contract + moderator + lifecycle once shape is proven.

Each step commits green (unit suite + eslint). Nothing merges half-built.
