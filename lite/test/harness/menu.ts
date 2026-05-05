/**
 * Onereach Lite Test Harness -- Menu introspection + interaction.
 *
 * Reads Electron's application menu structure via app.evaluate, finds menu
 * items by label or by registry id, and clicks them. Tests should prefer
 * `clickMenuItemById` (stable across label changes) when registering ids
 * via lite/menu/registry.ts; `clickMenuItem` (by label) is the fallback
 * for native role-driven items where no id exists.
 */

import type { ElectronApplication } from '@playwright/test';

export interface MenuItemInfo {
  label: string;
  role: string | null;
  accelerator: string | null;
  type: string | null;
  enabled: boolean;
  visible: boolean;
  hasSubmenu: boolean;
}

export interface TopLevelInfo extends MenuItemInfo {
  /** Children of this top-level. Empty array if no submenu. */
  items: MenuItemInfo[];
}

/**
 * Snapshot the entire application menu structure -- top-levels with their
 * direct children. Useful for asserting menu shape.
 */
export async function getMenuStructure(app: ElectronApplication): Promise<TopLevelInfo[]> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (menu === null) return [];
    return menu.items.map((top) => {
      const items = top.submenu
        ? top.submenu.items.map((it) => ({
            label: it.label,
            role: it.role ?? null,
            accelerator: it.accelerator ?? null,
            type: it.type ?? null,
            enabled: it.enabled,
            visible: it.visible,
            hasSubmenu: it.submenu !== undefined && it.submenu !== null,
          }))
        : [];
      return {
        label: top.label,
        role: top.role ?? null,
        accelerator: top.accelerator ?? null,
        type: top.type ?? null,
        enabled: top.enabled,
        visible: top.visible,
        hasSubmenu: top.submenu !== undefined && top.submenu !== null,
        items,
      };
    });
  });
}

/**
 * Click a menu item by its label. Searches all top-levels' direct children.
 * Throws if no matching item is found.
 *
 * Prefer clickMenuItemById when the item is registered via the menu
 * registry -- labels can change, ids are stable.
 */
export async function clickMenuItem(app: ElectronApplication, label: string): Promise<void> {
  const found = await app.evaluate(({ Menu }, targetLabel: string) => {
    const menu = Menu.getApplicationMenu();
    if (menu === null) return false;
    for (const top of menu.items) {
      if (top.submenu === undefined || top.submenu === null) continue;
      for (const it of top.submenu.items) {
        if (it.label === targetLabel) {
          it.click();
          return true;
        }
      }
    }
    return false;
  }, label);
  if (!found) {
    const structure = await getMenuStructure(app);
    const labels = structure
      .flatMap((top) => top.items.map((it) => `${top.label} > ${it.label}`))
      .join(', ');
    throw new Error(`Menu item not found: '${label}'. Available: ${labels}`);
  }
}

/**
 * Click a menu item by its registry id. The lite menu builder doesn't
 * forward the registry id onto Electron's MenuItem, so this requires
 * looking up the entry's label in the registry first then matching by
 * label. Implemented entirely in the main process so a single round-trip
 * resolves both lookup and click.
 *
 * If you have multiple registry items with identical labels, prefer
 * clicking via the renderer-side IPC instead.
 */
export async function clickMenuItemById(
  app: ElectronApplication,
  registryId: string
): Promise<void> {
  const result = await app.evaluate(
    async ({ Menu }, id: string) => {
      // The registry is a runtime-only object; require it from the bundled
      // location. Different bundling layouts make the path uncertain, so
      // try a couple of candidates.
      const candidates = ['./menu/registry.js', '../menu/registry.js', './registry.js'];
      let registry: { get?: (id: string) => { label?: string | (() => string) } | undefined } | null =
        null;
      for (const candidate of candidates) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
          const mod = require(candidate) as {
            registry?: { get?: (id: string) => { label?: string | (() => string) } | undefined };
          };
          if (mod && mod.registry !== undefined) {
            registry = mod.registry;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (registry === null || registry.get === undefined) {
        return { ok: false, reason: 'registry not loadable from main process' };
      }
      const entry = registry.get(id);
      if (entry === undefined) return { ok: false, reason: `entry '${id}' not registered` };
      const label = typeof entry.label === 'function' ? entry.label() : entry.label;
      if (label === undefined) return { ok: false, reason: `entry '${id}' has no label` };
      const menu = Menu.getApplicationMenu();
      if (menu === null) return { ok: false, reason: 'application menu is null' };
      for (const top of menu.items) {
        if (top.submenu === undefined || top.submenu === null) continue;
        for (const it of top.submenu.items) {
          if (it.label === label) {
            it.click();
            return { ok: true, reason: '' };
          }
        }
      }
      return { ok: false, reason: `label '${label}' not found in menu` };
    },
    registryId
  );
  if (!result.ok) {
    throw new Error(`clickMenuItemById('${registryId}') failed: ${result.reason}`);
  }
}

/**
 * Register a menu entry into the live registry from a test. Drives the
 * registry's `change` event, which the builder reacts to by rebuilding
 * the Electron menu. Used by menu-lifecycle E2E tests to verify that
 * dynamic registrations propagate end-to-end.
 *
 * Mirrors `clickMenuItemById`'s candidate-path discovery for the registry.
 *
 * NOTE: `click` and `enabled`/`visible` callbacks cannot cross the
 * IPC boundary -- they're stripped before insertion. Tests that need
 * dynamic state should set static `enabled`/`visible` booleans.
 */
export async function registerEntryFromTest(
  app: ElectronApplication,
  entry: {
    id: string;
    type: 'top-level' | 'item' | 'separator';
    parentId?: string;
    label?: string;
    order?: number;
    enabled?: boolean;
    visible?: boolean;
  }
): Promise<void> {
  const result = await app.evaluate(async (_, payload) => {
    // main-lite.ts attaches the registry to globalThis when LITE_TEST_MODE
    // is set. launchLite() always sets it, so this is the canonical path.
    const exposed = (globalThis as Record<string, unknown>).__liteMenuRegistry as
      | { register?: (e: unknown) => void }
      | undefined;
    if (exposed === undefined || exposed.register === undefined) {
      return { ok: false, reason: 'registry not exposed -- is LITE_TEST_MODE set?' };
    }
    try {
      exposed.register(payload);
      return { ok: true, reason: '' };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }, entry);
  if (!result.ok) {
    throw new Error(`registerEntryFromTest('${entry.id}') failed: ${result.reason}`);
  }
}

/**
 * Unregister a menu entry from the live registry. Counterpart to
 * registerEntryFromTest -- used to verify that removing entries
 * propagates back through the rebuild path.
 */
export async function unregisterEntryFromTest(
  app: ElectronApplication,
  id: string
): Promise<void> {
  await app.evaluate((_, registryId: string) => {
    const exposed = (globalThis as Record<string, unknown>).__liteMenuRegistry as
      | { unregister?: (id: string) => void }
      | undefined;
    if (exposed !== undefined && exposed.unregister !== undefined) {
      exposed.unregister(registryId);
    }
  }, id);
}

/**
 * Get the children of a top-level menu by its label. Useful for asserting
 * that a sub-menu has the expected items in the expected order.
 */
export async function getSubmenuItems(
  app: ElectronApplication,
  topLabel: string
): Promise<MenuItemInfo[]> {
  const structure = await getMenuStructure(app);
  const top = structure.find((t) => t.label === topLabel);
  if (top === undefined) {
    throw new Error(
      `Top-level menu '${topLabel}' not found. Available: ${structure.map((t) => t.label).join(', ')}`
    );
  }
  return top.items;
}
