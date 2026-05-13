# Spaces Manager — Micro-Phased Plan

This is the canonical source plan for the Lite Spaces module. It supersedes the prior revision plans:

- `.cursor/plans/spaces-plan-conceptual-additions_ec8410dd.plan.md`
- `.cursor/plans/spaces-plan-final-conceptual-additions_2ef6ba32.plan.md`
- `.cursor/plans/spaces-plan-revised-after-critique_6e95f000.plan.md`
- `.cursor/plans/spaces-plan-final-with-cypher-fixes_6b95dc97.plan.md`

The 9 edits described in `Spaces Manager Plan — Reframed for Agent Workspace` are reflected directly in the section bodies below.

## Conceptual Model

Lite Spaces is a graph-backed shared workspace where humans and AI agents co-produce, attribute, and govern organizational artifacts.

Spaces exist because organizational intelligence cannot scale as a single undifferentiated context window — not for humans reading it, and not for agents writing into it. Decomposing into contextual overlays reduces retrieval pollution, governance complexity, write-conflict ambiguity, and agent-scoping ambiguity.

Spaces are contextual overlays on a shared organizational ontology — not folders, not agent-private scratch pads. Assets, agents, workflows, people, and tools exist canonically in the graph and may participate in many Spaces simultaneously. Spaces contextualize entities; they do not own them.

The ontology is the canonical, organization-wide catalog of entities and their relationships. It is shared by every Space and owned by no Space. Spaces are operational contextual overlays on top of that shared ontology.

Concretely: a Q3 forecast PDF exists once in the ontology. It participates in the Finance Space (where the controller sees it alongside other forecasts), the Q3 Planning Space (where the strategy team sees it alongside meeting notes), and the Audit Space (where compliance sees it alongside provenance metadata). One asset. Three contexts. No duplication.

### Who produces, who governs

- **Agents** write outputs into Spaces they have access to, as part of task execution. Most production traffic in a mature deployment comes from agents.
- **Humans** write notes, drop files, capture web content. Lower volume; higher semantic intent per item.
- Both flow through the same Space membership model, the same audit log, and the same Librarian assistance layer.

Humans don't "file" information in the filesystem sense. They govern contextualization — for their own input, and for agent output entering the canonical record.

Note: we're designing for an agent-dominant production ratio — most volume arriving from agent task execution, less from human drops. If humans dominate in practice (e.g., during early adoption before agent deployment matures), the Uncategorized triage UX and Approval queue scaling assumptions need revisiting. The architecture handles either ratio; the UX defaults assume the mature state.

### What the AI assists with

- **Reconciliation** when agents produce overlapping work
- **Dedup** when new output resembles existing assets
- **Suggested contextualization** for open-ended human-dropped content
- **Anomaly flagging** when agent output doesn't fit expected patterns
- **Cross-Space discovery** before agents redundantly produce existing work
- **Provenance attribution** — every asset traces to an author, task, timestamp

### The Librarian model

Librarian agents are NOT primarily organizers of what humans drop. That is a small, visible slice of their work. Their primary job is to make the agent workforce legible to humans: surfacing what agents produced, where they placed it, why, what conflicts arose, and what needs review.

The product principle stands: "Just put the book in the bin — the AI librarians organize the company." It applies equally to human drops and to agent output without explicit destination.

The breakthrough is not search, not RAG, not retrieval — it is the continuous contextualization of organizational intelligence produced by humans AND agents in concert.

This plan is the first slice of that system: read-only browse of Spaces and their contents. Later phases add write paths (with agent + user provenance), the Approval + Audit queue for agent output, the activity feed showing what agents and Librarians produced today, and graph and overlap views.

### Trust Principles (govern Phase 3+ Librarian behavior)

This plan establishes the read-only substrate; Librarian actions don't exist yet. The principles below bind every phase that introduces them starting Phase 3, and apply equally to suggestions made about human-dropped content AND about agent-produced output:

