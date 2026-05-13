# Onereach Lite -- Porting Ledger

This file tracks every menu-item port from the full app into lite. Each port lands as one chunk per release tag, hardened against the six-criteria contract from the plan once Phase 0b is complete.

## Port Status Block Template

Copy this block per port; update fields as the chunk progresses.

```markdown
### chunk: <chunk-id>

- **status**: untested | porting | hardening | hardened | regressed
- **plan reference**: <link to plan section>
- **borrowed from full**: <file:line-range -- specific patterns referenced>
- **contracts**: lite/contracts/<name>.ts (zod schemas)
- **api conformance**: lite/test/unit/<module>-api.test.ts (runs runApiConformanceContract -- Rule 12 / ADR-024)
- **error conformance**: <yes/no -- runErrorConformanceContract for module-specific error classes>
- **unit tests**: lite/test/unit/<name>.test.ts (coverage % lines / branches)
- **integration tests**: lite/test/integration/<name>.test.ts (drives the real client against the in-memory KV server when the module talks to KV)
- **e2e tests**: lite/test/e2e/<name>.spec.ts (uses lite/test/harness/<module>/ helpers)
- **harness layer**: lite/test/harness/<module>/ (module-specific E2E scenarios; only if the module ships UI or end-to-end flows)
- **failure modes covered**: <list documented modes>
- **observability**: log span <span-name>, SLI metric <metric-name>
- **deliberately not ported from full**: <list features dropped or deferred>
- **regression-replay fixture**: <path or "none yet">
```

See [`test/HARNESS.md`](test/HARNESS.md) for the 5-step recipe of test files every new port adds.

## Module Structure

Every lite module follows the same shape. The canonical example is `lite/bug-report/` -- copy the structure when adding a new module.

### Folder template

```
lite/<module>/
  api.ts          # PUBLIC typed interface + singleton getter
  main.ts         # INTERNAL main-process IPC handlers + lifecycle
  store.ts        # INTERNAL state / persistence (optional)
  contracts/      # zod schemas per IPC channel (Phase 0b enforces)
  *.html / *.css  # Renderer assets (optional)
  *.ts            # Renderer-side logic (optional)
```

### The six rules

1. **Modules import only `<peer>/api.ts` from sibling modules.** Never `store.ts`, `main.ts`, or internal helpers. If you need a method that isn't on `api.ts`, add it there.
2. **Each `api.ts` exports a typed interface + singleton getter** (`getFooApi()`) plus `_resetFooApiForTesting()`.
3. **IPC channel naming**: `lite:<module>:<verb>` (e.g. `lite:bug-report:list`). Schemas live in `<module>/contracts/`.
4. **One preload script for the whole app** (`lite/preload-lite.ts`). Modules namespace on `window.<module>`. Multiple preloads is the trap full fell into.
5. **No `global.X`.** Cross-module references go through the public API.
6. **No service registry yet.** Singleton getters are enough until lifecycle ordering / health checks become a real need (probably not in 0a or 0b).

### `api.ts` starter template

```typescript
// lite/<module>/api.ts
import { FooStore } from './store.js';
import type { StoreConfig } from './store.js';

export type { /* re-export public types from store.ts */ } from './store.js';

export interface FooApi {
  doThing(arg: string): Promise<void>;
  // ...
}

let _instance: FooApi | null = null;

export function getFooApi(): FooApi {
  if (_instance === null) {
    _instance = new FooStore(defaultConfig());
  }
  return _instance;
}

export function _resetFooApiForTesting(): void {
  _instance = null;
}

export function _setFooApiForTesting(api: FooApi): void {
  _instance = api;
}

function defaultConfig(): StoreConfig {
  return { /* logger, etc. */ };
}
```

### Cross-module import: good vs bad

```typescript
// GOOD -- callers see only the public interface.
import { getBugReportApi } from '../bug-report/api.js';
const reports = await getBugReportApi().list();

// BAD -- reaches into the module's internals. Will fail dep-cruiser
// once Phase 0b lands the rule.
import { BugReportStore } from '../bug-report/store.js';
const store = new BugReportStore();
const reports = await store.list();
```

### IPC contracts

Each cross-process call uses a channel of the form `lite:<module>:<verb>`. Hand-write payload validation in `main.ts` until Phase 0b's `schema-first-ipc` chunk lands. After 0b, every channel has a zod schema in `<module>/contracts/<channel>.ts` and the IPC dispatcher validates payloads automatically.

## Menu Entry Registration Template

When a port adds a menu item, register it in the menu registry. Copy this pattern:

```typescript
// In your port's main-process bootstrap (e.g. lite/spaces/init.ts)
import { registry } from '../menu/registry';
import { createSpacesWindow } from './window';

// Top-level placeholder appears automatically when the first child registers
registry.register({
  id: 'top:tools',
  type: 'top-level',
  label: 'Tools',
  order: 50,
});

// Submenu item
registry.register({
  id: 'tools:open-spaces',
  type: 'item',
  parentId: 'top:tools',
  label: 'Spaces...',
  accelerator: 'CmdOrCtrl+Shift+V',
  click: () => createSpacesWindow(),
  order: 0,
});
```

Top-level menus with no children do NOT render. So pre-registering `top:tools` doesn't put an empty menu in the bar -- it appears the moment its first child registers.

## Port Ordering Convention

Top-level menu order across the eventual lite menu:

| Order | Top-level menu | Notes |
|---|---|---|
| 0 | Onereach.ai Lite (app menu) | Always first; About + Quit + later Preferences |
| 10 | File | Standard Electron file ops |
| 20 | Edit | Standard Electron edit ops |
| 30 | View | Reload, devtools, zoom |
| 40 | Window | Minimize, close, etc. |
| 50 | Tools | Tools Manager + per-tool submenu items |
| 60 | IDW | Configured IDWs (Cmd+1..9 hotkeys) |
| 70 | GSX | GSX-related menu items |
| 100 | Help | About, Report a Bug, Documentation |

## Phase 0a Kernel Manual Checklist

These items require human verification before declaring Phase 0a exit-gate met. Run alongside the automated `kernel-smoke-test`:

- [ ] App icon shows in macOS dock and Cmd+Tab; appears in Windows taskbar
- [ ] About panel content reads naturally (productName, version, copyright)
- [ ] Window title says "Onereach.ai Lite", not "Electron" or stale dev branding
- [ ] Bug-report modal layout is usable (text area is large enough, Send button is reachable, Esc cancels)
- [ ] Cmd+Q feels responsive (no hang on quit)
- [ ] Single-instance lock works -- launching lite a second time brings first window to front, doesn't spawn a second process
- [ ] Side-by-side: full and lite running together don't fight over focus, dock icons, or notifications
- [ ] codesign --verify --deep --strict passes on the built `.app`

## Phase 0 Exit Gate Manual Half

Per the plan, Phase 0 (combined 0a + 0b + first N menu-item ports) exits when both halves are green:

**Manual half** -- release manager attests below:

| User | 5 sessions used? | Real bug filed? | Bug report link | Replayable fixture? |
|---|---|---|---|---|
| (pending) | | | | |
| (pending) | | | | |
| (pending) | | | | |

Exit declared by: __________ on __________

## Active Ports

Currently porting from full into lite (one at a time):

### chunk: idw-multikind

- **status**: hardening
- **plan reference**: ADR-037 in `lite/DECISIONS.md` (`.cursor/plans/lite_idw_chunk_--_revised_multi-category_agents_+_polished_ux_*.plan.md`)
- **borrowed from full** (studied, not imported):
  - `lib/menu-sections/idw-gsx-builder.js` -- per-IDW menu shape, six-category structure, audio sub-categories. Lite drops the Cmd+1..9 accelerators per ADR-015.
  - `menu-data-manager.js` -- validate / atomic-save pattern. Lite simplifies to one KV blob with no debounce.
  - `omnigraph-client.js:getIDWDirectory` -- catalog Cypher. Ported inline into `lite/idw/catalog-renderer.ts`.
  - `idw-store.html` -- catalog visual layout. Lite ports as TS-strict modular form.
  - `setup-wizard.html` -- manual-add wizard. Lite collapses into the Settings -> IDWs section's Add form.
  - `lite/api-docs/window.ts` -- single-instance window factory pattern.
  - `lite/settings/sections/two-factor.ts` -- expandable inline form + `window.confirm` for destructive actions.
- **public surface**:
  - `lite/idw/api.ts` -- `IdwApi` (`list`, `listByKind`, `get`, `add`, `update`, `remove`, `onChange`, `onEvent`); `IdwError`, `IDW_ERROR_CODES`, `IDW_EVENTS`, `isIdwEvent`, `KIND_META`; types (`IdwEntry`, `AgentKind`, `AudioSubCategory`).
  - `window.lite.idw` (preload bridge): `list`, `listByKind`, `get`, `add`, `update`, `remove`, `openStore`, `onChange`, `parseError`. (`lite:idw:open` is registered main-side for future renderer launchers but NOT bridged today.)
  - Settings section: `Settings -> IDWs` (id `idws` between OAGI and Updates).
  - Top-level menu: `IDW` (order 60) registered by `lite/idw/menu-builder.ts` on init. Empty top-levels auto-hide per `lite/menu/build-menu.ts`.
  - Settings deep-link: `getSettingsApi().open('idws')` opens (or focuses) Settings to the IDWs section.
- **contracts**: `lite/idw/types.ts` (`IdwEntry`, `AgentKind`, `AudioSubCategory`, `IdwStorageBlob`) -- not yet zod-wrapped (Phase 0b). `lite/idw/contracts/` reserved for the schema-first IPC chunk.
- **api conformance**: `lite/test/unit/idw-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['list', 'listByKind', 'get', 'add', 'update', 'remove', 'onChange', 'onEvent']`.
- **error conformance**: same test file runs `runErrorConformanceContract` against `IdwError` + `IDW_ERROR_CODES` (modulePrefix `IDW_`).
- **events conformance** (ADR-032): `lite/test/unit/event-name-conformance.test.ts` includes `idw` in MODULES with sourceFiles `[idw/store.ts, idw/main.ts, idw/menu-builder.ts, idw/browser-window.ts]`.
- **unit tests** (4 files, ~63 tests):
  - `lite/test/unit/idw-api.test.ts` -- public surface conformance + error conformance + module-specific behavior
  - `lite/test/unit/idw-store.test.ts` -- per-kind validation, dedupe-by-id, Store-update vs duplicate, onChange listener isolation
  - `lite/test/unit/idw-menu-builder.test.ts` -- top:idw registration + order, kind partitioning, empty-section omission, audio sub-category submenus, click routing, teardown
  - `lite/test/unit/idw-types.test.ts` -- KIND_META completeness + per-kind contracts
- **integration tests**:
  - `lite/test/integration/idw-integration.test.ts` -- IdwStore against real in-memory KV server; menu-builder + IdwApi cross-wiring; multi-listener onChange isolation
  - `lite/test/integration/typed-onevent.test.ts` -- `IdwApi.onEvent typed narrowing` describe block (2 tests)
  - `lite/test/integration/event-coverage.test.ts` -- `IDW module emits spans for every op` describe block (5 tests)
