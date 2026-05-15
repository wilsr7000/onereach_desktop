# Spaces Home — Chunk Detail (3k + 3o)

> Chunk-detail doc for the Home view that ships first in v1 (Workspace Beta).
> Combines two logical chunks into one PR per Q-Home-1: **3k** (event/commit
> query layer, pulled forward from v2) + **3o** (Home view UI). Strategic
> framing in the plan at
> [`.cursor/plans/spaces_home_news_feed_5031f1d8.plan.md`](../../.cursor/plans/spaces_home_news_feed_5031f1d8.plan.md).
> Chunk-position framing in
> [`./RELEASE-V1-INTERNAL.md`](./RELEASE-V1-INTERNAL.md) (when drafted).

## Why this exists

The current Spaces window has a "Phase 0.5 — Discovery" panel at the bottom
that runs four diagnostic Cypher queries and renders raw JSON. That panel was
useful while engineers were verifying the schema; it does nothing for an end
user. Home replaces it with a feed-style dashboard that surfaces the same
underlying data (entity counts, agent presence, permission visibility) plus
two new live signals (recent activity from `:Commit` nodes, recent items)
in a way a non-engineer can actually read.

This is also the first piece of v1 that exercises the SDK in a read-heavy,
write-free way before chunks 3a/3b add mutations — a low-risk first ship
that makes every subsequent chunk land inside an app that already feels like
a data room.

## Scope (combined chunk per Q-Home-1)

In one PR (one chunk in [`PORTING.md`](../PORTING.md), single hardening row):

- **3k — data layer**: 6 new SDK methods on `SdkSpacesClient`; 6 new
  `CYPHER.*` constants; 6 new types; 6 new IPC handlers; preload bridge.
- **3o — UI layer**: Home view region in `spaces.html`; sidebar gains a
  Home item above the Spaces list; Home becomes the default landing scope
  on window open; 5 cards rendered in parallel with skeleton loaders +
  empty states + Tufte-style sparklines for card 1; Discovery panel removed
  from the user-facing UI; engineer access preserved via a Settings →
  Diagnostics toggle.

## SDK surface (new methods on [`api.ts`](./api.ts))

| Method | Returns | Cypher constant | Card it powers |
|---|---|---|---|
| `getEntityCounts()` | `{ spaces, assets, people, agents }` | `CYPHER.HOME_ENTITY_COUNTS` | 1 |
| `listRecentItems({ limit })` | `ItemSummary[]` | `CYPHER.HOME_RECENT_ITEMS` | 5 |
| `topContributors({ window: 'day' \| 'week' \| 'month', limit? })` | `Contributor[]` | `CYPHER.HOME_TOP_CONTRIBUTORS` | 2 |
| `listRecentEvents({ limit, since? })` | `Event[]` | `CYPHER.HOME_RECENT_EVENTS` | (drill-down for card 2) |
| `listAgentsSample({ limit })` | `AgentSummary[]` | `CYPHER.HOME_AGENTS_SAMPLE` | 3 |
| `getPermissionSummary()` | `PermissionSummary` | `CYPHER.HOME_PERMISSION_SUMMARY` | 4 |

Errors normalize to `SpacesError` per the existing convention; missing
`a.created_at` etc. coalesce to legacy fields the same way the existing
`LIST_ITEMS_*` queries do.

## Cypher catalog

All queries are read-only, run with the same `getNeonApi().query()` plumbing
the existing module uses, and follow the canonical schema (`:Asset` +
`:BELONGS_TO` etc.) with `coalesce(canonical, legacy, default)` where the
producer-side data uses legacy property names.

### `HOME_ENTITY_COUNTS`

```cypher
CALL apoc.meta.stats() YIELD labels
RETURN labels
```

If APOC is unavailable, the SDK falls back to:

```cypher
MATCH (s:Space) RETURN 'Space' AS kind, count(s) AS n
UNION ALL MATCH (a:Asset) RETURN 'Asset' AS kind, count(a) AS n
UNION ALL MATCH (p:Person) RETURN 'Person' AS kind, count(p) AS n
UNION ALL MATCH (g:Agent) RETURN 'Agent' AS kind, count(g) AS n
```

