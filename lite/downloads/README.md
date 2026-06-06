# lite/downloads

Captures every `will-download` event and offers the user a choice:

1. **Save to Downloads** — drops the file into the OS Downloads folder.
   Same behaviour as the default Electron handler.
2. **Save to Space** — opens a small picker window, then uploads the
   captured bytes via `getFilesApi().upload(...)` and creates a matching
   `:Asset` in the picked Space via `getSpacesApi().items.create({...})`.
3. **Cancel** — `item.cancel()`.

Mirrors the full app's `handleDownloadWithSpaceOption` (`browserWindow.js`)
behaviour but writes to the Neon graph + Files bucket instead of the
clipboard-manager-v2-adapter local store. ADR-019 / Rule 11 applies:
peer modules import only from [`api.ts`](api.ts).

## Module layout

| File              | Role |
|-------------------|------|
| `api.ts`          | Public surface (`getDownloadsApi`, `DownloadsApi`). Rule 11 boundary. |
| `main.ts`         | `initDownloads()` orchestrator. Attaches `will-download`, registers IPC. |
| `handler.ts`      | The 3-button dialog + upload + asset-create flow. |
| `picker-window.ts`| Single-instance picker BrowserWindow factory + lifecycle. |
| `picker.ts`       | Bundled renderer that runs inside the picker window. |
| `picker.html` / `picker.css` | UI scaffold + dark-theme styles. |
| `ipc.ts`          | `lite:download-picker:bootstrap` + `:resolve` channels. |
| `types.ts`        | Shared types (`CapturedDownload`, `PickerBootstrap`, ...). |
| `mime.ts`         | Pure helpers: MIME → ItemKind, sanitizeFileName, storage-key composer. |

## Boot wiring

`lite/main-lite.ts` calls `initDownloads({ pickerHtmlPath, preloadPath, getParentWindow, logger })`
after the main window exists. The downloads orchestrator:

- registers `lite:download-picker:bootstrap` + `:resolve` on `ipcMain`
- attaches `will-download` to `session.defaultSession`
- publishes the live api singleton via `_setDownloadsApiForTesting`

When new per-tab partitions are created at runtime, call
`getDownloadsApi().attachToSession(s)` to wire them too.

## Picker UX

Window:
- 420×540, no menu bar, application-modal, centered on parent.
- Header: "Save to Space".
- File card: kind badge (DOC/IMG/TXT/...) + filename + "{size} · {mime} · from {source}".
- Search input filters spaces by name.
- Scrollable list of spaces. Mouse + Up/Down navigate; Enter saves;
  Esc / Cancel button / window-close all resolve as cancel.
- Inline error block (e.g. "Failed to load spaces: …") shown without
  closing the window so the user keeps their context.

## Storage layout

Files land at:

```
lite-downloads/<spaceId>/<download-id>/<filename>
```

`<download-id>` is a 10-char hex prefix randomly generated at capture
time, so two downloads of the same filename to the same Space don't
collide.

## Error surfaces

- Picker fails to bootstrap → inline error block; user can cancel.
- Download interrupted before user picks → temp file scrubbed,
  native notification: "Save to Space failed".
- Upload or asset-create throws → same failure notification; upload
  bytes remain in the bucket until a future janitor sweep
  (`lite-downloads/<spaceId>/<id>/` prefixes that don't match an :Asset).

## Single-instance discipline

One picker open at a time (the BrowserWindow factory enforces this).
If a second download fires while the picker is busy, the second
download is silently routed to the OS Downloads folder — no
queue, no error dialog: the user still gets their file.

## Tests

- `test/unit/downloads/mime.test.ts` — pure helpers (MIME mapping,
  sanitizer, storage key composition).
- `test/unit/downloads/picker-window.test.ts` — single-instance lifecycle.

End-to-end coverage (drives a real picker window through Playwright)
is intentionally deferred — the unit-level coverage exercises every
branch with the heavy Electron bits stubbed.
