# Test Suite -- Onereach.ai

## Quick Start

```bash
# Run all unit tests (no app needed)
npm run test:unit

# Run all E2E tests (launches app)
npm run test:e2e

# Run everything
npm run test:full
```

## Test Commands

### Unit Tests (Vitest -- no app needed)

| Command | What it runs |
|---|---|
| `npm run test:unit` | All unit tests (excludes evals) |
| `npm test` | Same as above |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:coverage` | Unit tests with coverage report |
| `npm run test:converters` | Converter unit tests only |
| `npm run test:conversion` | Full conversion pipeline tests |
| `npm run test:bidding` | Agent bidding tests |

### E2E Tests (Playwright -- launches Electron app)

| Command | What it runs | Time |
|---|---|---|
| `npm run test:e2e:quick` | Smoke + API only | ~2 min |
| `npm run test:smoke` | Window smoke tests | ~1 min |
| `npm run test:api` | API integration tests | ~1 min |
| `npm run test:journey` | Smoke + Spaces + Settings flow | ~3 min |
| `npm run test:e2e:products` | All product-level suites | ~10 min |
| `npm run test:e2e` | Every E2E test | ~15 min |
| `npm run test:full` | Unit + Products + Smoke + API + Spaces | ~20 min |

### Specialized Tests

| Command | What it runs |
|---|---|
| `npm run test:e2e:ai-conversation` | AI conversation capture |
| `npm run test:conversion:evals` | Converter quality evals |
| `npm run test:wizard` | Setup wizard (Electron) |
| `npm run test:metadata` | Metadata generation |
| `npm run test:gsx-sync` | GSX sync operations |

## File Structure

```
test/
  unit/                          -- Vitest unit tests
    ai-service.test.js           -- AI service core logic
    item-tagging.test.js         -- Content type detection
    multi-tenant-store.test.js   -- Multi-tenant storage
    converters/                  -- 40+ converter tests
    voice-sdk/                   -- Voice SDK tests
    ...
  e2e/                           -- Playwright E2E tests
    helpers/
      electron-app.js            -- Shared Electron harness
    window-smoke.spec.js         -- Opens every window
    api-integration.spec.js      -- REST API tests
    spaces-flow.spec.js          -- Spaces CRUD journey
    settings-flow.spec.js        -- Settings flow
    products/                    -- Product-level suites
      video-editor.spec.js       -- Video Editor (23 tests)
      gsx-create.spec.js         -- GSX Create (25 tests)
      agent-composer.spec.js     -- Agent Composer (23 tests)
      command-hud.spec.js        -- Command HUD (23 tests)
      app-health.spec.js         -- App Health Dashboard (20 tests)
      agentic-player.spec.js     -- Agentic Player (18 tests)
      log-viewer.spec.js         -- Log Viewer (17 tests)
      budget-manager.spec.js     -- Budget Manager (12 tests)
      native-dialogs.spec.js     -- Native Dialogs (17 tests)
      gsx-sync.spec.js           -- GSX Sync & Backup (14 tests)
      spaces-full.spec.js        -- Spaces API + UI (11 tests)
      metadata-generation.spec.js-- Metadata Generation (10 tests)
      pickers-floating.spec.js   -- Pickers & Floating UI (9 tests)
      core-features.spec.js      -- Settings, Menu, Auth, IDW, etc.
  evals/                         -- Quality evaluation tests
  fixtures/                      -- Test fixtures (media, data)
  audit/                         -- Test audit tracking
    cli.js                       -- Audit CLI tool
    state/audit-state.json       -- Audit state
  plans/                         -- Test plan documents
```

## How It Works

### Unit Tests
- Run with **Vitest** -- fast, parallel, no app needed
- Mock Electron APIs and external services
- Cover pure logic: classification, detection, parsing, conversion

### E2E Tests
- Run with **Playwright** + Electron
- Launch the actual app, interact via IPC and REST APIs
- Use `window.api.invoke()` for main process IPC
- Use `fetch()` for Log Server (47292) and Spaces API (47291)
- Shared harness in `test/e2e/helpers/electron-app.js`

### Error Monitoring
Every E2E test file:
1. Snapshots errors before the suite runs
2. Checks for new errors after the suite completes
3. Filters out known benign errors (agent reconnects, CSP, etc.)

## Adding New Tests

### Unit Test
```javascript
// test/unit/my-feature.test.js
import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }), { virtual: true });

describe('My Feature', () => {
  it('does something', () => {
    expect(1 + 1).toBe(2);
  });
});
```

### E2E Test
```javascript
// test/e2e/products/my-product.spec.js
const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, snapshotErrors, checkNewErrors, filterBenignErrors } = require('../helpers/electron-app');

let app, electronApp, mainWindow, errorSnapshot;

test.describe('My Product', () => {
  test.beforeAll(async () => {
    app = await launchApp();
    electronApp = app.electronApp;
    mainWindow = app.mainWindow;
    errorSnapshot = await snapshotErrors();
  });
  test.afterAll(async () => { await closeApp(app); });

  test('feature works via IPC', async () => {
    const r = await mainWindow.evaluate(async () => {
      return await window.api?.invoke?.('my-ipc-channel', { data: 'test' });
    });
    expect(r).toBeDefined();
  });

  test('no unexpected errors', async () => {
    const errors = await checkNewErrors(errorSnapshot);
    const genuine = filterBenignErrors(errors);
    expect(genuine.length).toBeLessThanOrEqual(5);
  });
});
```

## Test Audit

Track which test items are automated vs. manual:

```bash
# View audit status
node test/audit/cli.js status

# Mark items as done
node test/audit/cli.js done <item-id>
```
