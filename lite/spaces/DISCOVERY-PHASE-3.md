# Spaces — Phase 3 Discovery (ACL semantics)

This document is the reference for the **D-series operational questions** that gate Phase 3d (Sharing UX) of the Lite Spaces module. It mirrors the Phase 0.5 Q5/Q6 pattern in [`./DISCOVERY.md`](./DISCOVERY.md): operational questions for the Edison team, tracked here, resolved before code lands.

> **Workflow**: send the questions below to whoever owns Edison authorization. Paste their answers under the "Answers — `<ISO timestamp>`" section at the bottom. Phase 3d code is blocked until D1-D4 return; D5-D7 are needed before 3d ships.

These questions exist because **sharing isn't on the existing Spaces roadmap and the wire format is not documented**. The Phase 0.5 discovery confirmed read-side ACL filtering exists; it didn't characterize the write-side grant/revoke semantics. Designing 3d around an assumed shape (like baking `[:CAN_READ]` edges into Cypher) and then discovering Edison expects a REST call into the authz layer would mean a v2 of the SDK before v1 ships. The questions below close that gap before code begins.

---

## D1 — How is per-Space access expressed in the graph? (GATING)

```
[ ] :CAN_READ / :CAN_EDIT / :CAN_ADMIN edges from principal to :Space
[ ] :MEMBER_OF edge with a level property
[ ] Account-level membership inherited (no per-Space ACL exists today)
[ ] Edison-side authz wraps Cypher with viewer-aware filters (no graph-visible ACL)
[ ] Other: ____
```

**Why it gates**: the SDK signature for `spaces.share()` depends on whether the wire format is a Cypher edge create, a property update, or an Edison API call. Wrong shape here is a v2 SDK.

---

## D2 — What permission levels exist? (GATING)

```
[ ] read / edit
[ ] read / edit / admin
[ ] read / edit / admin / owner
[ ] custom: ____
```

**Why it gates**: the Lite Share modal needs a permission-level radio. The set of choices and the semantics of each level (e.g. does "edit" allow re-sharing? does "admin" allow delete?) shape the UI.

**Follow-up**: for each level, what mutations are allowed?
- read: list items, read content
- edit: file in / remove items? rename Space? add other items via 3c?
- admin: re-share? grant other users?
- owner: delete? transfer ownership?

---

## D3 — How is "grant" expressed in Cypher? (GATING)

```
[ ] CREATE (p:Person {id: $principalId})-[:CAN_READ]->(s:Space {id: $spaceId})
[ ] MERGE (p:Person {id: $principalId})-[r:MEMBER_OF]->(s:Space {id: $spaceId}) SET r.level = $level
[ ] Edison API call (REST or RPC; not direct Cypher)
[ ] Other: ____
```

**Why it gates**: 3d's `spaces.share(spaceId, principal, level)` SDK method has to wrap the right call. Direct Cypher means it lives in `lite/spaces/sdk-client.ts`; Edison API means it lives in the Edison SDK and we proxy through `lite/spaces/`.

---

## D4 — How is "revoke" expressed in Cypher? (GATING)

```
[ ] DELETE (p:Person {id: $principalId})-[r:CAN_*]->(s:Space {id: $spaceId})
[ ] Property update on the edge (e.g., r.revokedAt = datetime()) -- soft revoke
[ ] Edison API call (REST or RPC)
[ ] Other: ____
```

**Why it gates**: drives the inverse method registered in `trust-principles.test.ts`. If revoke is soft (property update), the inverse is "clear `revokedAt`"; if hard (DELETE), the inverse is "re-grant from scratch."

---

## D5 — Who can grant access? (GATING)

```
[ ] Owner only
[ ] Anyone with edit
[ ] Anyone with admin
[ ] Account-level admin role only
[ ] Other: ____
```

**Why it gates**: drives the renderer's Share button visibility. Showing a button the user can't actually click is a worse UX than not showing it; the visibility check happens in the renderer based on the current principal's effective permission on the Space.

**Follow-up**: how does Lite know the current principal's effective level on a given Space? Is it carried on every `listSpaces()` row? A separate `getMyLevel(spaceId)` query? Inferred from the existence of an edge?

---

## D6 — Permission composition with item ACLs (GATING, revisits Phase 0.5 Q6 for write paths)

Phase 0.5 Q6 asked the read-side composition question: when entity-ACL and Space-ACL both apply, how do they compose? The answer governed the Phase 2b multi-Space chip Cypher.

For Phase 3, the write-side question is similar but distinct:

```
When user A shares Space S with user B at level "read", and Space S contains item I that user B was already FORBIDDEN to read at the item level, what does user B see?

[ ] B can read I in S (Space-ACL wins for items shared into the Space)
[ ] B cannot read I (item-ACL wins; intersection)
[ ] B can read I in S but not in any other Space I participates in
[ ] Sharing a Space cannot grant access to items the recipient otherwise can't see (sharing only grants access to items A also has access to that intersect S)
[ ] Other: ____
```

