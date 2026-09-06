# lite/main-window -- main window + tab store

Public surface: `getMainWindowApi()` from `./api.ts`. Renderer
surface: `window.lite.mainWindow` (under construction).

This module owns the Lite main window's `BrowserWindow` factory
and a per-tab persistence store. Tabs persist to KV (per
`./store.ts`) so the user's open tabs survive restart.

Status: **work in progress** -- this README is a stub kept in
place so the api-docs manifest test (`api-docs-manifest.test.ts`)
keeps passing while the module's public surface stabilizes. Add
the full design notes (error catalog, events, partitions, etc.)
before promoting this module out of WIP. (Done 2026-08-07 — public API below.)

## Sketch

| Method | Purpose |
|---|---|
| `openTab(input)` | Create a new tab, persist it, broadcast `lite:main-window:changed` |
| `closeTab(id)` | Remove a tab by id |
| `activateTab(id)` | Mark a tab active |
| `listTabs()` | All tabs in display order |
| `getActive()` | Currently-active tab id |
| `goHome()` | Activate the home tab |

## Errors (from `./errors.ts`)

- `MAIN_WINDOW_NOT_FOUND` -- tab id doesn't exist
- `MAIN_WINDOW_DUPLICATE_PARTITION` -- attempted to open two tabs with the same persistent partition
- `MAIN_WINDOW_INVALID_URL` -- non-http/https URL passed to `openTab`
- `MAIN_WINDOW_INVALID_INPUT` -- malformed payload
- `MAIN_WINDOW_PERSISTENCE_FAILED` -- KV write failed

## File layout

```
lite/main-window/
  README.md   (this file -- stub)
  api.ts      PUBLIC -- MainWindowApi singleton
  errors.ts   INTERNAL -- MainWindowError
  events.ts   INTERNAL -- MAIN_WINDOW_EVENTS
  main.ts     INTERNAL -- initMainWindow(): IPC handlers + window factory wiring
  store.ts    INTERNAL -- TabStore, KV-backed
```

Per Rule 11, **only `api.ts` is importable from other modules.**

## Public API (2026-08-07)

Per ADR-019 / Rule 11, consumers import ONLY from `api.ts`
(`getMainWindowApi()`), never internal files.

- `createMainWindow(config)` — factory (boot-time, `main.ts` owns the
  call). Config carries `chromeHtmlPath` + `preloadPath`.
- `getMainWindowApi().openTab(entry)` / `closeTab(id)` /
  `activateTab(id)` / `listTabs()` / `getActive()` — tab orchestration
  over `WebContentsView`s. IDW tabs get stable `persist:idw-<id>`
  partitions; ad-hoc tabs `persist:tab-<uuid>` (ADR-038: no preload on
  tab views).
- `goHome()` / `reloadActive()` — Home-pill + refresh behavior.
- Content tone (2026-09-01): the tab bar is the window header (macOS
  `titleBarStyle: 'hiddenInset'`, traffic lights inset) and wears the
  colour of the content under it. `window.ts` samples a 6px strip of the
  active view's top edge (`webContents.capturePage`) after each load, on
  in-page navigations, on a declared `theme-color`, and every 4s while
  visible; `content-tone.ts` (pure) turns the pixels into
  `{ tone, color }`; the chrome receives it over
  `lite:main-window:content-tone` (preload: `mainWindow.onContentTone`)
  and paints the bar in that colour with `--or-tone-*-ink-rgb` ink.
  `tone: null` (boot chat under the bar) = theme colours.
- IPC `lite:main-window:homeUrl:get|set` (preload:
  `window.lite.homeUrl`) — the configurable Home-tab URL
  (`home-url-store.ts`; default = the GSX Expert IDW since 2026-09-06;
  earlier defaults stored by Save read as the current default;
  `{accountId}` placeholder substitution; Settings → Home is the UI).
- Home-tab modes: default remote page → `LITE_HOME=learn` (local
  Learning Center) → `=feed` (legacy IDW feed) → `=chrome` (boot-chat).

Window rescue is NOT this module: `lite/window-rescue.ts` owns
reachability (auto-sweep on show + app-menu "Bring Windows Into
View"); this module only needs to never fight its bounds corrections.
Edge cases stay covered by `test/unit/window-rescue.test.ts` (16
tests, real observed coordinates).

**Popups and the user agent (ADR-096).** A popup's first document loads before `did-create-window` can set a UA; `app.userAgentFallback` (main-lite) is the Chrome string, so popups present Chrome from their first request. `did-create-window` logs one `popup created` line with the session match and the UAs.
