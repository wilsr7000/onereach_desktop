/**
 * Agentic University menu builder.
 *
 * Owns the lifecycle of the `top:university` menu and all its
 * children. Mirrors the full app's `_buildUniversityMenu` shape
 * from [lib/menu-sections/idw-gsx-builder.js](lib/menu-sections/idw-gsx-builder.js)
 * and the per-tab structure documented in
 * `test/plans/30-documentation-tutorials.md`:
 *
 *   Agentic University
 *     - Open LMS
 *     - (separator)
 *     - Quick Starts
 *         - View All Tutorials
 *         - (separator)
 *         - Getting Started
 *         - Building Your First Agent
 *         - Workflow Fundamentals
 *         - API Integration
 *     - (separator)
 *     - AI Run Times
 *
 * All clickable items route to either:
 *  - `openLearningInBrowser(entry)` for entries with a URL
 *  - `openTutorialsCatalog()` for "View All Tutorials"
 *
 * Per ADR-015, NO accelerators on any item.
 *
 * The catalog is hand-curated in `./curated-content.ts`. The menu
 * builder is static (computed once at init); it does NOT subscribe
 * to OAGI / KV mutations. A future port that pulls from OAGI would
 * change the shape (Cypher fetch + onChange) and the menu would
 * rebuild dynamically.
 *
 * @internal
 */

import { registry } from '../menu/registry.js';
import { CURATED, findCurated } from './curated-content.js';
import type { LearningEntry } from './types.js';
import { getLoggingApi } from '../logging/api.js';
import { UNIVERSITY_EVENTS } from './events.js';

/** Stable top-level id for the Agentic University menu. */
export const TOP_LEVEL_ID = 'top:university';
/** Submenu parent for Quick Starts. */
export const QUICK_STARTS_ID = 'university:quick-starts';
/** Stable id for "Open LMS". */
export const OPEN_LMS_ID = 'university:open-lms';
/** Stable id for "View All Tutorials" (inside Quick Starts). */
export const VIEW_ALL_TUTORIALS_ID = 'university:view-all-tutorials';
/** Stable id for "AI Run Times". */
export const AI_RUN_TIMES_ID = 'university:ai-run-times';

/** Stable order base for top-level items inside top:university. */
const ORDER = {
  OPEN_LMS: 100,
  SEP_AFTER_LMS: 150,
  QUICK_STARTS: 200,
  SEP_AFTER_QUICK_STARTS: 250,
  AI_RUN_TIMES: 300,
};

const QUICK_START_COURSE_IDS = [
  'getting-started',
  'first-agent',
  'workflow-basics',
  'api-integration',
];

export interface MenuBuilderConfig {
  /** Called when any URL-bound item is clicked. */
  onOpenEntry: (entry: LearningEntry) => void;
  /** Called when "View All Tutorials" is clicked -- opens the catalog window. */
  onOpenTutorials: () => void;
}

let initialized = false;
const dynamicIds = new Set<string>();

/**
 * Register the top-level placeholder + all child menu items. The
 * menu is static (computed from the curated catalog at init); no
 * onChange subscription needed for v1.
 */
export function initMenuBuilder(config: MenuBuilderConfig): void {
  if (initialized) return;

  // Top-level placeholder.
  upsertAndTrack({
    id: TOP_LEVEL_ID,
    type: 'top-level',
    label: 'Agentic University',
    order: 80,
  });

  // Open LMS.
  const lms = findCurated('lms');
  if (lms !== null) {
    upsertAndTrack({
      id: OPEN_LMS_ID,
      type: 'item',
      parentId: TOP_LEVEL_ID,
      label: 'Open LMS',
      order: ORDER.OPEN_LMS,
      click: () => {
        emitOpened(lms);
        config.onOpenEntry(lms);
      },
    });
  }

  upsertAndTrack({
    id: 'university:sep-1',
    type: 'separator',
    parentId: TOP_LEVEL_ID,
    order: ORDER.SEP_AFTER_LMS,
  });

  // Quick Starts submenu (parent item).
  upsertAndTrack({
    id: QUICK_STARTS_ID,
    type: 'item',
    parentId: TOP_LEVEL_ID,
    label: 'Quick Starts',
    order: ORDER.QUICK_STARTS,
  });

  // View All Tutorials.
  upsertAndTrack({
    id: VIEW_ALL_TUTORIALS_ID,
    type: 'item',
    parentId: QUICK_STARTS_ID,
    label: 'View All Tutorials',
    order: 0,
    click: () => {
      getLoggingApi().event(UNIVERSITY_EVENTS.TUTORIALS_OPENED);
      config.onOpenTutorials();
    },
  });

  upsertAndTrack({
    id: 'university:quick-starts:sep',
    type: 'separator',
    parentId: QUICK_STARTS_ID,
    order: 50,
  });

  // Course items inside Quick Starts.
  QUICK_START_COURSE_IDS.forEach((id, index) => {
    const entry = findCurated(id);
    if (entry === null) return;
    upsertAndTrack({
      id: `university:quick-starts:${id}`,
      type: 'item',
      parentId: QUICK_STARTS_ID,
      label: entry.title,
      order: 100 + index,
      click: () => {
        emitOpened(entry);
        config.onOpenEntry(entry);
      },
    });
  });

  upsertAndTrack({
    id: 'university:sep-2',
    type: 'separator',
    parentId: TOP_LEVEL_ID,
    order: ORDER.SEP_AFTER_QUICK_STARTS,
  });

  // AI Run Times.
  const aiRunTimes = findCurated('ai-run-times');
  if (aiRunTimes !== null) {
    upsertAndTrack({
      id: AI_RUN_TIMES_ID,
      type: 'item',
      parentId: TOP_LEVEL_ID,
      label: 'AI Run Times',
      order: ORDER.AI_RUN_TIMES,
      click: () => {
        emitOpened(aiRunTimes);
        config.onOpenEntry(aiRunTimes);
      },
    });
  }

  initialized = true;
}

/**
 * Tear down: unregister every menu entry this module installed.
 * Idempotent.
 */
export function teardownMenuBuilder(): void {
  if (!initialized) return;
  for (const id of Array.from(dynamicIds)) {
    registry.unregister(id);
  }
  dynamicIds.clear();
  registry.unregister(TOP_LEVEL_ID);
  initialized = false;
}

/** @internal -- exposed for tests. */
export function _isMenuBuilderInitializedForTesting(): boolean {
  return initialized;
}

/** @internal -- exposed for tests. */
export function _getDynamicIdsForTesting(): ReadonlySet<string> {
  return dynamicIds;
}

/** @internal -- expose the curated catalog for tests. */
export function _getCuratedForTesting(): ReadonlyArray<LearningEntry> {
  return CURATED;
}

// ─── helpers ──────────────────────────────────────────────────────────────

interface UpsertEntry {
  id: string;
  type: 'item' | 'separator' | 'top-level';
  parentId?: string;
  label?: string;
  order?: number;
  click?: () => void;
}

function upsertAndTrack(entry: UpsertEntry): void {
  // Cast through the registry's MenuEntry shape -- MenuEntry has
  // additional optional fields we don't set here.
  registry.upsert(entry as Parameters<typeof registry.upsert>[0]);
  dynamicIds.add(entry.id);
}

function emitOpened(entry: LearningEntry): void {
  getLoggingApi().event(UNIVERSITY_EVENTS.OPENED, { id: entry.id, kind: entry.kind });
}
