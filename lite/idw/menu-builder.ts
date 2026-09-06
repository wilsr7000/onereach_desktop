/**
 * IDW menu builder.
 *
 * Owns the lifecycle of the `top:idw` menu and all its children:
 *
 *  - Registers the `top:idw` placeholder on init (per the
 *    review-fix #1: empty top-levels auto-HIDE per
 *    `lite/menu/build-menu.ts:43-49`, but they don't auto-CREATE,
 *    so this module owns the placeholder).
 *  - Subscribes to `IdwApi.onChange` and rebuilds menu entries on
 *    every mutation. Rebuilds use `registry.upsert()` for idempotent
 *    re-registration; entries removed since the last rebuild are
 *    explicitly `unregister()`-ed.
 *  - The always-present Manage Agents item is registered once and stays.
 *    Store discovery lives inside Manage Agents. (No "Add Custom Agent" item -- the
 *    Settings -> IDWs section already has an "Add Custom Agent"
 *    button; surfacing it twice is noise.)
 *  - When the entry list is fully empty, a disabled welcoming item
 *    invites the user to start their journey as a product expert.
 *
 * Per ADR-019 / Rule 11, this module is internal -- consumers go
 * through `getIdwApi()` and the `top:idw` menu surface, never
 * import from here.
 *
 * @internal
 */

import { registry } from '../menu/registry.js';
import { getIdwApi } from './api.js';
import type { IdwApi, IdwEntry, AgentKind, AudioSubCategory } from './api.js';
import { KIND_META, AUDIO_SUB_LABELS } from './kind-metadata.js';
import { AGENT_KINDS, AUDIO_SUB_CATEGORIES } from './types.js';
import { getLoggingApi } from '../logging/api.js';
import { IDW_EVENTS } from './events.js';

/** Stable top-level id reserved for the IDW menu (PORTING.md order 60). */
export const TOP_LEVEL_ID = 'top:idw';
/** Stable id for the empty-state welcoming item. */
export const EMPTY_ITEM_ID = 'idw:empty-welcome';
/** Stable id for the always-present "Manage Agents..." item. */
export const MANAGE_ID = 'idw:manage';
/** Stable id of the divider between welcoming/sections and always-present block. */
export const TAIL_SEPARATOR_ID = 'idw:tail-separator';

/**
 * Render order constants. Section labels go at fixed offsets so the
 * menu builder doesn't accidentally interleave sections.
 *
 * The tail block (separator + always-present items) starts at 9000.
 */
const SECTION_ORDER_BASE: Record<AgentKind, number> = {
  idw: 100,
  'external-bot': 200,
  'image-creator': 300,
  'video-creator': 400,
  'audio-generator': 500,
  'ui-design-tool': 600,
};

const SECTION_OFFSET_LABEL = 0;
const SECTION_OFFSET_SEPARATOR_AFTER = 90;
const SECTION_OFFSET_ENTRIES_BASE = 1; // entries get base+1, base+2, ...
const TAIL_BASE = 9000;

export interface MenuBuilderConfig {
  /** Called when an IDW menu item is clicked. Receives the resolved entry. */
  onOpenEntry: (entry: IdwEntry) => void;
  /** Called when the "Manage Agents..." item is clicked. */
  onOpenSettings: () => void;
  /** Optional override for the IDW API (for tests). */
  api?: IdwApi;
}

let unsubscribe: (() => void) | null = null;
/** All menu-entry ids this module currently has registered (other than top + tail). */
const dynamicIds = new Set<string>();
let initialized = false;
let configRef: MenuBuilderConfig | null = null;

/**
 * Register the top-level placeholder + always-present tail items,
 * then subscribe to IdwApi.onChange to keep menu entries in sync.
 */
