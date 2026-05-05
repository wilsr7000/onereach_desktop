# lite/university -- Agentic University menu, tutorials catalog, Learning Browser

Public surface: `getUniversityApi()` from `./api.ts`. Renderer
surface: `window.lite.university`.

This module owns the top-level **Agentic University** menu in
Lite, a polished tutorials catalog window, and a shared Lite-native
"Learning Browser" window that loads each link in-app. Mirrors the
full app's `_buildUniversityMenu` shape from
`lib/menu-sections/idw-gsx-builder.js` plus the
[test/plans/30-documentation-tutorials.md](test/plans/30-documentation-tutorials.md)
spec.

The catalog is hand-curated in `./curated-content.ts` for v1.
Forward-compat: a future port can replace `CURATED` with a
function that pulls `Course` / `Tutorial` node types from OAGI
(same Cypher / mapping pattern as
`lite/idw/catalog-renderer.ts`).

## Menu structure

```
Agentic University                  (top:university, order 80)
  Open LMS                          -> Learning Browser
  --- (separator)
  Quick Starts                      (submenu)
    View All Tutorials              -> opens the Lite tutorials catalog window
    --- (separator)
    Getting Started                 -> Learning Browser
    Building Your First Agent       -> Learning Browser
    Workflow Fundamentals           -> Learning Browser
    API Integration                 -> Learning Browser
  --- (separator)
  AI Run Times                      -> Learning Browser
```

NO accelerators (per ADR-015).

## Usage

### Main process

```typescript
import { getUniversityApi } from '../university/api.js';

const all = await getUniversityApi().list();
const courses = await getUniversityApi().listByKind('course');
const lms = await getUniversityApi().get('lms');
```

### Renderer (tutorials catalog)

```typescript
const entries = await window.lite!.university!.list();
await window.lite!.university!.open('first-agent'); // routes to Learning Browser
await window.lite!.university!.openTutorials();      // opens the catalog window
```

`window.lite.university` exposes ONLY read methods +
`open` + `openTutorials`. Mutations are out of scope -- the catalog
is hand-curated, not user-editable.

## Public API surface

| Method | Purpose | Bridged to renderer |
|---|---|---|
| `list()` | All curated entries, in display order | Yes |
| `listByKind(kind)` | Filter by `LearningKind` | Yes |
| `get(id)` | Single entry, or null | Yes |
| `open(id)` *(IPC only)* | Open in Learning Browser | Yes |
| `openTutorials()` *(IPC only)* | Open the tutorials catalog window | Yes |
| `onEvent(handler)` | Subscribe to typed events (ADR-032) | No (main only) |

## Per-kind metadata (`./curated-content.ts`)

| Kind | Plural | Default emoji | Accent var | Used by |
|---|---|---|---|---|
| `lms` | LMS | classical building | `--accent-lms` | Top-level "Open LMS" |
| `course` | Courses | books | `--accent-course` | Quick Starts items |
| `tutorial` | Tutorials | graduation cap | `--accent-tutorial` | (reserved for future) |
| `feed` | Feeds | newspaper | `--accent-feed` | "AI Run Times" |
| `method` | Methods | compass | `--accent-method` | Catalog-only reference content |

## Error catalog

All errors extend `UniversityError` (which extends `LiteError`).

| Code | When | Remediation |
|---|---|---|
| `UNIV_NOT_FOUND` | `open(id)` with an unknown id | Refresh -- the catalog may have changed |
| `UNIV_INVALID_URL` | Curated entry has a malformed / non-http URL | Bug in the curated catalog; report it |

## Events (ADR-032)

Subscribe via `getUniversityApi().onEvent(handler)`.

Names (full catalog in `./events.ts`):

- Activity: `university.opened`, `university.tutorials.opened`,
  `university.browser.loading`, `university.browser.loaded`
- IPC entries (per ADR-030): `university.ipc.list`,
  `university.ipc.get`, `university.ipc.open`,
  `university.ipc.open-tutorials`

## Security posture

