/**
 * Tools menu builder.
 *
 * Owns the lifecycle of the `top:tools` menu and all its children:
 *
 *  - Registers `top:tools` placeholder on init. Empty top-levels
 *    auto-hide (lite/menu/build-menu.ts), but they don't auto-create,
 *    so this module owns the placeholder.
 *  - Registers the always-present "Manage Tools..." item (and the
 *    separator above it when there are user entries).
 *  - Subscribes to `ToolsApi.onChange` and rebuilds the per-tool items
 *    on every mutation.
 *  - Empty-state: when no user tools exist, surfaces a disabled
 *    "Add a tool to get started" hint above the Manage item.
 *
 * Per ADR-019 / Rule 11, this module is internal.
 *
 * @internal
 */

import { registry } from '../menu/registry.js';
import { getToolsApi } from './api.js';
import type { ToolsApi, ToolEntry } from './api.js';
import { getLoggingApi } from '../logging/api.js';
import { TOOLS_EVENTS } from './events.js';

/** Stable top-level id reserved for the Tools menu. Order 70 places it between IDW (60) and University (80). */
export const TOP_LEVEL_ID = 'top:tools';
/** Stable id for the empty-state hint item (only present when no entries). */
export const EMPTY_ITEM_ID = 'tools:empty-hint';
/** Stable id for the always-present "Manage Tools..." item. */
export const MANAGE_ID = 'tools:manage';
/** Stable id of the divider above the Manage item (only present when there are entries). */
export const TAIL_SEPARATOR_ID = 'tools:tail-separator';

/** Order block reserved for user entries; tail block sits above this. */
const ENTRIES_ORDER_BASE = 100;
const TAIL_BASE = 9000;

export interface MenuBuilderConfig {
  /** Called when a user clicks a tool in the menu. */
  onOpenEntry: (entry: ToolEntry) => void;
  /** Called when the user clicks "Manage Tools...". */
  onOpenManager: () => void;
  /** Optional override for the Tools API (for tests). */
  api?: ToolsApi;
}

let unsubscribe: (() => void) | null = null;
const dynamicIds = new Set<string>();
let initialized = false;
let configRef: MenuBuilderConfig | null = null;

export function initMenuBuilder(config: MenuBuilderConfig): void {
  if (initialized) return;
  configRef = config;

  // 1. Top-level placeholder.
  registry.upsert({
    id: TOP_LEVEL_ID,
    type: 'top-level',
    label: 'Tools',
    order: 70,
  });

  // 2. Always-present Manage item.
  registry.upsert({
    id: MANAGE_ID,
    type: 'item',
    parentId: TOP_LEVEL_ID,
    label: 'Manage Tools...',
    order: TAIL_BASE + 1,
    click: () => config.onOpenManager(),
  });

  // 3. Subscribe + initial render.
  const api = config.api ?? getToolsApi();
  unsubscribe = api.onChange((entries) => rebuild(entries));

  void api
    .list()
    .then((entries) => rebuild(entries))
    .catch((err: unknown) => {
      getLoggingApi().warn('tools', 'menu-builder: initial list() failed', {
        error: (err as Error).message,
      });
      rebuild([]);
    });

  initialized = true;
}

export function teardownMenuBuilder(): void {
  if (!initialized) return;
  if (unsubscribe !== null) {
    try {
      unsubscribe();
    } catch {
      // best-effort
    }
    unsubscribe = null;
  }
  for (const id of dynamicIds) {
    registry.unregister(id);
  }
  dynamicIds.clear();
  registry.unregister(MANAGE_ID);
  registry.unregister(EMPTY_ITEM_ID);
  registry.unregister(TAIL_SEPARATOR_ID);
  registry.unregister(TOP_LEVEL_ID);
  initialized = false;
  configRef = null;
}

/**
 * Recompute the dynamic part of the menu (everything except the top
 * placeholder + Manage item).
 *
 * Strategy: build the desired set of entries with stable ids, then
 * unregister anything in `dynamicIds` that's not in the new set,
 * then upsert the new set.
 */
function rebuild(entries: ToolEntry[]): void {
  if (configRef === null) return;
  const config = configRef;
  const desired = computeDynamicEntries(entries, config);
  const desiredIds = new Set(desired.map((d) => d.id));
  for (const id of Array.from(dynamicIds)) {
    if (!desiredIds.has(id)) {
      registry.unregister(id);
      dynamicIds.delete(id);
    }
  }
  for (const entry of desired) {
    registry.upsert(entry);
    dynamicIds.add(entry.id);
  }
}

interface DynamicEntry {
  id: string;
  type: 'item' | 'separator';
  parentId: string;
  label?: string;
  order: number;
  enabled?: boolean;
  click?: () => void;
}

function computeDynamicEntries(entries: ToolEntry[], config: MenuBuilderConfig): DynamicEntry[] {
  const out: DynamicEntry[] = [];

  if (entries.length === 0) {
    out.push({
      id: EMPTY_ITEM_ID,
      type: 'item',
      parentId: TOP_LEVEL_ID,
      label: 'Add a tool to get started -- click Manage Tools below.',
      order: 50,
      enabled: false,
    });
    return out;
  }

  entries.forEach((entry, i) => {
    out.push({
      id: `tools:item:${entry.id}`,
      type: 'item',
      parentId: TOP_LEVEL_ID,
      label: entry.label,
      order: ENTRIES_ORDER_BASE + i,
      click: () => {
        getLoggingApi().event(TOOLS_EVENTS.OPENED, { id: entry.id });
        config.onOpenEntry(entry);
      },
    });
  });

  // Separator between entries and Manage item.
  out.push({
    id: TAIL_SEPARATOR_ID,
    type: 'separator',
    parentId: TOP_LEVEL_ID,
    order: TAIL_BASE,
  });

  return out;
}

/** @internal -- testing helper. */
export function _isMenuBuilderInitializedForTesting(): boolean {
  return initialized;
}

/** @internal -- testing helper. */
export function _getDynamicIdsForTesting(): ReadonlySet<string> {
  return dynamicIds;
}
