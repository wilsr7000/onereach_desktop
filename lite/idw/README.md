# lite/idw -- IDW menu, manage UI, OAGI Store, placeholder browser

Public surface: `getIdwApi()` from `./api.ts`. Renderer surface:
`window.lite.idw`.

This module owns the top-level **IDW** menu in Lite, the
manage-agents Settings section, the OAGI-driven catalog window
("OAGI Store"), and the shared placeholder browser window that
loads each agent's URL when its menu item is clicked. It is the
forerunner of the eventual tabbed IDW browser.

The data model is unified: one `IdwEntry` shape, six `kind` values
("idw", "external-bot", "image-creator", "video-creator",
"audio-generator", "ui-design-tool"). Adding a new kind means
appending to `AGENT_KINDS` + `KIND_META`.

## Usage

### Main process

```typescript
import { getIdwApi, IdwError } from '../idw/api.js';

const all = await getIdwApi().list();
const bots = await getIdwApi().listByKind('external-bot');

try {
  await getIdwApi().add({
    kind: 'external-bot',
    label: 'ChatGPT',
    url: 'https://chat.openai.com',
    source: 'manual',
  });
} catch (err) {
  if (err instanceof IdwError && err.code === 'IDW_INVALID_URL') {
    // surface to the form
  }
}
```

### Renderer

```typescript
const entries = await window.lite!.idw!.list();

const result = await window.lite!.idw!.add({
  kind: 'idw',
  label: 'Sales',
  url: 'https://chat.example.com/sales',
  source: 'manual',
});
// result.wasUpdate is true if a Store catalogId match triggered an update.

// Subscribe to live cross-window mutations.
const unsub = window.lite!.idw!.onChange((latest) => {
  // re-render
});
unsub();

// Open the OAGI Store catalog window.
await window.lite!.idw!.openStore();
```

## Configuration

Persisted in KV collection `lite-idw-entries`, key `default` -- one
JSON blob:

```typescript
{
  schemaVersion: 1,
  entries: IdwEntry[]
}
```

No second JSON file (unlike the full app). Atomic write semantics
inherited from `lite/kv/api.ts`.

## Public API surface

| Method | Purpose | Bridged to renderer |
|---|---|---|
| `list()` | All entries in storage order | Yes |
| `listByKind(kind)` | Filter by kind | Yes |
| `get(id)` | Single entry or null | Yes |
| `add(entry)` | Insert (or Store-update by catalogId) | Yes |
| `update(id, patch)` | Mutate fields. `kind` cannot change | Yes |
| `remove(id)` | Delete | Yes |
| `onChange(handler)` | Subscribe to mutations | Yes (via broadcast) |
| `onEvent(handler)` | Subscribe to typed events (ADR-032) | No (main-process only) |

## Per-kind metadata (`./kind-metadata.ts`)

| Kind | Plural | Default emoji | Accent var | Required fields |
|---|---|---|---|---|
| `idw` | IDWs | robot | `--accent-idw` | -- |
| `external-bot` | External Bots | speech balloon | `--accent-external-bot` | -- |
| `image-creator` | Image Creators | palette | `--accent-image-creator` | -- |
| `video-creator` | Video Creators | clapper | `--accent-video-creator` | -- |
| `audio-generator` | Audio Generators | musical note | `--accent-audio-generator` | `audio.subCategory` |
| `ui-design-tool` | UI Design Tools | paintbrush | `--accent-ui-design-tool` | -- |

Adding a new kind: append to `AGENT_KINDS` in `./types.ts`, append a
row to `KIND_META`, optionally add a `--accent-<kind>` variable in
`./catalog.css` and `lite/settings/settings.css`. The menu builder,
Settings section, and catalog renderer all pick it up automatically.

## Error catalog

All errors extend `IdwError` (which extends `LiteError`).

| Code | When | Remediation |
|---|---|---|
| `IDW_NOT_FOUND` | `get/update/remove` with unknown id | Refresh -- the entry may have been removed |
| `IDW_INVALID_INPUT` | Required field missing or wrong type for the kind | Fill the missing field (label, audio sub-cat, etc.) |
| `IDW_INVALID_URL` | URL missing, malformed, or not http/https | Provide an https:// URL |
| `IDW_DUPLICATE` | Adding an explicit id that already exists | Use `update()` or pick a different label |
| `IDW_KIND_MISMATCH` | `update` tries to change kind, OR Store catalogId matches a different kind | Remove + re-add of the desired kind |
| `IDW_PERSISTENCE_FAILED` | KV write rejected | Check network; the change was not persisted |

## Events (ADR-032)

Per-module typed event surface. Subscribe via `getIdwApi().onEvent(handler)`.

Names (full catalog in `./events.ts`):

- CRUD spans: `idw.add.start/.finish/.fail`,
  `idw.update.*`, `idw.remove.*`
- Activity: `idw.changed`, `idw.opened`, `idw.store.opened`,
  `idw.store.installed`, `idw.store.updated`,
  `idw.browser.loading`, `idw.browser.loaded`
- IPC entries (per ADR-030): `idw.ipc.list`, `idw.ipc.list-by-kind`,
  `idw.ipc.get`, `idw.ipc.add`, `idw.ipc.update`, `idw.ipc.remove`,
  `idw.ipc.open`, `idw.ipc.open-store`

## Security posture

- **Placeholder browser** (`./browser-window.ts`): NO preload --
  third-party agent pages must not see `window.lite.*`. Sandboxed
  + contextIsolated + no node integration. Persistent partition
  `persist:lite-idw-browser` so cookies / localStorage persist
  across closures within one shared session for all agents.