export function initMenuBuilder(config: MenuBuilderConfig): void {
  if (initialized) return;
  configRef = config;

  // ── 1. Top-level placeholder ────────────────────────────────────────
  // Empty top-levels auto-HIDE (lite/menu/build-menu.ts), so it's safe
  // to register before children exist.
  registry.upsert({
    id: TOP_LEVEL_ID,
    type: 'top-level',
    label: 'IDW',
    order: 60,
  });

  // ── 2. Always-present tail items ────────────────────────────────────
  registry.upsert({
    id: TAIL_SEPARATOR_ID,
    type: 'separator',
    parentId: TOP_LEVEL_ID,
    order: TAIL_BASE,
  });
  registry.upsert({
    id: MANAGE_ID,
    type: 'item',
    parentId: TOP_LEVEL_ID,
    label: 'Manage Agents...',
    order: TAIL_BASE + 1,
    click: () => config.onOpenSettings(),
  });

  // ── 3. Subscribe to entries + initial render ────────────────────────
  const api = config.api ?? getIdwApi();
  unsubscribe = api.onChange((entries) => rebuild(entries));

  // Kick an initial render. list() is async, so .then().
  void api
    .list()
    .then((entries) => rebuild(entries))
    .catch((err: unknown) => {
      // Keep the menu functional even if the initial read failed --
      // the welcoming empty state still renders.
      getLoggingApi().warn('idw', 'menu-builder: initial list() failed', {
        error: (err as Error).message,
      });
      rebuild([]);
    });

  initialized = true;
}

/**
 * Tear down the menu builder. Removes ALL entries this module
 * registered (top, tail, dynamic). Idempotent.
 */
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
  // Unregister all dynamic ids.
  for (const id of dynamicIds) {
    registry.unregister(id);
  }
  dynamicIds.clear();
  // Unregister tail items.
  registry.unregister(TAIL_SEPARATOR_ID);
  registry.unregister(MANAGE_ID);
  registry.unregister(EMPTY_ITEM_ID);
  // Unregister the top-level placeholder.
  registry.unregister(TOP_LEVEL_ID);
  initialized = false;
  configRef = null;
}

/**
 * Recompute the dynamic part of the menu (everything except the
 * top placeholder + tail items).
 *
 * Strategy: build the desired set of entries with stable ids, then
 * unregister anything in `dynamicIds` that's not in the new set,
 * then upsert the new set. This handles add/remove/rename in a
 * single pass without leaving orphans.
 */
function rebuild(entries: IdwEntry[]): void {
  if (configRef === null) return;
  const config = configRef;
  const desired = computeDynamicEntries(entries, config);

  const desiredIds = new Set(desired.map((d) => d.id));
  // Drop anything that was registered last time but isn't desired now.
  for (const id of Array.from(dynamicIds)) {
    if (!desiredIds.has(id)) {
      registry.unregister(id);
      dynamicIds.delete(id);
    }
  }
  // Upsert desired entries.
  for (const entry of desired) {
    registry.upsert(entry);
    dynamicIds.add(entry.id);
  }
}

/** A registry entry the dynamic builder wants to install. */
interface DynamicEntry {
  id: string;
  type: 'item' | 'separator';
  parentId: string;
  label?: string;
  order: number;
  enabled?: boolean;
  click?: () => void;
}

/**
 * Compute the dynamic-entry list for the given entries. This includes:
 *  - the welcoming disabled item (only when entries is empty)
 *  - per-kind section labels (only when the section has entries)
 *  - per-kind section separators (between non-empty sections)
 *  - one item per entry (or, for audio-generator, per sub-category submenu)
 *
 * The tail block (separator + Manage) is registered once
 * at init and not touched here.
 */
