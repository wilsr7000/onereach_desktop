# Onereach Lite Test Harness Guide

This is the test strategy doc. It covers the tier model, the contract that every module must pass, the recipe for adding tests for a new module, and how the harness enforces all of it.

For the **module reference** (per-file API of the harness itself), see [`harness/README.md`](harness/README.md).

For the **architectural rationale** (why this exists), see ADR-023 (general harness) and ADR-024 (contract enforcement) in [`../DECISIONS.md`](../DECISIONS.md).

---

## Tier model

Lite tests are organized into four tiers, each with a different speed / coverage tradeoff. Run the tier appropriate to what changed:

| Tier | Path | Speed | Coverage | Run via |
|---|---|---|---|---|
| **Unit** | `test/unit/` | <1ms per test | Pure logic with mocks. No Electron, no HTTP. | `npm run lite:test:unit` |
| **Contract** | (filtered subset of unit) | <1ms per test | Conformance contracts -- proves every module's `api.ts` passes the uniform shape. | `npm run lite:test:contract` |
| **Integration** | `test/integration/` | 50-150ms per test | Real HTTP via in-memory KV server, real `BugReportStore` against real `EdisonKVClient`. Catches wire-format drift. | `npm run lite:test:integration` |
| **E2E** | `test/e2e/` | 2-10s per test | Built signed Electron app, Playwright drives menus + IPC + windows. Catches real regressions before ship. | `npm run lite:test:e2e` (requires `npm run lite:package:mac` first) |

Quick combinations:

- **Pre-commit** -- `lite:test:unit` (~3s)
- **PR gate** -- `lite:test:all` (typecheck + dep-check + unit + integration; ~6s)
- **Release** -- `lite:test:all` + `lite:test:e2e` (~30s)

Vitest runs both unit and integration in parallel; the integration tier adds ~500ms because of the real HTTP server.

---

## The contract every module passes (Rule 12)

Every lite module that exposes an `api.ts` must run through `runApiConformanceContract()` from the harness. This is **enforced** by the meta-test at [`test/unit/module-conformance.test.ts`](unit/module-conformance.test.ts), which scans `lite/` for `api.ts` files and fails the build if any module is missing its contract test.

```typescript
import { runApiConformanceContract } from '../harness/index.js';
import {
  getFooApi,
  _resetFooApiForTesting,
  _setFooApiForTesting,
} from '../../foo/api.js';

runApiConformanceContract({
  name: 'FooApi',
  getInstance: getFooApi,
  resetForTesting: _resetFooApiForTesting,
  setForTesting: _setFooApiForTesting,
  expectedMethods: ['doThing', 'listThings'],
});
```

The contract asserts:

1. `getInstance()` returns the same instance across calls (singleton)
2. Lazy initialization works (instance is non-null after first get)
3. Every method in `expectedMethods` exists and is a function
4. `resetForTesting()` clears the singleton (subsequent get returns a fresh instance)
5. `setForTesting(stub)` injects the stub (subsequent get returns it)
6. `resetForTesting()` clears a `setForTesting` override

If your module throws errors, also add the error conformance contract:

```typescript
import { runErrorConformanceContract } from '../harness/index.js';
import { FooError, FOO_ERROR_CODES } from '../../foo/api.js';

runErrorConformanceContract({
  name: 'FooError',
  ErrorClass: FooError,
  codeEnum: FOO_ERROR_CODES,
  modulePrefix: 'FOO_',
  constructErrorWithCode: (code) => new FooError({
    code: code as never,
    message: 'sample',
    context: { op: 'sample' },
  }),
});
```

This asserts:
- Every code follows the `<MODULE>_<WHAT>` convention (SCREAMING_SNAKE)
- Instances are both `FooError` and `LiteError`
- Standard fields populate (`code`, `message`, `context`, `remediation`)
- Context is frozen (immutable)
- `formatForLog()` includes the code in brackets and the message
- `formatForUser()` returns a non-empty string
- `toJSON()` serializes the structured shape
- Every code in the enum can construct a valid instance

