# Replica Activation Runbook

**Audience**: operator (you) flipping the sync-v5 replica gates from
default-off to production-active. Pair this with
[`replica-shape.md`](./replica-shape.md) for the architectural
context.

**Status**: replica architecture A→F is shipped (commits `605e921`
through `a9f3240`). All operational gates default to off; the steps
below activate them in the order the architecture requires.

---

## At a glance

```
┌──────────────────────────────────────────────────────────────────┐
│ Phase 1: Boot + populate    (settings + restart, ~1 minute)      │
│ Phase 2: Shadow-write live  (settings + restart, then watch ~1d) │
│ Phase 3: Shadow-read live   (settings + restart, then ≥7 days)   │
│ Phase 4: Cutover read path  (settings + restart, watch closely)  │
│ Phase 5: Pull engine on     (devtools, optional)                 │
│ Phase 6: Strict mode        (settings, after ≥30 clean days)     │
└──────────────────────────────────────────────────────────────────┘
```

The single tool you'll run between phases:

```bash
npm run replica:status               # one-shot
npm run replica:status -- --watch=10 # live refresh
npm run replica:status -- --json     # for scripting
```

Exit codes: `0` healthy + gate met, `1` unmet, `2` disabled, `3` app
unreachable. Suitable for `cron` / CI canary.

---

## Pre-flight

Before flipping anything:

