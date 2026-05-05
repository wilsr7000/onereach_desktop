/**
 * Menu Builder -- subscribes to the registry and rebuilds the Electron
 * application menu on every change. Top-level entries with no children
 * are NOT rendered, so pre-registered placeholders stay invisible until
 * their first child registers.
 *
 * This is the only file that knows about Electron's Menu API. Everything
 * else describes intent via MenuEntry.
 *
 * Borrowed pattern: section composition + dynamic rebuild trigger from
 *   menu.js + lib/menu-sections/idw-gsx-builder.js + module-manager.js
 *   updateApplicationMenu (full app, not imported, only studied).
 */

import { Menu, type MenuItemConstructorOptions } from 'electron';
import { registry, type MenuEntry } from './registry.js';
import { getLoggingApi } from '../logging/api.js';

let unsubscribe: (() => void) | null = null;
let rebuildScheduled = false;

/**
 * Resolve a static-or-function value to its current value.
 */
function resolveValue<T>(value: T | (() => T) | undefined): T | undefined {
  if (typeof value === 'function') {
    return (value as () => T)();
  }
  return value;
}

/**
 * Convert a MenuEntry to Electron's MenuItemConstructorOptions, recursively
 * filling in submenus from registry children.
 */
function entryToOptions(entry: MenuEntry): MenuItemConstructorOptions | null {
  if (entry.type === 'separator') {
    return { type: 'separator' };
  }

  const children = registry.getChildren(entry.id);

  if (entry.type === 'top-level') {
    // Top-level menus with no children do not render
    if (children.length === 0) return null;
    const submenuOptions = children
      .map(entryToOptions)
      .filter((o): o is MenuItemConstructorOptions => o !== null);
    if (submenuOptions.length === 0) return null;
    const opts: MenuItemConstructorOptions = {
      submenu: submenuOptions,
    };
    if (entry.role !== undefined) opts.role = entry.role;
    const label = resolveValue(entry.label);
    if (label !== undefined) opts.label = label;
    return opts;
  }

  // type === 'item'
  const opts: MenuItemConstructorOptions = {};
  if (entry.role !== undefined) opts.role = entry.role;
  const label = resolveValue(entry.label);
  if (label !== undefined) opts.label = label;
  if (entry.accelerator !== undefined) opts.accelerator = entry.accelerator;
  const enabled = resolveValue(entry.enabled);
  if (enabled !== undefined) opts.enabled = enabled;
  const visible = resolveValue(entry.visible);
  if (visible !== undefined) opts.visible = visible;
  if (entry.click !== undefined) {
    const click = entry.click;
    opts.click = () => {
      // Surface every menu click as an event so users-action causality
      // is observable in /logs and bug reports. ADR-026.
      getLoggingApi().event('menu.click', { id: entry.id, label });
      try {
        const result = click();
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            const message = (err as Error).message;
            getLoggingApi().error('menu', `click handler for '${entry.id}' rejected`, {
              id: entry.id,
              error: message,
            });
            getLoggingApi().event(
              'menu.click.failed',
              { id: entry.id, label, error: message },
              'error'
            );
          });
        }
      } catch (err) {
        const message = (err as Error).message;
        getLoggingApi().error('menu', `click handler for '${entry.id}' threw`, {
          id: entry.id,
          error: message,
        });
        getLoggingApi().event(
          'menu.click.failed',
          { id: entry.id, label, error: message },
          'error'
        );
      }
    };
  }
  if (children.length > 0) {
    const submenuOptions = children
      .map(entryToOptions)
      .filter((o): o is MenuItemConstructorOptions => o !== null);
    if (submenuOptions.length > 0) opts.submenu = submenuOptions;
  }
  return opts;
}

/**
 * Build the full menu template from the registry.
 */
function buildTemplate(): MenuItemConstructorOptions[] {
  const topLevels = registry.getChildren(undefined);
  const template: MenuItemConstructorOptions[] = [];
  for (const entry of topLevels) {
    const opts = entryToOptions(entry);
    if (opts !== null) template.push(opts);
  }
  return template;
}

/**
 * Rebuild and apply the application menu. Debounced via microtask so
 * burst-registrations during boot collapse to one rebuild.
 */
export function rebuildMenu(): void {
  if (rebuildScheduled) return;
  rebuildScheduled = true;
  queueMicrotask(() => {
    rebuildScheduled = false;
    const template = buildTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  });
}

/**
 * Initialize the menu builder. Call once after registry has been seeded
 * (or at boot -- subsequent registrations trigger rebuilds automatically).
 */
export function initMenu(): void {
  if (unsubscribe !== null) return;
  unsubscribe = registry.onChange(rebuildMenu);
  rebuildMenu();
}

/**
 * Tear down for tests / reload.
 */
export function teardownMenu(): void {
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
  Menu.setApplicationMenu(null);
}

/** Exported for tests: build the template without applying it. */
export function _buildTemplateForTesting(): MenuItemConstructorOptions[] {
  return buildTemplate();
}
