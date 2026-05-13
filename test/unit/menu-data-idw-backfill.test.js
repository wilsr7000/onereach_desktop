/**
 * menu-data-manager -- IDW environment backfill (regression)
 *
 * Legacy IDW entries (saved before the agent-explorer "Add IDW" form
 * started stamping `environment: 'custom'`) carry no `environment`
 * field. The menu builder (lib/menu-sections/idw-gsx-builder.js)
 * silently drops any IDW with a missing `environment` -- the entry
 * stays in `idw-entries.json` but never reaches the menu. The user
 * (correctly) reads this as "the IDW disappeared / I can't add one".
 *
 * Fix: the validator now backfills `environment: 'custom'` for any
 * entry missing that field. The menu builder also backfills at render
 * time as a belt-and-suspenders heal. This test pins the validator
 * contract.
 *
 * Run: npx vitest run test/unit/menu-data-idw-backfill.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// menu-data-manager touches electron + the log queue. Stub them so we
// can import the class and exercise the validator directly without
// booting the whole app.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp/menu-data-test' },
  BrowserWindow: { getAllWindows: () => [] },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { MenuDataManager } = require('../../menu-data-manager');

function makeManager() {
  // Build a fresh instance and skip filesystem init -- we just want to
  // exercise the pure validator.
  const mgr = new MenuDataManager();
  return mgr;
}

describe('MenuDataManager._validateIDWEnvironments -- environment backfill', () => {
  let mgr;
  beforeEach(() => { mgr = makeManager(); });

  it('preserves an entry that already has environment set', () => {
    const result = mgr._validateIDWEnvironments([
      { id: 'idw-1', label: 'Edison', chatUrl: 'https://e.io', environment: 'edison' },
    ]);
    expect(result.valid).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].environment).toBe('edison');
  });

  it('backfills environment to "custom" when missing', () => {
    const result = mgr._validateIDWEnvironments([
      { id: 'idw-legacy', label: 'Knowledge Demo', chatUrl: 'https://idw.example.com/chat/abc' },
    ]);
    expect(result.valid).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].environment).toBe('custom');
  });

  it('treats empty-string environment as missing and backfills', () => {
    const result = mgr._validateIDWEnvironments([
      { id: 'idw-x', label: 'X', chatUrl: 'https://x', environment: '' },
    ]);
    expect(result.data[0].environment).toBe('custom');
  });

  it('does not touch an entry with environment set to a non-default value', () => {
    const result = mgr._validateIDWEnvironments([
      { id: 'a', label: 'A', chatUrl: 'https://a', environment: 'staging' },
      { id: 'b', label: 'B', chatUrl: 'https://b', environment: 'production' },
    ]);
    expect(result.data[0].environment).toBe('staging');
    expect(result.data[1].environment).toBe('production');
  });

  it('still drops entries missing both id AND label (validator core contract intact)', () => {
    const result = mgr._validateIDWEnvironments([
      { chatUrl: 'https://no-anchors' },
    ]);
    // No id and no label -> validator returns null for this item (skipped)
    // and accumulates the error. When label IS provided, the validator
    // auto-generates an id from it, so we test the truly-anchorless case.
    expect(result.data).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('auto-generates an id from label and still backfills environment', () => {
    const result = mgr._validateIDWEnvironments([
      { label: 'No ID Provided', chatUrl: 'https://x' },
    ]);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBeTruthy();
    expect(result.data[0].environment).toBe('custom');
  });

  it('mixed batch: backfills some, leaves others alone, drops invalid', () => {
    const result = mgr._validateIDWEnvironments([
      { id: 'good', label: 'Good', chatUrl: 'https://good', environment: 'edison' },
      { id: 'legacy', label: 'Legacy', chatUrl: 'https://legacy' }, // missing environment
      { /* missing id and label */ chatUrl: 'https://orphan' },
    ]);
    // Two survive; one is dropped.
    expect(result.data).toHaveLength(2);
    expect(result.data.find((e) => e.id === 'good').environment).toBe('edison');
    expect(result.data.find((e) => e.id === 'legacy').environment).toBe('custom');
  });
});
