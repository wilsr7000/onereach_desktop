# Spaces Module

**Status**: Phase 0 scaffold. The module compiles, the window opens, the IPC surface is wired, and the renderer chrome shows a Phase-0 placeholder. Cypher-backed data lands in Phase 1.

> Spaces is a **platform primitive**, not a Lite-only feature. The Lite UI in this module is the first consumer of the SDK; future consumers include GSX agents, Cowork integrations, and the Approval + Audit event stream. The methods on `SpacesApi` ARE the platform contract -- treat them with that level of stability discipline. See the spaces plan ("Spaces as Platform Primitive" section).

## Public surface (`api.ts`)

```ts
import { getSpacesApi } from '../spaces/api.js';

const api = getSpacesApi();
api.open();                                    // launch / focus the window
await api.listSpaces();                        // Phase 1
await api.getUncategorizedCount();             // Phase 1
await api.items.list({ kind: 'uncategorized' }); // Phase 1
await api.items.list({ kind: 'space', spaceId: '…' }); // Phase 2
await api.items.get(itemId);                   // Phase 2
```

Use `resolveSpaceScope(id)` at any UI/IPC boundary that hands a plain id into the SDK. The synthetic Uncategorized id is exported as `UNCATEGORIZED_SPACE_ID` and is the only string the renderer/IPC layer ever uses; the typed `SpaceScope` union is what every internal call site sees.

### Phase 0 → Phase 1 promotion

The Phase 0 stub backs every data method with `SPACES_NOT_INITIALIZED`. To promote, replace `lite/spaces/sdk-client.ts` with the real Neon-backed implementation and the surface here stays unchanged.

## Internal layout

| File                  | Role                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `api.ts`              | Public surface + singleton swap pattern. The only allowed importer. |
| `types.ts`            | `Space`, `Item`, `ItemSummary`, `ListOpts`, etc.                    |
| `scope.ts`            | `SpaceScope` union + `resolveSpaceScope` helper.                    |
| `errors.ts`           | `SpacesError` + `SPACES_ERROR_CODES`.                               |
| `events.ts`           | `SpacesEvent` taxonomy + `SPACES_EVENTS` catalog.                   |
| `sdk-client.ts`       | Cypher wrapper. Phase 0 = stub. Phase 1 = real Neon calls.          |
| `discovery.ts`        | Phase 0.5 query runner (main-process; uses `getNeonApi()`).         |
| `discovery-format.ts` | Renderer-safe types + Markdown formatter for discovery results.     |
| `window.ts`           | Single-instance `BrowserWindow` factory.                            |
| `ipc.ts`              | `lite:spaces:*` IPC handler registration.                           |
| `main.ts`             | `initSpaces()` orchestrator + Tools-menu wiring.                    |
| `spaces.html/css`     | Renderer chrome (incl. Phase 0.5 Discovery panel).                  |
| `spaces.ts`           | Renderer entrypoint (IIFE bundled by esbuild).                      |
| `DISCOVERY.md`        | Phase 0.5 reference: Q1–Q6 queries + Q5/Q6 operational template.    |

## Error catalog

| Code                          | Trigger                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `SPACES_NOT_AUTHENTICATED`    | No `mult` token / no active account.                             |
| `SPACES_NOT_FOUND`            | Space / item missing, or filtered out by ACL.                    |
| `SPACES_FORBIDDEN`            | Caller lacks read/mutate permission on the target.               |
| `SPACES_CYPHER`               | Neon query failed (transient or syntax).                         |
| `SPACES_NETWORK`              | DNS / TCP / TLS / fetch reject on the way to Edison.             |
| `SPACES_INVALID_INPUT`        | Empty id, bad limit, malformed payload.                          |
| `SPACES_NOT_INITIALIZED`      | SDK called before `initSpaces()` ran (Phase 0 stub also throws). |

## Conformance

`lite/test/unit/spaces-api.test.ts` runs `runApiConformanceContract` per Rule 12. Required surface: `['open', 'listSpaces', 'getUncategorizedCount', 'items']`.

## Out of scope (this phase)

- `Cypher` reads / writes (Phase 1+)
- Multi-Space chips on item cards (Phase 2)
- Item-detail rail population (Phase 2)
- `addToSpace` / `removeToSpace` mutations (Phase 3)
- Suggestions / Librarian agents (Phase 4)