---

## How to add tests for a new module (5-step recipe)

You're porting a new module (`lite/foo/`). Here's exactly what to do:

### 1. Create your module's `api.ts` following ADR-019 / Rule 11

```typescript
// lite/foo/api.ts
import { FooStore } from './store.js';

export interface FooApi {
  doThing(input: string): Promise<void>;
  listThings(): Promise<string[]>;
}

let _instance: FooApi | null = null;

export function getFooApi(): FooApi {
  if (_instance === null) _instance = new FooStore();
  return _instance;
}

export function _resetFooApiForTesting(): void {
  _instance = null;
}

export function _setFooApiForTesting(api: FooApi): void {
  _instance = api;
}
```

### 2. Create the contract test

```typescript
// lite/test/unit/foo-api.test.ts
import { describe, it, expect } from 'vitest';
import {
  getFooApi,
  _resetFooApiForTesting,
  _setFooApiForTesting,
  type FooApi,
} from '../../foo/api.js';
import { runApiConformanceContract } from '../harness/index.js';

runApiConformanceContract<FooApi>({
  name: 'FooApi',
  getInstance: getFooApi,
  resetForTesting: _resetFooApiForTesting,
  setForTesting: _setFooApiForTesting,
  expectedMethods: ['doThing', 'listThings'],
});

// Module-specific behavior tests below...
```

This file is the **bare minimum** to pass the meta-test (`module-conformance.test.ts`). Without it, CI fails.

### 3. (If your module throws errors) Add error conformance

Either in the same file or a dedicated `lite/test/unit/foo-errors.test.ts`. Pattern:

```typescript
import { runErrorConformanceContract } from '../harness/index.js';
import { FooError, FOO_ERROR_CODES } from '../../foo/api.js';

runErrorConformanceContract({
  name: 'FooError',
  ErrorClass: FooError,
  codeEnum: FOO_ERROR_CODES,
  modulePrefix: 'FOO_',
  constructErrorWithCode: (code) => new FooError({
    code: code as never,
    message: 'sample',
  }),
});
```

### 4. (If your module talks to KV) Add an integration test

```typescript
// lite/test/integration/foo-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FooStore } from '../../foo/store.js';
import { EdisonKVClient } from '../../kv/client.js';
import { startInMemoryKVServer, type InMemoryKVServer } from '../harness/index.js';

let server: InMemoryKVServer;
let store: FooStore;

beforeEach(async () => {
  server = await startInMemoryKVServer();
  const kv = new EdisonKVClient({ url: `${server.url}/keyvalue` });
  store = new FooStore({ kvApi: kv });
});

afterEach(async () => {
  await server.stop();
});

it('round-trip preserves payload', async () => {
  await store.write('k', { v: 1 });
  expect(await store.read('k')).toEqual({ v: 1 });
});
```

### 5. (If your module ships UI) Add an E2E spec + helper layer

```typescript
// lite/test/harness/foo/index.ts -- module-specific scenario helpers
export async function openFooFlow(app, opts) {
  await clickMenuItem(app, 'Open Foo...');
  // ...
}

// lite/test/e2e/foo-smoke.spec.ts
import { test, expect } from '@playwright/test';
import { launchLite, closeLite } from '../harness/index.js';
import { openFooFlow } from '../harness/foo/index.js';
// ...
```

---

## How to test event flows

Every event a lite module emits via `getLoggingApi().event()` / `start()` / `Span.finish()` ends up in the lite log queue (port 47392) as a structured `{ data: { eventName, spanId?, durationMs?, error? } }` entry. The harness gives you four ways to interact with that flow in tests:

### 1. Unit-tier: assert against `FakeLogging.events`

For tests that just want to verify "this code emitted X events", inject `FakeLogging` via `_setLoggingApiForTesting`:

```typescript
import { FakeLogging } from '../harness/index.js';
import { _setLoggingApiForTesting } from '../../logging/api.js';

const fake = new FakeLogging();
_setLoggingApiForTesting(fake);

// run code under test...

expect(fake.events.map((e) => e.name)).toContain('kv.set.start');
```