**Why it gates**: this is the difference between a benign share gesture and a privilege-escalation surface. If sharing a Space transitively grants access to all items in it (option 1), users sharing freely can leak items they didn't realize were inherited. If item-ACL wins (option 2), the recipient sees an empty Space and gets confused.

Lite needs to know the model so the Share modal can show "B will gain access to N items in this Space" or warn "Some items will not be visible to B because they have stricter item-level access."

---

## D7 — Member picker query + PII shape (GATING)

```
1. What is the query for "people in my account I could share with"?
   [ ] Cypher query against :Person + account membership edges
   [ ] @or-sdk/accounts call (which method?)
   [ ] Edison REST endpoint (which path?)
   [ ] Other: ____

2. What does a row in the response contain?
   [ ] id
   [ ] displayName / name
   [ ] email
   [ ] avatar URL
   [ ] role / title
   [ ] phone
   [ ] last-active-at
   [ ] Other: ____

3. Is the response already filtered to "people the caller is allowed to see"?
   [ ] Yes, server-side filtered
   [ ] No, returns all account members regardless of caller
   [ ] Depends on caller's role
```

**Why it gates**: the answer determines (a) where the member-picker code lives (new `lite/people/` module vs extending `lite/auth/api.ts`), (b) whether Lite has to layer a privacy filter on the response before render, and (c) what the picker UI can show without leaking PII. See [`PRIVACY-REVIEW-PICKER.md`](./PRIVACY-REVIEW-PICKER.md) for the privacy-side work that follows D7's answer.

---

## D8 — Space ID issuance (INFORMATIONAL; affects 3a)

```
When Lite calls spaces.create({ name, ... }), where does the resulting Space's id come from?

[ ] Lite generates a UUID; Edison/Neo4j accepts it
[ ] Lite calls an Edison endpoint that returns an id; Lite then issues the Cypher CREATE
[ ] Lite calls Cypher CREATE without specifying id; the response includes the server-assigned id
[ ] Lite uses elementId (Neo4j-internal) returned by CREATE
[ ] Other: ____
```

**Why it's informational not gating**: 3a SDK method works either way; the difference is whether `spaces.create()` rounds-trips an extra call to fetch the id, or assigns it client-side. Lite prefers client-issued UUIDs for offline-tolerance, but isn't blocked on this.

---

## D9 — Notification on share grant (INFORMATIONAL; affects future Phase 4)

```
When user A grants user B access to Space S, is there a notification surface today?

[ ] No notification anywhere; B discovers the new Space in their sidebar on next refresh
[ ] Email notification via Edison
[ ] In-product notification (where? what surface?)
[ ] Other: ____
```

**Why it's informational not gating**: Phase 3d emits a `spaces.share.granted` event regardless. Phase 4 builds the recipient-side notification UI; D9's answer informs that design but doesn't block 3d.

---

## Branches by outcome

| D1 outcome | Effect on Phase 3d |
|---|---|
| Per-Space ACL edges exist | 3d Cypher `CREATE/DELETE` edges; SDK lives in `lite/spaces/sdk-client.ts` |
| `:MEMBER_OF` with level property | 3d uses `MERGE ... SET r.level`; revoke is `DELETE` or `SET r.revokedAt` per D4 |
| Account-membership inherited (no per-Space ACL) | 3d collapses to "you can't share a Space; sharing happens at account level"; Lite Share modal becomes "invite to account" or is removed entirely |
| Edison-side authz wraps Cypher | 3d wraps Edison API call; `lite/spaces/sdk-client.ts` doesn't handle the grant directly |

| D2 outcome | Effect on Phase 3d |
|---|---|
| read/edit | Modal radio has 2 options; edit semantics need spelling out |
| read/edit/admin | Modal radio has 3 options |
| read/edit/admin/owner | Modal radio has 4 options; owner transfer is a separate UX |
| custom | Plan revisits modal copy + permission-level constants in `lite/spaces/types.ts` |

| D5 outcome | Effect on Phase 3d Share button visibility |
|---|---|
| Owner only | Hide Share button unless `myLevel === 'owner'` |
| Anyone with edit | Hide unless `myLevel >= 'edit'` |
| Anyone with admin | Hide unless `myLevel >= 'admin'` |

---

## Kill / defer criteria

- **If D1 returns "Account-level membership inherited (no per-Space ACL exists today)"** → Phase 3d collapses dramatically. Either (a) defer 3d entirely until per-Space ACL lands in Edison, or (b) reframe 3d as "invite a teammate to your account, then they'll see all your Spaces." The plan defaults to (a); (b) requires re-spec.
- **If D6 returns "Sharing a Space transitively grants access to items inside"** → Phase 3d Share modal must show a clear "B will gain access to these N items" preview before confirm. Cannot ship without that preview UI.
- **If D7 returns "response is not server-side filtered AND contains PII (emails)"** → Phase 3d cannot ship until [`PRIVACY-REVIEW-PICKER.md`](./PRIVACY-REVIEW-PICKER.md) signs off on a Lite-side filter.
- **If D5 cannot be answered before 3d code lands** → ship 3d with a defensive default: hide the Share button unless the user is the owner of the Space. Note the conservative default in the 3d commit message.

