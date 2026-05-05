# `lite/kv/` — Key-Value Storage

HTTP-backed key-value storage for any lite module. Wraps the OneReach Edison KV flow behind a typed `KVApi`.

- **Public API**: [`api.ts`](api.ts) — `KVApi` interface, `getKVApi()` singleton, error class & codes
- **Internal**: [`client.ts`](client.ts) — `EdisonKVClient`, the HTTP wrapper. Do not import directly.
- **Tests**: [`../test/unit/kv-api.test.ts`](../test/unit/kv-api.test.ts), [`../test/unit/kv-client.test.ts`](../test/unit/kv-client.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-020](../DECISIONS.md#adr-020-kv-promoted-to-top-level-lite-module)

---

## What it is

A flat key/value store partitioned into named **collections**. Values round-trip through JSON. Operations are network calls under the hood — every method can fail and every method tells you exactly why.

```typescript
import { getKVApi } from '../kv/api.js';

const kv = getKVApi();
await kv.set('settings', 'theme', { mode: 'dark', accent: '#888' });
const theme = await kv.get('settings', 'theme'); // -> { mode: 'dark', ... }
const keys = await kv.listKeys('settings');       // -> ['theme', ...]
const all = await kv.list('settings');            // -> [{ key, value }, ...]
await kv.delete('settings', 'theme');
```

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `set(coll, key, value)` | `Promise<void>` | Yes | Idempotent upsert. Value JSON-encoded on the wire. |
| `get(coll, key)` | `Promise<unknown \| null>` | Network errors only | `null` when key absent. |
| `listKeys(coll)` | `Promise<string[]>` | Yes | Returns `[]` for empty collection. Order not guaranteed. |
| `list(coll)` | `Promise<KVRecord[]>` | Yes (only on `listKeys`; per-key get failures are skipped) | Cost: 1 listKeys + N gets in parallel. |
| `delete(coll, key)` | `Promise<void>` | Yes | Upstream may time out but typically succeeds. |

Full JSDoc with `@throws`/`@example` on every method is in [`api.ts`](api.ts) — your IDE renders it on hover.

---

## Usage patterns

### First-run defaults

```typescript
const value = await kv.get('settings', 'theme');
if (value === null) {
  await kv.set('settings', 'theme', defaults);
}
```

### Per-collection isolation

Same key in different collections is independent:

```typescript
await kv.set('coll-a', 'shared', 'A');
await kv.set('coll-b', 'shared', 'B');
await kv.get('coll-a', 'shared'); // 'A'
await kv.get('coll-b', 'shared'); // 'B'
```

### Soft-failing render

If you'd rather render an empty UI than an error toast, swallow KV failures:

```typescript
async function safeList(collection: string): Promise<KVRecord[]> {
  try {
    return await getKVApi().list(collection);
  } catch (err) {
    if (err instanceof KVError) console.warn(err.formatForLog());
    return [];
  }
}
```

### Test injection

```typescript
import { _setKVApiForTesting, _resetKVApiForTesting } from '../kv/api.js';

beforeEach(() => _resetKVApiForTesting());

it('does the thing', () => {
  const stub: KVApi = { /* in-memory impl */ };
  _setKVApiForTesting(stub);
  // run code under test -- it gets the stub
});
```

---

## Error catalog

Every method throws `KVError` (extends [`LiteError`](../errors.ts)) on failure. Stable codes are exported as `KV_ERROR_CODES`.

| Code | When it fires | `.context` fields | Remediation surfaced to user |
|---|---|---|---|
| `KV_TIMEOUT` | Request didn't return within the configured timeout (default 5000ms; 2500ms for `listKeys`). | `op`, `collection`, `key?`, `timeoutMs` | "Check your network connection. If you are on a slow link, the operation may need a longer timeout." |
| `KV_HTTP` | Server returned non-2xx status. Message includes the status. | `op`, `collection`, `key?`, `status`, `body` (truncated 200 chars) | Status-specific: 401/403 → "endpoint rejected as unauthorized"; 404 → "URL is reachable but path returned 404"; 429 → "rate-limiting; wait and retry"; 5xx → "transient — retry in a few seconds". |
| `KV_NETWORK` | Underlying `fetch` rejected (DNS, TCP, TLS, abort-not-timeout). | `op`, `collection`, `key?` | "Check your network connection (DNS, VPN, captive portal). The Edison KV endpoint may be unreachable." |

### Catching

```typescript
import { KVError, KV_ERROR_CODES } from '../kv/api.js';

try {
  await kv.set('coll', 'key', value);
} catch (err) {
  if (err instanceof KVError) {
    console.error(err.formatForLog());
    //   [KV_HTTP] KV set failed: HTTP 500 from https://...
    //     context: {"op":"set","collection":"coll","key":"key","status":500,"body":"..."}
    //     remediation: The KV endpoint returned a server error. ...
    //     cause: ...

    if (err.code === KV_ERROR_CODES.TIMEOUT) {
      return queueRetry();
    }
    if (err.code === KV_ERROR_CODES.HTTP && err.status === 429) {
      return backoff();
    }
    toast(err.formatForUser()); // short combined message + remediation
  }
  throw err;
}
```

---

## Event taxonomy

Per ADR-030, every KV operation emits a span (`<name>.start` / `.finish` or `.fail`) through the central event log. Per ADR-032, these events are exposed as a typed discriminated union (`KvEvent`) and a per-module subscription method (`getKVApi().onEvent()`). The typed catalog is the source of truth -- if it's not in `KV_EVENTS`, no event with that name is emitted.

**Names.** Defined in [`lite/kv/events.ts`](./events.ts) as the `KV_EVENTS` constant:

```typescript
import { KV_EVENTS, type KvEvent } from '../kv/api.js';
// KV_EVENTS.SET_START === 'kv.set.start'
// KV_EVENTS.SET_FINISH === 'kv.set.finish'
// ...etc, 15 names total
```

**Event shapes** (typed via `KvEvent` discriminated union):

| Event | When | Typed payload |
|---|---|---|
| `kv.set.start` | Entering `set()` | `data: { collection, key }` |
| `kv.set.finish` | `set()` HTTP returned 2xx | `durationMs: number` |
| `kv.set.fail` | `set()` threw `KVError` | `durationMs: number`, top-level `error: { code, message, ... }` |
| `kv.get.start` | Entering `get()` | `data: { collection, key }` |
| `kv.get.finish` | `get()` returned (including `null` for not-found) | `durationMs: number` |
| `kv.get.fail` | `get()` threw `KVError` | `durationMs: number`, top-level `error` |
| `kv.listKeys.start` / `.finish` / `.fail` | Each `listKeys()` call | `data: { collection }` / `durationMs` / `durationMs + error` |
| `kv.list.start` / `.finish` / `.fail` | Each composite `list()` call (one outer span; inner listKeys + per-key get spans nested) | `data: { collection }` / `data: { count }` + `durationMs` / `durationMs + error` |
| `kv.delete.start` / `.finish` / `.fail` | Each `delete()` call | `data: { collection, key }` / `durationMs` / `durationMs + error` |

Note: error info is at the **top level** of the event record (`ev.error`), not inside `ev.data`. This matches the `EventRecord` shape Span.fail emits.

**Subscribing with type narrowing:**

```typescript
import { getKVApi, KV_EVENTS, type KvEvent } from '../kv/api.js';

const unsub = getKVApi().onEvent((ev: KvEvent) => {
  switch (ev.name) {
    case KV_EVENTS.SET_FINISH:
      // ev narrowed to KvSetFinishEvent; ev.durationMs is number
      metrics.timing('kv.set', ev.durationMs);
      break;
    case KV_EVENTS.SET_FAIL:
      // ev narrowed to KvSetFailEvent; ev.error is SerializedEventError
      sentry.capture(ev.error);
      break;
    case KV_EVENTS.LIST_FINISH:
      // ev.data is { count: number }
      console.log(`Listed ${ev.data.count} records`);
      break;
  }
});
// ... later
unsub();
```

`onEvent` filters internally to `kv.*`; consumers never see other modules' events through this handler.

Spans only emit when the consumer wires a `spanEmitter` on the `KVConfig`. The default config in `kv/api.ts` wires it to `getLoggingApi().start()`; tests can pass a stub or omit (silent path).

Adding a new KV event requires updating BOTH `kv/events.ts` (typed constant + interface) AND the emit site. The meta-test in `lite/test/unit/event-name-conformance.test.ts` enforces this: it scans `kv/client.ts` for literal event names and fails if any aren't in `KV_EVENTS`.

## Gotchas

- **Collection names are caller-defined.** The KV module does not enforce naming. Pick a stable string (`lite-bugs`, `settings`, `prefs-<userid>`); never reuse another module's collection.
- **Values must JSON round-trip.** `Date`, `Map`, `Set`, `BigInt`, functions, `undefined`, and circular refs do not survive `JSON.stringify`. Convert to ISO strings / arrays / numbers / null before `set()`.
- **Anonymous auth.** The flow URL itself is the bearer of trust. Don't log it. Don't ship it in error messages exposed to users (the URL is masked in `formatForUser()` but appears in `formatForLog()`).
- **`get()` returns `null` for two cases**: key missing, and upstream "No data found" sentinel. Treat both as "absent".
- **`list()` swallows per-key get failures.** A partial list is returned. Inspect logs (`[kv] list per-key get failed`) for diagnostics.
- **Default timeouts are tuned for the modal**: 5s for `set/get/delete`, 2.5s for `listKeys` (which runs while UI is waiting). Override via `KVConfig.timeoutMs` / `listTimeoutMs` for batch jobs.

---

## Test layering

| Layer | File | Tests | What it asserts |
|---|---|---|---|
| HTTP contract | [`../test/unit/kv-client.test.ts`](../test/unit/kv-client.test.ts) | 20 | PUT/GET/POST/DELETE shape, JSON wrapping, "No data found" sentinel, timeout/abort, logger. Drives `EdisonKVClient` directly with a mocked `fetch`. |
| Public-singleton | [`../test/unit/kv-api.test.ts`](../test/unit/kv-api.test.ts) | 6 | `getKVApi()` identity, reset, `_setForTesting` override, full CRUD round-trip via in-memory stub, collection isolation. |
| Error infrastructure | [`../test/unit/errors.test.ts`](../test/unit/errors.test.ts) | 17 | `LiteError` base behavior, `KVError` is a `LiteError`, body truncation, code branching. |

---

## Internal structure (for contributors)

```
lite/kv/
  api.ts         <- you import only from here
  client.ts      <- HTTP wrapper, @internal
  README.md      <- this file
```

The `EdisonKVClient` class in `client.ts` is `@internal`. It is exported only because TypeScript without a barrel build can't truly hide it; the discipline is enforced by Rule 11 + JSDoc, and dep-cruiser will enforce at build time once Phase 0b lands.

If you need a method that isn't on `KVApi`, add it to `api.ts` (forward to the underlying client). Don't import `client.ts` from another module.
