# `lite/event-bus/` — domain-event pub/sub

Per ADR-043, the event bus sits **on top of** the central logging queue and projects raw module events (`auth.signIn.finish`, `idw.changed`, `main-window.open-tab.finish`, …) into a small, stable catalogue of **domain events** that other systems subscribe to without coupling to module internals.

## Public surface — `getEventBusApi()`

| Method | Purpose |
|---|---|
| `on(name, handler, opts?)` | Subscribe to a single domain event by exact name. Type narrows the handler's `event.data`. Returns unsubscribe. |
| `onPattern(glob, handler, opts?)` | Subscribe via glob (`agent.tab.*`, `*.signed-in`, `*`). Returns unsubscribe. |
| `recent(name \| null, limit?)` | Snapshot read of the most-recent matching events from the ring buffer. |
| `size()` | Count of events currently in the buffer. |
| `emit(event)` | Manually publish a domain event. Goes through the same fanout + persistence path as translated events. |
| `onEvent(handler)` | Subscribe to the bus's OWN operational events (translated, persist, hydrate). Main-process only. |

Subscribers receive the full discriminated `DomainEvent` (`{ name, id, ts, data }`). Throws inside a handler are swallowed and logged — a buggy subscriber CANNOT bring down emission.

## Renderer surface — `window.lite.events.*`

Same shape as the main-process API. `recent` / `size` / `emit` are async (Promise-wrapped over IPC); `on` / `onPattern` register a listener directly via the preload-side broadcast channel.

```js
const off = window.lite.events.on('user.signed-in', (ev) => {
  console.log('hello', ev.data.email);
});
// later: off();

const recent = await window.lite.events.recent('agent.tab.opened', 10);
```

## Subscription contract

- Default: future-only — `on` / `onPattern` returns events that fire *after* registration.
- Opt-in: `{ replay: true }` — synchronously replay any matching events already in the ring buffer (most-recent-last) before any future events.
- Snapshot: `recent(name, limit)` — does NOT subscribe; just reads the buffer.

## Domain events (current catalogue)

| Name | Trigger | Payload |
|---|---|---|
| `user.signed-in` | `auth.signIn.finish` | `{ env, accountId, email? }` |
| `user.signed-out` | `auth.signOut.finish` | `{ env }` |
| `agent.tab.opened` | `main-window.open-tab.finish` (wasFocus=false) | `{ tabId, url, label }` |
| `agent.tab.focused` | `main-window.open-tab.finish` (wasFocus=true) | `{ tabId, idwId? }` |
| `agent.tab.closed` | `main-window.close-tab.finish` | `{ tabId }` |
| `agent.tab.activated` | `main-window.activate-tab.finish` | `{ tabId }` |
| `token.injected` | `auth.inject-token.finish` (injected=true) | `{ env, partitionPrefix }` |
| `update.available` | `updater.update-available` | `{ version }` |
| `update.downloaded` | `updater.update-downloaded` | `{ version }` |
| `idw.installed` | `idw.store.installed` | `{ id, kind, catalogId }` |
| `bug-report.submitted` | `bug-report.save.finish` | `{ filePath, redactionBucket }` |

Adding / changing the catalogue is an ADR-worthy event — subscribers depend on the shape staying stable.

## Persistence

- **Ring buffer** (`RING_BUFFER_MAX = 200`): in-memory, evicted oldest-first.
- **KV mirror** (`lite-event-bus / default`): debounced 500ms after each mutation. Best-effort — on KV failure the in-memory state stays authoritative and the bus retries on the next push.
- **Hydrate on boot**: `initEventBus()` reads the persisted blob and pre-populates the buffer, so renderer subscribers using `{ replay: true }` immediately after launch see history from the previous session.

## Architecture

```
auth.signIn.finish event fires
         ↓
logging queue
         ↓
event-bus subscribed ('*')
         ↓
translator rule for 'auth.signIn.finish'
         ↓
DomainEvent { name: 'user.signed-in', data: { env, accountId, email? } }
         ↓
ring buffer push + KV-debounced persist + EventEmitter fanout
         ↓
   ┌─ main-process subscribers (await getEventBusApi().on(...))
   └─ webContents.send('lite:event-bus:event', ev) → all renderer windows
                                                      ↓
                                             window.lite.events.on(name, cb)
```

## Error catalog

| Code | Meaning |
|---|---|
| `EB_UNKNOWN_NAME` | Caller passed a domain event name not in the catalogue. |
| `EB_INVALID_INPUT` | Subscriber payload failed validation (renderer-side). |
| `EB_PERSISTENCE_FAILED` | Underlying KV write rejected. Bus stays operational; in-memory state is authoritative. |

## Files

| File | Purpose |
|---|---|
| `api.ts` | Public API surface (`getEventBusApi()`) + re-exports. |
| `types.ts` | `DomainEvent` discriminated union + `DOMAIN_EVENT_NAMES` source-of-truth list + persistence shape. |
| `translator.ts` | Pure rules table mapping raw `EventRecord` → `DomainEvent`. |
| `store.ts` | Ring buffer + KV persistence + EventEmitter fanout + glob matching. |
| `errors.ts` | `EventBusError` + `EVENT_BUS_ERROR_CODES`. |
| `events.ts` | Bus's OWN typed events (operational telemetry). |
| `main.ts` | IPC handlers + boot init + cross-window broadcast. |

See [DECISIONS.md ADR-043](../DECISIONS.md) for the architectural rationale.