1. **Suggest, don't decide.** The default for any AI-initiated action is a suggestion awaiting human approval. For agent-produced output specifically: the default is "needs review before entering the canonical record." Auto-acceptance is opt-in per agent, per Space, with admin-configurable confidence thresholds.
2. **Explainable.** No suggestion or action exists without structured, traceable reasoning. Every "Why was this suggested?" and "Why did this agent produce this?" question has a first-class answer derived from graph evidence, not generated post-hoc.
3. **Reversible.** Every Librarian and agent action — including those auto-applied above a confidence threshold — has an undo. Context changes are never destructive at the entity level; they affect membership, not existence.
4. **Attributable.** Every action is attributable to a principal (human user, agent, or service identity) with full provenance chain. Attribution is the precondition for governance in regulated industries — and the precondition for agent-workforce visibility.

### Product Name Note

The product name "Spaces Manager" is provisional through Phase 2. It is read in menu copy, route names, telemetry event names, and the sidebar header. Locking an alternative (e.g. "The Library", "Context") requires a small rename pass; locking after Phase 2 ships requires migration of telemetry event names and external bug-report references. Revisit before Phase 0.4 if intending to change.

## Spaces as Platform Primitive

Spaces is a substrate other GSX components consume, not an end-user app. The Lite UI in this plan is the first consumer of a public Spaces API, not the whole product.

The SDK functions defined here (`listSpaces`, `listItems`, eventual `addToSpace`, `removeFromSpace`) are the platform contract. Stability and versioning matter from Phase 0, not later. Concretely:

- **Stable signatures.** Function shapes get a deprecation window before breaking changes; minor changes are additive.
- **Semantic versioning.** The module exports a `SPACES_MODULE_VERSION` constant; consumers can pin or feature-detect.
- **Structured errors.** `SpacesError` codes form a stable contract; new codes are additive, removed codes get a deprecation cycle.
- **Observable events.** Every public-API call emits a span via `getLoggingApi().start()`. The event taxonomy is consumer-facing, not just internal debug telemetry.

### Anticipated consumers

- **The Lite Spaces UI** (this plan) — the first consumer, validates the API surface end-to-end.
- **GSX agent runtime** — agents write outputs into Spaces during task execution; provenance edges (`PRODUCED_BY`) populate as part of that write path.
- **Cowork integration** — reads Space contents into context windows for agent dispatch.
- **Future Approval + Audit event stream** — emits events when agent output lands in Uncategorized OR moves into a canonical Space. Compliance tooling and third-party audit systems subscribe.
- **Third-party Librarian-class agents** — recommendation, reconciliation, dedup, archival agents written by GSX customers, plugging into the Spaces substrate via the same SDK and conforming to the same Trust Principles.

### Physical home: today vs. tomorrow

**Today**: `lite/spaces/` is the home. Lite UI is the only consumer.

**Designed as if**: the module were `@or-sdk/spaces` — stable signatures, semantic versioning, structured errors, full observability — so extraction is mechanical, not architectural.

**Trigger for promotion**:

- When a second in-monorepo consumer appears (full app porting a Spaces view, GSX agent runtime making SDK calls), promote to `lib/spaces/`. This is an in-repo move, no API change.
- When a non-monorepo consumer appears (Cowork, third-party Librarians, external audit subscribers), promote to `@or-sdk/spaces` — the true platform layer. The API stays the same; the distribution mechanism changes.

Both promotions are mechanical refactors, not architectural rewrites. The discipline above is what makes this possible.

### Why this matters now, not later

If Spaces is genuinely a platform primitive, decisions taken in Phase 2 will be load-bearing for every future consumer. A user-token-only auth assumption baked into `listItems(scope)` becomes a v2 SDK if the GSX agent runtime needs delegated-token auth. Naming the trajectory explicitly forces the right shape from the start — and is the reason Phase 0.5 query 5 (agent identity) is gating, not informational.

### What this is NOT

