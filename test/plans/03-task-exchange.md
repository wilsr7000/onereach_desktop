# Task Exchange Test Plan

## Prerequisites

- App running (`npm start`)
- At least 2 agents enabled in Agent Manager (for bidding tests)
- Exchange bridge initialized (happens automatically on startup)

## Features Documentation

The Task Exchange (`packages/task-exchange/src/exchange/exchange.ts`) is an auction-based system for routing tasks to agents. When a task is submitted, it enters an auction where enabled agents place bids. The highest-scoring bid wins, and that agent executes the task. If execution fails, the task cascades to backup agents. The system tracks agent reputation, supports rate limiting, and has a circuit breaker that halts tasks after repeated failures.

**Key files:** `packages/task-exchange/src/exchange/exchange.ts`, `packages/task-exchange/src/types/index.ts`, `src/voice-task-sdk/exchange-bridge.js`
**Task statuses:** PENDING, OPEN, MATCHING, ASSIGNED, SETTLED, BUSTED, CANCELLED, DEAD_LETTER, HALTED
**Priorities:** URGENT (1), NORMAL (2), LOW (3)
**Execution modes:** single, parallel, series

## Checklist

### Task Lifecycle
- [ ] `[A]` Submit a task via exchange bridge -- receives task ID back
- [ ] `[A]` Task transitions through PENDING -> OPEN -> MATCHING -> ASSIGNED -> SETTLED
- [ ] `[A]` Cancel a pending task -- status becomes CANCELLED
- [ ] `[A]` Get task by ID returns correct status and metadata

### Auction and Bidding
- [ ] `[A]` Multiple agents bid on same task -- highest score wins
- [ ] `[A]` Disabled agents do not participate in auctions
- [ ] `[P]` Agent with higher reputation scores higher in bids (verify via bid history)

### Priority Ordering
- [ ] `[A]` URGENT tasks are processed before NORMAL tasks in queue
- [ ] `[A]` NORMAL tasks are processed before LOW tasks

### Failure and Cascade
- [ ] `[A]` When assigned agent fails (BUSTED), task cascades to next-best bidder
- [ ] `[A]` When all agents fail, task enters DEAD_LETTER status
- [ ] `[P]` Circuit breaker triggers HALTED after repeated failures (verify via stats)

## Automation Notes

- **Existing coverage:** None (no spec file for Task Exchange)
- **Gaps:** All items need new tests
- **Spec file:** Create `test/e2e/task-exchange.spec.js` -- can test via `electronApp.evaluate` calling exchange bridge functions directly
- **Note:** Most tests can run headless by evaluating exchange functions in the main process