### 2. Integration-tier: drive a real LoggingStore against an in-memory queue

When the test needs to verify the real publish path (queue mirror, ring buffer, subscriptions), use a real `LoggingStore` with an injected fake queue. See [`test/integration/logging-flow.test.ts`](integration/logging-flow.test.ts) for the canonical example.

### 3. Integration-tier: drive `LiteLogServerClient` against an in-memory log server

When the test needs to exercise the HTTP transport (POST /logs, /logs query, /logs/stats), boot the real `lib/log-server.js` on a random port and use the harness client:

```typescript
import {
  LiteLogServerClient,
  startInMemoryLogServer,
  type InMemoryLogServer,
} from '../harness/index.js';

let server: InMemoryLogServer;
let client: LiteLogServerClient;

beforeEach(async () => {
  server = await startInMemoryLogServer();
  client = new LiteLogServerClient(server.url);
});
afterEach(async () => {
  await server.stop();
});

// Push events
await client.pushEvent('test.preflight', { runId: 1 });
await client.pushEvent('test.failed', { reason: 'mock' }, 'error');
await client.pushLog('info', 'manual', 'plain log line', { x: 1 });

// Read events back
const all = await client.getEvents();                            // every structured event
const kvOnly = await client.getEvents({ pattern: 'kv.*' });      // glob filter
const fails = await client.getEvents({ pattern: '*.fail' });     // suffix filter
const newOnes = await client.getEvents({ since: snapshotIso });  // time filter

// Wait for an event
const ev = await client.waitForEvent('async.arrival', { timeoutMs: 1_000 });

// Wait with a predicate
const correctOne = await client.waitForEvent('match.*', {
  predicate: (e) => (e.data.data as { tag?: string })?.tag === 'right',
});
```

`startInMemoryLogServer()` resets the underlying lib queue on every call, so tests start with a blank slate. See [`test/integration/log-server-client.test.ts`](integration/log-server-client.test.ts) for the canonical example covering all four read/write paths.

### 4. E2E-tier: drive the running lite app's log server

When the test launches the built lite app and wants to assert "the running app emitted X event":

```typescript
import { launchLite, closeLite, LiteLogServerClient, LITE_LOG_SERVER } from '../harness/index.js';

handle = await launchLite();
const client = new LiteLogServerClient(LITE_LOG_SERVER); // default port 47392

await clickMenuItem(handle.app, 'Report a Bug...');
const ev = await client.waitForEvent('bug-report.*', { timeoutMs: 3_000 });
expect(ev.data.eventName).toBe('bug-report.opened');
```

Same client surface, just pointed at the live app. No different code patterns between integration and E2E.

### Choosing a tier

- **Just verifying emission shape**: use `FakeLogging` (unit, fastest).
- **Verifying queue + ring buffer + subscriptions**: real `LoggingStore` + fake queue (integration, ~10ms).
- **Verifying HTTP transport / `LiteLogServerClient` itself**: `startInMemoryLogServer()` + real `LogServer` (integration, ~100ms).
- **Verifying the built app emits events end-to-end**: `launchLite()` + `LiteLogServerClient` (E2E, seconds).

---

## What each tier catches (failure-mode coverage)

| Failure | Caught by |
|---|---|
| Method removed from API by accident | Contract (typecheck + `expectedMethods` assertion) |
| Singleton broken after refactor | Contract (singleton identity test) |
| `_resetForTesting` no longer clears state | Contract (reset test) |
| New module added without tests | Meta-test (Rule 12 enforcement) |
| Error class fields removed | Error conformance contract |
| New error code with wrong prefix | Error conformance contract |
| KV wire format mismatch (PUT/GET/POST/DELETE shape) | Integration tier |
| KV serialization bug (JSON wrapping, sentinels) | Integration tier |
| Timeout / 4xx / 5xx error paths | Integration tier |
| BugReportStore + EdisonKVClient mis-glued | Integration tier |
| Modal doesn't open on menu click | E2E |
| Bug report saves but file is missing/corrupt | E2E |
| Code signing breaks on macOS | E2E (`codesign --verify --deep --strict`) |
| Module's events don't reach the log server | Integration (push/read via `LiteLogServerClient` against `startInMemoryLogServer()`) |
| Span correlation broken across publish path | Integration (real `LoggingStore` + verify spanId round-trips through `getEvents()`) |