Platform framing does not mean delaying Phase 1-2. The Lite UI ships on the same micro-phase schedule. Platform framing only changes how we describe what we're building, what discipline we apply to the SDK surface, and how we anticipate future consumers. If no second consumer ever materializes, the Lite UI is still a useful product on its own.

### Kill / Defer Criteria

The platform thesis depends on Edison's existing schema and auth model supporting agents as first-class principals. Phase 0.5 query 5 (agent identity) is the test. Three branches:

| Q5 outcome | Action on platform framing |
| --- | --- |
| Documented agent auth model exists (service accounts, delegated tokens, or both) | **Fully supported.** Proceed as written. |
| Agent auth is planned but not yet shipped; today agents inherit user `mult` tokens | **Deferred, not killed.** Lite UI ships as designed. SDK discipline still applies. The "Platform Consumers" section in `ROADMAP.md` is marked as future-quarter (specifically: the GSX agent runtime consumer is dependent on agent identity landing). |
| No agent identity concept in schema OR Edison at all; agents are server-side processes with no principal model | **Demoted.** Spaces becomes "shared workspace primitive between Lite UI and full app" rather than "platform substrate for agents + users." The Platform Primitive section gets revised; the third-party Librarian consumers are removed from the roadmap. The SDK discipline is still useful (still likely to be promoted to `lib/spaces/` when full app ports a view) but `@or-sdk/spaces` is no longer the trajectory's endpoint. |

This is a real decision point, not a fuzzy "we'll see." Resolve it explicitly when Phase 0.5 Q5 returns, before Phase 2 code locks in SDK signatures.

### Discipline Cost

Stable signatures, semantic versioning, structured errors, observable events, and deprecation cycles add overhead — roughly 10-15% per micro-phase relative to a non-platform-shaped module. This is real and recurring. The plan accepts it as the cost of optionality.

## Uncategorized — The Intake and Exception Space

Uncategorized is not the absence of a Space. It is a first-class architectural primitive that serves two distinct purposes:

- **Mode 1: Open-ended intake.** Humans drop arbitrary content (emails, PDFs, web clips, Slack threads, screenshots) without an obvious destination. The "just put the book in the bin" pattern. Librarian suggestions help the user contextualize.
- **Mode 2: Agent-exception state.** An agent produced output without a destination — its task spec was incomplete, it inferred a new entity type, or it failed to find a matching Space. These items need operator attention as governance events, not just casual review.

Mode 1 is the user-visible slice — what every individual user experiences when they drop something. Mode 2 dominates aggregate volume in a mature deployment.

What distinguishes Uncategorized from normal Spaces:

- Always present at the top of the sidebar; cannot be deleted or renamed.
- Membership is implicit: any entity not yet in any other Space appears here.
- Items here are subject to continuous Librarian analysis — embeddings, ontology matching, similarity scoring, suggestion generation, provenance verification.
- The user's action is approval (or rejection / quarantine), not filing. They confirm, reject, or refine; they do not pick folders.
- Mode 2 items (agent-exception) may warrant elevated triage UX — notifications, audit trail capture, escalation to admins. Defer the exact treatment to a later phase; data-model-level, both modes are the same `NOT (i)-[:MEMBER_OF]->(:Space)` state.

In data terms, Uncategorized is the result of `MATCH (i:Item) WHERE NOT (i)-[:MEMBER_OF]->(:Space)` rather than a `:Space` node. The UI presents it as a Space; the graph models it as a state.

In these phases, Uncategorized appears in the sidebar (Phase 1) and lists its items as cards (Phase 2). The Librarian-led suggestion flow and the agent-output Approval + Audit queue land later.

## Membership Not Ownership

A core principle the rest of the architecture depends on: **Spaces do not own assets. Spaces contextualize them.**

This is the difference between this product and every filesystem, SharePoint clone, or content management system. An entity participates in many Spaces simultaneously, and removing it from one Space does not remove it from the graph or any other Space.

