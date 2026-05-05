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
before promoting this module out of WIP.

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
