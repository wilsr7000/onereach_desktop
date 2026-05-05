# `lite/bug-report/` — Bug Reports

User-filed bug reports with mandatory PII/secret redaction, KV-backed CRUD, and a modal UI for filing and triaging.

- **Public API**: [`api.ts`](api.ts) — `BugReportApi` interface, `getBugReportApi()` singleton, error class & codes
- **Internal**:
  - [`store.ts`](store.ts) — KV-backed store + `BugReportError` definition (`@internal`)
  - [`main.ts`](main.ts) — main-process IPC handlers + modal lifecycle (`@internal`)
  - [`capture.ts`](capture.ts) — payload assembly + redaction
  - [`modal.html`](modal.html) / [`modal.css`](modal.css) / [`modal.ts`](modal.ts) — renderer UI
- **Tests**: [`../test/unit/bug-report-api.test.ts`](../test/unit/bug-report-api.test.ts), [`../test/unit/bug-report-store.test.ts`](../test/unit/bug-report-store.test.ts), [`../test/unit/bug-report-capture.test.ts`](../test/unit/bug-report-capture.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-008 (redaction)](../DECISIONS.md#adr-008-mandatory-default-on-bug-reporter-redaction), [ADR-019 (modular shape)](../DECISIONS.md#adr-019-modular-api-pattern-with-public-apits-per-module)

---

## What it is

Bug reports are user-filed records of "this app misbehaved". Each report carries the user's description, the app version + platform, the last several log lines, and redacted notes/status mutations from triage. Records live in the Edison KV store under collection `lite-bugs`, keyed by ISO timestamp.

Mandatory PII/secret redaction runs on every save and every notes update — the user cannot disable it. See [`bug-report-redaction-patterns.ts`](../bug-report-redaction-patterns.ts) for the regex catalog.

```typescript
import { getBugReportApi } from '../bug-report/api.js';

const api = getBugReportApi();
const result = await api.save(payload);    // throws BugReportError on KV failure
const reports = await api.list();           // soft-fails to []
const report = await api.read(reports[0]!.filePath);
const updated = await api.update(report.timestamp, { status: 'resolved' });
const deleted = await api.delete(report.timestamp);
```

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `save(payload)` | `Promise<SaveResult>` | Yes (`BugReportError`, `KVError`) | Persists to KV. Cause-chains the underlying KV failure. |
| `list()` | `Promise<BugReportSummary[]>` | **No (soft-fail)** | Returns `[]` on KV failure; modal renders empty state. |
| `read(idOrPath)` | `Promise<BugReportPayload>` | Yes (`BugReportError`, `KVError`) | Accepts bare timestamp or `kv:<timestamp>` synthetic id. |
| `update(timestamp, partial)` | `Promise<UpdateResult>` | **No (soft-fail)** | Returns `{ kvUpdated, kvError }` so modal can render inline retry. Notes redacted before save. |
| `delete(timestamp)` | `Promise<DeleteResult>` | **No (soft-fail)** | Returns `{ kvDeleted, kvError }`. |

The throw / soft-fail split is intentional. Throws are reserved for "operation cannot succeed and there's nothing meaningful to return" (e.g. `BR_NOT_FOUND` from `read`). Mutations that have a partial-success shape (the in-memory payload is still valid even if the network write failed) return a result object so the UI can show an inline error and let the user retry.

Full JSDoc with `@throws` / `@example` per method is in [`api.ts`](api.ts) — your IDE renders it on hover.

---

## Usage patterns

### Filing a report (from the modal renderer)

```typescript
const payload = await window.bugReport.capture(userDescription);
const result = await window.bugReport.save(payload.payload);
if (result.kvWritten) {
  toast('Report sent. Thank you.');
} else {
  toast(result.kvError ?? 'Send failed');
}
```

The renderer-side bridge in [`preload-lite.ts`](../preload-lite.ts) wraps the IPC. The modal renderer never imports `getBugReportApi()` directly — it goes through `window.bugReport`.

### Triaging from a different module (main process)

```typescript
import { getBugReportApi, BugReportError } from '../bug-report/api.js';

async function markResolvedIfRecent(timestamp: string): Promise<void> {
  try {
    const report = await getBugReportApi().read(timestamp);
    if (Date.parse(report.timestamp) > Date.now() - 86400_000) {
      await getBugReportApi().update(timestamp, {
        status: 'resolved',
        notes: 'Auto-resolved by sweeper -- < 24h old',
      });
    }
  } catch (err) {
    if (err instanceof BugReportError && err.code === 'BR_NOT_FOUND') {
      // Already deleted -- nothing to do
      return;
    }
    throw err;
  }
}
```

### Testing

```typescript
import { _setBugReportApiForTesting, _resetBugReportApiForTesting } from '../bug-report/api.js';

beforeEach(() => _resetBugReportApiForTesting());

it('does the thing', async () => {
  _setBugReportApiForTesting({
    save: async () => ({ kvWritten: true, kvError: null }),
    list: async () => [],
    read: async () => { throw new BugReportError({ code: 'BR_NOT_FOUND', message: 'gone' }); },
    update: async () => ({ payload: {} as never, kvUpdated: true, kvError: null }),
    delete: async () => ({ kvDeleted: true, kvError: null }),
  });
  // run code under test
});
```

---

## Error catalog

`save()` and `read()` throw `BugReportError` (extends [`LiteError`](../errors.ts)) on failure. `list()` / `update()` / `delete()` return result objects with a `kvError` field instead of throwing. KV-layer errors propagate through `.cause`.

| Code | Method | When it fires | `.context` fields | Remediation surfaced to user |
|---|---|---|---|---|
| `BR_SAVE_FAILED` | `save()` | KV write rejected. `.cause` is the underlying `KVError`. | `op`, `timestamp`, `collection`, `kvCode?`, `kvStatus?` | Inherits the KV error's remediation if available; otherwise "Check your network connection and try again. The report was not stored." |
| `BR_NOT_FOUND` | `read()` | The id resolves to no record (deleted or wrong key). | `op`, `idOrPath`, `key`, `collection` | "The report may have been deleted, or the identifier is wrong. Refresh the list and try again." |
| `BR_BAD_PAYLOAD` | `read()` | KV returned a non-object value (corrupt or written by an incompatible client). | `op`, `key`, `collection`, `actualType` | "The stored value is corrupt or written by an incompatible client. Delete the record and re-file the report." |

### Catching

```typescript
import { BugReportError, BUG_REPORT_ERROR_CODES } from '../bug-report/api.js';
import { KVError } from '../kv/api.js';

try {
  await getBugReportApi().save(payload);
} catch (err) {
  if (err instanceof BugReportError) {
    console.error(err.formatForLog());
    //   [BR_SAVE_FAILED] Bug report save failed: KV set failed: HTTP 500 from ...
    //     context: {"op":"save","timestamp":"...","collection":"lite-bugs","kvCode":"KV_HTTP","kvStatus":500}
    //     remediation: The KV endpoint returned a server error. ...
    //     cause: KVError: KV set failed: HTTP 500 ...

    if (err.code === BUG_REPORT_ERROR_CODES.SAVE_FAILED) {
      // Inspect the cause for KV-specific code
      if (err.cause instanceof KVError && err.cause.code === 'KV_TIMEOUT') {
        return queueRetry();
      }
    }
    toast(err.formatForUser());
  }
  throw err;
}
```

For soft-fail methods, inspect the `kvError` string:

```typescript
const result = await getBugReportApi().delete(timestamp);
if (!result.kvDeleted) {
  toast(result.kvError ?? 'Delete failed -- please retry.');
}
```

---

## Event taxonomy

Per ADR-030, every store op + every IPC handler emits structured events through the central log. Per ADR-032, these are exposed as a typed `BugReportEvent` discriminated union with per-module `getBugReportApi().onEvent()`. The typed constants in [`lite/bug-report/events.ts`](./events.ts) (`BUG_REPORT_EVENTS`) are the source of truth.

| Event | When | Typed payload |
|---|---|---|
| `bug-report.save.start` / `.finish` / `.fail` | `save()` boundary | `data: { timestamp }` / `data: { kvWritten }` + `durationMs` / `durationMs` + top-level `error` |
| `bug-report.list.start` / `.finish` / `.fail` | `list()` boundary; `.fail` fires even though `list()` returns `[]` (soft-fail) | (no data) / `data: { count }` + `durationMs` / `durationMs` + `error` |
| `bug-report.read.start` / `.finish` / `.fail` | `read()` boundary; `.fail` fires for `BR_NOT_FOUND` and `BR_BAD_PAYLOAD` | `data: { key }` / `durationMs` / `durationMs` + `error` |
| `bug-report.update.start` / `.finish` / `.fail` | `update()` boundary | `data: { timestamp, hasStatusChange, hasNotesChange }` / `data: { kvUpdated }` + `durationMs` / `durationMs` + `error` |
| `bug-report.delete.start` / `.finish` / `.fail` | `delete()` boundary | `data: { timestamp }` / `data: { kvDeleted }` + `durationMs` / `durationMs` + `error` |
| `bug-report.ipc.capture` | IPC `lite:bug-report:capture` invoked | (no data) |
| `bug-report.ipc.save` | IPC `lite:bug-report:save` invoked | (no data) |
| `bug-report.ipc.close` | IPC `lite:bug-report:close` invoked | (no data) |
| `bug-report.ipc.list` | IPC `lite:bug-report:list` invoked | (no data) |
| `bug-report.ipc.read` | IPC `lite:bug-report:read` invoked | `data: { idOrPath }` |
| `bug-report.ipc.update` | IPC `lite:bug-report:update` invoked | `data: { timestamp }` |
| `bug-report.ipc.delete` | IPC `lite:bug-report:delete` invoked | `data: { timestamp }` |
| `window.bug-report.ready-to-show` / `.closed` | Modal window lifecycle (emitted by `main-lite.ts` for the modal's parent) | — |

Note: `error` info is at the **top level** of the event record (`ev.error`), not inside `ev.data`. Span finish/fail also carry `durationMs` at the top level.

**Subscribing with type narrowing:**

```typescript
import { getBugReportApi, BUG_REPORT_EVENTS, type BugReportEvent } from '../bug-report/api.js';

getBugReportApi().onEvent((ev: BugReportEvent) => {
  switch (ev.name) {
    case BUG_REPORT_EVENTS.SAVE_FINISH:
      metrics.timing('bug-report.save', ev.durationMs);
      break;
    case BUG_REPORT_EVENTS.SAVE_FAIL:
      sentry.capture(ev.error);
      break;
    case BUG_REPORT_EVENTS.UPDATE_START:
      // ev.data narrowed to { timestamp; hasStatusChange; hasNotesChange }
      audit.log('bug-update', ev.data.timestamp);
      break;
  }
});
```

Spans only emit when the consumer wires a `spanEmitter` on the `StoreConfig`. The default config in `bug-report/api.ts` wires it to `getLoggingApi().start()`.

The bug-report **save** flow nests events under the parent: `bug-report.save.start` -> `kv.set.start` -> `kv.set.finish` -> `bug-report.save.finish`. Bug reports filed by users automatically capture this trace in `recentLogs`.

## Redaction

Every `save()` and every `notes` update on `update()` runs through [`redact()`](../bug-report-redaction-patterns.ts). The current catalog (7 patterns):

| Kind | What it matches |
|---|---|
| `OPENAI_KEY` | `sk-...` style OpenAI keys |
| `AWS_ACCESS_KEY` | `AKIA...` access key IDs |
| `GITHUB_PAT` | `ghp_...` personal access tokens |
| `GITHUB_OAUTH` | `gho_...` OAuth tokens |
| `JWT` | Three-segment base64url tokens (`<header>.<payload>.<sig>`) |
| `BEARER_TOKEN` | Authorization-header-style `Bearer <token>` |
| `API_KEY_ENV` | `API_KEY=` / `SECRET=` / `TOKEN=` env-style assignments |

Redacted spans are replaced with `[REDACTED:<kind>]`. Per-bucket counts are emitted as cohort-level telemetry (per ADR-008 — never per-user-attributable).

The redaction layer is **mandatory and not user-disableable**. There is no opt-out toggle and there will not be one. Reports that include a "do not redact" toggle in the UI bypass the entire purpose of the layer.

If you need to add a new pattern (email, phone, IP, etc.), add it to [`lite/bug-report-redaction-patterns.ts`](../bug-report-redaction-patterns.ts) and add a corresponding test to [`lite/test/unit/redaction-patterns.test.ts`](../test/unit/redaction-patterns.test.ts). Note that broad patterns like email + phone tend to false-positive on legitimate identifiers in logs (timestamps that look like phone numbers, CDN cache keys that look like emails) -- weigh carefully before adding.

---

## IPC channel reference

The renderer talks to the main process exclusively via `window.bugReport` (set up in [`../preload-lite.ts`](../preload-lite.ts)). Channel names live in [`main.ts`](main.ts) `BUG_REPORT_IPC`.

| Channel | Direction | Bridge method | Notes |
|---|---|---|---|
| `lite:bug-report:capture` | invoke | `window.bugReport.capture(description)` | Returns the assembled payload preview (already redacted). |
| `lite:bug-report:save` | invoke | `window.bugReport.save(payload)` | Persists to KV. |
| `lite:bug-report:list` | invoke | `window.bugReport.list()` | Returns `BugReportSummary[]`. |
| `lite:bug-report:read` | invoke | `window.bugReport.read(idOrPath)` | Returns full payload. |
| `lite:bug-report:update` | invoke | `window.bugReport.update(timestamp, partial)` | Returns `UpdateResult`. |
| `lite:bug-report:delete` | invoke | `window.bugReport.delete(timestamp)` | Returns `DeleteResult`. |
| `lite:bug-report:close` | send | `window.bugReport.close()` | Closes the modal window. |

Schemas are hand-validated in `main.ts` today. Phase 0b's `schema-first-ipc` chunk will add zod-driven validation at the dispatcher.

---

## Test layering

| Layer | File | Tests | What it asserts |
|---|---|---|---|
| Public API singleton | [`../test/unit/bug-report-api.test.ts`](../test/unit/bug-report-api.test.ts) | 6 | `getBugReportApi()` identity, reset, `_setForTesting` override, full CRUD round-trip via stub. |
| Store (production class against fake KV) | [`../test/unit/bug-report-store.test.ts`](../test/unit/bug-report-store.test.ts) | 18 | save/list/read/update/delete behavior, KV failure handling, payload validation. Injects a `FakeKV implements KVApi`. |
| Payload capture + redaction | [`../test/unit/bug-report-capture.test.ts`](../test/unit/bug-report-capture.test.ts) | 13 | Schema, redaction integration, legacy-payload migration. |
| Error infrastructure | [`../test/unit/errors.test.ts`](../test/unit/errors.test.ts) | 17 | `BugReportError` is a `LiteError`, code branching. |

E2E: [`../test/e2e/kernel-smoke.spec.ts`](../test/e2e/kernel-smoke.spec.ts) drives the full modal flow against a built signed app.

---

## Internal structure (for contributors)

```
lite/bug-report/
  api.ts               <- you import only from here
  main.ts              <- IPC handlers + modal lifecycle, @internal
  store.ts             <- KV-backed store + BugReportError, @internal
  capture.ts           <- payload assembly, redaction integration
  modal.html           <- renderer template
  modal.css            <- renderer styles
  modal.ts             <- renderer logic (consumes window.bugReport)
  README.md            <- this file
```

If you need a method that isn't on `BugReportApi`, add it to `api.ts` (forward to `BugReportStore`). Don't import `store.ts` from another module.