The SDK normalises both shapes into a flat `{ spaces, assets, people, agents }`
record. Same fallback pattern as `discovery.ts` Q1.

### `HOME_RECENT_ITEMS`

```cypher
MATCH (a:Asset)
OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
WITH a, head(collect(s)) AS firstSpace
RETURN a.id AS id,
       coalesce(a.name, a.title, a.id) AS title,
       coalesce(a.type, a.assetType, 'other') AS kind,
       coalesce(a.url, a.fileUrl) AS fileKey,
       coalesce(a.sourceUrl, a.source) AS sourceUrl,
       coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
       coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
       coalesce(a.excerpt, a.description, a.notes) AS excerpt,
       CASE WHEN firstSpace IS NULL
            THEN []
            ELSE [{ id: firstSpace.id,
                    name: coalesce(firstSpace.name, firstSpace.id),
                    color: firstSpace.color,
                    iconKey: coalesce(firstSpace.iconKey, firstSpace.icon) }]
       END AS otherSpaces,
       null AS producedBy
ORDER BY coalesce(toString(a.updatedAt), toString(a.updated_at),
                  toString(a.createdAt), toString(a.created_at), '') DESC
LIMIT toInteger($limit)
```

Mirrors `LIST_ITEMS_IN_SPACE`'s projection so it returns the same
`ItemSummary` shape — renderers reuse the existing item-card builder.

### `HOME_TOP_CONTRIBUTORS`

```cypher
MATCH (c:Commit)
WHERE c.timestamp >= $sinceMs
RETURN c.author AS author, count(c) AS events
ORDER BY events DESC
LIMIT toInteger($limit)
```

`$sinceMs` is computed in JS based on `window: 'day' | 'week' | 'month'`.
The `:Commit` data is what the existing GSX-Desktop sync writes — we
verified 120+ in production already.

### `HOME_RECENT_EVENTS`

```cypher
MATCH (c:Commit)
WHERE ($since IS NULL OR c.timestamp >= $since)
OPTIONAL MATCH (c)<-[:IN_SPACE]-(s:Space)
RETURN c.hash AS id,
       c.author AS author,
       c.message AS kind,
       c.timestamp AS timestamp,
       c.spaceId AS spaceId,
       coalesce(s.name, c.spaceId) AS spaceName
ORDER BY c.timestamp DESC
LIMIT toInteger($limit)
```

Per Q-Home-4, the `kind` projection deliberately exposes `c.message`
verbatim (e.g. `'item:added'`, `'item:updated'`). When 3l (real sync)
lands in v2, sync events reuse the same projection — the `kind` string
just widens. No data-shape churn.

### `HOME_AGENTS_SAMPLE`

```cypher
MATCH (a:Agent)
RETURN a.id AS id,
       coalesce(a.name, a.title, a.id) AS name,
       coalesce(a.description, a.summary, '') AS description
ORDER BY toLower(coalesce(a.name, a.id, '')) ASC
LIMIT toInteger($limit)
```

### `HOME_PERMISSION_SUMMARY`

```cypher
MATCH (s:Space)
WITH count(s) AS visible
RETURN visible AS visibleSpaceCount
```

For v1-internal there's no separate "total Spaces in account I might not see"
projection — the canonical schema doesn't expose that today. The
`PermissionSummary.totalSpaceCount` field stays optional; renderer hides
the "X of Y" framing and uses "you see X Spaces in this account" when only
`visibleSpaceCount` is known.

## UI specification

### Window layout

```
+---------------------------------------------+
| Spaces                                       |  <- header (existing)
+----------+----------------------------------+
| [Home]   | Card 1: Your data room           |
| Intake   |                                  |
|  Uncat.  | Card 2: Recent activity          |
|          |                                  |
| Spaces   | Card 3: Agents in your account   |
|  Space A |                                  |
|  Space B | Card 4: Your view (conditional)  |
|  ...     |                                  |
|          | Card 5: Just added               |
+----------+----------------------------------+
```

Sidebar gains a new section at the very top:

```html
<div class="spaces-sidebar-section">
  <ul class="spaces-list" id="spaces-list-home">
    <li class="spaces-row spaces-row-home" data-scope-id="__home__">
      <span class="spaces-row-icon"><!-- home glyph from icon-library --></span>
      <span class="spaces-row-name">Home</span>
    </li>
  </ul>
</div>
```

Home is the default `state.activeScopeId` on first load. Clicking Home
re-renders the cards. Clicking any Space switches to the existing
Space-detail view. The Uncategorized row keeps its current behavior.

### Cards

Each card is an `<article class="home-card">` with a fixed footprint
(min-height 120px, max-height 200px on desktop) so the page doesn't jump
as queries land at different times. Skeleton state shows shimmer blocks
matching the eventual content shape.

#### Card 1 — Your data room at a glance

```
YOUR DATA ROOM

   4              9              3
Spaces        Assets        People
▁▂▃▃▄▅▅▆     ▁▁▂▂▃▄▅▆      ▁▂▃▃▃
+2 this wk    +14 today     +1 since Mar

Plus 159 agents available to your account
```

- Three big-number tiles. Numbers from `getEntityCounts()`.
- Each tile has a 30-day sparkline drawn as inline SVG (Tufte-style: 1.5px
  stroke, no axes, no fill, ~80px wide × 18px tall). Sparklines fed by
  daily-bucketed counts derived from `:Asset.createdAt` / `:Space.createdAt`
  / `:Person.createdAt`. v1: synthesise the sparkline from a single Cypher
  range query per kind; defer "real time-series" to v2.
- Footer line shows agent count without a sparkline (count only).

#### Card 2 — Recent activity

```
RECENT ACTIVITY

  Audit Agent              47 items today
  Bob Wilson               14 items yesterday
  Quarterly Review Agent    9 items this week
  Sarah Kim                 3 items this week

  See timeline →
```

- Top 4 contributors over the last 7 days. From `topContributors({ window: 'week', limit: 4 })`.
- "X items today / yesterday / this week" computed in JS from the
  contributor's most-recent commit timestamp.
- "See timeline" → drill into a placeholder modal listing all
  `listRecentEvents({ limit: 100 })` results (modal-only for v1; full
  events page deferred to v2 / Phase 4).

#### Card 3 — Agents in your account

```
AGENTS IN YOUR ACCOUNT

  Audit Agent           Quarterly compliance
  Brief Generator       Daily news synthesis
  Research Librarian    Cross-Space search

  + 156 more — see all →
```

- First 3 agents from `listAgentsSample({ limit: 3 })`.
- "+ N more" computed as `entityCounts.agents - 3` (clamped to ≥ 0).
- "See all" → modal listing all agents (paginated via repeated
  `listAgentsSample` calls). Per Q-Home-2 default, no separate `/agents`
  page in v1.

#### Card 4 — Your view (conditional)

```
YOUR PERMISSIONS

  You can see 4 Spaces in this account.
```