- **failure modes covered**:
  - `IDW_NOT_FOUND` -- get/update/remove with unknown id
  - `IDW_INVALID_INPUT` -- missing label, audio without sub-category, unknown kind
  - `IDW_INVALID_URL` -- non-string, malformed, ftp://
  - `IDW_DUPLICATE` -- explicit id collision
  - `IDW_KIND_MISMATCH` -- update tries to change kind, OR Store re-install on different kind
  - `IDW_PERSISTENCE_FAILED` -- KV write rejected
  - Browser window: invalid URL surfaces a friendly dialog, no crash
  - onChange listener throws -- other listeners still receive the event (vs Node's default EventEmitter halt)
- **observability**:
  - log spans: `idw.add.start/.finish/.fail`, `idw.update.*`, `idw.remove.*`
  - activity events: `idw.changed`, `idw.opened`, `idw.store.opened`, `idw.store.installed`, `idw.store.updated`, `idw.browser.loading`, `idw.browser.loaded`
  - IPC entry events (per ADR-030): `idw.ipc.list`, `idw.ipc.list-by-kind`, `idw.ipc.get`, `idw.ipc.add`, `idw.ipc.update`, `idw.ipc.remove`, `idw.ipc.open`, `idw.ipc.open-store`
  - all under `category=idw` on lite log server (port 47392)
- **persistence**: KV collection `lite-idw-entries`, key `default`. Schema `{ schemaVersion: 1, entries: IdwEntry[] }`. One blob, atomic write semantics from `lite/kv/api.ts`. No second JSON file (vs full app's drift-prone dual-store pattern).
- **forward-compat**:
  - **Tabbed browser**: replace `loadURL(entry.url)` in `browser-window.ts:openAgentInBrowser` with `createTabInBrowser(entry)`. Window + partition + security + click wiring all stay.
  - **Per-kind dedicated windows**: `kind-metadata.ts` grows a `windowFactory` field; click handler reads it.
  - **Per-IDW partitions**: replace shared `persist:lite-idw-browser` with `persist:lite-idw-<kind>`.
  - **New kinds**: append to `AGENT_KINDS` + `KIND_META`; menu builder, Settings section, and catalog renderer pick it up automatically.
  - **Bearer auth on /omnidata/neon**: handled by `lite/neon/credentials.ts`'s pluggable `CredentialsProvider` (ADR-033).
- **deliberately not ported from full**:
  - Tabbed browser (separate chunk; placeholder is the seam)
  - Cmd+1..Cmd+9 accelerators (ADR-015)
  - GSX submenu inside IDW (depends on full's `gsx-autologin`)
  - File Sync menu (full's `_addGSXFileSync`)
  - URL-pattern detection (full's `idw-registry.js`) -- belongs with the tabbed browser port
  - One-time onboarding modal (lean on welcoming copy in menu / Settings / Store header)
- **consumers today**: Settings -> IDWs section (`lite/settings/sections/idws.ts`); IDW Store catalog window (`lite/idw/catalog-renderer.ts`); future renderer features via `window.lite.idw.*`; future main-process features via `getIdwApi()`.
- **regression-replay fixture**: none yet -- in-memory KV + FakeKV cover the wire and validation regressions.

### chunk: university

- **status**: ported
- **plan reference**: ADR-038 in `lite/DECISIONS.md`
- **borrowed from full** (studied or reused as noted):
  - `menu.js:_buildUniversityMenu` -- studied; copied menu shape (Open LMS / Quick Starts -> View All Tutorials + 4 courses / AI Run Times / Wiser Method); replaced full-app `openLearningWindow` call with Lite-native Learning Browser singleton.
  - `lib/gsx-autologin.js:openLearningWindow` -- studied; learning window pattern (BrowserWindow with backgroundThrottling: false). Lite simplifies: standard chrome (1400x900), drops the injected loading-indicator CSS (Electron's default suffices). NO autologin (Lite has no GSX integration yet -- the LMS is pure cookie-session-driven through the persistent partition).
  - `tutorials.html` -- studied; Netflix-style hero + carousel + grid. Lite ports the hero copy + grid as a polished card grid; carousel + dynamic-fetch deferred to U1 (OAGI-driven catalog).
  - `lite/idw/catalog-window.ts` + `catalog-renderer.ts` -- single-instance window factory + cards-with-hover-lift + accent variables.
  - `lite/idw/browser-window.ts` -- placeholder browser pattern (separate persistent partition, no preload, deny popups -> shell.openExternal).
- **public surface**:
  - `lite/university/api.ts` -- `UniversityApi` (`list`, `listByKind`, `get`, `onEvent`); `UniversityError`, `UNIVERSITY_ERROR_CODES`, `UNIVERSITY_EVENTS`, `isUniversityEvent`, `KIND_UI`; types (`LearningEntry`, `LearningKind`).
  - `window.lite.university` (preload bridge): `list`, `listByKind`, `get`, `open`, `openTutorials`, `parseError`. (`open` and `openTutorials` are click-driven from the renderer; the `lite:university:open` IPC routes to the Learning Browser; `lite:university:open-tutorials` opens the catalog window.)
  - Top-level menu: `Agentic University` (order 80) registered by `lite/university/menu-builder.ts` on init. Empty top-levels auto-hide per `lite/menu/build-menu.ts`.
  - No Settings section (catalog is hand-curated and read-only for v1).
- **contracts**: `lite/university/types.ts` (`LearningEntry`, `LearningKind`, `LEARNING_KINDS`) -- not yet zod-wrapped (Phase 0b). `lite/university/contracts/` reserved for the schema-first IPC chunk.
- **api conformance**: `lite/test/unit/university-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['list', 'listByKind', 'get', 'onEvent']`.
- **error conformance**: same test file runs `runErrorConformanceContract` against `UniversityError` + `UNIVERSITY_ERROR_CODES` (modulePrefix `UNIV_`).
- **events conformance** (ADR-032): `lite/test/unit/event-name-conformance.test.ts` includes `university` in MODULES with sourceFiles `[university/main.ts, university/menu-builder.ts, university/browser-window.ts]`.
- **unit tests** (3 files, ~45 tests):
  - `lite/test/unit/university-api.test.ts` -- public surface conformance + error conformance + module-specific behavior; isUniversityEvent narrowing.
  - `lite/test/unit/university-curated.test.ts` -- catalog completeness, URL validity (http/https), KIND_UI per-kind metadata.
  - `lite/test/unit/university-menu-builder.test.ts` -- top:university registration + order, child registration (Open LMS, Quick Starts parent, 4 course items, AI Run Times, Wiser Method), click routing, teardown.
- **integration tests**:
  - `lite/test/integration/typed-onevent.test.ts` -- `UniversityApi.onEvent typed narrowing` describe block (2 tests).
  - `lite/test/integration/event-coverage.test.ts` -- `University module emits IPC + activity events` describe block (3 tests).
- **failure modes covered**:
  - `UNIV_NOT_FOUND` -- open() with an unknown id (resolveEntryStrict throws)
  - `UNIV_INVALID_URL` -- curated entry has a malformed / non-http URL
  - Browser window: invalid URL surfaces a friendly dialog, no crash
- **observability**:
  - activity events: `university.opened`, `university.tutorials.opened`, `university.browser.loading`, `university.browser.loaded`
  - IPC entry events (per ADR-030): `university.ipc.list`, `university.ipc.get`, `university.ipc.open`, `university.ipc.open-tutorials`
  - all under `category=university` on lite log server (port 47392)
- **persistence**: none (catalog is hand-curated in `./curated-content.ts`). No KV collection.
- **forward-compat**:
  - **OAGI-driven catalog** (U1): replace `CURATED` with a Cypher fetch (mirrors `lite/idw/catalog-renderer.ts`'s OAGI integration).
  - **Per-kind dedicated windows** (U2): `KIND_UI` grows a `windowFactory` field; click handler reads it.
  - **Per-domain partitions** (U3): replace shared `persist:lite-university` with `persist:lite-university-<host>` -- isolates LMS session from Wiser Method, etc.
  - **Tabbed Learning Browser**: replace `loadURL(entry.url)` in `browser-window.ts:openLearningInBrowser` with `createTabInBrowser(entry)`. Same pattern as IDW.
  - **Dynamic tutorials feed** (carousel + featured rotation): replace static `featured` flag with a fetch from OAGI.
- **deliberately not ported from full**:
  - Netflix-style carousel + dynamic content fetch in `tutorials.html` (catalog is static + curated for v1)
  - Flipboard-style AI Run Times feed in `Flipboard-IDW-Feed/uxmag.html` (heavy; AI Run Times menu item opens the source URL in the Learning Browser instead)
  - GSX-autologin URL parameter injection (`lib/gsx-autologin.js` integration; Lite has no GSX yet)
  - Wiser Method dark-text CSS injection (Lite uses a sandboxed window with no CSS injection -- if user reports, U2 work)
  - In-window loading-indicator CSS overlay (Electron's default suffices)
- **consumers today**: top-level Agentic University menu; tutorials catalog window; future renderer features via `window.lite.university.*`; future main-process features via `getUniversityApi()`.
- **regression-replay fixture**: none yet -- catalog is static, browser opens are deterministic.

### chunk: ai-openai-v1

> **PULLED.** This chunk has been removed from the codebase. Brought
> the `lite/ai/` module + Settings -> AI section + TTS support; the
> Listen feature in AI Run Times never earned its keep as a single
> consumer of a full AI service module. Bringing it back is a new
> chunk that reverses the deletion + re-wires the consumers.
> The original chunk notes are preserved below for reference.



- **status**: ported
- **plan reference**: ADR-040 in `lite/DECISIONS.md`
- **borrowed from full** (studied or reused as noted):
  - `lib/ai-service.js` -- centralized-AI-endpoint philosophy (no module makes raw OpenAI fetches). Lite simplifies: no profile system, no jsonMode, no centralized cost tracking; v1 ships TTS + chat only.
  - `lib/ai-providers/openai-adapter.js` -- OpenAI request body shape (`response_format` for TTS; `model / messages / max_tokens` for chat).
  - `lite/neon/credentials.ts` -- `CredentialsProvider` abstraction for forward-security swaps without changing call sites (ADR-033 pattern).
  - `lite/totp/store.ts` -- the keychain pattern A1 will adopt.
- **public surface**:
  - `lite/ai/api.ts` -- `AiApi` (`tts`, `chat`, `status`, `configure`, `onEvent`); `AiError`, `AI_ERROR_CODES`, `AI_EVENTS`, `isAiEvent`; types (`TtsRequest/Response`, `ChatRequest/Response`, `AiConfig`, `AiStatus`, `OPENAI_TTS_VOICES`).
  - `window.lite.ai` (preload bridge): `tts` (returns base64 audio), `chat`, `status`, `configure`, `parseError`.
  - Settings section: `Settings -> AI` (id `ai` between IDWs and Updates).
- **contracts**: `lite/ai/types.ts` -- not yet zod-wrapped (Phase 0b).
- **api conformance**: `lite/test/unit/ai-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['tts', 'chat', 'status', 'configure', 'onEvent']`.
- **error conformance**: same test file runs `runErrorConformanceContract` against `AiError` + `AI_ERROR_CODES` (modulePrefix `AI_`).
- **events conformance** (ADR-032): `lite/test/unit/event-name-conformance.test.ts` includes `ai` in MODULES with sourceFiles `[ai/api.ts, ai/main.ts]`.
- **unit tests**:
  - `lite/test/unit/ai-api.test.ts` -- public surface conformance + error conformance + behavior (status, configure, tts/chat input validation, isAiEvent narrowing)
  - `lite/test/unit/ai-client.test.ts` -- OpenAI HTTP client: TTS request shape (auth header, JSON body, accept header), 429 -> AI_RATE_LIMITED, 401/500 -> AI_HTTP, fetch throw -> AI_NETWORK, AbortError -> AI_TIMEOUT, chat completion request body + response parsing
- **integration tests**:
  - `lite/test/integration/typed-onevent.test.ts` -- `AiApi.onEvent typed narrowing` describe block
  - `lite/test/integration/event-coverage.test.ts` -- AI module IPC + span events
- **failure modes covered**:
  - `AI_NOT_CONFIGURED` -- tts/chat called before API key set
  - `AI_BAD_INPUT` -- empty text, empty messages, text > 4096 chars
  - `AI_HTTP` -- 401 (key rejected), 500 (OpenAI error)
  - `AI_RATE_LIMITED` -- 429 with backoff guidance
  - `AI_NETWORK` -- DNS / TCP / TLS failure
  - `AI_TIMEOUT` -- 60s budget exceeded
- **observability**:
  - log spans: `ai.tts.start/.finish/.fail`, `ai.chat.start/.finish/.fail`, `ai.configure.start/.finish/.fail`
  - IPC entry events (per ADR-030): `ai.ipc.tts`, `ai.ipc.chat`, `ai.ipc.status`, `ai.ipc.configure`
  - all under `category=ai` on lite log server (port 47392)
  - API key NEVER logged; raw text input / completions NEVER logged (only counts + statuses)
- **persistence**: KV collection `lite-ai-config`, key `default`. Schema `{apiKey, defaultTtsVoice, defaultTtsModel, defaultChatModel}`. Single blob, atomic writes.
- **forward-compat**:
  - **Keychain-backed API key** (A1): swap `KVAiCredentialsProvider` for a keychain provider; `CredentialsProvider` interface unchanged.
  - **Org-managed bearer tokens** (A2): add `BearerCredentialsProvider`; `client.ts` adds new switch case.
  - **Multi-provider** (A3): add `lite/ai/providers/anthropic.ts`, `gemini.ts`; `AiApi` grows `profile` parameter (mirrors full app's `ai-service.js`).
  - **Cost tracking** (A4): wire `feature` label into a future `lite/budget/` module.
- **deliberately not ported from full**:
  - Profile system (`fast` / `standard` / `powerful` / etc.) -- v1 has one provider so profiles are noise
  - jsonMode / response_format -- not needed by v1 consumers
  - Vision / embedding / transcription / image-generate methods -- add when a consumer asks
  - Adaptive thinking / extended-thinking budget tokens -- OpenAI doesn't have a Claude-equivalent
- **consumers today**: AI Run Times (TTS for article playback). Future: Spaces summarization, IDW chat presets, Voice Orb.
- **regression-replay fixture**: stub `fetch` impl in `ai-client.test.ts` covers the wire-format regressions.

### chunk: ai-run-times

- **status**: ported (TTS half pulled -- see amendment 2026-05-05)
- **plan reference**: ADR-041 in `lite/DECISIONS.md`
- **amendment 2026-05-05** -- TTS pulled along with `lite/ai/`:
  - Listen button removed from the article overlay.
  - Audio playlist bar + queue panel removed from the reader window.
  - `AI Run Times can read articles aloud` AI key banner removed.
  - `cachedTts` IPC + `cachedTts` bridge method removed.
  - `lite:ai-run-times:cached-tts` channel and Files-backed cache
    helpers (`ttsCachePrefix`, `ttsCacheFileName`, `ttsCacheKey`)
    deleted from `main.ts`.
  - `lite/test/unit/ai-run-times-cached-tts.test.ts` deleted.
  - The `openai-key-set` onboarding step was dropped.
  - Reading log still records the `listenedToCompletion` flag in
    its persisted shape (no schema migration needed); new entries
    will always have it `false`.
  - The README banner notes the deletion + reversal path.

- **borrowed from full** (studied or reused as noted):
  - `Flipboard-IDW-Feed/uxmag-script.js` (~3500 LOC) -- `FlipboardReader` class shape: tile grid + article viewer overlay + playlist bar + content preferences. Lite ports the structure as TS-strict modules + bundled renderer (~1600 LOC of TS + 600 LOC of CSS).
  - `Flipboard-IDW-Feed/main.js` -- main-process RSS fetch with redirect handling. Lite uses `fetch()` directly (Electron 22+) with `AbortSignal` for timeouts; rewrites for cleaner error mapping.
  - `Flipboard-IDW-Feed/preload.js` -- `flipboardAPI` bridge surface. Lite collapses into the standard `window.lite.*` pattern via `preload-lite.ts`.
  - `lite/idw/store.ts` -- KV blob shape, dedupe-by-id, listener isolation in `emitChange`.
  - `lite/idw/catalog.css` + `lite/university/tutorials.css` -- visual language.
- **public surface**:
  - `lite/ai-run-times/api.ts` -- `AiRunTimesApi` (15 methods: list/get/refresh/fetch articles, list/save preferences, list/add/remove/toggle feed sources, list/record/clear/export reading log, onEvent); `AiRunTimesError`, `AI_RUN_TIMES_ERROR_CODES`, `AI_RUN_TIMES_EVENTS`, `isAiRunTimesEvent`; types (`Article`, `FeedSource`, `Preference`, `ReadingLogEntry`).
  - `window.lite.aiRunTimes` (preload bridge): all 15 methods + `openWindow` + `parseError`.
  - Reader window: dedicated `BrowserWindow` loading `ai-run-times.html` (1400x900, single-instance).
  - Top-level menu: routes via `Agentic University -> AI Run Times` (the University menu's `onOpenEntryOverride` callback in `main-lite.ts` opens the reader window for `id === 'ai-run-times'` instead of the generic Learning Browser).
- **contracts**: `lite/ai-run-times/types.ts` -- not yet zod-wrapped (Phase 0b).
- **api conformance**: `lite/test/unit/ai-run-times-api.test.ts` runs `runApiConformanceContract` with all 15 methods + `onEvent`.
- **error conformance**: same test file runs `runErrorConformanceContract` against `AiRunTimesError` + `AI_RUN_TIMES_ERROR_CODES` (modulePrefix `ART_`).
- **events conformance** (ADR-032): `lite/test/unit/event-name-conformance.test.ts` includes `ai-run-times` in MODULES with sourceFiles `[ai-run-times/api.ts, ai-run-times/store.ts, ai-run-times/main.ts]`.
- **unit tests** (~85 tests total across 3 files):
  - `lite/test/unit/ai-run-times-api.test.ts` -- conformance + behavior (preferences, feed source CRUD with URL validation, dedupe, NOT_FOUND for unknown ids, recording log, JSON export)
  - `lite/test/unit/ai-run-times-store.test.ts` -- KV persistence: upsertArticles dedupe + cached body preservation, ARTICLE_CACHE_MAX pruning, publishedAt sorting, savePreferences validation, recordRead update vs insert, removeFeedSource cascades to articles, multi-listener `onChange` isolation
  - `lite/test/unit/ai-run-times-fetcher.test.ts` -- `parseRssFeed` (CDATA, named + numeric entities, missing fields), `extractArticleContent` heuristic, `countWords` with apostrophe handling, `stableArticleId` stability, `fetchAndParseFeed` redirect following + error mapping
- **integration tests**:
  - `lite/test/integration/typed-onevent.test.ts` -- `AiRunTimesApi.onEvent typed narrowing`
  - `lite/test/integration/event-coverage.test.ts` -- AI Run Times module IPC + activity events
- **failure modes covered**:
  - `ART_FEED_FETCH_FAILED` -- HTTP non-2xx, network throw, too-many-redirects
  - `ART_ARTICLE_FETCH_FAILED` -- article HTML fetch failure
  - `ART_BAD_INPUT` -- empty/malformed url, invalid http URL, unknown preference id, duplicate feed url
  - `ART_NOT_FOUND` -- removeFeedSource / toggleFeedSource / setArticleContent for unknown id
  - `ART_PERSISTENCE_FAILED` -- KV write rejected
  - Renderer: missing OpenAI key shows friendly toast on Listen click; bridge unavailable shows error banner
- **observability** (full coverage 2026-05-05 -- ADR-030):
  - log spans: `ai-run-times.refresh-feed.{start,finish,fail}`, `ai-run-times.fetch-article.{start,finish,fail}`
  - activity events: `window.opened`, `article.opened` (recordRead with no `finishedAt`), `article.finished` (recordRead with `finishedAt`, includes best-effort `durationMs` derived from `openedAt -> finishedAt`), `preferences.saved`, `feed-source.{added,removed,toggled}`, `reading-log.{exported,cleared}`, `changed` (TTS events removed alongside `lite/ai/`; bringing TTS back re-adds `tts.playback-{start,finish,fail}`)
  - IPC entry events (per ADR-030): all 15 IPC channels each emit a `ipc.<verb>` event on entry: `list-articles`, `refresh-feed`, `get-article`, `fetch-article-body`, `list-preferences`, `save-preferences`, `list-reading-log`, `record-read`, `clear-reading-log`, `export-reading-log`, `list-feed-sources`, `add-feed-source`, `remove-feed-source`, `toggle-feed-source`, `open-window`
  - per-feed warn: refresh swallows individual feed failures so it can return per-feed status; each failure also emits `getLoggingApi().warn('ai-run-times', 'feed fetch failed', {feedId, url, code, message})` so a single broken feed inside an otherwise-OK refresh remains observable
  - all under `category=ai-run-times` on lite log server (port 47392)
- **persistence**: KV collection `lite-ai-run-times`, key `default`. Single blob: `{schemaVersion, feedSources[], preferences[], articles[], readingLog[]}`. Article cache capped at 200 entries, reading log capped at 1000.
- **forward-compat**:
  - **OAGI-driven feed sources** (R1): replace KV-backed `feedSources` with an OAGI fetch (Feed node type); user-added feeds still in KV.
  - **Atom / JSON Feed support** (R3): `parseAtomFeed` / `parseJsonFeed`; `fetchAndParseFeed` dispatches by `Content-Type`.
  - **Reading position memory** (R4): persist scrollPosition in `ReadingLogEntry`, restore on next open.
  - **OAGI-synced reading log** (R5): move `readingLog` into OAGI (`ReadingEvent` node type) for cross-device.
  - **Audio script generation** (R6): use `getAiApi().chat()` to summarize / restructure article into a podcast-style script before TTS.
- **deliberately not ported from full**:
  - Twitter embeds, Font Awesome icons (use Unicode + inline SVG)
  - Service Worker (`Flipboard-IDW-Feed/sw.js`) -- not needed in Electron
  - Reading-log download via filesystem write (use `URL.createObjectURL` + anchor-click in renderer)
  - Cache-to-disk via `cache:save` / `cache:load` IPC -- collapsed into the single KV blob
  - Audio script generation (deferred to R6 -- needs lite/ai/ chat method to mature)
  - `localStorage` for preferences (Lite uses KV per ADR-020)
  - Per-feed reading-time labels with progress bars on tiles -- v1 shows fixed reading time only; "% read" tracking deferred to R4
  - Three-pane layout from full app's later iterations -- Lite uses single-pane reader overlay matching IDW Store visual language
- **consumers today**: Agentic University menu's "AI Run Times" item; future Settings -> AI Run Times section for feed source management.
- **regression-replay fixture**: stub `fetch` impl in `ai-run-times-fetcher.test.ts` covers RSS-format regressions.

### chunk: auth-totp-autofill-v1

- **status**: porting (detection model upgraded 2026-05-04)
- **plan reference**: ADR-034 (with 2026-05-04 amendment) in `lite/DECISIONS.md`
- **borrowed from full** (studied or reused as noted):
  - `lib/auth-scripts.js` -- reused directly (allowed `lib/` import) for `buildWaitForAuthFormScript`, `buildFillTOTPScript`, `buildSubmitButtonScript`
  - `lib/gsx-autologin.js:589-598` -- `waitForAuthForm` (MutationObserver) shape (studied, not imported)
  - `lib/gsx-autologin.js:716-1052` -- TOTP timing / retry / post-submit handling shape (studied, not imported)
- **public surface**: none new -- this is internal auth-window behavior behind `getAuthApi().signIn('edison')`
- **contracts**: none (no new IPC channel; no renderer bridge)
- **api conformance**: unchanged (`lite/test/unit/auth-api.test.ts`)
- **error conformance**: unchanged (`AuthError` only)
- **unit tests**: `lite/test/unit/auth-totp-autofill.test.ts` -- no-handle no-op, non-onereach skip, 2FA detection via the MutationObserver wait, no-secret no-op, fill+submit success, popup-window watcher attachment, per-frame parallel-scan dedup, listener detach on stop(), redaction (no six-digit code in logs)
- **integration tests**: none in v1 -- full BrowserWindow flow deferred to E2E
- **e2e tests**: deferred -- fake OneReach auth server should exercise email/password manual -> 2FA auto-fill -> account select -> cookie capture
- **failure modes covered**:
  - No auth BrowserWindow handle / no `webContents` -> no-op (logs "disabled")
  - Frame is not `*.onereach.ai` -> skipped per-frame, never `executeJavaScript`'d
  - Auth frame present but TOTP input not yet rendered (SPA timing) -> MutationObserver wait keeps polling for up to 10s; resolves only when the form actually mounts
  - No TOTP secret configured -> no-op (user can still copy code manually from Settings once configured)
  - Code near expiration -> waits for next 30-second window, re-fetches, then fills
  - 2FA prompt opens in a `window.open` popup -> auto-fill attaches to the popup via `did-create-window`
  - Fill/submit fails -> bounded `MAX_ATTEMPTS=3` global; warn-level log per failed attempt
- **observability**:
  - log events under `category=auth` and message prefix `auth-totp-autofill:` (`started watching`, `tracking popup window`, `scan`, `skip non-onereach frame`, `waiting for auth form`, `form wait resolved`, `waiting for fresh code window`, `filled and submitted 2FA code`, `no onereach frame in tree`, `frame walk failed`, `fill threw`, `submit threw`, `getCurrentCode failed`, `skipped because no TOTP secret is configured`)
  - never log the six-digit code, the TOTP secret, or cookie values
- **deliberately not ported from full**:
  - Email/password auto-fill
  - Account-picker auto-select
  - Full GSX window chrome / toolbar / overlay
- **consumers today**: `lite/auth/store.ts` starts/stops the helper during `signIn()`
- **regression-replay fixture**: none yet

### chunk: neon-readonly

- **status**: porting
- **plan reference**: ADR-033 in `lite/DECISIONS.md`
- **borrowed from full** (studied, not imported):
  - `omnigraph-client.js:818-948` -- request/response shape for the OneReach Cypher proxy. Pure reference; nothing imported.
  - `lite/kv/client.ts` -- the entire `runRequest` timeout/abort/error-normalization pattern; copied wholesale, only the wire format differs.
  - `lite/auth/api.ts` -- main-process-only credential pattern (`getToken` not bridged); applied to `configure()` (renderer can call it only from the Settings -> Neon section, not arbitrary windows).
  - `lite/auth/main.ts` -- `JSON.stringify({__authError: ...})` over IPC + `parseError()` on the renderer side; copied as `__neonError`.
- **public surface**:
  - `lite/neon/api.ts` -- `NeonApi` (`query`, `ping`, `status`, `configure`, `onEvent`), `NeonError`, `NEON_ERROR_CODES`, `NEON_EVENTS`, `isNeonEvent`, types.
  - `window.lite.neon` (preload bridge): `query`, `status`, `testConnection`, `configure`, `parseError`. The Settings -> Neon section is the only consumer of `configure`.
  - Settings section: `Settings -> Neon` (id `neon` in the section list, between `two-factor` and `updates`).
- **contracts**: `lite/neon/types.ts` (`NeonRecord`, `NeonNode`, `NeonRelationship`, `NeonStatus`, `NeonConfig`) -- not yet zod-wrapped (Phase 0b).
- **api conformance**: `lite/test/unit/neon-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['query', 'ping', 'status', 'configure', 'onEvent']`.
- **error conformance**: `lite/test/unit/neon-api.test.ts` runs `runErrorConformanceContract` against `NeonError` + `NEON_ERROR_CODES` (modulePrefix `NEON_`).
- **events conformance** (ADR-032): `lite/test/unit/event-name-conformance.test.ts` includes `neon` in MODULES with sourceFiles `[neon/client.ts, neon/main.ts, neon/api.ts]`.
- **unit tests**: `lite/test/unit/neon-api.test.ts` (25 tests), `lite/test/unit/neon-client.test.ts` (28 tests covering happy path, every error code, span emission, and the `buildRequest` switch for both `basic-in-body` and `bearer` credential variants), `lite/test/unit/neon-credentials.test.ts` (15 tests).
- **integration tests**: `lite/test/integration/neon-integration.test.ts` (9 tests): real `EdisonNeonClient` against an in-memory HTTP server with the exact /omnidata/neon body shape; also exercises `KVCredentialsProvider` end-to-end against the real in-memory KV server.
- **typed onEvent integration**: `lite/test/integration/typed-onevent.test.ts` includes a `NeonApi.onEvent typed narrowing` block (3 tests).
- **event coverage integration**: `lite/test/integration/event-coverage.test.ts` includes a `Neon module emits spans for every op` block (5 tests).
- **failure modes covered**:
  - `NEON_NOT_CONFIGURED` -- endpoint or credentials missing (separate context for each)
  - `NEON_TIMEOUT` -- abort due to per-request timeout
  - `NEON_HTTP` -- non-2xx with status-specific remediation (401/403/404/429/5xx)
  - `NEON_NETWORK` -- fetch rejection (DNS/TCP/TLS)
  - `NEON_QUERY` -- 200 with server-side `error` field (Cypher-side failure)
  - `NEON_BAD_INPUT` -- empty / non-string Cypher rejected at the boundary
  - 401 invalidates a future bearer-flow's cached credentials (provider.invalidate hook)
- **observability**:
  - log spans: `neon.query.start`/`.finish`/`.fail`, `neon.ping.start`/`.finish`/`.fail`, `neon.configure.start`/`.finish`/`.fail`
  - instant IPC-entry events: `neon.ipc.query`, `neon.ipc.status`, `neon.ipc.test-connection`, `neon.ipc.configure` (ADR-030)
  - all under `category=neon` on lite log server (port 47392)
- **persistence**: KV collection `lite-neon-config`, key `default`. Schema `{ endpoint, uri, user, password, database }`. Provider abstraction (`CredentialsProvider`) hides the storage choice from the client.
- **forward-security seam**: `lite/neon/credentials.ts` -- the `NeonCredentials` discriminated union has `'basic-in-body'` (today) and `'bearer'` (reserved) variants. `client.ts:buildRequest` switches on `creds.kind`. When the `/omnidata/neon` endpoint hardens, a new provider variant + one new `buildRequest` case lands; call sites stay unchanged.
- **deliberately not ported from full**:
  - Typed CRUD helpers (`upsertSpace`, `upsertAsset`, `ensurePerson`, `shareWith`, etc.) -- those land in feature modules (e.g. `lite/spaces/graph.ts`) when their respective ports happen, not in the transport client.
  - The full-app dual-transport (`neo4j-driver` direct path + GSX async-job polling) -- single-transport HTTP only.
  - Cypher escape-string utility -- callers use bound `parameters`, never string concatenation.
  - `Cmd+,`-style accelerators on the Settings -> Neon section (ADR-015).
  - Renderer-side write blocking -- per the user's decision, full query (read + write) is exposed; can tighten later via a Cypher validator at the IPC boundary.
- **consumers today**: Settings -> Neon section (`lite/settings/sections/neon.ts`); `window.lite.neon.*` for any future renderer-side feature; `getNeonApi()` for any future main-process feature.
- **regression-replay fixture**: none yet -- the in-memory fake endpoint covers wire-shape regressions.

### chunk: auto-updater

- **status**: hardening
- **plan reference**: `.cursor/plans/lite_auto-updater_+_harness_*.plan.md` (ADR-021, ADR-022)
- **borrowed from full**:
  - `main.js:360-370` -- electron-updater initialization
  - `main.js:16695-16723` -- update-state.json read/write/clear
  - `main.js:16725-16783` -- verifyUpdateOnStartup cross-restart check
  - `main.js:16806-16988` -- setupAutoUpdater event handlers + dialogs
  - `main.js:17001-17063` -- checkForUpdates with timeout + in-flight guard
  - `main.js:17120-17302` -- performUpdateInstall (writability, save-state, ShipIt, safety net)
  - `main.js:17158-17223` -- _saveStateBeforeUpdate bounded hooks (1.5s total / 500ms per hook)
  - `rollback-manager.js` -- backup directory + retention
- **public surface**:
  - `lite/updater/index.ts` -- `initUpdater()`, `verifyUpdateOnStartup()`, `UPDATER_IPC` channel constants, `RELEASES_URL`
  - `window.updater` (preload bridge): `check({manual?})`, `install()`, `getState()`, `onStatus(cb)`
  - Menu entry: `Help -> Check for Updates...` (id `help:check-for-updates`, no accelerator per ADR-015)
- **contracts**: `lite/updater/types.ts` (UpdateState, UpdaterStatus, UpdaterInfo, BackupRecord) -- not yet zod-wrapped (Phase 0b)
- **unit tests**: `lite/test/unit/updater/{init,state,verify,backups,save-state,check,lifecycle,install,menu-wiring}.test.ts` -- 63 tests, all passing
- **integration tests**: `lite/test/integration/updater/boot-wiring.test.ts` -- 5 tests, all passing
- **e2e tests**: `lite/test/e2e/updater/{menu-presence,cross-restart-state,backup-created,check-flow,local-server}.spec.ts` -- 5 specs, skip gracefully without a built `.app`
- **failure modes covered**:
  - electron-updater not loadable (broken install) -- fallback menu entry shows manual-download dialog
  - check-for-updates timeout (30s default) -- emits error status with friendly copy
  - update-not-available on auto check -- silent (no dialog)
  - update-not-available on manual check -- "you are on latest" dialog
  - download error mapping (CONNECTION_REFUSED, ENOTFOUND, INTERNET_DISCONNECTED, 404, sha512 mismatch) -- friendly copy
  - bundle-not-writable on macOS -- pre-flight refusal dialog with Download Manually
  - cross-restart install failure -- failedAttempts increment + 3-button dialog
  - repeat install failure (>=2 attempts) -- different copy ("could not be applied")
  - save-state hook timeout / hook error -- captured per-hook, never throws
  - in-flight check coalescing -- second concurrent call returns first's promise
- **observability**:
  - All updater events log under `category=updater` to lite's log server (`http://127.0.0.1:47392/logs?category=updater`)
  - Status IPC (`lite:updater:status`) broadcasts to all renderers for future banner UI
  - Update state on disk: `userData/update-state.json`
  - Backups on disk: `userData/app-backups/v<version>/backup-metadata.json`
- **deliberately not ported from full**:
  - Custom restore script generator (`rollback-manager.js`'s `createRestoreScript`) -- defer until pilot demands rollback UI
  - Help -> Manage Backups submenu -- kernel keeps Help minimal
  - Aider/agent state-save hooks -- lite kernel has no equivalent state yet; future ports register their own via `registerSaveHook`
- **consumers today**: `lite/main-lite.ts` (boot wiring), `lite/preload-lite.ts` (renderer bridge), `lite/menu/registry.ts` (menu item)
- **regression-replay fixture**: none yet -- E2E specs cover the surface

### chunk: settings-window-v1

- **status**: porting
- **plan reference**: ADR-031 in `lite/DECISIONS.md`
- **borrowed from full** (studied, not imported):
  - `settings.html:481-551` -- sidebar tab structure (lite uses a vertical scroll-list instead of tabs)
  - `settings.html:943-1026` -- two-factor UI shape, already migrated into `lite/totp/authenticator.{html,ts}` per ADR-027 and now relocating into `lite/settings/sections/two-factor.ts`
  - Single-instance window pattern from `lite/totp/window.ts` (deleted as part of this chunk) and `lite/bug-report/main.ts`
- **public surface**:
  - `lite/settings/api.ts` -- `SettingsApi`, `getSettingsApi()`, `_resetSettingsApiForTesting()`, `_setSettingsApiForTesting()`. No error class in v1 (failures inside the Two-Factor section bubble through `TotpError`).
  - `window.lite.settings.open()` (preload bridge) -- single method; opens or focuses the Settings window.
  - Menu entry: `Onereach.ai Lite -> Settings...` (id `app:settings`, no accelerator per ADR-015) under `top:app`, order 50 (between About at 0 and Quit at 100).
- **sections shipped in v1**: `two-factor` only. Mounts `mountTwoFactor(container)` from `lite/settings/sections/two-factor.ts` which consumes the unchanged `getTotpApi()` surface.
- **contracts**: `lite/settings/types.ts` (`SectionDescriptor`) -- not yet zod-wrapped (Phase 0b).
- **api conformance**: `lite/test/unit/settings-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['open']`.
- **error conformance**: N/A in v1 -- no Settings-specific error class.
- **unit tests**: `lite/test/unit/settings-api.test.ts`.
- **integration tests**: none in v1 -- the Settings shell is a thin BrowserWindow + IPC; the TOTP integration tests already cover the section's data path.
- **e2e tests**: deferred -- tracked as `settings-e2e` in deferred queue.
- **window.ts coverage**: manual smoke only in v1 (the BrowserWindow factory is the same shape as `lite/auth/window.ts` / the deleted `lite/totp/window.ts`).
- **failure modes covered**:
  - Open Settings twice -> single-instance focus instead of duplicate window
  - Two-Factor section fails to mount (e.g. `window.lite.totp` undefined) -> error banner inside the section, rest of Settings unaffected
  - All TOTP failure modes from `chunk: totp-authenticator-v1` continue to apply (the section is a transparent UI host)
- **observability**:
  - log span `settings.open` (start/finish)
  - structured event `settings.section-mounted` per section
  - all under `category=settings` on lite log server (port 47392)
- **deliberately not ported from full**:
  - Sidebar + tabs layout (full app's section count justifies tabs; lite v1 has 1 section)
  - Per-setting persistence layer (no Settings-owned state in v1; future sections will use `lite/kv/` under collection `lite-settings` if needed)
  - `Cmd+,` accelerator (ADR-015)
  - All non-Two-Factor sections (Account / Updates / Diagnostics / About land as follow-up chunks)
- **persistence**: none v1 -- TOTP secret is in keychain via `lite/totp/store.ts`. Settings has no own state.
- **consumers today**: `Onereach.ai Lite -> Settings...` menu entry; `window.lite.settings.open()` is the single bridge call.
- **deletes** (cleanup in this chunk):
  - `lite/totp/window.ts`
  - `lite/totp/authenticator.html`
  - `lite/totp/authenticator.css`
  - `lite/totp/authenticator.ts`
  - `openAuthenticator()` from `lite/totp/main.ts` `TotpHandle`
  - `tools:authenticator` + `top:tools` from `lite/menu/seed.ts`
  - `authenticatorOptions` esbuild entry + `authenticator.{html,css}` asset copies
- **regression-replay fixture**: none yet

### chunk: api-docs-window-v1

- **status**: porting
- **plan reference**: ADR-035 in `lite/DECISIONS.md`
- **borrowed from full**: none -- novel for lite
- **public surface**:
  - `lite/api-docs/api.ts` -- `ApiDocsApi`, `getApiDocsApi()`, `_resetApiDocsApiForTesting()`, `_setApiDocsApiForTesting()`. Single method: `open()` (idempotent; focuses existing window).
  - `window.lite.apiDocs.open()` (preload bridge) -- exposed so the Settings "Developer" section can deep-link.
  - IPC `lite:api-docs:open` (no payload) and `lite:api-docs:get-manifest` (returns the prebuilt manifest array).
  - No menu entry in v1 -- only reachable from `Settings -> Developer -> Open API Reference`. Future: surface in Help menu when external developers consume it.
- **manifest source-of-truth**:
  - `lite/api-docs/manifest-builder.ts` walks `lite/<module>/api.ts` + `events.ts` + `README.md` for every module that exposes a public API.
  - Output: `lite/api-docs/manifest.generated.ts` (TS module exporting `MANIFEST: ModuleDoc[]`). Generated; never hand-edited; gitignored is intentional but committed in v1 to make `npm install`-only consumers happy.
  - Run before esbuild via `lite:build:api-docs-manifest` (chained into `lite:build`).
  - **Drift policy**: a module without `api.ts` does not appear in the docs window. A module without `README.md` shows the API surface only. A module with mismatched JSDoc / interface shape generates a manifest entry with `surface: { incomplete: true, reason: '...' }` so the renderer flags it.
- **modules covered in v1** (all 7 with both `api.ts` and `README.md`): `kv`, `bug-report`, `auth`, `logging`, `neon`, `settings`, `totp`. Modules without typed APIs (`updater`, `menu`) appear in a "Without typed API" footer with a one-line note pointing at their inline event taxonomy.
- **renderer**:
  - `lite/api-docs/index.html` -- two-pane layout: sidebar with module list + filter, content pane with sticky module header + scrollable body.
  - `lite/api-docs/index.ts` -- loads bundled manifest, renders sidebar, renders content via `marked` (already a project dep at ^17.0.1), wires keyboard navigation (Arrow Up / Down / Home / End on sidebar tabs only -- per ADR-015 no accelerators).
  - `lite/api-docs/index.css` -- monospace for code blocks, sans for prose; matches `settings.css` palette.
- **contracts**: `lite/api-docs/types.ts` (`ModuleDoc`, `MethodDoc`, `EventDoc`) -- shared between the manifest builder and the renderer.
- **api conformance**: `lite/test/unit/api-docs-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['open']`.
- **error conformance**: N/A in v1 -- no API-docs-specific error class.
- **unit tests**:
  - `lite/test/unit/api-docs-api.test.ts` -- conformance contract.
  - `lite/test/unit/api-docs-manifest.test.ts` -- builder snapshot for known modules; asserts `kv`, `bug-report`, `auth`, `logging`, `neon`, `settings`, `totp` all appear, each with a non-empty `methods` array, and that `kv` lists `set`, `get`, `listKeys`, `list`, `delete`, `onEvent`.
- **integration tests**: none in v1 -- the manifest builder is pure (FS in, JSON out); covered by the unit snapshot.
- **e2e tests**: extend `lite/test/e2e/kernel-smoke.spec.ts` -- open Settings, click "Open API Reference", verify the new window opens with the expected modules in its sidebar.
- **failure modes covered**:
  - Open API Reference twice -> single-instance focus (same pattern as Settings / bug-report)
  - Manifest is empty / missing -> renderer shows "No API documentation found." with a help line pointing at `lite/api-docs/manifest-builder.ts`
  - Marked fails to parse a README -> the module's content pane shows a fallback `<pre>` with the raw markdown + a `console.warn`
  - Window closed while content is still rendering -> dispose guard in renderer cancels pending work
- **observability**:
  - log span `api-docs.open` (start/finish)
  - structured event `api-docs.module-viewed` per click on a sidebar entry
  - structured event `api-docs.filter-applied` when the filter changes (debounced)
  - all under `category=api-docs` on lite log server (port 47392)
- **deliberately not ported from full**:
  - Search across all module docs (filter narrows the sidebar; full-text search lands when there are >10 modules)
  - Versioned doc browsing (lite ships one version of itself; older docs live in git history)
  - Cross-module link resolution (markdown links between READMEs are rendered as plain anchors; clicking them opens the linked README in the same content pane only when the target module is known)
- **persistence**: none -- the docs window is stateless across app restarts.
- **consumers today**: Settings "Developer" section button. Future: Help menu entry, in-app onboarding.
- **regression-replay fixture**: none yet

### chunk: health-snapshot-v1

- **status**: hardened
- **plan reference**: ADR-036 in `lite/DECISIONS.md`; design plan at `~/.cursor/plans/health_snapshot_v1_*.plan.md`
- **borrowed from full** (studied, not imported):
  - `lib/health-monitor.js` -- high-level concept of an aggregating snapshot. Lite's version is far simpler (no SLI metrics, no rolling window) and tightly scoped to documented lite modules.
- **public surface**:
  - `lite/health/api.ts` -- `HealthApi`, `getHealthApi()`, `_resetHealthApiForTesting()`, `_setHealthApiForTesting()`, `makeHealthApi()`, `HEALTH_SCHEMA_VERSION`, plus all snapshot type re-exports.
  - `window.lite.health.snapshot()` (preload bridge) -- single method; returns `AppHealthSnapshot`.
  - IPC: `lite:health:snapshot` (no payload, returns `AppHealthSnapshot`).
  - No menu entry. Future Settings -> Diagnostics will be the canonical UI consumer.
- **contracts**: `lite/health/types.ts` (`AppHealthSnapshot` + 7 section subtypes + `HEALTH_SCHEMA_VERSION = 1`) -- not yet zod-wrapped (Phase 0b).
- **api conformance**: `lite/test/unit/health-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024) with `expectedMethods: ['snapshot']`.
- **error conformance**: N/A in v1 -- no Health-specific error class. The snapshot is best-effort and never throws.
- **unit tests**: `lite/test/unit/health-api.test.ts`, `lite/test/unit/health-store.test.ts`. Updated `lite/test/unit/bug-report-capture.test.ts` for the optional `healthSnapshot` payload field.
- **integration tests**: covered by the unit tests' stub-reader pattern (each section reader is independently injectable -- no real HTTP / FS / keychain to integration-test against).
- **e2e tests**: deferred -- tracked as `health-e2e` in deferred queue. The natural shape is the kernel-smoke spec asserting `window.lite.health.snapshot()` returns a well-shaped object with `auth.signedIn === false` after launch.
- **failure modes covered** (each exercised in `health-store.test.ts`):
  - `auth.getSession` / `getToken` throw -> `auth.signedIn = false`, `hasMultToken = false`
  - `totp.hasSecret` throws -> `totp.configured = false`, `hasCurrentCode = false`
  - `totp.getCurrentCode` throws while configured -> `configured = true`, `hasCurrentCode = false`, `secondsRemaining` omitted
  - `totp.getMetadata` throws while configured -> snapshot still includes `configured = true`, no `metadata`
  - `neon.status` throws -> `configured = false`, `ready = false`, `hasPassword = false`
  - `updater.read` throws -> `failedAttempts = 0`, `lastAttemptVersion = null`
  - `diagnostics.recent` throws -> counts `0`, no `lastError`
  - `BrowserWindow.getAllWindows` throws -> `windows: []`
  - Destroyed BrowserWindow inputs are tolerated (only `id` + `destroyed` are read)
- **observability**:
  - log warns under `category=health` when a section reader fails (best-effort; never logs secrets)
  - structured event `health.initialized` is implicit through the existing `app.boot` span when `initHealth` runs (no new event names introduced)
- **deliberately not ported from full**:
  - `lib/health-monitor.js` push-based mutable health record (rejected -- see ADR-036)
  - SLI metric rolling windows (overkill for v1)
  - Remote health upload (no telemetry endpoint in v1)
  - Settings -> Diagnostics UI (separate chunk)
  - Multi-environment auth (`edison` only in v1; type leaves room to widen)
- **persistence**: none -- every call re-reads from live state. A future feature that wants "snapshot at last shutdown" can opt in via `bug-report` or its own KV collection.
- **consumers today**:
  - `lite/bug-report/main.ts` `buildPayload` -> attaches `healthSnapshot` to every saved bug report
  - `lite/settings/sections/diagnostics.ts` -> Settings -> Diagnostics renders the snapshot as a definition-list panel with Refresh + Copy as JSON actions
  - `window.lite.health.snapshot()` for renderer / devtools
- **regression-replay fixture**: none yet

### chunk: totp-authenticator-v1

- **status**: porting
- **plan reference**: ADR-027 in `lite/DECISIONS.md`
- **borrowed from full** (studied, not imported):
  - `lib/totp-manager.js` -- TOTP code generation + otpauth URI parsing (rewritten in TS-strict)
  - `lib/qr-scanner.js` -- desktopCapturer + jsqr + BGRA->RGBA conversion (rewritten in TS-strict)
  - `credential-manager.js:512-572` -- TOTP keychain save/get/delete (rewritten in TS-strict; separate keychain service name `OneReach.ai-Lite-TOTP` per Rule 7)
  - `settings.html:943-1026` -- live-code + countdown UI shape (rewritten in TS, no jQuery)
- **public surface**:
  - `lite/totp/api.ts` -- `TotpApi`, `getTotpApi()`, `_resetTotpApiForTesting()`, `_setTotpApiForTesting()`, `TotpError`, `TOTP_ERROR_CODES`
  - `window.lite.totp` (preload bridge): `hasSecret()`, `saveSecret(secret)`, `scanQrFromScreen()`, `scanQrFromClipboard()`, `getCurrentCode()`, `deleteSecret()` -- secret value never round-trips back to renderer
  - Menu entry: `Tools -> Authenticator...` (id `tools:authenticator`, no accelerator per ADR-015) -- first child of the new `top:tools` placeholder
- **dependencies** (already in `package.json`, externalized in esbuild):
  - `otplib ^13.2.1` -- TOTP code generation (RFC 6238)
  - `jsqr ^1.4.0` -- QR decode from RGBA bitmap
  - `keytar ^7.9.0` -- already used by full; lite uses a separate service name
- **contracts**: `lite/totp/types.ts` (`TotpSecretMetadata`, `TotpCodeInfo`, `QrScanResult`) -- not yet zod-wrapped (Phase 0b)
- **api conformance**: `lite/test/unit/totp-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024)
- **error conformance**: `lite/test/unit/totp-errors.test.ts` runs `runErrorConformanceContract` for `TotpError`
- **unit tests**: `lite/test/unit/totp-{api,manager,store,errors}.test.ts` -- includes redaction assertion (no secret substring appears in log output)
- **integration tests**: `lite/test/integration/totp-integration.test.ts` -- save -> get-code round-trip with mocked keytar
- **e2e tests**: deferred -- tracked as `totp-authenticator-e2e` in deferred queue
- **window.ts coverage**: manual smoke only in v1 (the authenticator window factory is covered by the same shape as `lite/auth/window.ts`)
- **failure modes covered**:
  - Invalid Base32 secret -> `TOTP_INVALID_SECRET`
  - Keychain unavailable / save fails -> `TOTP_KEYCHAIN_FAILED`
  - `getCurrentCode()` called with no secret stored -> `TOTP_NO_SECRET`
  - QR scan finds no QR code -> `TOTP_NO_QR_FOUND`
  - QR scan finds non-otpauth URI -> `TOTP_NOT_AUTHENTICATOR_QR`
  - Screen-recording permission denied (macOS) -> caller sees friendly error + manual-entry fallback
  - otplib generation failure -> `TOTP_GENERATION_FAILED`
- **observability**:
  - log span `totp.save-secret`, `totp.scan-qr-screen`, `totp.scan-qr-clipboard`, `totp.get-code`
  - structured events: `totp.secret-saved`, `totp.secret-deleted`, `totp.qr-scanned` (no secret), `totp.code-generated` (the ephemeral code is fine to log; the secret is never logged)
  - all under `category=totp` on lite log server (port 47392)
  - **secret values NEVER logged** -- enforced by unit test
- **deliberately not ported from full**:
  - Auto-fill of the OneReach 2FA form (tracked as `auth-autofill`)
  - Settings-window placement -- DONE in `chunk: settings-window-v1` (ADR-031). The TOTP UI now lives as the Two-Factor section inside Settings; the standalone Tools -> Authenticator window has been removed.
  - Backup codes / recovery codes UI -- not implemented in full app either
- **persistence**:
  - Secret: OS Keychain via `keytar`, service `OneReach.ai-Lite-TOTP`, account `lite-totp-secret`
  - Metadata (issuer, account, savedAt): same keychain, service `OneReach.ai-Lite-TOTP-meta`, account `lite-totp-secret`
- **consumers today**: placeholder UI is unchanged; the new `Tools -> Authenticator...` menu entry opens the dedicated window.
- **regression-replay fixture**: none yet

### chunk: auth-signin-v1

- **status**: porting
- **plan reference**: ADR-026 in `lite/DECISIONS.md`
- **borrowed from full** (studied, not imported):
  - `multi-tenant-store.js:387-469` -- session cookie listener pattern
  - `multi-tenant-store.js:81-87` -- safe OneReach domain validation
  - `multi-tenant-store.js:573` -- environment extraction from cookie domain
  - `gsx-autologin.js:1063-1120` -- per-account session partition shape
- **public surface**:
  - `lite/auth/api.ts` -- `AuthApi`, `getAuthApi()`, `_resetAuthApiForTesting()`, `_setAuthApiForTesting()`, `AuthError`, `AUTH_ERROR_CODES`
  - `window.lite.auth` (preload bridge): `signIn(env)`, `signOut(env)`, `getSession(env)`, `hasValidSession(env)`, `onSessionChanged(cb)` -- token NOT exposed via IPC
  - Placeholder UI: `Sign in to GSX` button + signed-in state
- **contracts**: `lite/auth/types.ts` (`Environment`, `SUPPORTED_ENVIRONMENTS`, `EDISON_CONFIG`, `AuthSession`, `SignInOptions`) -- not yet zod-wrapped (Phase 0b)
- **api conformance**: `lite/test/unit/auth-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024)
- **error conformance**: `lite/test/unit/auth-errors.test.ts` runs `runErrorConformanceContract` for `AuthError`
- **unit tests**: `lite/test/unit/auth-{api,store,errors}.test.ts` -- includes redaction assertion (no token value substring appears in log output)
- **integration tests**: `lite/test/integration/auth-integration.test.ts` against `lite/test/harness/mocks/in-memory-kv-server.ts` with a fake `Electron.Session` cookie emitter
- **e2e tests**: deferred -- tracked as `auth-signin-e2e` in deferred queue (needs fake OneReach auth server)
- **window.ts coverage**: manual smoke only in v1 -- `lite/auth/window.ts` is exercised through end-to-end flows that require a real `BrowserWindow`. The integration tests cover `store.ts` against a fake session.
- **failure modes covered**:
  - User closes auth window without finishing -> `AUTH_CANCELLED`
  - Cookies arrive partially within timeout -> `AUTH_TIMEOUT` (default 5 min, configurable per call)
  - KV write fails after cookies arrive -> window closes, `signIn()` rejects with `AUTH_KV_FAILED`
  - `or` cookie JSON decode fails (URL-decode + JSON.parse) -> `AUTH_INVALID_COOKIE`
  - Unsupported env (anything other than `edison` in v1) -> `AUTH_UNSUPPORTED_ENV`
  - Concurrent `signIn(env)` calls -> coalesce on in-flight promise (no `AUTH_IN_FLIGHT` thrown; existing promise returned)
  - Existing valid session in partition -> probe on first `did-finish-load`, treat as immediate capture
  - Navigation outside `*.onereach.ai` -> deny in-window, route to `shell.openExternal`
- **observability** (ADR-030):
  - **Spans** (every async op): `auth.signIn` / `auth.signOut` / `auth.hydrate` (each emits `.start` / `.finish` / `.fail`)
  - **Coalesce event**: `auth.signIn.coalesced` -- when a concurrent `signIn(env)` call returns the in-flight promise rather than starting a new flow
  - **Sync-op event**: `auth.session.read` -- emitted from `getSession()` so reads are still observable (with `hasSession` boolean, no token value)
  - **IPC entry events**: `auth.ipc.sign-in` / `.sign-out` / `.get-session` / `.has-valid-session`
  - all under `category=auth` on lite log server (port 47392)
  - **token values NEVER logged** -- enforced by unit test that captures all log output and asserts no captured token substring
- **deliberately not ported from full**:
  - Form auto-fill (`credential-manager.js` + `auth-scripts.js`)
  - TOTP handling (`totp-manager.js`)
  - Account-picker auto-click (`gsx-autologin.js` account-selection)
  - Cross-partition token propagation (`multi-tenant-store.js` propagateToken)
  - `Authorization` header capture from network requests
  - Menu entry (deferred as `auth-menu-entry`)
- **persistence**: KV collection `lite-auth-sessions`, key `${environment}:${accountId}`, value shape `{environment, accountId, email?, capturedAt, expiresAt?}`. Raw `mult` token kept main-process-only in an in-memory `Map<Environment, AuthSession>`.
- **consumers today**: placeholder UI (sign-in button + signed-in state). Future ports (Spaces, IDW, help-agent) will read the token via `getAuthApi().getToken('edison')` from main.
- **regression-replay fixture**: none yet

### chunk: app-test-harness

- **status**: hardening
- **plan reference**: `.cursor/plans/lite_auto-updater_+_harness_*.plan.md` (ADR-023)
- **borrowed from full**: `test/e2e/helpers/electron-app.js` (shape only -- launch/close, log-server snapshot, isolated userData). Lite's variant is narrower (no Spaces/Exchange/AI cost helpers -- lite kernel doesn't have those services).
- **public surface**:
  - `lite/test/harness/index.ts` -- general harness barrel
  - `lite/test/harness/updater/index.ts` -- updater-specific scenarios barrel
- **modules**:
  - General: `launch.ts`, `menu.ts`, `windows.ts`, `log-server.ts`, `userdata.ts`
  - Updater: `server.ts` (local HTTP), `fixtures.ts` (YAML + app builders), `dev-config.ts` (dev-app-update.yml injection), `scenarios.ts` (composed flows)
- **contracts**: TypeScript interfaces only (no IPC; harness runs in test process)
- **unit tests**: harness modules don't have their own units -- they're exercised transitively by every consumer spec
- **integration tests**: `lite/test/integration/updater/boot-wiring.test.ts` is the first harness consumer
- **e2e tests**: `lite/test/e2e/kernel-smoke.spec.ts` (refactored) + all `lite/test/e2e/updater/*.spec.ts`
- **failure modes covered**:
  - Missing built lite app -- skip gracefully via `testInfo.skip(true, ...)`
  - Tempdir cleanup on close (handle tracks ownership)
  - Force-kill fallback if graceful close hangs
  - clearUserData refuses non-test paths (defensive)
- **observability**:
  - `LiteLogServerClient.snapshot()` / `errorsSince()` for asserting no new errors
  - `getMenuStructure()` returns the full menu shape for assertions
- **deliberately not ported from full**:
  - Spaces / Task Exchange / AI cost helpers (lite kernel lacks these services)
  - Benign-error pattern list is much smaller (lite has fewer noisy boot paths)
- **consumers today**: `lite/test/e2e/kernel-smoke.spec.ts` (refactored), all `lite/test/integration/updater/*.test.ts`, all `lite/test/e2e/updater/*.spec.ts`
- **regression-replay fixture**: not applicable -- harness is test infrastructure, not user-facing
- **READMEs**: `lite/test/harness/README.md`, `lite/test/harness/updater/README.md`

## Hardened Ports

Ports that have passed the six-criteria contract and are stable:

### chunk: logging-module

- **status**: hardened
- **plan reference**: in-session plan -- centralized event logger (ADR-025)
- **borrowed from full**: pattern only -- inspired by full's logging conventions in `lib/log-event-queue.js`. The lib queue itself is shared between apps; lite wraps it behind its modular API.
- **public surface**: `lite/logging/api.ts` -- `LoggingApi` interface (debug/info/warn/error + event/start + onEvent/recent), `getLoggingApi()` singleton, `_resetLoggingApiForTesting()`, `_setLoggingApiForTesting()`. Re-exports `LoggingError`, `LOGGING_ERROR_CODES`, `Span`, `EventRecord`, `LiteError`.
- **internal**:
  - `lite/logging/store.ts` -- `LoggingStore` (wraps lib LogEventQueue, owns local ring buffer + subscriber set), `LoggingError`. `@internal` JSDoc.
  - `lite/logging/events.ts` -- `Span`, `EventRecord`, `matchPattern` (glob matcher), `serializeError`. Re-exported via api.ts.
- **contracts**: none yet (no IPC schemas; main-process module with renderer-side bridge in preload-lite.ts).
- **api conformance**: `lite/test/unit/logging-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024).
- **error conformance**: `lite/test/unit/logging-api.test.ts` runs `runErrorConformanceContract` for `LoggingError` (codes follow `LOGGING_*` SCREAMING_SNAKE).
- **unit tests**:
  - `lite/test/unit/logging-api.test.ts` -- 35 tests (15 conformance contract + 10 error conformance + 18 module-specific: log routing, events, spans, onEvent, recent, validation throws).
  - `lite/test/unit/logging-events.test.ts` -- 16 tests (matchPattern across all glob shapes, serializeError variants, Span lifecycle + idempotency).
- **integration tests**: `lite/test/integration/logging-flow.test.ts` -- 8 tests against a real `LoggingStore` writing to a `FakeQueue`, with cross-module flows (bug-report + KV routing logs through the central queue, span around real save).
- **e2e tests**: none direct -- main-process module exercised transitively via kernel-smoke when the modal is filed (events appear in `recentLogs`).
- **harness layer**: `lite/test/harness/mocks/fake-logging.ts` -- `FakeLogging implements LoggingApi`. Used by tests that want to assert "this code emitted X events" without standing up the real queue.
- **migration impact**: bug-report, KV, and auth `defaultConfig()` switched from `console.log` to `getLoggingApi()`. Their internal `[bug-report-store]` / `[kv]` / `[auth]` events now appear in the lite log queue (port 47392) and are auto-captured into bug reports via `recentLogs`. Per ADR-030, every module's async ops also wrap in `<module>.<op>.start` / `.finish` / `.fail` spans.
- **events emitted by the logging module itself**: subscriber-callback failures emit `logging` warnings (subscriber throw isolation). The module also serves as the transport for every other module's events.
- **failure modes covered**: invalid event name (whitespace / empty), invalid pattern, subscriber throw isolation, span double-finish/fail idempotency, queue write failure (silent fallback for log methods).
- **observability**: every event mirrored to the lib queue with structured `data: { eventName, spanId, parentSpanId, durationMs, error }`. Visible at `/logs?category=<module>` HTTP endpoint and on the WebSocket stream. Local ring buffer (1000 events) for `recent()`.
- **deliberately not ported from full**: log shipping to a remote service, durable persistence beyond the existing in-memory ring buffer, automatic span instrumentation via decorators or proxies, renderer-side spans (renderers emit paired instant events), structured `recentEvents` array on the bug-report payload (deferred -- recentLogs already captures events through the queue mirror).
- **regression-replay fixture**: none yet.
- **consumers today**: `lite/main-lite.ts` (boot logs + IPC), `lite/bug-report/api.ts` (defaultConfig logger), `lite/kv/api.ts` (defaultConfig logger), `lite/preload-lite.ts` (renderer bridge).

### chunk: kv-module

- **status**: hardened
- **plan reference**: `.cursor/plans/promote_kv_to_lite_module_*.plan.md` (ADR-020)
- **borrowed from full**: none -- net-new module that wraps the Edison KV HTTP flow. Schema lifted from the OneReach KeyValue Storage API Guide (URL embedded in `lite/kv/client.ts` header).
- **public surface**: `lite/kv/api.ts` -- `KVApi` interface, `getKVApi()` singleton, `_resetKVApiForTesting()`, `_setKVApiForTesting()`. Re-exports `KVError`, `KV_ERROR_CODES`, `KVRecord`, `KVConfig`.
- **internal**: `lite/kv/client.ts` -- `EdisonKVClient` (HTTP wrapper, timeouts, abort, structured errors). `@internal` JSDoc.
- **contracts**: none yet (no IPC surface; main-process-only). Phase 0b's `schema-first-ipc` chunk will add zod schemas if a renderer-facing surface is ever needed.
- **api conformance**: `lite/test/unit/kv-api.test.ts` runs `runApiConformanceContract` (Rule 12 / ADR-024).
- **error conformance**: covered by `lite/test/unit/errors.test.ts`; could also run `runErrorConformanceContract` for KVError specifically as a follow-up.
- **unit tests**:
  - `lite/test/unit/kv-client.test.ts` -- 20 tests, internal class, HTTP-contract level (PUT/GET/POST/DELETE shape, JSON wrapping, "No data found" sentinel, timeouts, logger).
  - `lite/test/unit/kv-api.test.ts` -- 9 tests, public-singleton level + collection isolation + FakeKV failure injection.
- **integration tests**: `lite/test/integration/kv-integration.test.ts` -- 16 tests against the in-memory KV server (real PUT/GET/POST/DELETE wire format, status-specific remediation, timeout via injected delay, server-inspection of recorded requests).
- **e2e tests**: none direct -- main-process-only module with no UI surface. Bug-reporter's E2E (`lite/test/e2e/kernel-smoke.spec.ts`) exercises the module transitively.
- **harness layer**: none -- KV is a leaf module with no UI, no end-to-end flows. The in-memory server in `lite/test/harness/mocks/in-memory-kv-server.ts` IS the harness for KV consumers; it lives in the general harness because every future KV consumer will use it.
- **failure modes covered**: network timeout, non-2xx response (with status-specific remediation for 401/403/404/429/5xx), malformed JSON body, "No data found" sentinel, abort/cancel, per-key get failure during `list()`.
- **events**: Every op emits `kv.<op>.start` / `.finish` / `.fail` spans through `getLoggingApi()` (ADR-030). Span correlation IDs propagate through the lib queue so consumers can stitch `kv.set.start` → `kv.set.finish` for duration tracking.
- **observability**: structured logger (`[kv]` tag) emits `info|warn|error` events on every op with collection/key/status/timeout. Default config in `api.ts` wires console; consumers can override.
- **deliberately not ported from full**: nothing -- net-new module.
- **regression-replay fixture**: none yet (would be added the first time a real KV regression is observed in production).
- **consumers today**: `lite/bug-report/store.ts` (collection: `lite-bugs`).

### chunk: lite-kv-via-sdk

- **status**: hardened
- **plan reference**: `.cursor/plans/lite_kv_via_sdk_*.plan.md`
- **borrowed from full**: `lib/edison-sdk-manager.js:298-308` -- the SDK construction shape (token getter + discoveryUrl + accountId). Studied, not imported (Rule 1).
- **public surface (new)**: `lite/discovery/api.ts` -- `DiscoveryApi`, `getDiscoveryApi()`, `_resetDiscoveryApiForTesting()`, `_setDiscoveryApiForTesting()`, `_buildDiscoveryApiForTesting()`. Re-exports `DiscoveryError`, `DISCOVERY_ERROR_CODES`, `DiscoveryService`. Wraps `@or-sdk/discovery`.
- **public surface (changed)**: `lite/kv/api.ts` -- same `KVApi` interface; `getKVApi()` now returns an `SdkKVClient` instance instead of an `EdisonKVClient`. The legacy `EdisonKVClient` remains exported for the one-shot migration path only.
- **internal**:
  - `lite/discovery/store.ts` -- `DiscoveryStore` SDK wrapper + 5-minute resolve cache. `@internal`.
  - `lite/kv/sdk-client.ts` -- `SdkKVClient` thin wrapper around `@or-sdk/key-value-storage`. Re-creates the SDK when the active accountId changes. `@internal`.
  - `lite/kv/migration.ts` -- one-shot copy on first sign-in: `runKvMigration(accountId)` reads `lite-idw-entries`, `lite-main-window-tabs`, `lite-neon-config`, `lite-ai-config` from the legacy anonymous KV (per-account `edison:<accountId>` first, then global `default` fallback) and copies into the user's authenticated KV at `default`. Idempotent via `lite-migrations / migrated-from-default-v1` sentinel.
  - `lite/auth/types.ts` -- new `EnvironmentConfig.discoveryUrl` field (Edison: `https://discovery.edison.api.onereach.ai`).
- **gating added (defense in depth)**: `lite/idw/store.ts`, `lite/main-window/store.ts`, `lite/bug-report/store.ts`, `lite/neon/credentials.ts`, `lite/ai/credentials.ts` -- each accepts a `getActiveAccountId` resolver in its config; reads return empty / writes throw a clear "sign in first" error when no active account. Wired in each module's `api.ts` to `getAuthApi().getSession('edison')?.accountId ?? null`.
- **redundant prefix removed**: yesterday's interim fix added an `edison:<accountId>` KV key prefix to `lite/idw/store.ts` and `lite/main-window/store.ts`. The SDK now scopes per-account server-side, so the client-side prefix is unnecessary; both stores are back to the singleton `'default'` key. Per-user isolation is now enforced by the auth token + accountId on the SDK request, not by the key name. The signed-in gating stays.
- **api conformance**: `lite/test/unit/discovery-api.test.ts` runs `runApiConformanceContract`. KVApi conformance test was already in place and continues to pass against the new client.
- **unit tests**:
  - `lite/test/unit/discovery-api.test.ts` -- 14 tests (conformance + caching + error mapping + signed-out gate).
  - `lite/test/unit/sdk-kv-client.test.ts` -- 8 tests (set/get/listKeys/list delegation, signed-out 401, account-switch SDK rebuild).
  - `lite/test/unit/kv-migration.test.ts` -- 9 tests (idempotency, per-account → global fallback, no-overwrite when user already has data, partial-failure tolerance).
- **integration tests**: `lite/test/integration/kv-integration.test.ts` -- rewritten to drive `SdkKVClient` against a fake SDK that mimics `@or-sdk/key-value-storage`'s wire-format (round-trip, per-account isolation, signed-out gating, SDK error mapping).
- **e2e tests**: none direct -- exercised transitively via signing in then opening tabs / IDWs in `lite/test/e2e/kernel-smoke.spec.ts`.
- **failure modes covered**: signed-out reads (return null/empty), signed-out writes (throw `KV_HTTP` 401), 401/403 server response (token expired remediation), 404 on get (treated as null), 5xx (rate-limit / server error remediation), network failure, account switch mid-session (SDK rebuilt, cache invalidated).
- **events**: KV ops still emit `kv.<op>.start/.finish/.fail` (unchanged). Discovery emits `discovery.resolve.start/.finish/.fail`, `discovery.list.start/.finish/.fail`, `discovery.cache.hit`. Both modules use the central `getLoggingApi()` event surface.
- **observability**: structured logger tags `[kv]` and `[discovery]`; cold-start cost paid once per service per session (cache TTL 5 min); accountId switches log a re-construct line.
- **deliberately not ported from full**: `lib/edison-sdk-manager.js`'s broader SDK orchestration (sdk reuse caching across many services, per-feature config). Lite uses just `@or-sdk/discovery` and `@or-sdk/key-value-storage` for now; future SDKs (`@or-sdk/flows`, `@or-sdk/users`, etc.) port one-by-one through `lite/discovery/api.ts`.
- **regression-replay fixture**: none yet (would be added if a real KV regression escapes to production).
- **migration outcome**: existing pilot installs preserve their IDWs / tabs / Neon config / AI key on first sign-in after this update. Per-user isolation is now enforced server-side; multi-user leakage (the bug Rich hit on his fresh clone) cannot recur.
- **consumers today**: `lite/bug-report/store.ts`, `lite/idw/store.ts`, `lite/main-window/store.ts`, `lite/neon/credentials.ts`, `lite/ai/credentials.ts`. All gate on `getActiveAccountId`; signed-out users see graceful empty states or "sign in first" errors instead of leaking other users' data.

### chunk: lite-files-v1

- **status**: hardened
- **plan reference**: ADR-045 in [`DECISIONS.md`](DECISIONS.md)
- **borrowed from full**: `lib/edison-sdk-manager.js:349-358` -- the SDK construction shape (token getter + discoveryUrl + accountId). Studied, not imported (Rule 1).
- **public surface (new)**: `lite/files/api.ts` -- `FilesApi`, `getFilesApi()`, `_resetFilesApiForTesting()`, `_setFilesApiForTesting()`, `_buildFilesApiForTesting()`, `setFilesAuthBindings()`. Re-exports `FilesError`, `FILES_ERROR_CODES`, `FilesItem`, `FilesContent`, content + option types.
- **internal**:
  - `lite/files/sdk-client.ts` -- `SdkFilesClient` thin wrapper around `@or-sdk/files`. Re-creates the SDK when the active accountId changes (mirrors `SdkKVClient`). `@internal`.
  - `lite/files/types.ts` -- `FilesItem` + option shapes.
  - `lite/files/errors.ts` -- `FilesError` + 7-code catalog.
  - `lite/files/events.ts` -- typed event surface (24 events: upload/download/get/list/delete/createFolder/ttl.set/privacy each with start/finish/fail).
- **consumer integrations**:
  - `lite/bug-report/` -- new `attach()` + `downloadAttachment()` IPCs (`lite:bug-report:attach` / `lite:bug-report:download-attachment`). Renderer picks a file -> base64 over IPC -> main uploads via Files at `lite-bugs/attachments/staging-<ts>/<safeName>` (private, 10MB cap, sanitized filename, prefix-locked download). Payload schema gains optional `attachments?: BugReportAttachment[]` carrying file references (`{key, name, contentType, size, uploadedAt}`); `BugReportSummary.attachmentCount` exposes the count for the modal list view. Legacy payloads without attachments deserialize unchanged via `migrateLegacyPayload`.
  - `lite/ai-run-times/` -- new `cached-tts` IPC (`lite:ai-run-times:cached-tts`). Renderer-driven TTS chunks now check Files first by deterministic key (`ai-run-times/tts/<articleId>/<voice>-<sha1(text)>.mp3`) and replay from cache when present. On miss, generates via the AI module and uploads with a 30-day TTL so re-listening doesn't burn OpenAI credits. Best-effort cache write -- upload failures don't block audio delivery.
- **wiring**: `setFilesAuthBindings` is called from `main-lite.ts` immediately after `setKVAuthBindings` (after `initAuth` completes). The binding is read lazily on every Files op, so it always reflects the current sign-in state.
- **api conformance**: `lite/test/unit/files-api.test.ts` runs `runApiConformanceContract` against the 11 expected methods.
- **unit tests**:
  - `lite/test/unit/files-api.test.ts` -- 20 tests (conformance + behavior + error mapping + auth binding).
  - `lite/test/unit/bug-report-capture.test.ts` -- 4 new tests (capture forwards attachments; migrateLegacyPayload preserves valid attachments + drops malformed entries; attachments-omitted payload).
  - `lite/test/unit/bug-report-store.test.ts` -- 1 new test (summary's `attachmentCount` reflects payload).
- **integration tests**: `lite/test/integration/files-integration.test.ts` -- 12 tests (upload + getDownloadUrl round-trip, get returns null for missing, list/delete, per-account isolation, signed-out gating, rewrite vs prevent-rewrite, TTL add/update/clear, privacy flip).
- **e2e tests**: none direct -- exercised transitively via bug-report and ai-run-times. A future `bug-report-attachments-e2e` Playwright spec would round-trip an attachment against the live OneReach Files endpoint.
- **failure modes covered**: signed-out reads/writes (return null / throw `FILES_NOT_AUTHENTICATED`), 401/403 (token expired remediation), 404 on get/delete (soft-fail to null/no-op), 409 on prevent-rewrite (`FILES_ALREADY_EXISTS`), 413 on oversize upload (`FILES_TOO_LARGE`), 5xx (server error remediation), network failure, invalid input (empty key/name).
- **events**: 24 events emitted via `getLoggingApi()` -- one start/finish/fail per op (upload, download, get, list, delete, createFolder, ttl.set, privacy.change).
- **observability**: structured logger tags `[files]`; SDK rebuild on accountId switch logs a re-construct line; cache hits/misses logged at info level for the AI Run Times TTS cache.
- **deliberately not ported from full**:
  - `@or-sdk/files-sync-node` (the `gsx-file-sync.js` "mirror a folder" engine) -- different mental model, no in-app consumer yet, deferred to `lite-files-sync-v1` chunk.
  - The SDK's deprecated `uploadFile` / `getUploadUrl` / `uploadSystemFileV2` legacy variants -- v1 uses only the modern `*V2` / `*V3` shapes.
  - Renderer-direct `window.lite.files.*` IPC bridge -- v1 keeps the module main-process only; renderer consumers go through their own module's IPC (e.g. bug-report's `attach` handler) so per-IPC validation / size caps / prefix locks live in one place per consumer.
- **regression-replay fixture**: none yet.
- **consumers today**: `lite/bug-report/main.ts` (attach + downloadAttachment), `lite/ai-run-times/main.ts` (cached-tts).

### chunk: oauth-popups

- **status**: ported
- **plan reference**: ADR-046 in `lite/DECISIONS.md`
- **borrowed from full** (studied or reused as noted):
  - `main.js:182-218` `shell.openExternal` override pattern -- studied; the inverse problem (we want SOME popups in-app, not all out).
  - `lib/gsx-autologin.js:1063-1120` per-account session partition shape -- the `partition` shape Lite already adopted for the auth window.
- **public surface**:
  - `lite/auth/oauth-popup.ts` -- `OAUTH_POPUP_ALLOWLIST`, `isOAuthPopupUrl(url)`, `buildPopupHandler({partition, logger, extraAllowPredicate, source, shellOpenExternal})`, `attachPopupLifecycle(parent, popup, opts)`. Test seam: `shellOpenExternal` override.
  - Three popup-aware contexts wired: `lite/auth/window.ts` (auth window with extra `*.onereach.ai` predicate), `lite/main-window/window.ts` (per-tab partition inheritance), `lite/idw/browser-window.ts` (placeholder fallback).
- **api conformance**: not applicable -- this is a helper, not a singleton API.
- **error conformance**: not applicable.
- **events conformance** (ADR-032): emits structured log events via the optional `logger` callback (info on allow / deny, with origin + partition + source).
- **unit tests** (1 file, 13 tests): `lite/test/unit/oauth-popup.test.ts` -- `isOAuthPopupUrl` truth table, `buildPopupHandler` allow / deny shape, `extraAllowPredicate` short-circuit, defense-in-depth (javascript: still denied even though not on the allowlist).
- **failure modes covered**:
  - Subdomain match (e.g. `tenant.auth0.com`) -- allowed
  - Substring-style spoof (e.g. `accounts.google.com.evil.com`) -- denied (correct behavior verified by test)
  - Malformed URL -- denied
  - non-http(s) scheme (`javascript:`, `file:`) -- denied
- **observability**:
  - log events (via injected logger): `oauth-popup: allowed in-app child window` (info; reason: `extra-predicate` or `oauth-allowlist`), `oauth-popup: routed to OS default browser` (info)
- **persistence**: none (helper only); the partition string flows from the caller.
- **forward-compat**:
  - **Per-IDW partitions in placeholder**: when ADR-037's deferred per-IDW partition split lands, `buildPopupHandler` already takes the partition as a parameter -- no change needed in the helper.
  - **Bearer-only IdPs (ADR-040 A2)**: a future bearer-token IdP that needs popup messaging slots into the allowlist with a one-line edit.
- **deliberately not ported from full**:
  - Allow-all popups (rejected for security)
  - Custom OAuth window chrome (popups use Electron's default)
- **consumers today**: `lite/auth/window.ts`, `lite/main-window/window.ts`, `lite/idw/browser-window.ts`.

### chunk: first-run-ux-hardening

- **status**: ported
- **plan reference**: ADR-046 in `lite/DECISIONS.md`
- **borrowed from full** (studied or reused as noted):
  - Full app's auth window doesn't have a 2FA-needs-setup banner -- the Lite chunk introduces this pattern proactively.
  - Onboarding pattern is Lite-native; full app uses a setup-wizard.html that's much heavier.
- **public surface**:
  - `lite/onboarding/api.ts` -- `OnboardingApi` (`load`, `markComplete`, `dismiss`, `onChange`); 4-step `OnboardingStepId` union.
  - `window.lite.onboarding` (preload bridge): `load`, `markComplete`, `dismiss`.
  - `window.lite.auth.on2FANeedsSetup(handler)` -- new bridge method on the existing auth surface.
  - `lite:auth:2fa-needs-setup` IPC broadcast (one-per-watcher dedupe).
- **contracts**: `lite/onboarding/types.ts` (`OnboardingState`, `OnboardingStepId`).
- **api conformance**: not yet -- onboarding is small enough to skip the full conformance harness for v1.
- **events conformance**: no module-specific events (uses the auth event surface).
- **unit tests** (4 files, 29 tests):
  - `lite/test/unit/oauth-popup.test.ts` (13 tests; under chunk: oauth-popups)
  - `lite/test/unit/onboarding-store.test.ts` (11 tests) -- KV persistence, idempotent markComplete, dismiss, reset, listener isolation
  - `lite/test/unit/auth-twofa-needs-setup.test.ts` (4 tests) -- 2FA-needs-setup fires on detection + NO_SECRET, NOT on success, NOT on non-2FA pages, exactly once per watcher
  - `lite/test/unit/settings-deep-links.test.ts` (1 lint test) -- scans renderer surfaces for unscoped `settings.open()` calls; guards against the bug where contextual links dropped users on Account
- **failure modes covered**:
  - 2FA detected + no secret -> banner (not silent)
  - AUTH_CANCELLED -> banner ("ready to try again", not silent)
  - Two-Factor link -> deep-links to the right section (not Account)
  - AI Run Times Listen without key -> banner before the click (not toast after)
  - OAGI returns malformed rows -> distinct empty state ("missing required fields", not "no agents yet")
  - Multi-listener on onChange -- isolated; one bad listener doesn't break others
- **observability**:
  - log events: `2fa-needs-setup broadcast` (auth), `oauth-popup: allowed/routed` (auth)
  - new IPC channel: `lite:auth:2fa-needs-setup`, `lite:onboarding:{load, mark-complete, dismiss}`
- **persistence**: KV collection `lite-onboarding`, key `default`. Single blob: `{schemaVersion, completedAt: Partial<Record<StepId, string>>, dismissedAt: string | null}`.
- **forward-compat**:
  - **Add new checklist steps**: append to `ONBOARDING_STEP_IDS`; existing entries' completion state survives.
  - **Per-account onboarding state**: today's blob is per-device; if needed, add `accountId` to the KV key.
  - **More 2FA-needs-X notifications**: same pattern can fire `lite:auth:account-picker-needs-attention` etc.
- **deliberately not ported from full**:
  - First-run setup wizard (`setup-wizard.html`) -- Lite's checklist card is the lighter-weight equivalent.
  - Tooltips / coach-marks tour -- considered, deferred (not on roadmap).
- **consumers today**: `lite/main-window/chrome.ts` (renders the checklist + reads `on2FANeedsSetup`), `lite/placeholder.ts` (reads `on2FANeedsSetup`).

## Deferred Queue

Pending ports, ordered roughly by likely value but not committed:

- bug-reporter-screenshot-capture
- bug-reporter-spaces-write-path
- shell-window-vue-tabs (introduces Vue 3 + Vite; required before content-tab ports)
- spaces-tab-readonly
- idw-tab-crud
- tools-manager-window
- dynamic-menu-builder-extensions
- help-agent-port (first AI-using port; per-app AI accounting from 0b kicks in here)
- GSX window content
- Image / Video / Audio creator categories
- External bots
- UI design tools
- GSX API docs submenu
- GSX File Sync submenu
- updater-status-banner -- renderer UI consuming the `window.updater.onStatus` event stream
- backup-restore-ui -- Help -> Manage Backups submenu (restore-script generator + folder reveal); hold until pilot demands rollback
- auth-signin-e2e -- Playwright spec for the auth sign-in flow against a fake OneReach auth server harness (would need a hermetic local server that mimics `auth.edison.onereach.ai` redirect + cookie set)
- auth-menu-entry -- `app:sign-in` menu item under top:app with a label flip ("Sign in to GSX..." vs "Sign out of GSX")
- auth-autofill-email-password -- credential-manager port + email/password form fill into the OneReach auth window. TOTP-only autofill is active as `chunk: auth-totp-autofill-v1`.
- auth-multi-account -- multi-account picker UI in Lite (one button -> picker -> per-account sign-in)
- auth-multi-env -- enable staging/dev/production environments behind the `Environment` type union
- totp-authenticator-e2e -- Playwright spec that opens Settings, asserts the Two-Factor section renders a code, advances time, asserts countdown
- settings-e2e -- Playwright spec that opens Settings via the menu, asserts the Two-Factor section renders, asserts single-instance focus on second open

You pick the next port at each release-tag boundary based on what's most needed.