In an agent-workspace context this matters even more: when an agent produces an asset and tags it for Space X, that same asset may later become relevant to Space Y (for a different agent task or a different human workflow) without re-creation. Membership is light; the asset is durable.

UI implications, even at read-only stage:

- Multi-Space membership is visible by default — every item card shows the Spaces it currently participates in (subject to viewer permissions; see Phase 2b).
- "Removing from a Space" is a reversible context change, not a delete. Particularly important when removing an agent-produced asset: the asset stays in the graph for audit, even if it stops participating in that Space's working context.
- Search across Spaces returns the same canonical entity, not duplicates.
- Permissions follow the entity AND the Space. The composition semantics (intersection of entity-ACL and Space-ACL? union? Space-ACL overrides? entity-ACL overrides?) are not yet specified by the OneReach data model and are an open question for Phase 0.5 verification (see query 6). Phase 2b's permission-filtered chip Cypher assumes whatever the `/omnidata/neon` endpoint enforces is internally consistent across both node types; we verify this empirically rather than asserting the composition rule a priori.

## Constraints

- Read-only browse in Phases 0-2; write paths (mutate Space membership, create/rename/delete Space) land in Phase 3.
- One discriminated `:Item` rendering kind in Phase 2 to cap the renderer's heterogeneity. `:Agent`, `:Workflow`, `:Person`, `:Tool` are deferred to later phases as their respective Lite modules port over.
- No local cache. Every read goes through `getNeonApi().query()`. A cache layer is a separate plan keyed on `(account, scope, query)` once we see real query patterns.
- Server-side ACL filtering is assumed (Phase 0.5 Q4). The renderer never layers a per-user predicate on top of the Cypher.
- Renderer code lives behind the preload bridge; main-process modules never reach into renderer state.
- Per Rule 11, cross-module imports go through `lite/spaces/api.ts`.

## Phase 0 — Module foundation + window shell

- `lite/spaces/` module layout: `api.ts`, `types.ts`, `scope.ts`, `errors.ts`, `events.ts`, `sdk-client.ts`, `window.ts`, `ipc.ts`, `main.ts`, `spaces.html`, `spaces.css`, `spaces.ts`.
- `Tools → Spaces…` menu entry wired via `lite/menu/registry.ts`.
- Single-instance BrowserWindow factory in `window.ts`.
- `lite:spaces:open` IPC handler in `ipc.ts`.
- `getSpacesApi()` singleton with `_setSpacesApiForTesting` / `_resetSpacesApiForTesting` hooks.
- `SpacesError` + `SPACES_ERROR_CODES` catalog.
- Conformance contract test: `runApiConformanceContract(getSpacesApi())` passes against the stub.

## Phase 0.5 — Discovery panel

Six verification queries land in `lite/spaces/discovery.ts` + `lite/spaces/discovery-format.ts` + the Spaces window's Discovery panel section. Q1–Q4 run from the panel directly; Q5 and Q6 are operational questions tracked in `lite/spaces/DISCOVERY.md`. Queries marked **GATING** must run and resolve before Phase 2 design locks. Queries marked **INFORMATIONAL** are strongly recommended but Phase 2 can ship without them with documented assumptions.

### Q1 — Entity-type inventory (GATING)

Run one of:

**Option A — `apoc.meta.stats()` (preferred):**

```cypher
CALL apoc.meta.stats() YIELD labels RETURN labels
```

**Option B — explicit `UNION ALL` (fallback if APOC unavailable):**

```cypher
MATCH (n:Item) RETURN 'Item' AS kind, count(n) AS count
UNION ALL
MATCH (n:Asset) RETURN 'Asset' AS kind, count(n) AS count
UNION ALL
MATCH (n:Agent) RETURN 'Agent' AS kind, count(n) AS count
UNION ALL
MATCH (n:Workflow) RETURN 'Workflow' AS kind, count(n) AS count
UNION ALL
MATCH (n:Person) RETURN 'Person' AS kind, count(n) AS count
UNION ALL
MATCH (n:Tool) RETURN 'Tool' AS kind, count(n) AS count
```