- Hidden entirely when `visibleSpaceCount === 0` (the "no Spaces" state
  is already covered by Card 1's empty state).
- When `totalSpaceCount` is known and differs from `visibleSpaceCount`,
  shows "You can see X of Y Spaces in this account" instead.
- Tap → opens Settings → OAGI section.

#### Card 5 — Just added

```
JUST ADDED

  "Concept of Spaces for AI Agents"
   in ChatGPT Conversations · 5/11

  "Demo Strategy for Enterprise Architects"
   in ChatGPT Conversations · 5/11

  See all 6 →
```

- Top 3 items from `listRecentItems({ limit: 3 })`.
- Each item title is clickable: opens existing Space-detail view with
  the item selected.
- "See all N" footer if `entityCounts.assets > 3`; takes user to
  Uncategorized + recently-added sort. (This sort is implicit in the
  existing item list, not a new feature.)

### Empty states

| Card | Empty trigger | Copy |
|---|---|---|
| 1 | counts all 0 | "Your data room is empty. Create your first Space →" with primary CTA |
| 2 | no commits in window | "No activity yet this week. Activity from people and agents will appear here." |
| 3 | no agents | "No agents enabled for your account yet." |
| 4 | `visibleSpaceCount === 0` | (hide card entirely) |
| 5 | no items | "Nothing added recently. Drop a file in to get started." |

### Loading + refresh strategy (Q-Home-3 default)

Stale-while-revalidate with a 60s cache window per query, shared across
Home view re-mounts in the same renderer session. On Home view focus:

- If cache is fresh (< 60s old): render from cache immediately, no
  network call.
- If cache is stale or missing: render from cache (if present) immediately
  AND kick off background refresh; swap in fresh data when it lands with
  a subtle 200ms cross-fade per card.

Cache lives in renderer state only — not persisted across window opens.
Decision rationale: 60s is short enough that "I just added something"
feels live, long enough to absorb rapid sidebar clicks without thrashing.

## IPC channels

| Channel | Payload | Result |
|---|---|---|
| `lite:spaces:home:entityCounts` | `void` | `LiteSpacesIpcResult<EntityCounts>` |
| `lite:spaces:home:recentItems` | `{ limit?: number }` | `LiteSpacesIpcResult<LiteSpaceItemSummary[]>` |
| `lite:spaces:home:topContributors` | `{ window?: 'day'\|'week'\|'month', limit?: number }` | `LiteSpacesIpcResult<Contributor[]>` |
| `lite:spaces:home:recentEvents` | `{ limit?: number, since?: number }` | `LiteSpacesIpcResult<Event[]>` |
| `lite:spaces:home:agentsSample` | `{ limit?: number }` | `LiteSpacesIpcResult<AgentSummary[]>` |
| `lite:spaces:home:permissionSummary` | `void` | `LiteSpacesIpcResult<PermissionSummary>` |

All errors serialize to the existing `SpacesIpcResult.error` envelope.

## Acceptance criteria

- All 6 SDK methods have Cypher source pinned in `spaces-sdk-client.test.ts`.
- All 6 SDK methods have row-mapping coverage (canned rows in, normalized
  shape out, including null-row defaults).
- Home view renders against an in-memory neon-stub returning canned
  responses for all 6 queries.
- Empty-state rendering verified for each of the 5 cards (zero spaces,
  zero events, zero agents, full visibility, zero recent items).
- Discovery panel is no longer present in `spaces.html`. Existing 33
  discovery tests still pass (the runner is still importable).
- Settings → Diagnostics has an engineer toggle "Show raw discovery
  queries" that mounts the moved panel.
- Live-graph integration: Home loads against the actual Neon endpoint
  in < 4 s wall-clock, all 5 cards either populate or honestly empty.
- No regression in existing Phase 1+2 tests (1219 unit tests still
  green).

## Decisions baked in here (per recommended defaults)

- **Q-Home-1 → ONE chunk.** Faster end-to-end ship; reviewers can still
  read the diff in two passes.
- **Q-Home-2 → modal-for-v1 for agents listing.** Defers `/agents` route
  to its own future chunk.
- **Q-Home-3 → stale-while-revalidate, 60 s cache.** Fewer queries, near-
  live feel.
- **Q-Home-4 → extend `kind` projection rather than add a new `eventType`
  field.** v2 sync events widen the `kind` enum; no churn in callers.

## Out of scope for this chunk

- "Real" agents page (modal-only for v1).
- Per-Space activity timeline (Card 2 surfaces top contributors only;
  per-Space drill-down lands when 3a-3i adds the activity tab).
- Auto-refresh on background events (next-app-focus refresh is enough
  for v1; live event stream is a v2 concern, paired with 3l sync).
- Sparkline daily-bucket "real" time series — v1 derives buckets from a
  single range query per kind. Real time-series with caching lands in v2.

## Future hooks

- 3l (real sync, v2): the `kind` field on `HOME_RECENT_EVENTS` widens to
  include sync events; Card 2 picks them up automatically.
- 3j (auto-metadata, v2): once auto-metadata lands, Card 5 can show
  AI-generated summaries instead of the existing `excerpt` fallback.
- 3n (agents-as-first-class, v2): Card 3's "see all" modal becomes the
  agents page with subscriptions and activity per agent.
