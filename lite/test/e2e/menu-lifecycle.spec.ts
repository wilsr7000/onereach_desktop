/**
 * Menu lifecycle E2E -- exercise the dynamic registry → builder → Electron
 * menu pipeline against a real running lite kernel.
 *
 * Why this exists: the menu builder is registry-driven (lite/menu/build-menu.ts)
 * and rebuilds on every `change` event from lite/menu/registry.ts. The unit
 * tests cover the registry and template-building logic; the kernel-smoke spec
 * asserts the seeded structure. This spec covers the live boundary in between:
 * register/unregister entries from a running app and verify the application
 * menu rebuilds correctly.
 *
 * Specifically asserts:
 *   1. Registering a new top-level + child makes both appear in the live menu.
 *   2. Unregistering the last child of a top-level hides the top-level
 *      (the "empty top-levels do not render" contract from registry.ts).
 *   3. Registering a top-level placeholder alone does not render it; the
 *      first child registration is what materializes it.
 *   4. Removing all dynamic entries returns the menu to the seeded shape
 *      so tests don't leak state.
 *
 * Run with:  npm run lite:test:e2e
 * Prerequisites:  npm run lite:package:mac (or :win) must have produced
 *                 a build under dist-lite/.
 */

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
// Per-file imports rather than the harness barrel: the barrel re-exports
// the vitest-bound conformance helpers, and Playwright can't load vitest.
// Same pattern that kernel-smoke.spec.ts should adopt.
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  sleep,
  type LiteHandle,
} from '../harness/launch.js';
import {
  getMenuStructure,
  registerEntryFromTest,
  unregisterEntryFromTest,
} from '../harness/menu.js';

let handle: LiteHandle | null = null;

/** Microtask debounce in build-menu.ts -- one tick is enough, but give a small buffer. */
const REBUILD_WAIT_MS = 50;

/** Stable test ids -- prefixed so any leak is obvious in failure output. */
const TEST_TOP_ID = 'top:e2e-menu-test';
const TEST_TOP_LABEL = 'E2EMenuTest';
const TEST_ITEM_ID = 'e2e-menu-test:hello';
const TEST_ITEM_LABEL = 'E2E Hello';

test.afterEach(async () => {
  // Best-effort cleanup so the next test sees a clean menu. unregister is
  // idempotent (no-op if absent) so it's safe even if the test never
  // registered the ids.
  if (handle !== null) {
    try {
      await unregisterEntryFromTest(handle.app, TEST_ITEM_ID);
      await unregisterEntryFromTest(handle.app, TEST_TOP_ID);
    } catch {
      /* shutdown best-effort */
    }
  }
  await closeLite(handle);
  handle = null;
});

async function skipIfUnbuilt(testInfo: { skip: (cond: boolean, reason: string) => void }): Promise<boolean> {
  try {
    await fs.access(defaultExecutablePath());
    return false;
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return true;
  }
}

test('menu-lifecycle: registering a top-level + child renders both in the live menu', async ({}, testInfo) => {
  if (await skipIfUnbuilt(testInfo)) return;
  handle = await launchLite();

  const baseline = await getMenuStructure(handle.app);
  const baselineLabels = baseline.map((t) => t.label);
  expect(baselineLabels).not.toContain(TEST_TOP_LABEL);

  await registerEntryFromTest(handle.app, {
    id: TEST_TOP_ID,
    type: 'top-level',
    label: TEST_TOP_LABEL,
  });
  await registerEntryFromTest(handle.app, {
    id: TEST_ITEM_ID,
    type: 'item',
    parentId: TEST_TOP_ID,
    label: TEST_ITEM_LABEL,
  });
  await sleep(REBUILD_WAIT_MS);

  const afterRegister = await getMenuStructure(handle.app);
  const newTop = afterRegister.find((t) => t.label === TEST_TOP_LABEL);
  expect(newTop).toBeDefined();
  expect(newTop?.items.map((it) => it.label)).toEqual([TEST_ITEM_LABEL]);

  // The seeded top-levels (App menu + Help) are still present and unchanged.
  expect(afterRegister.length).toBe(baseline.length + 1);
  for (const seededLabel of baselineLabels) {
    expect(afterRegister.map((t) => t.label)).toContain(seededLabel);
  }
});

test('menu-lifecycle: empty top-level placeholders do not render until a child registers', async ({}, testInfo) => {
  if (await skipIfUnbuilt(testInfo)) return;
  handle = await launchLite();

  // Register the top-level alone -- per registry.ts contract, it should
  // NOT appear in the rendered menu because it has no children.
  await registerEntryFromTest(handle.app, {
    id: TEST_TOP_ID,
    type: 'top-level',
    label: TEST_TOP_LABEL,
  });
  await sleep(REBUILD_WAIT_MS);

  const afterTopOnly = await getMenuStructure(handle.app);
  expect(afterTopOnly.find((t) => t.label === TEST_TOP_LABEL)).toBeUndefined();

  // First child registration should materialize the top-level.
  await registerEntryFromTest(handle.app, {
    id: TEST_ITEM_ID,
    type: 'item',
    parentId: TEST_TOP_ID,
    label: TEST_ITEM_LABEL,
  });
  await sleep(REBUILD_WAIT_MS);

  const afterChild = await getMenuStructure(handle.app);
  const newTop = afterChild.find((t) => t.label === TEST_TOP_LABEL);
  expect(newTop).toBeDefined();
  expect(newTop?.items.map((it) => it.label)).toEqual([TEST_ITEM_LABEL]);
});

test('menu-lifecycle: unregistering the last child hides the top-level and restores baseline', async ({}, testInfo) => {
  if (await skipIfUnbuilt(testInfo)) return;
  handle = await launchLite();

  const baseline = await getMenuStructure(handle.app);
  const baselineLabels = baseline.map((t) => t.label);

  await registerEntryFromTest(handle.app, {
    id: TEST_TOP_ID,
    type: 'top-level',
    label: TEST_TOP_LABEL,
  });
  await registerEntryFromTest(handle.app, {
    id: TEST_ITEM_ID,
    type: 'item',
    parentId: TEST_TOP_ID,
    label: TEST_ITEM_LABEL,
  });
  await sleep(REBUILD_WAIT_MS);

  const afterRegister = await getMenuStructure(handle.app);
  expect(afterRegister.find((t) => t.label === TEST_TOP_LABEL)).toBeDefined();

  // Remove the only child -- top-level should disappear because it has no children.
  await unregisterEntryFromTest(handle.app, TEST_ITEM_ID);
  await sleep(REBUILD_WAIT_MS);

  const afterChildRemoved = await getMenuStructure(handle.app);
  expect(afterChildRemoved.find((t) => t.label === TEST_TOP_LABEL)).toBeUndefined();

  // Remove the placeholder top-level too. Menu should now match the seeded baseline.
  await unregisterEntryFromTest(handle.app, TEST_TOP_ID);
  await sleep(REBUILD_WAIT_MS);

  const final = await getMenuStructure(handle.app);
  expect(final.map((t) => t.label)).toEqual(baselineLabels);
});