If Option A returns `Neo.ClientError.Procedure.ProcedureNotFound`, fall back to Option B.

### Q2 — Provenance / authorship edges (INFORMATIONAL)

```cypher
MATCH ()-[r:PRODUCED_BY|AUTHORED_BY|WRITTEN_BY|CREATED_BY]->(p)
RETURN type(r) AS edge, labels(p) AS principalType, count(*) AS count
ORDER BY count DESC
```

Non-empty rows ⇒ Phase 2d "Produced by" line is wireable immediately. Empty ⇒ defer the provenance UI to a later phase.

### Q3 — Are agents first-class graph nodes (INFORMATIONAL)

```cypher
MATCH (a:Agent) RETURN count(a) AS agentCount
```

Confirms `:Agent` exists as a node label.

### Q4 — User-level ACL filtering (GATING)

Run as two signed-in accounts with known-different Space memberships:

```cypher
MATCH (s:Space) WITH count(s) AS spaceCount
MATCH (i:Item) RETURN spaceCount, count(i) AS itemCount
```

Different counts between accounts confirms server-side ACL filtering exists. This test reveals filtering EXISTS and whether it's symmetric across node types, but does NOT characterize granularity (per-membership vs. per-ownership vs. inheritance). Phase 2b's reliance on the API filter assumes (a) filtering exists, and (b) it operates at node-membership granularity. The first is testable here; the second requires reading Edison authorization code or a targeted test.

### Q5 — Agent identity model (GATING, operational)

Promoted from INFORMATIONAL because Spaces is a platform primitive. SDK signature depends on knowing how agents authenticate.

Operational questions for whoever owns Edison:

1. How does an agent authenticate to `/omnidata/neon`? Service account credentials? Per-task delegated user token? Bot OAuth client credentials?
2. Does an agent inherit the dispatching user's ACL, or have its own identity?
3. Is there a schema model for agents as graph principals? If `(:Agent)` nodes exist (per Q3), can they appear on the LEFT side of edges or only the RIGHT?

These answers determine the SDK signature for write paths in Phase 4+ AND whether Phase 2d's "Produced by" line renders an agent name, a user name, or both.

### Q6 — Permission composition semantics (GATING, operational)

When entity-ACL and Space-ACL both apply, how do they compose? Intersection? Union? Override (Space wins)? Override (entity wins)?

Phase 2b's permission-filtered chip Cypher does not assume a composition rule — it relies on whatever `/omnidata/neon` enforces consistently across both node types. Confirm by:

- Verifying the composition behavior is documented in Edison's authorization layer, OR
- Running a targeted test: create an item that user A can access via Space X but not Space Y. If Cypher returns the item with `otherSpaces` containing only X, composition is intersection-style and Phase 2b's filtering is safe.

If composition turns out to be union-style or override-style with entity-ACL winning, Phase 2b's chip query needs an explicit per-user predicate on `otherSpaces`.

### Kill / defer criteria

- If Q1 returns only `:Item` and < 10 items across all accounts → Phase 1 has nothing meaningful to render. Defer until OmniGraph is seeded.
- If Q4 returns identical counts across two known-different accounts → server-side ACL filtering unconfirmed. Block Phase 2b multi-Space chips until verified.
- If Q5 resolves to "agents inherit user ACL + no `:Agent` schema" → defer the platform framing. Document deferral in `ROADMAP.md`.
- If Q6 cannot be resolved before Phase 2b → ship Phase 2b with an explicit per-user predicate on `otherSpaces` (safe default).

## Phase 1 — Spaces list (left sidebar)

### Phase 1a — `listSpaces()` + `getUncategorizedCount()` SDK methods

