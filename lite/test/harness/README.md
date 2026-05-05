# Onereach Lite Test Harness

Reusable building blocks for testing the lite app. Per ADR-023, this harness is the standard for all lite port tests -- new ports either consume the general harness directly or layer their own scenarios on top of it (see `updater/` for an example).

## Modules

### Conformance contracts (Rule 12 enforcement, ADR-024)

| Module | Purpose |
|---|---|
| `api-conformance.ts` | `runApiConformanceContract()` -- the uniform suite every module's `api.ts` runs through. Asserts singleton/lazy/reset/setForTesting/expectedMethods. |
| `error-conformance.ts` | `runErrorConformanceContract()` -- asserts every module-specific error class extends `LiteError`, codes follow `<MODULE>_<WHAT>` convention, formatters work. |

The meta-test at `lite/test/unit/module-conformance.test.ts` enforces that every `lite/<module>/api.ts` has a matching `<module>-api.test.ts` that calls the contract.

### Module mocks + fixtures

| Module | Purpose |
|---|---|
| `mocks/fake-kv.ts` | `FakeKV implements KVApi` -- in-memory mock with controllable failure flags. Use for unit tests that consume `getKVApi()`. |
| `mocks/fake-logging.ts` | `FakeLogging implements LoggingApi` -- in-memory mock that records logs/events. Use for unit tests that want to assert "this code emitted X events." |
| `mocks/in-memory-kv-server.ts` | `startInMemoryKVServer()` -- real `node:http` server speaking the OneReach KV protocol. Use for integration tests that need real wire format. |
| `mocks/in-memory-log-server.ts` | `startInMemoryLogServer()` -- real `lib/log-server.js` + `lib/log-event-queue.js` on a random localhost port. Use for integration tests that drive `LiteLogServerClient` end-to-end. |
| `fixtures/bug-report.ts` | `makeBugReportPayload()` -- factory with deterministic defaults. |

### App-level harness (E2E, ADR-023)

| Module | Purpose |
|---|---|
| `launch.ts` | Boot/teardown the built lite app, with optional isolated `userData` |
| `menu.ts` | Read application menu structure, click items by label or registry id |
| `windows.ts` | Find/wait for specific windows by URL or title |
| `log-server.ts` | HTTP client for lite's log server (`:47392`) -- query, snapshot, **push events** (`pushEvent`/`pushLog`), **read events** (`getEvents`/`waitForEvent`), wait-for-log-entry |
| `userdata.ts` | Snapshot/read bug reports, update-state.json, app-backups |
| `bug-report/index.ts` | Module-specific E2E flows (open + file a bug report) |
| `updater/` | Module-specific updater flows (local update server, fixture builders) |
| `index.ts` | Barrel re-exports everything above |

## Quick start

```typescript
import { test, expect } from '@playwright/test';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  clickMenuItem,
  waitForBugReportModal,
  type LiteHandle,
} from '../harness/index.js';

let handle: LiteHandle | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
});

test('something useful', async ({}, testInfo) => {
  // Skip gracefully if no built lite app is present
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'Run `npm run lite:package:mac` first');
    return;
  }

  // launchLite creates an isolated userData tempdir by default.
  // It's cleaned up automatically by closeLite().
  handle = await launchLite();

  await clickMenuItem(handle.app, 'Report a Bug...');
  const modal = await waitForBugReportModal(handle.app);
  await modal.fill('#description', 'test');
  // ...
});
```

## Conventions

1. **Always pair `launchLite` with `closeLite`** in `afterEach`/`afterAll`. The handle owns the tempdir; `closeLite` cleans it up.
2. **Always launch with an isolated `userDataDir`** -- the default is a tempdir, which is what you want. Only override if you're testing a specific path-collision scenario.
3. **Skip gracefully** if the built lite app isn't present -- contributors who haven't run `lite:package:mac` shouldn't be blocked.
4. **Prefer `clickMenuItemById` over `clickMenuItem`** when an item is registered via the menu registry -- ids are stable across copy changes.
5. **Use `LiteLogServerClient.snapshot()` + `errorsSince()`** to assert "no new errors during this test" rather than scraping logs.

## Running the harness suite

```bash
# Unit tests (don't need a built lite app)
npm run lite:test:unit

# Integration tests (use the harness to test multi-module wiring)
npm run lite:test:harness

# E2E tests (require a built lite app)
npm run lite:package:mac   # one-time
npm run lite:test:e2e
```

## Layering port-specific harnesses

When a port has scenarios that other ports won't reuse, put them in a sibling folder under `harness/`. Example: `harness/updater/` contains a local update server, fixture builders, and composed flows. The general harness stays narrow.

The rule: **if two ports would benefit from the same helper, lift it into the general harness.**

## Adding a new harness module

1. Create `lite/test/harness/<module>.ts` with focused, exported functions.
2. Export it from `lite/test/harness/index.ts`.
3. Document the surface in this README.
4. Where helpful, add a usage example to the JSDoc on each exported function.

Test infrastructure isn't subject to the 80% coverage threshold (`lite/vitest.config.ts` excludes `test/**`). Spend the rigor on real port code instead.