---

## Process notes

- These questions go to the Edison-authorization owner via the standard channel for cross-team operational asks. Same channel as Phase 0.5 Q5/Q6.
- The plan intentionally does NOT pre-design the SDK signature for `spaces.share()` — the signature waits for D1-D4 answers. Pre-designing risks throw-away work.
- Privacy review for D7 ([`PRIVACY-REVIEW-PICKER.md`](./PRIVACY-REVIEW-PICKER.md)) starts immediately on D7 return; cannot wait for D1-D6 to all be answered.

---

## Answers — `<YYYY-MM-DD HH:MM ISO>`

_Paste Edison answers here, one D-question per subsection. Mark the date you received the answer. Multiple Answer sections accumulate as the team iterates._

<!-- Answers go here -->

---

## Out-of-band finding — 2026-05-13 (Phase 0 schema gap)

While answering an unrelated UI report ("Spaces in Lite show empty when clicked"), we
ran live Cypher probes against the production Neon graph at
`em.edison.api.onereach.ai/.../omnidata/neon` and discovered that
**Lite's Spaces SDK (Phase 1+2) was querying a schema that doesn't exist in the data**.
This pre-dates the D-series questions in this doc and gates them: Phase 3 sharing
UX presumes Phase 2 actually returns items, which it didn't.

### What was wrong

Lite's `lite/spaces/sdk-client.ts` Cypher used:
- Node label `:Item`
- Edge `[:MEMBER_OF]` from item to Space
- Properties `i.title`, `i.kind`, `i.fileKey`, `i.excerpt`, `i.createdAt`

The actual graph (verified live) uses:
- Node label `:Asset` — the canonical `(:Schema {entity:'Asset'})` declares no `Item` entity
- Edge `[:BELONGS_TO]` from Asset to Space — `[:MEMBER_OF]` is reserved for Person→Space membership
- Mixed legacy / canonical property names depending on the producer:
  - Legacy (`omnigraph-client.js`): `title`, `assetType`, `fileUrl`, `fileSize`, snake_case timestamps
  - Canonical (per `:Schema`): `name`, `type`, `url`, `size`, camelCase timestamps

Result: `MATCH (i:Item)-[:MEMBER_OF]->(s:Space {id: $spaceId}) RETURN count(i)` returned
`0` for every Space. Empty Lite UI even when the Space had items.

### What was fixed (this commit)

`lite/spaces/sdk-client.ts CYPHER` now queries the canonical schema (`:Asset` +
`[:BELONGS_TO]` + `[:CREATED]` for provenance) with `coalesce(canonical, legacy, default)`
projections so existing data keeps rendering while new producers can move to canonical
names. Lite's TypeScript surface (`Item` / `ItemSummary` / `ItemKind`) is unchanged;
the storage label translation lives in the SDK.

### What this does to Phase 3

| D-question | Effect of this finding |
|---|---|
| **D1** ("how is per-Space access expressed?") | Unchanged — read-side ACL question still needs Edison's answer. The `[:MEMBER_OF]` direction is now confirmed available in the schema for Person→Space; previously we had no data to verify. |
| **D2** ("what permission levels exist?") | Unchanged — operational question for Edison. |
| **D3 / D4** ("how is grant / revoke expressed?") | Unchanged — operational. |
| **D5 / D6** ("who grants, composition with item ACLs?") | Unchanged — operational; but D6's "what does B see in S?" presumes S has visible items, which only became true today. |
| **D7** ("member picker query + PII shape") | Unchanged — operational. |

The finding does NOT unblock D1–D7. They remain operational questions for Edison.
But it does unblock the empirical Phase 0.5 verification work that was supposed to
happen before Phase 1 shipped: the schema is now queryable from Lite for the first
time.

### Producer-side debt this exposed

Two bugs in `omnigraph-client.js` (full app, not Lite) that lite's coalesce fallbacks
mask but should be cleaned up before public launch:
1. **Empty `name` defaults to `id`** at `omnigraph-client.js:1008` (`SET s.name = '${escapeCypher(space.name || space.id)}'`). Same pattern at lines 792, 1063, 1286, 1790, 1824. Caused production Spaces / Assets to be named with their own GUIDs.
2. **Writes legacy property names** instead of canonical (per `(:Schema {entity:'Asset'})`). Should write `name` not `title`, `type` not `assetType`, `url` not `fileUrl`, etc.

Both tracked in `lite/LITE-PUNCH-LIST.md` under "Medium Priority" cross-noted to full's punch list.
