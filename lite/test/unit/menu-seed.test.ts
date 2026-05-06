import { describe, it, expect, beforeEach } from 'vitest';
import { seedKernelMenu, _resetSeedForTesting, isSeeded } from '../../menu/seed.js';
import { registry } from '../../menu/registry.js';

describe('seedKernelMenu', () => {
  beforeEach(() => {
    registry._resetForTesting();
    _resetSeedForTesting();
  });

  function noop(): void {
    /* test handler */
  }

  const handlers = { onReportBug: noop, onAbout: noop, onQuit: noop };

  it('registers exactly the kernel entries (no extras)', () => {
    seedKernelMenu(handlers);

    // Kernel ships with: top:app + 2 items + the Edit submenu (top:edit
    // nested under top:app), top:help + 1 item, and 8 Edit entries
    // (6 role-driven items + 2 separators) under top:edit. The Edit
    // menu is the documented exception to the no-role-no-accelerator
    // policy because Cmd+C / Cmd+V / etc. require role-based items to
    // dispatch via Electron's menu.
    const ids = [
      'top:app',
      'top:help',
      'top:edit',
      'app:about',
      'app:quit',
      'help:report-bug',
      'edit:undo',
      'edit:redo',
      'edit:sep-1',
      'edit:cut',
      'edit:copy',
      'edit:paste',
      'edit:sep-2',
      'edit:select-all',
    ];
    for (const id of ids) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registry.size()).toBe(ids.length);
  });

  it('seeds top-level menus in order: app, help (Edit is nested under top:app)', () => {
    seedKernelMenu(handlers);
    const tops = registry.getChildren();
    expect(tops.map((e) => e.id)).toEqual(['top:app', 'top:help']);
  });

  it('top:edit is a non-top-level item parented to top:app', () => {
    seedKernelMenu(handlers);
    const edit = registry.get('top:edit');
    expect(edit?.type).toBe('item');
    expect(edit?.parentId).toBe('top:app');
    expect(edit?.label).toBe('Edit');
  });

  it('Edit menu has the standard items in order', () => {
    seedKernelMenu(handlers);
    const editMenu = registry.getChildren('top:edit');
    expect(editMenu.map((e) => e.id)).toEqual([
      'edit:undo',
      'edit:redo',
      'edit:sep-1',
      'edit:cut',
      'edit:copy',
      'edit:paste',
      'edit:sep-2',
      'edit:select-all',
    ]);
    // Each clickable item carries an Electron role -- the role IS
    // what gives it the platform-default accelerator (Cmd+C, etc.)
    // and wires it into the focused webContents.
    expect(registry.get('edit:cut')?.role).toBe('cut');
    expect(registry.get('edit:copy')?.role).toBe('copy');
    expect(registry.get('edit:paste')?.role).toBe('paste');
    expect(registry.get('edit:select-all')?.role).toBe('selectAll');
    expect(registry.get('edit:undo')?.role).toBe('undo');
    expect(registry.get('edit:redo')?.role).toBe('redo');
  });

  it('app menu has About, Edit (submenu), then Quit', () => {
    seedKernelMenu(handlers);
    const appMenu = registry.getChildren('top:app');
    expect(appMenu.map((e) => e.id)).toEqual(['app:about', 'top:edit', 'app:quit']);
  });

  it('help menu has Report a Bug', () => {
    seedKernelMenu(handlers);
    const helpMenu = registry.getChildren('top:help');
    expect(helpMenu.map((e) => e.id)).toEqual(['help:report-bug']);
    expect(helpMenu[0]?.label).toBe('Report a Bug...');
  });

  it('NO accelerators are bound on any item (per ADR-015)', () => {
    seedKernelMenu(handlers);
    for (const id of ['app:about', 'app:quit', 'help:report-bug']) {
      const entry = registry.get(id);
      expect(entry?.accelerator).toBeUndefined();
    }
  });

  it('NO role-driven menu items (avoids platform-default accelerators)', () => {
    seedKernelMenu(handlers);
    for (const id of ['app:about', 'app:quit', 'help:report-bug']) {
      const entry = registry.get(id);
      expect(entry?.role).toBeUndefined();
    }
  });

  it('every kernel item uses an explicit label (not role-derived)', () => {
    seedKernelMenu(handlers);
    expect(registry.get('app:about')?.label).toBe('About Onereach.ai Lite');
    expect(registry.get('app:quit')?.label).toBe('Quit Onereach.ai Lite');
    expect(registry.get('help:report-bug')?.label).toBe('Report a Bug...');
  });

  it('every kernel item has an explicit click handler', () => {
    seedKernelMenu(handlers);
    expect(registry.get('app:about')?.click).toBeDefined();
    expect(registry.get('app:quit')?.click).toBeDefined();
    expect(registry.get('help:report-bug')?.click).toBeDefined();
  });

  it('top:app keeps role:appMenu (for macOS positioning); top:help has NO role (per ADR-017)', () => {
    seedKernelMenu(handlers);
    expect(registry.get('top:app')?.role).toBe('appMenu');
    // Per ADR-017, top:help intentionally has no role -- avoids macOS
    // injecting "Send <AppName> Feedback to Apple..." into the menu.
    expect(registry.get('top:help')?.role).toBeUndefined();
    expect(registry.get('top:help')?.label).toBe('Help');
  });

  it('idempotent (safe to call twice via upsert)', () => {
    seedKernelMenu(handlers);
    const sizeAfterFirst = registry.size();
    expect(() => seedKernelMenu(handlers)).not.toThrow();
    expect(registry.size()).toBe(sizeAfterFirst);
  });

  it('isSeeded reflects state', () => {
    expect(isSeeded()).toBe(false);
    seedKernelMenu(handlers);
    expect(isSeeded()).toBe(true);
  });

  it('Report a Bug click invokes the provided handler', () => {
    let count = 0;
    seedKernelMenu({
      onReportBug: () => {
        count += 1;
      },
      onAbout: noop,
      onQuit: noop,
    });
    const entry = registry.get('help:report-bug');
    expect(entry?.click).toBeDefined();
    entry?.click?.();
    expect(count).toBe(1);
  });

  it('About click invokes the provided handler', () => {
    let count = 0;
    seedKernelMenu({
      onReportBug: noop,
      onAbout: () => {
        count += 1;
      },
      onQuit: noop,
    });
    const entry = registry.get('app:about');
    expect(entry?.click).toBeDefined();
    entry?.click?.();
    expect(count).toBe(1);
  });

  it('Quit click invokes the provided handler', () => {
    let count = 0;
    seedKernelMenu({
      onReportBug: noop,
      onAbout: noop,
      onQuit: () => {
        count += 1;
      },
    });
    const entry = registry.get('app:quit');
    expect(entry?.click).toBeDefined();
    entry?.click?.();
    expect(count).toBe(1);
  });

  it('does not register top:tools (owned by lite/tools/menu-builder.ts)', () => {
    seedKernelMenu(handlers);
    expect(registry.has('top:tools')).toBe(false);
    expect(registry.has('tools:manage')).toBe(false);
  });

  it('registers Dev Tools menu only when DevTools handlers are provided', () => {
    seedKernelMenu({
      ...handlers,
      onOpenFocusedDevTools: noop,
      onOpenActiveTabDevTools: noop,
      onOpenAllDevTools: noop,
    });

    expect(registry.get('top:dev-tools')?.label).toBe('Dev Tools');
    expect(registry.get('top:dev-tools')?.role).toBeUndefined();
    expect(registry.get('top:dev-tools')?.accelerator).toBeUndefined();
    expect(registry.getChildren().map((e) => e.id)).toEqual([
      'top:app',
      'top:dev-tools',
      'top:help',
    ]);
    expect(registry.getChildren('top:dev-tools').map((e) => e.id)).toEqual([
      'dev-tools:open-focused-window',
      'dev-tools:open-active-tab',
      'dev-tools:open-all-windows',
    ]);
  });

  it('Dev Tools entries use click handlers without accelerators or roles', () => {
    seedKernelMenu({
      ...handlers,
      onOpenFocusedDevTools: noop,
      onOpenActiveTabDevTools: noop,
      onOpenAllDevTools: noop,
    });

    for (const id of [
      'dev-tools:open-focused-window',
      'dev-tools:open-active-tab',
      'dev-tools:open-all-windows',
    ]) {
      const entry = registry.get(id);
      expect(entry?.click).toBeDefined();
      expect(entry?.accelerator).toBeUndefined();
      expect(entry?.role).toBeUndefined();
    }
  });
});
