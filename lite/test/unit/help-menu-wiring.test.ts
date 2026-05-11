/**
 * Unit tests for lite/help/menu-wiring.ts.
 *
 * Asserts the User Guide entry registers under top:help, has no
 * accelerator (per ADR-015), uses order 10 (above Report a Bug at 30
 * and Check for Updates at 50), and its click handler dispatches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HELP_USER_GUIDE_ID,
  HELP_USER_GUIDE_LABEL,
  registerHelpMenu,
  unregisterHelpMenu,
  isHelpMenuRegistered,
} from '../../help/menu-wiring.js';
import { registry } from '../../menu/registry.js';

beforeEach(() => {
  registry._resetForTesting();
});

describe('registerHelpMenu', () => {
  it('registers help:user-guide under top:help', () => {
    const onOpen = vi.fn();
    registerHelpMenu({ onOpenUserGuide: onOpen });
    const entry = registry.get(HELP_USER_GUIDE_ID);
    expect(entry).toBeDefined();
    expect(entry?.parentId).toBe('top:help');
    expect(entry?.label).toBe(HELP_USER_GUIDE_LABEL);
    expect(entry?.type).toBe('item');
  });

  it('does NOT bind an accelerator (per ADR-015)', () => {
    registerHelpMenu({ onOpenUserGuide: () => {} });
    const entry = registry.get(HELP_USER_GUIDE_ID);
    expect(entry?.accelerator).toBeUndefined();
  });

  it('does NOT bind an item-level role (per ADR-015)', () => {
    registerHelpMenu({ onOpenUserGuide: () => {} });
    const entry = registry.get(HELP_USER_GUIDE_ID);
    expect(entry?.role).toBeUndefined();
  });

  it('uses order=10 so it sits above Report a Bug (30) and Check for Updates (50)', () => {
    registerHelpMenu({ onOpenUserGuide: () => {} });
    const entry = registry.get(HELP_USER_GUIDE_ID);
    expect(entry?.order).toBe(10);
  });

  it('the click handler invokes the supplied onOpenUserGuide', () => {
    const onOpen = vi.fn();
    registerHelpMenu({ onOpenUserGuide: onOpen });
    const entry = registry.get(HELP_USER_GUIDE_ID);
    entry?.click?.();
    expect(onOpen).toHaveBeenCalled();
  });

  it('is idempotent (re-registering replaces the click handler)', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerHelpMenu({ onOpenUserGuide: first });
    registerHelpMenu({ onOpenUserGuide: second });
    registry.get(HELP_USER_GUIDE_ID)?.click?.();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});

describe('unregisterHelpMenu', () => {
  it('removes the entry', () => {
    registerHelpMenu({ onOpenUserGuide: () => {} });
    unregisterHelpMenu();
    expect(registry.get(HELP_USER_GUIDE_ID)).toBeUndefined();
    expect(isHelpMenuRegistered()).toBe(false);
  });
});

describe('Help menu integration with kernel seed', () => {
  it('User Guide (10) sorts above Report a Bug (30) when both are registered', async () => {
    const { seedKernelMenu, _resetSeedForTesting } = await import('../../menu/seed.js');
    _resetSeedForTesting();
    seedKernelMenu({
      onAbout: () => {},
      onQuit: () => {},
      onReportBug: () => {},
    });
    registerHelpMenu({ onOpenUserGuide: () => {} });
    const helpMenu = registry.getChildren('top:help');
    expect(helpMenu.map((e) => e.id)).toEqual([
      HELP_USER_GUIDE_ID,
      'help:report-bug',
    ]);
  });
});