- **Learning Browser** (`./browser-window.ts`): NO preload --
  third-party content (LMS, Wiser Method, UX Mag) cannot see
  `window.lite.*`. Sandboxed + contextIsolated + no node
  integration. Persistent partition `persist:lite-university` --
  separate from IDW's so course session cookies don't bleed into
  agent sessions.
- **Tutorials catalog window** (`./tutorials-window.ts`): uses the
  standard Lite preload so the renderer can call
  `window.lite.university.list/open`.
- **URL validation**: defensive at the
  `openLearningInBrowser` boundary -- invalid URLs surface a
  friendly dialog instead of crashing the window. Validation also
  enforced at `resolveEntryStrict` (curated catalog).
- **External link handling**: `setWindowOpenHandler` denies child
  Electron windows; `window.open()` and `target="_blank"` clicks
  route to the OS default browser via `shell.openExternal`.

## Hardening roadmap

The hand-curated catalog is the seam for the eventual OAGI-driven
content port:

| Phase | Trigger | Change |
|---|---|---|
| **U0** -- this PR | -- | Hand-curated catalog in `./curated-content.ts` |
| **U1** | Course content lands in OAGI | Replace `CURATED` with an OAGI Cypher fetch (mirrors `lite/idw/catalog-renderer.ts`) |
| **U2** | A kind needs its own window class | `KIND_UI` grows a `windowFactory` field |
| **U3** | Per-context partition isolation | Replace shared `persist:lite-university` with per-domain partitions |

## File layout

```
lite/university/
  README.md              (this file)
  api.ts                 PUBLIC -- UniversityApi, UniversityError, UNIVERSITY_ERROR_CODES, KIND_UI, types
  curated-content.ts     INTERNAL -- CURATED catalog + KIND_UI + URL constants
  events.ts              INTERNAL -- UNIVERSITY_EVENTS, UniversityEvent union, isUniversityEvent
  errors.ts              INTERNAL -- UniversityError, UNIVERSITY_ERROR_CODES
  types.ts               INTERNAL -- LearningEntry, LearningKind, LEARNING_KINDS
  main.ts                INTERNAL -- initUniversity() registers IPC + menu + windows
  menu-builder.ts        INTERNAL -- top:university + items, no onChange (static catalog)
  browser-window.ts      INTERNAL -- shared Learning Browser singleton
  tutorials-window.ts    INTERNAL (main) -- catalog window factory
  tutorials-renderer.ts  INTERNAL (renderer) -- entry: university-tutorials.js
  tutorials.html         INTERNAL (renderer) -- copied as university-tutorials.html
  tutorials.css          INTERNAL (renderer) -- copied as university-tutorials.css
```

Per Rule 11, **only `api.ts` is importable from other modules.**

## Tests

- `lite/test/unit/university-api.test.ts` -- `runApiConformanceContract`
  + `runErrorConformanceContract` + behavior
- `lite/test/unit/university-curated.test.ts` -- catalog coverage,
  URL validity, KIND_UI completeness
- `lite/test/unit/university-menu-builder.test.ts` -- top-level
  registration, click routing, teardown
- `lite/test/integration/typed-onevent.test.ts` -- typed narrowing
  block
- `lite/test/integration/event-coverage.test.ts` -- university
  block (IPC + activity events)

## Borrowed patterns (studied, not imported)

- `menu.js:_buildUniversityMenu` (full app) -- menu structure
  (Open LMS / Quick Starts / AI Run Times); copied
  shape, replaced full-app `openLearningWindow` call with Lite-native
  Learning Browser.
- `lib/gsx-autologin.js:openLearningWindow` -- learning window
  pattern (1600x1000 BrowserWindow, backgroundThrottling: false,
  loading indicator). Lite simplifies: standard Lite chrome
  (1400x900), drops the injected loading CSS (Electron's default
  is fine).
- `tutorials.html` (full app) -- Netflix-style hero + carousel +
  grid. Lite ports the hero + grid as a polished card grid;
  carousel + dynamic content fetch deferred to U1.
- `lite/idw/catalog-window.ts` + `catalog-renderer.ts` -- catalog
  window pattern + cards-with-hover-lift.
- `lite/idw/browser-window.ts` -- placeholder browser pattern
  (separate persistent partition, no preload, deny popups).
