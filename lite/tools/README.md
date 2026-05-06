# Tools

User-curated shortcuts surfaced in the top-level **Tools** menu. Each
entry is a `{ label, url }` pair; clicking a tool in the menu opens the
URL in the user's default browser.

## Surface

```
Tools (top:tools)
  |- (one menu item per saved tool)
  |- ---
  |- Manage Tools...   -> opens the manager window
```

The manager window is a small CRUD UI where the user can:

- Add a tool (label + URL)
- Edit a tool
- Delete a tool

## Storage

KV-backed (`lite-tool-entries / default`). Entries are scoped to the
signed-in OneReach `accountId` -- the same multi-user isolation pattern
as IDW. Signed-out reads return an empty list; signed-out writes throw
`TOOLS_PERSISTENCE_FAILED`.

## Public API (`api.ts`)

| Method | Purpose |
|---|---|
| `list()` | All entries, in storage order. |
| `get(id)` | Single entry by id, or null. |
| `add(input)` | Add a new entry. Auto-generates `id` if absent. |
| `update(id, patch)` | Update label / url. |
| `remove(id)` | Remove an entry. |
| `onChange(handler)` | Subscribe to mutations. |
| `onEvent(handler)` | Subscribe to typed Tools events (ADR-032). |

## Error catalog

| Code | Cause | Remediation |
|---|---|---|
| `TOOLS_NOT_FOUND` | `get`/`update`/`remove` with unknown id. | Refresh the list. |
| `TOOLS_INVALID_INPUT` | Missing or empty label. | Provide a non-empty label. |
| `TOOLS_INVALID_URL` | Missing, malformed, or non-http(s) url. | Provide an https:// URL. |
| `TOOLS_DUPLICATE` | Explicit `id` collides on add. | Pick a different label, or update existing. |
| `TOOLS_PERSISTENCE_FAILED` | KV write rejected (incl. signed-out). | Check connection; sign in. |

## Renderer surface (`window.lite.tools.*`)

- `list()`, `get(id)`, `add(entry)`, `update(id, patch)`, `remove(id)`
- `openManager()` -- opens the manager window
- `onChange(handler)` -- subscribe to `lite:tools:changed` broadcasts
- `parseError(err)` -- recover the structured error JSON from a thrown
  IPC error, mirroring the IDW pattern