```cypher
MATCH (s:Space)
OPTIONAL MATCH (i:Item)-[:MEMBER_OF]->(s)
WITH s, count(i) AS itemCount
RETURN s.id AS id, s.name AS name, s.description AS description,
       s.color AS color, s.iconKey AS iconKey, itemCount,
       s.createdAt AS createdAt, s.updatedAt AS updatedAt
ORDER BY toLower(coalesce(s.name, '')) ASC
```

```cypher
MATCH (i:Item) WHERE NOT (i)-[:MEMBER_OF]->(:Space)
RETURN count(i) AS count
```

`sdk-client.ts` exposes `listSpaces()` and `getUncategorizedCount()` as separate methods. Both fire in parallel from the renderer.

### Phase 1b — IPC + preload bridge

- `lite:spaces:listSpaces` and `lite:spaces:uncategorizedCount` handlers in `ipc.ts`.
- `LiteSpace[]` and `number` typed return shapes on the preload bridge.

**Loading-state note**: The sidebar renders the Spaces list as soon as it resolves; the Uncategorized pulse dot appears (or hides) when the count query resolves, even if a few hundred milliseconds later. Stale-count flicker is acceptable for read-only.

### Phase 1c — Renderer first-paint

- Initial render uses a 3-row shimmer skeleton in the Spaces section so first paint shows structure, not text.
- `loadSpaces()` and `loadUncategorizedCount()` fire in parallel on `init()`.
- Empty state ("No Spaces yet."), loading skeleton, and error banner are each reachable.

### Phase 1d — Render Uncategorized as a pinned top entry

A dedicated "Uncategorized" row sits at the top of the sidebar, ALWAYS visible, even when empty. Visually distinct from regular Spaces: italic name, dim accent color, subtle pulse dot when count is above zero. The constant `UNCATEGORIZED_SPACE_ID = '__uncategorized__'` is the synthetic id used in selection state — see Phase 2b for how that synthetic id is wrapped in a `SpaceScope` type so it doesn't leak as a sentinel across the codebase.

### Phase 1e — Uncategorized visual treatment

- Uncategorized row uses the same row chrome but with italic label and dim accent color.
- A pulsing accent dot appears when count > 0 (`.spaces-row-dot-intake.has-count` + `spaces-intake-pulse` keyframes).

### Phase 1f — Search + sort

- Client-side substring filter on Space name. No network round-trip per keystroke.
- Empty query is "filter off" (everything visible).
- Uncategorized is excluded from sort (always pinned to top) and matches the search filter when the query is `uncategorized` (case-insensitive) or any substring thereof.

## Phase 2 — Item list (main pane) + detail panel

### Phase 2a — Item-only scope

Phase 2 renders only `:Item` entities (binary files, text, URLs, web clips). Other entity types (`:Agent`, `:Workflow`, `:Person`, `:Tool`) exist in the Conceptual Model but are visible in later phases as their respective Lite modules port over. The data model supports all of them; the UI unwraps them gradually. This restricts the renderer's heterogeneity surface to one card type in Phase 2.

### Phase 2b — `SpaceScope` helper + branched query + permission filter

Introduce a typed `SpaceScope` so the synthetic Uncategorized id doesn't leak across the codebase. Every future call site — `listItems`, eventual `addToSpace` / `removeFromSpace`, permission checks, analytics span tags — takes a `SpaceScope` argument and branches on `kind`.

```ts
// lite/spaces/scope.ts
export type SpaceScope =
  | { kind: 'uncategorized' }
  | { kind: 'space'; spaceId: string };

export const UNCATEGORIZED_SPACE_ID = '__uncategorized__';

export function resolveSpaceScope(id: string): SpaceScope {
  return id === UNCATEGORIZED_SPACE_ID
    ? { kind: 'uncategorized' }
    : { kind: 'space', spaceId: id };
}
```

`listItems(scope, opts?)` branches on `scope.kind`.

**When `scope.kind === 'space'`:**

