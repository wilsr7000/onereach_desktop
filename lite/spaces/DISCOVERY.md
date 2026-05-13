# Spaces — Phase 0.5 Discovery

This document is the reference for the 6 verification queries that resolve architectural unknowns before Phase 1 + Phase 2 design locks. Q1–Q4 are auto-runnable from the Spaces window's Discovery panel. Q5 and Q6 are operational questions that require human resolution with the Edison team.

> **Workflow**: open `Tools → Spaces…`, click **Run Discovery**, copy the result as Markdown, paste below into the "Results — <ISO timestamp>" section, then fill in the Q5/Q6 answers from the Edison conversation.

---

## Q1 — Entity-type inventory (GATING)

Tells us which node labels exist in OmniGraph today. If only `:Item` exists, Phase 2's scope (item-only rendering) is confirmed by the data itself. If `:Agent` / `:Workflow` exist but are empty, the schema is forward-compatible without committing to render them yet.

The runner tries `apoc.meta.stats()` first; if APOC is unavailable, falls back to an explicit `UNION ALL` across the known labels (`Item`, `Asset`, `Agent`, `Workflow`, `Person`, `Tool`).

## Q2 — Provenance / authorship edges (INFORMATIONAL)

Tells us whether agent-produced items already carry authorship in the graph. Non-empty rows → Phase 2d "Produced by" line is wireable immediately. Empty rows → defer the provenance UI to a later phase that lands with the schema.

## Q3 — Are agents first-class graph nodes (INFORMATIONAL)

Confirms `:Agent` exists as a node label. Required for the Q2 provenance edge to mean anything.

## Q4 — User-level ACL filtering (GATING)

The auto-run probe captures **this account's** visible Space + Item counts. The GATING outcome requires re-running as a **second account** with known-different memberships and comparing.

Use the operational template below to record both accounts' results.

```
Account A (admin / power user):
  spaceCount: ____
  itemCount:  ____

Account B (viewer-only / different org):
  spaceCount: ____
  itemCount:  ____

Resolution:
  [ ] Counts differ → server-side ACL filtering confirmed.
  [ ] Counts identical → either (a) both accounts have the same access, OR
      (b) filtering is not happening server-side. Re-test with two
      accounts of known-different membership before treating as evidence.
```

The probe tells us **whether filtering exists** and whether it's symmetric across node types, but does NOT characterize the filter's granularity (per-membership vs. per-ownership vs. inheritance). Phase 2b's implicit reliance on the API filter assumes both (a) filtering exists, and (b) it operates at node-membership granularity. The first is testable from this query; the second requires reading Edison authorization code or a targeted test where one user can access a specific item via membership in only one Space and another cannot.

## Q5 — Agent identity model (GATING, operational)

**Promoted from INFORMATIONAL because Spaces is a platform primitive.** If agents are first-class platform consumers, the SDK signature depends on knowing how they authenticate. Designing `listItems(scope, opts)` without knowing whether `opts` needs to carry a delegation context, a service-account credential, or an inherited user token is designing the wrong API. The cost of getting this wrong is a v2 SDK; the cost of finding out now is one operational question.

Resolve with the Edison team — these are not Cypher queries:

```
1. How does an agent authenticate to /omnidata/neon?
   [ ] Service account credentials
   [ ] Per-task delegated user token
   [ ] Bot OAuth client credentials
   [ ] Other: ____

2. Does an agent inherit the dispatching user's ACL, or have its own identity?
   [ ] Inherits user ACL (delegated)
   [ ] Independent identity (service account)
   [ ] Hybrid: ____

3. Is there a schema model for agents as graph principals?
   [ ] :Agent nodes exist and appear on LHS of edges (agent)-[:DISPATCHED]->(...)
   [ ] :Agent nodes exist but only on RHS of edges (item)-[:PRODUCED_BY]->(agent)
   [ ] :Agent does not exist as a node label
```

### Branches by outcome

| Q5 outcome | Action on platform framing |
| --- | --- |
| Agents inherit user ACL + no `:Agent` schema | Platform framing deferred. Ship Phase 1+ as Lite-UI-only without SDK stability discipline. Re-evaluate when the schema lands. |
| Agents have independent identity OR `:Agent` schema exists | Platform framing holds. Phase 2 SDK signatures bake in delegation context. |
| Mixed / unclear | Phase 2 ships with a discriminated `Principal` union in the SDK; the actual auth wiring is fixed in Phase 3. |

## Q6 — Permission composition semantics (GATING, operational)

Phase 2b's permission-filtered chip Cypher does **not** assume a specific composition rule — it relies on whatever the `/omnidata/neon` endpoint enforces consistently across both node types. Confirm before Phase 2 locks:

```
When entity-ACL and Space-ACL both apply, how do they compose?

   [ ] Intersection (most restrictive) — item visible only if both Space-ACL
       AND entity-ACL grant access. (Phase 2b's implicit filtering is safe.)
   [ ] Union (most permissive) — item visible if either Space-ACL OR
       entity-ACL grants access. (Phase 2b's chip query needs an
       explicit predicate to filter `otherSpaces` per-user.)
   [ ] Override: Space wins
   [ ] Override: entity wins
   [ ] Documented behavior: ____

Resolution evidence:
   [ ] Documented in Edison's authorization layer code
   [ ] Targeted multi-account test passed
   [ ] Verified by Edison team (name + date)
```

---

## Kill / defer criteria

The plan defines these triggers; check them after discovery completes:

- **If Q1 returns only `:Item` and the graph has < 10 items** across all accounts → Phase 1 likely has nothing meaningful to render. Defer Phase 1 until OmniGraph is seeded with real content.
- **If Q4 returns identical counts across two known-different accounts** → server-side ACL filtering is unconfirmed. Block Phase 2b multi-Space chips until filtering is verified.
- **If Q5 resolves to "agents inherit user ACL + no `:Agent` schema"** → defer the platform framing. Document the deferral in `ROADMAP.md` "Out of Scope" and continue with Lite-UI-only intent.
- **If Q6 cannot be resolved before Phase 2b code lands** → Phase 2b ships with an **explicit** per-user predicate on `otherSpaces` (the safe default). Note the conservative choice in the Phase 2b commit message.

---

## Results — <YYYY-MM-DD HH:MM ISO>

_Paste the Discovery-panel Markdown output below, then fill in Q5/Q6._

<!-- Discovery output goes here -->
