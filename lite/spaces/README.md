# Spaces Module

**Status**: Phase 1 + Phase 2 shipped. The Spaces window opens, lists every `:Space` the active account can see, surfaces the Uncategorized intake count, fetches `:Item` cards for the selected scope (Uncategorized or a chosen Space), renders multi-Space chips and optional provenance on each card, and pops a detail panel with full content when a card is clicked. Cypher-backed throughout; no stubs remain. Phase 0.5 Discovery panel kept as a collapsible diagnostic at the bottom of the page.

> Spaces is a **platform primitive**, not a Lite-only feature. The Lite UI in this module is the first consumer of the SDK; future consumers include GSX agents, Cowork integrations, and the Approval + Audit event stream. The methods on `SpacesApi` ARE the platform contract -- treat them with that level of stability discipline. See the spaces plan ("Spaces as Platform Primitive" section).

## Public surface (`api.ts`)

```ts
import { getSpacesApi } from '../spaces/api.js';

const api = getSpacesApi();
api.open();                                          // launch / focus the window
await api.listSpaces();                              // every :Space the account can read
await api.getUncategorizedCount();                   // :Items with no :MEMBER_OF edge
await api.items.list({ kind: 'uncategorized' });     // Items without a :Space
await api.items.list({ kind: 'space', spaceId: '…' }); // Items in one :Space (+ chips)
await api.items.get(itemId);                          // full Item incl. content + metadata
```

Use `resolveSpaceScope(id)` at any UI/IPC boundary that hands a plain id into the SDK. The synthetic Uncategorized id is exported as `UNCATEGORIZED_SPACE_ID` and is the only string the renderer/IPC layer ever uses; the typed `SpaceScope` union is what every internal call site sees.

### Cypher

All five queries live as module constants on `lite/spaces/sdk-client.ts` so they're greppable, diffable in code review, and asserted on by unit tests (regression-guarded against accidental drift). See `CYPHER.LIST_SPACES`, `UNCATEGORIZED_COUNT`, `LIST_ITEMS_UNCATEGORIZED`, `LIST_ITEMS_IN_SPACE`, `GET_ITEM`.

### Provenance projection

Each item-list query and `getItem` optionally project a `producedBy` row via `(:Item)-[:PRODUCED_BY|AUTHORED_BY]->(producer)`. When the edge is absent, the projection collapses to `null` and the renderer omits the provenance line. This wires for the Phase 0.5 Q2 outcome: if the schema doesn't carry authorship yet, the column is invisible until it does.

## Internal layout

| File                  | Role                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `api.ts`              | Public surface + singleton swap pattern. The only allowed importer.        |
| `types.ts`            | `Space`, `Item`, `ItemSummary`, `ListOpts`, etc.                           |
| `scope.ts`            | `SpaceScope` union + `resolveSpaceScope` helper.                           |
| `errors.ts`           | `SpacesError` + `SPACES_ERROR_CODES`.                                      |
| `events.ts`           | `SpacesEvent` taxonomy + `SPACES_EVENTS` catalog.                          |
| `sdk-client.ts`       | Cypher wrapper. Phase 1+ injects `getNeonApi().query` at boot.             |
| `discovery.ts`        | Phase 0.5 query runner (main-process; uses `getNeonApi()`).                |
| `discovery-format.ts` | Renderer-safe types + Markdown formatter for discovery results.            |
| `window.ts`           | Single-instance `BrowserWindow` factory.                                   |
| `ipc.ts`              | `lite:spaces:*` IPC handler registration.                                  |
| `main.ts`             | `initSpaces()` orchestrator + Tools-menu wiring.                           |
| `spaces.html/css`     | Renderer chrome + item card / chip / detail-pane styles + Discovery panel. |
| `spaces.ts`           | Renderer entrypoint (IIFE bundled by esbuild).                             |
| `DISCOVERY.md`        | Phase 0.5 reference: Q1–Q6 queries + Q5/Q6 operational template.           |
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

`lite/test/unit/spaces-api.test.ts` runs `runApiConformanceContract` per Rule 12. Required surface: `['open', 'listSpaces', 'getUncategorizedCount', 'items']`.

## Test coverage

| File                                       | Layer covered                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `spaces-api.test.ts`                       | Singleton swap + conformance contract.                                       |
| `spaces-discovery.test.ts`                 | Phase 0.5 Q1–Q4 runner shape.                                                |
| `spaces-sdk-client.test.ts`                | Cypher source regression guards, row-to-domain mapping, error normalization. |
| `spaces-renderer.test.ts`                  | Pure DOM builders (sidebar rows, item cards, chips, detail pane, formatters). |

## Out of scope (this phase)

- `addToSpace` / `removeFromSpace` mutations (Phase 3)
- Create / rename / delete Space (Phase 3)
- Pin / favorite Spaces (small follow-up chunk; not roadmap-level)
- Suggestions / Librarian agents (Phase 4)
- Local cache / offline support
- Real-time activity pulse (server WebSocket prerequisite; no plan to add)
