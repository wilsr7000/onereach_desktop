# `lite/logging/` — Centralized Logs + Events

The single funnel for everything that happens in the lite app. Every log line, every structured event, every span — all flow through this module's API and end up in one place: the lite log queue at port 47392.

- **Public API**: [`api.ts`](api.ts) — `LoggingApi` interface, `getLoggingApi()` singleton, error class & codes
- **Internal**:
  - [`store.ts`](store.ts) — `LoggingStore` wrapping the lib `LogEventQueue`. `@internal`.
  - [`events.ts`](events.ts) — `EventRecord`, `Span`, `matchPattern`, `serializeError`. Re-exported via `api.ts`.
- **Tests**: [`../test/unit/logging-api.test.ts`](../test/unit/logging-api.test.ts), [`../test/unit/logging-events.test.ts`](../test/unit/logging-events.test.ts), [`../test/integration/logging-flow.test.ts`](../test/integration/logging-flow.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-025](../DECISIONS.md#adr-025-centralized-event-logger-as-a-module)

---

## What it is

Three coordinated surfaces on a single underlying queue:

1. **Logs** — classic `level + category + message + data`. Goes to the lib queue, the log server (`/logs` HTTP, WebSocket), and the queue's ring buffer.
2. **Events** — semantic happenings with dotted names (`kv.set`, `bug-report.save.failed`). Same queue mirror, plus a local ring buffer the API exposes via `recent()`.
3. **Spans** — paired `<name>.start` / `<name>.finish` (or `.fail`) events with correlation ids and `durationMs`. Returned from `start()`; idempotent so try/finally is safe.

Modules consume `getLoggingApi()` and never write to `console.log` for production observability. The kernel boot, the updater, bug-report's store-level activity, and KV's HTTP traffic all funnel here.

```typescript
import { getLoggingApi } from '../logging/api.js';

const log = getLoggingApi();

// Logs
log.info('settings', 'theme changed', { newTheme: 'dark' });

// Instant event
log.event('bug-report.opened');

// Span
const span = log.start('kv.set', { collection: 'lite-bugs', key: 'x' });
try {
  await kv.set('lite-bugs', 'x', payload);
  span.finish({ ok: true });
} catch (err) {
  span.fail(err);
  throw err;
}

// In-process subscription
const unsub = log.onEvent('kv.*', (ev) => console.log(ev.name, ev.data));
unsub(); // detach when done

// Snapshot the last 50 KV events
const recentKv = log.recent('kv.*', 50);
```

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `debug/info/warn/error(category, message, data?)` | `void` | No | Routes to the lib queue. Never throws. |
| `event(name, data?, level?)` | `void` | Yes | Validates `name` is non-empty + no whitespace. |
| `start(name, data?)` | `Span` | Yes | Emits `<name>.start` immediately. Span is idempotent. |
| `onEvent(pattern, handler)` | `() => void` | Yes | Returns unsubscribe. Pattern: `kv.*`, `*.fail`, `*`. |
| `recent(pattern, limit?)` | `EventRecord[]` | Yes | Newest-first. Default `limit=50`. |

Full JSDoc with `@throws` / `@example` per method is in [`api.ts`](api.ts) — your IDE renders it on hover.

---

## Event taxonomy

Use dotted names. The first segment becomes the event's `category` (which is also the lib-queue category, so `/logs?category=kv` filters correctly).

Conventions:

- **`module.action`** — instant event, no span. E.g. `bug-report.opened`, `app.boot`.
- **`module.action.outcome`** — completion event. E.g. `kv.set.start`, `kv.set.finish`, `kv.set.fail`.
- **Use `start()` for spans**, not manual `<x>.start` + `<x>.finish` pairs. Spans wire correlation ids and durations for you.
- **Lowercase, hyphens for compound module names** (`bug-report.*`), match the module folder name.

What NOT to do:

- Whitespace in event names (rejected).
- Names without a dot — they work but you lose category routing.
- Event names that change every call (e.g. `kv.set.${key}`) — these blow up the ring buffer's distinct-name index. Use `data` for variability.

---

## Spans

```typescript
const span = log.start('bug-report.save', { timestamp: payload.timestamp });
try {
  await store.write(payload);
  span.finish({ kvWritten: true }); // emits bug-report.save.finish
} catch (err) {
  span.fail(err); // emits bug-report.save.fail with serialized error
  throw err;
}
```

Span semantics:

- **`finish(data?)`** — emits `<name>.finish` with `level: 'info'`, `durationMs`, your `data`.
- **`fail(error, data?)`** — emits `<name>.fail` with `level: 'error'`, `durationMs`, the serialized error, and your `data`.
- **Idempotent**: calling `finish()` twice (or `fail()` after `finish()`) is a no-op. Lets you wrap `finish/fail` in `try/finally` without double-emitting.
- **No nested-span auto-tracking**: child spans must pass `parentSpanId` in `data` if they care.

`LiteError` instances passed to `fail()` serialize to `{ code, message, remediation, context, name }`. Plain `Error` instances become `{ code: 'UNKNOWN', message, name }`. Non-Error values stringify.

Spans are **main-process only**. Renderer code that wants span-shaped instrumentation should emit paired instant events:

```typescript
window.logging.event('save.start', { id });
try {
  await someWork();
  window.logging.event('save.finish', { id, ok: true });
} catch (err) {
  window.logging.event('save.fail', { id, error: String(err) }, 'error');
  throw err;
}
```

---

## Subscriptions

Two patterns, same buffer:

```typescript
// 1. Live: be notified when matching events arrive.
const unsub = log.onEvent('*.fail', (ev) => {
  metrics.increment(`failures.${ev.category}`);
});
// later
unsub();

// 2. Snapshot: pull the last N matching events synchronously.
const last20 = log.recent('kv.*', 20);
```

Pattern syntax (see `matchPattern` in [`events.ts`](events.ts)):

- `*` — match anything (including empty)
- `prefix.*` — anything starting with `prefix.` (the dot is required)
- `*.suffix` — anything ending with `.suffix`
- `prefix.*.suffix` — both ends, anything in between
- `exact.name` — exact match only

Subscriber failures are isolated — if your handler throws, the publisher continues to deliver to other subscribers and emits a warning to the queue under category `logging`.

---

## Cross-module event catalog (ADR-030)

Every lite module that performs work emits structured events through this central log. Event names follow `<module>.<action>` (instant) or `<module>.<action>.start` / `.finish` / `.fail` (span). The first dotted segment becomes the queue category, so `/logs?category=<module>` filters.

Per ADR-032, modules with public APIs additionally expose:
1. A const-typed event-name catalog (`KV_EVENTS`, `BUG_REPORT_EVENTS`, etc.)
2. A discriminated union of typed event records (`KvEvent`, `BugReportEvent`, etc.)
3. A per-module subscription method (`getKVApi().onEvent()`, `getBugReportApi().onEvent()`, etc.) that filters and type-narrows automatically

The typed events files are the source of truth for what each module emits. A meta-test (`lite/test/unit/event-name-conformance.test.ts`) enforces correspondence between emit-site literals and the typed catalog.

| Module | Events | Typed catalog | Subscription | Docs |
|---|---|---|---|---|
| `app` (main-lite.ts) | `app.boot.start` / `.finish` / `.fail`, `app.window-all-closed`, `app.before-quit`, `app.second-instance` | — (no public API) | use `getLoggingApi().onEvent('app.*', ...)` | inline in [`main-lite.ts`](../main-lite.ts) |
| `window` (main-lite.ts) | `window.main.ready-to-show` / `.closed`, `window.about.ready-to-show` / `.closed` | — | use `getLoggingApi().onEvent('window.*', ...)` | inline in [`main-lite.ts`](../main-lite.ts) |
| `menu` (build-menu.ts) | `menu.click`, `menu.click.failed` | — | use `getLoggingApi().onEvent('menu.*', ...)` | inline in [`menu/build-menu.ts`](../menu/build-menu.ts) |
| `kv` | 15 spans (5 ops × 3) | [`KV_EVENTS`](../kv/events.ts) / `KvEvent` | `getKVApi().onEvent(handler)` | [`kv/README.md`](../kv/README.md#event-taxonomy) |
| `bug-report` | 5 spans (15) + 7 IPC | [`BUG_REPORT_EVENTS`](../bug-report/events.ts) / `BugReportEvent` | `getBugReportApi().onEvent(handler)` | [`bug-report/README.md`](../bug-report/README.md#event-taxonomy) |
| `auth` | 3 spans (8) + coalesced + session.read + 4 IPC | [`AUTH_EVENTS`](../auth/events.ts) / `AuthEvent` | `getAuthApi().onEvent(handler)` | [`auth/README.md`](../auth/README.md#event-taxonomy) |
| `updater` | 2 spans (6) + 3 IPC | [`UPDATER_EVENTS`](../updater/events.ts) / `UpdaterEvent` | `onUpdaterEvent(handler)` (free fn; updater handle is nullable across teardown) | inline in [`updater/check.ts`](../updater/check.ts) and [`updater/index.ts`](../updater/index.ts) |
| `totp` | 7 IPC events (`totp.ipc.<verb>`) | — (deferred until typed events land for totp) | use `getLoggingApi().onEvent('totp.*', ...)` | inline in [`totp/main.ts`](../totp/main.ts) |
| `logging` | self-events when subscriber callbacks throw (under category `logging`) | — | this module |

Glob patterns to filter:

| Goal | Pattern |
|---|---|
| All operations starting | `*.start` |
| All operation failures | `*.fail` |
| All KV activity | `kv.*` |
| All IPC invocations | `*.ipc.*` |
| All app lifecycle | `app.*` |
| All boot activity (boot span only) | `app.boot.*` |
| All window lifecycle | `window.*` |

## Bug-report integration (the streams payoff)

When a user files a bug, the report's `recentLogs` field is populated by querying the lite log server's `/logs?limit=200` endpoint. **Because every event written via `event()`, `start()`, `finish()`, `fail()` is mirrored to the lib queue, every event automatically appears in `recentLogs`.**

This means bug reports get causal context for free:

- A failing `kv.set` emits `kv.set.start` → `kv.set.fail` with serialized error
- A bug-report `save()` emits `bug-report` log lines on success and on failure
- All of those land in `recentLogs` redacted, in chronological order

No instrumentation at the bug-report site needed. If a future round wants a structured `recentEvents: EventRecord[]` field on the payload (instead of just stringified log lines), bump the schema version then; it's purely additive.

---

## Renderer bridge

`window.logging` exposes:

```typescript
interface LoggingBridge {
  debug(category, message, data?): void;
  info(category, message, data?): void;
  warn(category, message, data?): void;
  error(category, message, data?): void;
  event(name, data?, level?): void;
  recent(pattern, limit?): Promise<EventRecord[]>;
  // No `start()` -- spans are main-process only. Use paired events.
  // No `onEvent()` -- in-process subscription doesn't cross IPC. The
  // renderer can poll `recent()` if it needs reactive updates.
}
```

IPC channels (defined in [`../main-lite.ts`](../main-lite.ts)):

- `lite:logging:enqueue` (one-way) — `debug/info/warn/error`
- `lite:logging:event` (one-way) — `event()`
- `lite:logging:recent` (invoke) — `recent()`

---

## Error catalog

`event()`, `start()`, `onEvent()`, `recent()` throw `LoggingError` (extends `LiteError`) on bad input. Codes are exported as `LOGGING_ERROR_CODES`.

| Code | When it fires | Remediation |
|---|---|---|
| `LOGGING_INVALID_EVENT_NAME` | Empty event name, or contains whitespace. | Use a non-empty dotted name with no whitespace (e.g. `kv.set`, `bug-report.save.failed`). |
| `LOGGING_INVALID_PATTERN` | `onEvent` or `recent` got an empty / non-string pattern. | Pass a non-empty glob (`kv.*`, `*.fail`, `*`). |

Catching:

```typescript
import { LoggingError, LOGGING_ERROR_CODES } from '../logging/api.js';

try {
  log.event('');
} catch (err) {
  if (err instanceof LoggingError && err.code === LOGGING_ERROR_CODES.INVALID_EVENT_NAME) {
    // pass through to the test harness, fail loudly
  }
  throw err;
}
```

Log methods (`debug/info/warn/error`) **never throw** — they fall back to silent if the underlying queue misbehaves. Failing observability should never cascade into failing the operation being logged.

---

## Test layering

| Layer | File | Tests | What it asserts |
|---|---|---|---|
| Public-singleton conformance | [`../test/unit/logging-api.test.ts`](../test/unit/logging-api.test.ts) | 35 | Singleton, reset, `_setForTesting`, all 8 expected methods, error conformance for `LoggingError`, span lifecycle, event emission, recent buffer, onEvent pattern matching, validation throws. |
| Internal pieces | [`../test/unit/logging-events.test.ts`](../test/unit/logging-events.test.ts) | 16 | `matchPattern` (every glob shape), `serializeError` (LiteError, plain Error, non-Error, circular), `Span` lifecycle (finish, fail, idempotency, accessors). |
| Real-queue integration | [`../test/integration/logging-flow.test.ts`](../test/integration/logging-flow.test.ts) | 8 | LoggingStore writes to a real queue, spans correlate end-to-end, BugReportStore + EdisonKVClient route logs through the central queue, span around real save/fail flow. |

---

## Internal structure (for contributors)

```
lite/logging/
  api.ts          <- you import only from here
  store.ts        <- LoggingStore + LoggingError, @internal
  events.ts       <- Event/Span types, matchPattern, serializeError
  README.md       <- this file
```

If you need a method that isn't on `LoggingApi`, add it to `api.ts`. Don't import `store.ts` or `events.ts` from another module (Rule 11).

If you find yourself wanting log shipping, durable persistence, or remote ingestion: **don't add it here**. The bug reporter is the path off-device for diagnostic data; the queue is local-only by design (see ADR-025 for the rationale).
