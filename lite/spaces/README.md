# Spaces Module

**Status**: Phase 1 + Phase 2 + chunk 3k/3o (Home view) shipped. The Spaces window opens with **Home** as the default scope — a 5-card news feed that surfaces what's in your data room (entity counts + 30-day sparklines, top contributors over the last week, agents in your account, your visible-Space count, and the most-recently-added items). Sidebar lists every `:Space` the active account can see and surfaces the Uncategorized intake count. When you click into a Space (or Uncategorized) the main pane switches to the existing item-cards view: `:Asset` cards (surfaced as "Items" in the renderer naming) with multi-Space chips, optional provenance, and a right-rail detail panel. Cypher-backed throughout; no stubs remain.

The Phase 0.5 Discovery panel that previously lived at the bottom of the Spaces window has moved to **Settings → Diagnostics → "Spaces Discovery (engineer)"** — same runner, same JSON output, but no longer crowding the user-facing UI. See [`HOME-V1.md`](./HOME-V1.md) for the chunk detail.

**Schema**: queries follow the canonical OneReach graph schema documented in the `(:Schema)` nodes themselves: node label `:Asset`, edge `[:BELONGS_TO]` from Asset to Space, creator edge `[:CREATED]` from Person to Asset. Every projected field uses `coalesce(canonical, legacy, default)` so existing data written by the legacy `omnigraph-client.js` push path (which writes `title` / `assetType` / `fileUrl` / snake_case timestamps) still renders alongside data using the canonical names. The TypeScript surface (`Item`, `ItemSummary`) keeps the friendlier "Item" naming for renderers; only the Cypher uses the storage label.

> Spaces is a **platform primitive**, not a Lite-only feature. The Lite UI in this module is the first consumer of the SDK; future consumers include GSX agents, Cowork integrations, and the Approval + Audit event stream. The methods on `SpacesApi` ARE the platform contract -- treat them with that level of stability discipline. See the spaces plan ("Spaces as Platform Primitive" section).

## Public surface (`api.ts`)

```ts
import { getSpacesApi } from '../spaces/api.js';

const api = getSpacesApi();
api.open();                                          // launch / focus the window

// Phase 1 + 2 (browse)
await api.listSpaces();                              // every :Space the account can read
await api.getUncategorizedCount();                   // :Asset nodes with no :BELONGS_TO edge
await api.items.list({ kind: 'uncategorized' });     // Items without a :Space
await api.items.list({ kind: 'space', spaceId: '…' }); // Items in one :Space (+ chips)
await api.items.get(itemId);                          // full Item incl. content + metadata

// Home view (chunk 3k + 3o) — read-only news-feed data
await api.getEntityCounts();                          // { spaces, assets, people, agents }
await api.listRecentItems({ limit: 3 });              // most-recent :Asset, ItemSummary shape
await api.topContributors({ window: 'week', limit: 4 }); // :Commit aggregates by author
await api.listRecentEvents({ limit: 50 });            // :Commit projection (id/author/kind/timestamp/space)
await api.listAgentsSample({ limit: 3 });             // first N :Agent alphabetically
await api.getPermissionSummary();                     // { visibleSpaceCount, totalSpaceCount? }
```

Use `resolveSpaceScope(id)` at any UI/IPC boundary that hands a plain id into the SDK. The synthetic Uncategorized id is exported as `UNCATEGORIZED_SPACE_ID` and is the only string the renderer/IPC layer ever uses; the typed `SpaceScope` union is what every internal call site sees.

### Cypher

All eleven queries live as module constants on `lite/spaces/sdk-client.ts` so they're greppable, diffable in code review, and asserted on by unit tests (regression-guarded against accidental drift):

- `CYPHER.LIST_SPACES`, `UNCATEGORIZED_COUNT`, `LIST_ITEMS_UNCATEGORIZED`, `LIST_ITEMS_IN_SPACE`, `GET_ITEM` — Phase 1 + 2 browse
- `CYPHER.HOME_ENTITY_COUNTS` (+ `_FALLBACK`), `HOME_RECENT_ITEMS`, `HOME_TOP_CONTRIBUTORS`, `HOME_RECENT_EVENTS`, `HOME_AGENTS_SAMPLE`, `HOME_PERMISSION_SUMMARY` — Home view (chunk 3k)

### Provenance projection

Each item-list query and `getItem` optionally project a `producedBy` row via the canonical creator edge `(:Person)-[:CREATED]->(:Asset)` (per the `_RelationshipTypes` Schema node). When the edge is absent, the projection collapses to `null` and the renderer omits the provenance line. Future producer types (`:Agent`, `:Workflow`, etc.) will widen the OPTIONAL MATCH as those modules port over.

## Internal layout