- **Catalog window** (`./catalog-window.ts`): uses the standard Lite
  preload so it can call `window.lite.neon.query` + `window.lite.idw.*`.
- **URL validation**: defensive at the `openAgentInBrowser` boundary
  -- invalid URLs surface a friendly dialog instead of crashing the
  window. Validation is also enforced in `IdwStore.add/update`.
- **External link + popup handling** (ADR-046): `setWindowOpenHandler`
  uses `buildPopupHandler` from `lite/auth/oauth-popup.ts`. OAuth
  IdP popups (Google / Microsoft / Apple / Auth0 / Okta / etc. --
  see `OAUTH_POPUP_ALLOWLIST`) are allowed as in-app child windows
  inheriting the placeholder's partition (so "Sign in with Google"
  inside ChatGPT / Claude / Gemini actually completes in-app).
  Anything else routes to the OS default browser via
  `shell.openExternal`.

## Hardening roadmap

The shared placeholder browser is the seam for the eventual tabbed
browser port:

| Phase | Trigger | Change |
|---|---|---|
| **N0** -- this PR | -- | One singleton browser window, one URL at a time |
| **N1** | Tabbed browser port lands | `loadURL(entry.url)` -> `createTabInBrowser(entry)`. Window + partition + security + click wiring all stay the same |
| **N2** | A kind needs its own window class (e.g. wide aspect for video) | `kind-metadata.ts` grows a `windowFactory` field; click handler reads it |
| **N3** | Per-kind partitions for security isolation | Replace shared `persist:lite-idw-browser` with `persist:lite-idw-<kind>` |

Other future work documented in the plan (ADR-034 in
`lite/DECISIONS.md`):
- Per-IDW partitions (security review)
- URL-pattern detection (full's `idw-registry.js`) -- belongs with
  the tabbed browser port
- Cmd+1..Cmd+9 accelerators (currently per ADR-015 -- no shortcuts)

## File layout

```
lite/idw/
  README.md          (this file)
  api.ts             PUBLIC -- IdwApi, IdwError, IDW_ERROR_CODES, IDW_EVENTS, isIdwEvent, types
  store.ts           INTERNAL -- IdwStore (KV-backed; validation; emits change + events)
  events.ts          INTERNAL -- IDW_EVENTS, IdwEvent union, isIdwEvent
  errors.ts          INTERNAL -- IdwError, IDW_ERROR_CODES
  types.ts           INTERNAL -- IdwEntry, AgentKind, AudioSubCategory, AGENT_KINDS
  kind-metadata.ts   INTERNAL -- KIND_META table (per-kind labels, accents, validation)
  main.ts            INTERNAL -- initIdw() registers IPC, menu, window factories
  menu-builder.ts    INTERNAL -- top:idw + per-kind sections + always-present items
  browser-window.ts  INTERNAL -- shared placeholder browser singleton
  catalog-window.ts  INTERNAL (main) -- catalog window factory
  catalog-renderer.ts INTERNAL (renderer) -- entry: idw-store.js
  catalog.html       INTERNAL (renderer) -- copied as idw-store.html
  catalog.css        INTERNAL (renderer) -- copied as idw-store.css
```

Per Rule 11, **only `api.ts` is importable from other modules.**

## Tests

- `lite/test/unit/idw-api.test.ts` -- `runApiConformanceContract` +
  `runErrorConformanceContract` + behavior
- `lite/test/unit/idw-store.test.ts` -- per-kind validation,
  dedupe-by-id, Store-update vs duplicate, KV round-trip
- `lite/test/unit/idw-menu-builder.test.ts` -- top-level
  registration, kind partitioning, empty-section omission, audio
  sub-category submenus, click routing
- `lite/test/unit/idw-types.test.ts` -- KIND_META completeness +
  per-kind contracts
- `lite/test/integration/idw-integration.test.ts` -- end-to-end
  store + menu rebuild + multi-listener onChange
- `lite/test/integration/typed-onevent.test.ts` -- IdwApi.onEvent
  typed narrowing block
- `lite/test/integration/event-coverage.test.ts` -- IDW module
  emits spans for every op block

The Settings section (`lite/settings/sections/idws.ts`) is
intentionally NOT unit-tested here -- per the plan's review fix,
sections aren't unit-tested anywhere in lite today; manual smoke +
future E2E covers it.

## Borrowed patterns (studied, not imported)

- `lib/menu-sections/idw-gsx-builder.js` (full app) -- per-IDW menu
  shape (label + click handler emitting an action). Lite drops the
  `accelerator: index < 9 ? 'CmdOrCtrl+...' : undefined` line per
  ADR-015. Section structure (IDWs / External Bots / Image Creators
  / etc.) mirrored 1-to-1.
- `menu-data-manager.js` (full app) -- the validate / atomic-save /
  debounced-refresh pattern. Lite simplifies: single KV blob, no
  debounce (KV is fast and `onChange` is rare).
- `omnigraph-client.js:getIDWDirectory` (full app) -- catalog
  Cypher + graph-node-to-renderer mapping. Ported inline into
  `lite/idw/catalog-renderer.ts`.
- `idw-store.html` (full app) -- catalog visual layout (cards,
  search, categories). Lite ports the structure as TS-strict
  modular form, dropping inline scripts.
- `lite/api-docs/window.ts` -- single-instance window factory pattern.
- `lite/settings/sections/two-factor.ts` -- expandable inline form
  pattern + `window.confirm` for destructive actions.