---

## Fixtures and mocks reference

### Shared fixtures (deterministic test data)

| Fixture | What it builds | Use when |
|---|---|---|
| `makeBugReportPayload()` | Full `BugReportPayload` with sensible defaults; accepts overrides | Any test that needs a payload (unit, integration, E2E) |

Adding a fixture: put it under `harness/fixtures/<topic>.ts`, export from `harness/index.ts`, keep it deterministic (no `Date.now()`, no random ids).

### Shared mocks

| Mock | Type | Use when |
|---|---|---|
| `FakeKV` | `class implements KVApi` | Unit test of a module that calls `getKVApi()`; you want fast in-memory persistence with controllable failure flags. |
| `FakeLogging` | `class implements LoggingApi` | Unit test of a module that calls `getLoggingApi()`; you want to assert on `fake.logs` and `fake.events`. |
| `startInMemoryKVServer()` | Real `node:http` server | Integration test against the OneReach KV wire format. |
| `startInMemoryLogServer()` | Real `lib/log-server.js` + `lib/log-event-queue.js` | Integration test that drives `LiteLogServerClient` end-to-end. Resets the lib queue on each call. |

---

## CI integration

The `lite:test` script chains everything that gates a merge:

```
lite:test
  -> lite:typecheck      (TypeScript strict)
  -> lite:dep-check      (dep-cruiser; enforces Rule 1)
  -> lite:test:unit      (unit + contract + meta-test)
  -> lite:test:integration  (real HTTP wire format)
```

E2E is not in `lite:test` because it requires a built signed app (`npm run lite:package:mac`). Run before release:

```bash
npm run lite:package:mac  # ~30s
npm run lite:test:e2e     # ~30s (smoke + updater)
```

Ports that introduce a new UI flow add a smoke spec under `test/e2e/<port>-smoke.spec.ts` and a helper layer under `harness/<port>/`.

---

## Escape hatches (when to NOT use the harness)

The harness is mandatory for the contract layer (Rule 12). For everything else, use it where it helps — not religiously.

| Skip the harness when | Use instead |
|---|---|
| You need to test a single private function | Plain `vitest` test, no harness import |
| You're testing a renderer-side logic that runs in the browser context | Playwright `page.evaluate()` directly; the harness wraps Electron-side flows |
| You're benchmarking | Custom timing harness; the conformance tests are correctness-only |
| You're driving a remote service that requires network | Mark the test with `test.skip(process.env['CI'] === 'true')` and document why |

---

## Adding a new harness primitive

If a helper would be reused across two or more modules, lift it into the general harness:

1. Add `lite/test/harness/<thing>.ts`
2. Export from `lite/test/harness/index.ts`
3. Document in [`harness/README.md`](harness/README.md) (the reference doc for the harness internals)
4. Update this guide if the addition changes the recipe

Module-specific scenarios stay in module-specific subfolders (`harness/<module>/`), not in the general harness.

---

## Related docs

| Doc | Purpose |
|---|---|
| [`harness/README.md`](harness/README.md) | Per-module reference for the harness internals |
| [`harness/updater/README.md`](harness/updater/README.md) | Updater-specific scenarios reference |
| [`../LITE-RULES.md`](../LITE-RULES.md) | Rule 12 (contract enforcement) and the rest of the rules |
| [`../DECISIONS.md`](../DECISIONS.md) | ADR-023 (general harness), ADR-024 (contract enforcement), ADR-019 (modular API pattern) |
| [`../PORTING.md`](../PORTING.md) | Per-port hardening status; references this guide for testing requirements |