| File                  | Role                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `api.ts`              | Public surface + singleton swap pattern. The only allowed importer.        |
| `types.ts`            | `Space`, `Item`, `ItemSummary`, `ListOpts`, etc.                           |
| `scope.ts`            | `SpaceScope` union + `resolveSpaceScope` helper.                           |
| `errors.ts`           | `SpacesError` + `SPACES_ERROR_CODES`.                                      |
| `events.ts`           | `SpacesEvent` taxonomy + `SPACES_EVENTS` catalog.                          |
| `sdk-client.ts`       | Cypher wrapper. Phase 1+ injects `getNeonApi().query` at boot.             |
| `discovery.ts`        | Phase 0.5 query runner (main-process; uses `getNeonApi()`). Now invoked from Settings → Diagnostics, not the Spaces window. |
| `discovery-format.ts` | Renderer-safe types + Markdown formatter for discovery results.            |
| `window.ts`           | Single-instance `BrowserWindow` factory.                                   |
| `ipc.ts`              | `lite:spaces:*` IPC handler registration (incl. `lite:spaces:home:*`).      |
| `main.ts`             | `initSpaces()` orchestrator + Tools-menu wiring.                           |
| `spaces.html/css`     | Renderer chrome + Home view + item card / chip / detail-pane styles.       |
| `spaces.ts`           | Renderer entrypoint (IIFE bundled by esbuild). Default scope is Home.       |
| `DISCOVERY.md`        | Phase 0.5 reference: Q1–Q6 queries + Q5/Q6 operational template.           |
| `DISCOVERY-PHASE-3.md`| Phase 3 D-series operational questions for Edison; gates 3d/3g.             |
| `HOME-V1.md`          | Chunk detail for Home (3k + 3o).                                            |
| `ROADMAP.md`          | Phases shipped / sketched / out of scope.                                  |

## Error catalog

| Code                          | Trigger                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `SPACES_NOT_AUTHENTICATED`    | No `mult` token / no active account.                             |
| `SPACES_NOT_FOUND`            | Space / item missing, or filtered out by ACL.                    |
| `SPACES_FORBIDDEN`            | Caller lacks read/mutate permission on the target.               |
| `SPACES_CYPHER`               | Neon query failed (transient, syntax, or malformed result).      |
| `SPACES_NETWORK`              | DNS / TCP / TLS / fetch reject on the way to Edison.             |
| `SPACES_INVALID_INPUT`        | Empty id, bad limit, malformed payload.                          |
| `SPACES_NOT_INITIALIZED`      | SDK called before `initSpaces()` ran.                            |

The SDK client normalizes the underlying `NEON_*` codes to the spaces-side codes above so callers only ever see one error taxonomy. See `normalizeError()` in `sdk-client.ts`.

## Conformance

`lite/test/unit/spaces-api.test.ts` runs `runApiConformanceContract` per Rule 12. Required surface: `['open', 'listSpaces', 'getUncategorizedCount', 'items']` (the new Home methods extend the surface but are not part of the conformance baseline yet).

## Test coverage

| File                                       | Layer covered                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `spaces-api.test.ts`                       | Singleton swap + conformance contract.                                       |
| `spaces-discovery.test.ts`                 | Phase 0.5 Q1–Q4 runner shape.                                                |
| `spaces-sdk-client.test.ts`                | Cypher source regression guards (incl. 6 Home queries), row-to-domain mapping, error normalization. |
| `spaces-renderer.test.ts`                  | Pure DOM builders (sidebar rows, item cards, chips, detail pane, formatters). |
| `spaces-home-cards.test.ts`                | Home view pure builders + `formatBigNumber` / `formatRecency` / `sparklinePath` rules. |
| `spaces-renderer-integration.test.ts`      | Sidebar search filter + intake pulse (driven via the renderer bundle).        |
| `spaces/home-flow.test.ts` (integration)   | End-to-end Home view: 5 cards loaded / empty / error states against an in-memory bridge. |
| `spaces/platform-contract.test.ts` (integration) | Platform-primitive contract assertions across the SDK surface.            |
| `spaces/trust-principles.test.ts` (integration)  | Reversibility harness across mutation methods (Phase 3+).                  |

## Out of scope (this phase)

- `addToSpace` / `removeFromSpace` mutations (Phase 3 chunks 3a-3c)
- Per-Space activity-tab drill-down (extension of 3k in v2)
- Real bidirectional sync (v2 chunk 3l)
- Auto-metadata pipeline beyond Space suggestions (v2 chunk 3j)
- Ontology-aware navigation (v2 chunk 3m)
- Agents as first-class room participants — subscribe-and-react (v2 chunk 3n)
- Real-time activity pulse (server WebSocket prerequisite; no plan to add)
- Pin / favorite Spaces (small follow-up; not roadmap-level)