function computeDynamicEntries(entries: IdwEntry[], config: MenuBuilderConfig): DynamicEntry[] {
  const out: DynamicEntry[] = [];

  if (entries.length === 0) {
    out.push({
      id: EMPTY_ITEM_ID,
      type: 'item',
      parentId: TOP_LEVEL_ID,
      label: 'Start your journey as a product expert -- manage agents to install your first agent.',
      order: 50,
      enabled: false,
    });
    return out;
  }

  // Bucket entries by kind, preserving storage order within each bucket.
  const byKind: Map<AgentKind, IdwEntry[]> = new Map();
  for (const kind of AGENT_KINDS) byKind.set(kind, []);
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind);
    if (bucket !== undefined) bucket.push(entry);
  }

  // Track whether we've emitted any preceding non-empty section so we
  // can decide when to emit a separator before the next section.
  let needsLeadingSeparator = false;

  for (const kind of AGENT_KINDS) {
    const items = byKind.get(kind) ?? [];
    if (items.length === 0) continue;
    const meta = KIND_META[kind];
    const base = SECTION_ORDER_BASE[kind];

    // Separator between sections (only between two non-empty sections).
    if (needsLeadingSeparator) {
      out.push({
        id: `idw:section:${kind}:lead-sep`,
        type: 'separator',
        parentId: TOP_LEVEL_ID,
        order: base - 50,
      });
    }
    needsLeadingSeparator = true;

    // Section label.
    out.push({
      id: `idw:section:${kind}:label`,
      type: 'item',
      parentId: TOP_LEVEL_ID,
      label: meta.menuSectionLabel,
      order: base + SECTION_OFFSET_LABEL,
      enabled: false,
    });

    if (kind === 'audio-generator') {
      // Audio gets sub-category submenus. We model each submenu as a
      // disabled label (Electron menu item with submenu via parentId
      // resolution -- the registry's getChildren() makes a submenu
      // automatically when an entry has children).
      //
      // Actually the registry/build-menu pattern is: a parent item
      // becomes a submenu when other entries have parentId === <its
      // id>. So for each non-empty sub-category we register a
      // submenu-parent item (with a label), and register the audio
      // entries with parentId set to that submenu.
      const bySub: Map<AudioSubCategory, IdwEntry[]> = new Map();
      for (const sub of AUDIO_SUB_CATEGORIES) bySub.set(sub, []);
      for (const entry of items) {
        const sub = entry.audio?.subCategory;
        if (sub !== undefined && bySub.has(sub)) {
          (bySub.get(sub) as IdwEntry[]).push(entry);
        }
      }
      let subOffset = SECTION_OFFSET_ENTRIES_BASE;
      for (const sub of AUDIO_SUB_CATEGORIES) {
        const subItems = bySub.get(sub) ?? [];
        if (subItems.length === 0) continue;
        const submenuParentId = `idw:section:audio-generator:sub:${sub}`;
        out.push({
          id: submenuParentId,
          type: 'item',
          parentId: TOP_LEVEL_ID,
          label: AUDIO_SUB_LABELS[sub] ?? sub,
          order: base + subOffset,
        });
        subItems.forEach((entry, i) => {
          out.push({
            id: `idw:${entry.kind}:${entry.id}`,
            type: 'item',
            parentId: submenuParentId,
            label: entry.label,
            order: i,
            click: () => {
              getLoggingApi().event(IDW_EVENTS.OPENED, { id: entry.id, kind: entry.kind });
              config.onOpenEntry(entry);
            },
          });
        });
        subOffset += 1;
      }
    } else {
      items.forEach((entry, i) => {
        out.push({
          id: `idw:${entry.kind}:${entry.id}`,
          type: 'item',
          parentId: TOP_LEVEL_ID,
          label: entry.label,
          order: base + SECTION_OFFSET_ENTRIES_BASE + i,
          click: () => {
            getLoggingApi().event(IDW_EVENTS.OPENED, { id: entry.id, kind: entry.kind });
            config.onOpenEntry(entry);
          },
        });
      });
    }

    // Trailing separator marker (no-op -- we handle separators on the
    // leading edge of the next section). Reserved for future use:
    // unused offset SECTION_OFFSET_SEPARATOR_AFTER.
    void SECTION_OFFSET_SEPARATOR_AFTER;
  }

  return out;
}

/** @internal -- exposed for tests. */
export function _isMenuBuilderInitializedForTesting(): boolean {
  return initialized;
}

/** @internal -- exposed for tests. */
export function _getDynamicIdsForTesting(): ReadonlySet<string> {
  return dynamicIds;
}
