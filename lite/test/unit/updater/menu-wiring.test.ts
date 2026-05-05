/**
 * Unit tests for lite/updater/menu-wiring.ts.
 *
 * Asserts the Check for Updates entry registers under top:help, has no
 * accelerator (per ADR-015), and is idempotent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CHECK_FOR_UPDATES_ID,
  CHECK_FOR_UPDATES_LABEL,
  registerUpdaterMenu,
  unregisterUpdaterMenu,
  isUpdaterMenuRegistered,
} from '../../../updater/menu-wiring.js';
import { registry } from '../../../menu/registry.js';

beforeEach(() => {
  registry._resetForTesting();
});

describe('registerUpdaterMenu', () => {
  it('registers help:check-for-updates under top:help', () => {
    const onCheck = vi.fn();
    registerUpdaterMenu({ onCheckForUpdates: onCheck });
    const entry = registry.get(CHECK_FOR_UPDATES_ID);
    expect(entry).toBeDefined();
    expect(entry?.parentId).toBe('top:help');
    expect(entry?.label).toBe(CHECK_FOR_UPDATES_LABEL);
    expect(entry?.type).toBe('item');
  });

  it('does NOT bind an accelerator (per ADR-015)', () => {
    registerUpdaterMenu({ onCheckForUpdates: () => {} });
    const entry = registry.get(CHECK_FOR_UPDATES_ID);
    expect(entry?.accelerator).toBeUndefined();
  });

  it('does NOT bind an item-level role (per ADR-015)', () => {
    registerUpdaterMenu({ onCheckForUpdates: () => {} });
    const entry = registry.get(CHECK_FOR_UPDATES_ID);
    expect(entry?.role).toBeUndefined();
  });

  it('uses order=50 so future Help entries can fit on either side', () => {
    registerUpdaterMenu({ onCheckForUpdates: () => {} });
    const entry = registry.get(CHECK_FOR_UPDATES_ID);
    expect(entry?.order).toBe(50);
  });

  it('the click handler invokes the supplied onCheckForUpdates', () => {
    const onCheck = vi.fn();
    registerUpdaterMenu({ onCheckForUpdates: onCheck });
    const entry = registry.get(CHECK_FOR_UPDATES_ID);
    entry?.click?.();
    expect(onCheck).toHaveBeenCalled();
  });

  it('is idempotent (re-registering replaces the click handler)', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerUpdaterMenu({ onCheckForUpdates: first });
    registerUpdaterMenu({ onCheckForUpdates: second });
    registry.get(CHECK_FOR_UPDATES_ID)?.click?.();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});

describe('unregisterUpdaterMenu', () => {
  it('removes the entry', () => {
    registerUpdaterMenu({ onCheckForUpdates: () => {} });
    unregisterUpdaterMenu();
    expect(registry.get(CHECK_FOR_UPDATES_ID)).toBeUndefined();
    expect(isUpdaterMenuRegistered()).toBe(false);
  });
});