1. **Backup `OR-Spaces/` and the index.json**. The replica is
   additive (it doesn't modify primary storage), but Phase 6's
   strict mode eventually depends on the replica being correct, so
   start with a recoverable baseline.

2. **Confirm the app is on a build that includes commits A→F**:
   ```bash
   git log --oneline | grep -E '(commit (A|B|C|D|E|F))' | head -6
   ```
   You should see all six replica commits + the pre-A unification
   (`0c0d3d6`).

3. **Confirm Neo4j Aura is reachable** (cutover doesn't require
   Neo4j to be up, but Phase 5's pull engine does, and the heartbeat
   reporter complains in logs if it can't reach the graph). Check
   the existing `/sync/queue` schemaVersion handshake.

4. **Note your baseline state**:
   ```bash
   npm run replica:status > /tmp/replica-baseline.txt
   ```
   Should report "REPLICA: not wired".

---

## Phase 1 — Boot + populate

**Goal**: replica file exists at `userData/sync-v5/replica.sqlite`,
schema applied, ~1019 items + spaces migrated from
clipboard-storage-v2, content blobs uploaded to `userData/sync-v5/blobs/`.

**Action**:
1. Settings → Sync v5 → flip `syncV5.replica.enabled` to `true`.
   (Or edit the persisted settings JSON directly and restart.)
2. Restart the app.
3. Watch the boot log for:
   ```
   [sync-v5/replica] initialised at <path>/replica.sqlite (schemaVersion 1)
   [sync-v5/replica] shadow-writer attached (15 events subscribed)
   [sync-v5/replica] migration complete: spaces=N items=M hashed=M skipped=0 errors=0 duration=Xms
   ```
4. Run `npm run replica:status`.

**Expected**:
- Banner: `REPLICA: shadow-write only` (cyan)
- counts: `spaces=N items=~1019 smartFolders=K`
- `migratedFromClipAt` populated with an ISO timestamp
- shadow-writer: writes counter starts ticking as you use the app
- shadow-reader: `not wired` (expected -- shadow-read is Phase 3)
- validation gate: `not wired` (expected)

**Watch for**:
- `errors=N` in the migration line. Any non-zero count means specific
  items failed to migrate. Check the app log for the per-item error
  detail. Typically resolves to "missing body file on disk" -- those
  items will replicate on next write but won't have a content_hash.
- `skipped=N` is fine for items with no on-disk body (text-only items
  with content in the index entry already get hashed inline).
- `duration` over 60 seconds for ~1k items: investigate. Usually means
  blob store has slow disk; check `userData/sync-v5/blobs/` is on a
  reasonable filesystem.

**Rollback**: flip `syncV5.replica.enabled = false`, restart. The
replica file remains on disk (untouched by primary path) and the
next re-enable picks up where it left off (idempotent migration).

---

## Phase 2 — Shadow-write soak

**Goal**: every successful spaces-api write also writes the replica.
Drift detection happens here for the first time -- if the shadow-
writer encounters a write it can't mirror, it logs but doesn't crash
the primary write.

**Action**: nothing. Use the app normally for ~1 day. The shadow-
writer is auto-attached as part of Phase 1.

**Periodic check**:
```bash
npm run replica:status
```

**Expected**:
- shadow-writer: `writes` keeps growing, `errors=0`
- `lastWriteEvent` rotates through the events you'd expect
  (item:added, item:updated, item:tags:updated, etc.)
- `per event` line shows reasonable distribution

**Watch for**:
- `errors > 0`: read the per-event error detail in the log. Common
  causes: replica row missing for an item:updated (divergence; the
  shadow-writer synthesises a minimal row to catch up but logs a
  warning), or an upsert failure (rare; usually a write while the
  replica was being closed during shutdown).
- `lastError`: if non-null, an event is consistently failing. Capture
  the error string and the per-event counter; this is a real bug.

**Rollback**: same as Phase 1 (flip `enabled = false`, restart). The
replica's state is preserved.

---

## Phase 3 — Shadow-read window (the load-bearing one)

**Goal**: the §6.6 validation gate accumulates ≥7 days of clean
divergence logs across thresholds (≥100 items.list, ≥100 items.get,
≥50 search, ≥20 tag mutations, ≥10 smartFolders.list).

**Action**:
1. Settings → flip `syncV5.replica.shadowReadEnabled` to `true`.
2. Restart the app.
3. Confirm boot log: `shadow-reader + validation gate attached
   (sample 1-in-10 hot paths)`.
4. Run `npm run replica:status` -- now the validation gate section
   should be populated.

**Expected immediately after boot**:
- Banner: `REPLICA: shadow-read ACTIVE -- validation window in
  progress`
- shadow-reader: events appear with `inv` ticking
- validation gate: `cutoverAllowed: NO` (everything below threshold)
- `Blockers:` list with all 5 categories below threshold + wall-clock

**During the window** (use the app normally):

The hot-path events sample at 1-in-10 (items:listed, item:fetched).
Cold-path events compare 100% (items:findByTags, smartFolders:listed,
search). Counters tick on every invocation regardless of sample.

Run `npm run replica:status -- --watch=30` in a terminal to watch
progress live. The blockers list shrinks as thresholds are met.

**Daily check**:
```bash
npm run replica:status | tee -a /tmp/replica-day-N.txt
```

The wall-clock gate counts elapsed days from `startedAt`. Threshold
is 7d.

**Watch for**:
- **Divergences** (the critical signal). Expected: zero. If non-zero:
  1. The `Last divergence` summary in the CLI output shows the event
     and offending ids.
  2. Investigate: did spaces-api do something the shadow-writer
     didn't propagate? Is there a write path that bypasses
     spaces-api's `_emit`?
  3. Fix the root cause.
  4. Reset the gate (operator action only):
     ```js
     // From devtools console of the running app:
     globalThis.__syncV5.replicaValidationGate.reset();
     ```
     This zeroes the counters and stamps a fresh `startedAt`. The
     7-day floor restarts.

- **Slow gate progression**: if items.list is at 247/100 but
  smartFoldersList is at 3/10 after 5 days, the user just doesn't
  use smart folders much. Expected and not a problem -- the gate is
  designed to require sustained traffic across all dimensions, not
  fast-burst on one.

- **search divergence is intentionally NOT compared** in commit D
  (counts only). FTS5 query parity is a follow-up commit; until it
  lands, `search` divergence column always reads 0.

**Rollback**: flip `syncV5.replica.shadowReadEnabled = false`,
restart. Counters preserved (debounced flush on shutdown). Re-enabling
later resumes accumulation; no need to start from zero unless you
explicitly `reset()`.

---

## Phase 4 — Cutover read path

**Goal**: spaces-api reads route through the replica via
`setCutoverProvider`. **This is the architecturally significant
change.** Until now the replica was observable; from this phase
forward it's load-bearing for reads.

**Pre-condition** (do not skip):
```bash
npm run replica:status
# Must show:
#   validation gate: cutoverAllowed YES
#   wall-clock: at least 7d met
#   all invocation gates: met
#   divergences: 0 (clean)
```

If any of those is missing, **stop**. The architecture's whole point
is to refuse cutover until these are met.

**Action**:
1. Settings → flip `syncV5.replica.cutoverEnabled` to `true`.
   Leave `syncV5.replica.fallbackToOldPath = true` (default).
2. Restart the app.
3. Boot log should show:
   ```
   [sync-v5/replica] CUTOVER ACTIVE -- spaces-api reads now route through replica (fallback enabled)
   ```
4. Run `npm run replica:status`.

**Expected**:
- Banner: `REPLICA: CUTOVER ACTIVE  (fallback enabled)`
- cutover: `enabled=yes  active=yes  fallbackToOldPath=enabled`
- The shadow-reader keeps comparing (now: replica vs replica, but
  divergences would still surface if the cutover provider's row
  reshape is buggy).

**Watch for** (next 24-48h):
- App behaves normally. UIs render correctly. Search still works
  (search is NOT in the cutover provider; it stays on the primary
  path until FTS5 parity ships).
- shadow-writer counters keep ticking (writes still go through
  primary -> replica via the shadow path).
- Divergences stay zero. If a divergence surfaces post-cutover, it
  means the cutover provider's row reshape (snake_case ↔ camelCase
  translation) lost a field. Look at the `differences[]` array.

**Rollback (immediate)**: flip `cutoverEnabled = false`, restart.
Reads return to primary path on the very next call. No data
consequences -- the replica continues to be shadow-written.

**Belt-and-braces**: even if you forget to flip the flag, the
validation gate's `cutoverAllowed()` is checked at boot. If
divergences accumulated since cutover started, the gate refuses to
re-attach the cutover provider on next boot. A bad cutover state
self-heals on restart.

---

## Phase 5 — Pull engine (optional, requires Neo4j)

**Goal**: remote ops from other devices land in the local replica.
Today (single-device) this phase is mostly proof-of-life. Becomes
load-bearing when the iPhone Spaces client ships and starts writing
to the same graph tenant.

**Action**:
1. Confirm Neo4j is reachable: `curl /sync/health/schemaVersionDistribution`.
2. From the running app's devtools console:
   ```js
   await globalThis.__syncV5.pullEngine.start();
   ```
3. Run `npm run replica:status`.

**Expected**:
- pull-engine adapter section shows non-zero `applied` and/or
  `tombstoned` counters as remote ops land.
- pull-engine `applyMode: sqlite` (already set since `cutoverEnabled
  = true` in Phase 4 boot, but only meaningful once started).

**Stop**: from devtools, `__syncV5.pullEngine.stop()`. The engine is
a long-running poller; stopping doesn't lose state but does pause
remote-op ingestion.

---

## Phase 6 — Strict mode + legacy retirement

**Goal**: remove the safety net. After this point, a replica miss
is a real error rather than a fall-through.

**Pre-condition**: ≥30 days of clean cutover. `npm run replica:status`
should report zero shadow-reader divergences and the cutover
provider's per-method `errors` counter should be zero across the
window.

**Action**:
1. Settings → flip `syncV5.replica.fallbackToOldPath = false`.
2. Restart the app.
3. Boot log: `CUTOVER ACTIVE -- spaces-api reads now route through
   replica (strict mode, no fallback)`.

**Watch for**: the next ~72h, any spaces-api error logs. In strict
mode, a replica miss surfaces as an exception in the renderer
(rendered via the existing error-diagnostics overlay shipped in
`a4a93d0`). If you see "replica list failed" repeatedly, flip
`fallbackToOldPath` back to `true` and investigate.

**Final retirement** (longer tail; not on this runbook): physically
remove `clipboard-storage-v2.js` and `spaces-sync-manager.js`. This
is a deliberate refactoring pass touching dozens of callers; estimate
1-2 weeks of focused work.

---

## Quick-reference: emergency rollback

If anything goes wrong at any phase:

| Symptom | Action |
|---|---|
| App won't start | Flip the most recent setting back; restart. The previous phase's flags stay set. |
| Read divergences | Phase 3: investigate. Phase 4+: `cutoverEnabled = false` + restart -> reads back on primary. |
| Write divergences | Phase 2+: `replica.enabled = false` + restart. Replica file stays on disk. |
| Pull engine misbehaving | Devtools: `__syncV5.pullEngine.stop()`. Restart not required. |
| Strict mode causing errors | `fallbackToOldPath = true` + restart. |
| Total roll-out | `replica.enabled = false` + restart. The replica file at `userData/sync-v5/replica.sqlite` is untouched primary state; can be deleted manually if a fresh re-migration is desired. |

---

## What to capture if you find a bug

For divergences, please grab:
1. Output of `npm run replica:status -- --json > status.json`
2. The 100 most recent log lines from the app
3. The specific item id(s) from `onlyInPrimary` / `onlyInReplica`
4. A description of what you were doing when it happened

The architecture has the structured signal it needs to debug
divergences without guesswork; capturing those four artefacts is
usually enough to pinpoint the cause.