```cypher
MATCH (i:Item)-[:MEMBER_OF]->(s:Space {id: $spaceId})
OPTIONAL MATCH (i)-[:MEMBER_OF]->(other:Space)
  WHERE other.id <> s.id
OPTIONAL MATCH (i)-[:PRODUCED_BY|AUTHORED_BY]->(producer)
WITH i,
     collect(DISTINCT { id: other.id, name: other.name,
                        color: other.color, iconKey: other.iconKey }) AS otherSpacesRaw,
     head(collect(producer)) AS producer
RETURN i.id AS id, i.title AS title, i.kind AS kind,
       i.fileKey AS fileKey, i.sourceUrl AS sourceUrl,
       i.createdAt AS createdAt, i.updatedAt AS updatedAt,
       i.excerpt AS excerpt,
       [x IN otherSpacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
       CASE WHEN producer IS NULL
            THEN null
            ELSE { kind: head(labels(producer)),
                   name: coalesce(producer.name, producer.title, ''),
                   id: producer.id }
       END AS producedBy
ORDER BY coalesce(i.updatedAt, i.createdAt, '') DESC
SKIP toInteger($offset) LIMIT toInteger($limit)
```

**When `scope.kind === 'uncategorized'`:**

```cypher
MATCH (i:Item) WHERE NOT (i)-[:MEMBER_OF]->(:Space)
OPTIONAL MATCH (i)-[:PRODUCED_BY|AUTHORED_BY]->(producer)
WITH i, head(collect(producer)) AS producer
RETURN i.id AS id, i.title AS title, i.kind AS kind,
       i.fileKey AS fileKey, i.sourceUrl AS sourceUrl,
       i.createdAt AS createdAt, i.updatedAt AS updatedAt,
       i.excerpt AS excerpt,
       [] AS otherSpaces,
       CASE WHEN producer IS NULL
            THEN null
            ELSE { kind: head(labels(producer)),
                   name: coalesce(producer.name, producer.title, ''),
                   id: producer.id }
       END AS producedBy
ORDER BY coalesce(i.updatedAt, i.createdAt, '') DESC
SKIP toInteger($offset) LIMIT toInteger($limit)
```

**Permission semantics**: multi-Space chips are permission-filtered at query time, not render time. The `otherSpaces` projection only returns memberships the viewer is authorized to see. Phase 0.5 Q4 + Q6 verify whether `/omnidata/neon` filters by viewer ACL implicitly. Resolve before Phase 2b code lands.

### Phase 2c — IPC + preload bridge for items

- `lite:spaces:items:list` and `lite:spaces:items:get` handlers.
- Bridge types: `LiteSpaceItemSummary[]` and `LiteSpaceItem | null`.

### Phase 2d — Cards + chips + optional provenance

Item cards render in a responsive grid. Each card shows:

- Kind pill (color-coded per `ItemKind`).
- Relative-time line ("just now", "5m ago", "3h ago", "4d ago", or short date).
- Title (2-line clamp) and excerpt (3-line clamp).
- Multi-Space chip strip from the `otherSpaces` projection (max 3 visible, "+N more" overflow when needed).
- Clicking a chip navigates to that Space (Phase 2e).
- Items shown in the Uncategorized list have NO chips — that's the visible signal that they need contextualization.
- For Uncategorized items, a subtle "Awaiting contextualization" cue under the title.
- **Optional provenance line** (conditional on Phase 0.5 Q2/Q3): when `producedBy` is non-null, render "Produced by [name] ([kind])" under the metadata row. When null, render nothing.

### Phase 2e — Detail panel

Right-rail panel populates on card click via `items.get(id)`:

- Kind pill, title, "Updated …" line.
- Chip strip (richer hover-state planned: description, owner, when added).
- Provenance section if `producedBy` non-null.
- Inline content for text-kind items.
- Source link for url-kind items (`target="_blank"` + `rel="noopener noreferrer"`).
- Close button collapses the rail and clears the active card.

### Phase 2 stretch goals (not part of MVP)

- Filter chips in the main pane: documents only, images only, etc.
- Richer chip hover state.

## Testing strategy

| Layer | Test file | Coverage |
|---|---|---|
| SDK types | `spaces-api.test.ts` | Conformance contract; reset/install singleton hooks. |
| Discovery runner | `spaces-discovery.test.ts` | Q1–Q4 runner shape. |
| SDK client | `spaces-sdk-client.test.ts` | Cypher source regression guards; row-to-domain mapping; error normalization. |
| Renderer (pure) | `spaces-renderer.test.ts` | DOM builders (sidebar rows, item cards, chips, detail pane), formatters, query helpers. |
| Renderer (integrated) | `spaces-renderer-integration.test.ts` | Sidebar search filter + Uncategorized pulse dot toggling. |
| Platform contract | `spaces-platform-contract.test.ts` (integration) | Stub consumer outside `lite/spaces/` proves the public API surface end-to-end. |

## Success Criteria

Each phase ships when these criteria hold. Without them, "is this phase done?" becomes a feeling rather than a check.

### Phase 0 success

- `Tools → Spaces…` menu item appears and opens an empty styled window.
- Window closes cleanly with no error logs in the lite log queue.
- Window position survives restart (via `lite/kv/`).
- The module passes `runApiConformanceContract(getSpacesApi())` even though the API is stubbed at this stage.

### Phase 1 success

- Sidebar renders the full Spaces list within 500ms of window open on a reference account containing 10-50 Spaces.
- Uncategorized stays pinned to top across sort changes and filter activity.
- Search filter is purely client-side (no network round-trip per keystroke).
- Empty state, loading skeleton, and error state are each reachable and visually distinct.
- One synthetic Cypher test confirms `listSpaces()` returns the expected shape for at least one fixture account.

### Phase 2 success

- Item cards render within 800ms of Space selection on a reference Space containing up to 100 items.
- Multi-Space chips display the correct subset under at least three viewer-permission scenarios (admin, viewer-only, cross-org user) consistent with whatever filter model Phase 0.5 Q4 + Q6 established.
- Detail-panel preview handles all six item `kind` values (`document`, `image`, `url`, `text`, `audio`, `video`) without errors.
- `producedBy` line renders correctly when the schema exposes provenance edges; gracefully hidden when it does not.
- **Platform-contract proof**: a stub consumer outside `lite/spaces/` (e.g. a one-page test in `lite/test/integration/spaces/`) imports `getSpacesApi()`, calls `listSpaces()` and `items.list()`, and asserts the returned shapes match the public types. This is the non-negotiable test of the platform claim — if the SDK can't be consumed from outside the module without reaching into internals, the platform discipline failed and the Phase 2 ship is blocked until it succeeds.

### Cross-cutting success criteria (all phases)

- Zero permission-leak bugs against the test scenarios from Phase 0.5 Q4 / Q6.
- No regression in lite startup time (the kernel boots in roughly the same time it did pre-Spaces).
- All event names follow the ADR-032 taxonomy (`spaces.<op>.start / .finish / .fail`).
- API contract conformance test passes in CI.

## Future Librarian Phases (sketch, not commitment)

This plan delivers the read-only spine. The full product unfolds in further phases including: an Approval + Audit queue for agent output landing in Uncategorized (with reject/quarantine semantics, not just file-where); write paths for human and agent contextualization; an Activity Feed showing what agents and Librarians produced today; explainability panels with structured reasoning per suggestion; graph and overlap views; semantic search ("Ask the Librarians"); and per-Librarian observability dashboards. Sequencing and scope of those phases is deferred to `lite/spaces/ROADMAP.md` and will be revised as Phase 1-2 ships and we observe what users actually need.

## Out of Scope (not on the Librarian roadmap)

- Local cache / offline support
- Real-time activity pulse (would require server-side WebSocket; deferred indefinitely)
- Pin / favorite Spaces (small follow-up chunk; not roadmap-level)
