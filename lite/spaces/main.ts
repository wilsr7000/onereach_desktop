/**
 * Spaces main-process orchestration.
 *
 * Owns:
 *   - The Spaces window factory (single-instance) -- exposed via the
 *     `open()` method on `SpacesApi`.
 *   - The `lite:spaces:*` IPC handler suite (see `ipc.ts`).
 *   - The `Tools -> Spaces...` menu entry. Registers directly into the
 *     `top:tools` placeholder owned by `lite/tools/menu-builder.ts` --
 *     no cross-module imports; the parent id is the string contract.
 *
 * Per ADR-019 / Rule 11 (LITE-RULES.md), every other module imports from
 * `lite/spaces/api.ts`. This file is the implementation boundary.
 *
 * Phase 0 wiring:
 *   - `initSpaces()` opens an empty BrowserWindow when the menu fires
 *   - Data methods (`listSpaces`, `items.list`, etc.) still throw
 *     `SPACES_NOT_INITIALIZED` -- they're wired in Phase 1
 */

import { BrowserWindow } from 'electron';
import { registry } from '../menu/registry.js';
import {
  _setSpacesApiForTesting,
  _resetSpacesApiForTesting,
  type SpacesApi,
  type SpacesItemsApi,
} from './api.js';
import { SpacesError } from './errors.js';
import { openSpacesWindow, closeSpacesWindow } from './window.js';
import { registerSpacesIpc, unregisterSpacesIpc } from './ipc.js';
import { SdkSpacesClient } from './sdk-client.js';
import type {
  Item,
  ItemSummary,
  ListOpts,
  Space,
} from './types.js';
import type { SpaceScope } from './scope.js';

// ─── Menu wiring ────────────────────────────────────────────────────────

/**
 * Parent id owned by `lite/tools/menu-builder.ts`. We use the string
 * literal rather than importing the constant so this module stays
 * importer-free per Rule 11 (no cross-module internal imports).
 */
const TOOLS_TOP_LEVEL_ID = 'top:tools';

/** Stable id for the Tools -> Spaces... menu entry. */
const SPACES_MENU_ITEM_ID = 'tools:spaces';

/**
 * Order slot for the Spaces menu entry. The Tools menu reserves
 * `0..8999` for entries above the tail block (Manage Tools sits at
 * `9001`). We pick `50` so Spaces sorts above any user-curated tools.
 */
const SPACES_MENU_ORDER = 50;

// ─── Init / teardown ────────────────────────────────────────────────────

export interface InitSpacesOptions {
  /** Path to the bundled preload-lite.js. */
  preloadPath: string;
  /** Path to the bundled spaces.html. */
  htmlPath: string;
  /** Resolver for the parent window. Called each time Spaces opens. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface SpacesHandle {
  /** Open (or focus) the Spaces window. Convenience for menu wiring. */
  open(): void;
  /** Tear down IPC handlers + close the window. Idempotent. */
  teardown(): void;
}

let registered = false;
let initOptions: InitSpacesOptions | null = null;

/**
 * Register IPC handlers, install the Spaces menu entry, and install
 * the BrowserWindow-backed `SpacesApi` singleton. Safe to call multiple
 * times -- idempotent.
 */
export function initSpaces(opts: InitSpacesOptions): SpacesHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  initOptions = opts;

  const handle: SpacesHandle = {
    open: (): void => {
      if (initOptions === null) {
        log.warn('open() called before init', {});
        return;
      }
      try {
        openSpacesWindow({
          parent: initOptions.getParentWindow(),
          htmlPath: initOptions.htmlPath,
          preloadPath: initOptions.preloadPath,
        });
        log.info('spaces window opened', {});
      } catch (err) {
        log.error('failed to open spaces window', { error: (err as Error).message });
      }
    },
    teardown: teardownInternal,
  };

  // Install the real API singleton -- replaces the no-op placeholder
  // that `getSpacesApi()` returns until init runs.
  const api = createPhase0Api(handle);
  _setSpacesApiForTesting(api);

  if (registered) return handle;

  registerSpacesIpc({ onOpen: handle.open });

  // Menu entry: Tools -> Spaces...
  registry.upsert({
    id: SPACES_MENU_ITEM_ID,
    type: 'item',
    parentId: TOOLS_TOP_LEVEL_ID,
    label: 'Spaces...',
    order: SPACES_MENU_ORDER,
    click: handle.open,
  });

  registered = true;
  log.info('spaces initialized', {});
  return handle;
}

function teardownInternal(): void {
  if (!registered) return;
  unregisterSpacesIpc();
  try {
    registry.unregister(SPACES_MENU_ITEM_ID);
  } catch {
    // best-effort
  }
  registered = false;
  initOptions = null;
  closeSpacesWindow();
  _resetSpacesApiForTesting();
}

/** @internal -- exposed for tests. */
export function _isSpacesRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetSpacesRegistrationForTesting(): void {
  teardownInternal();
}

// ─── Phase 0 backing implementation ─────────────────────────────────────

/**
 * Build the Phase 0 SpacesApi. `open()` is wired to the BrowserWindow
 * factory; data methods delegate to the stub SDK client, which throws
 * `SPACES_NOT_INITIALIZED` until Phase 1 lands.
 *
 * Phase 1 replaces this with a real implementation that calls
 * `getNeonApi().query(...)` under the hood.
 */
function createPhase0Api(handle: SpacesHandle): SpacesApi {
  const client = new SdkSpacesClient();

  const items: SpacesItemsApi = {
    list(scope: SpaceScope, opts?: ListOpts): Promise<ItemSummary[]> {
      return client.listItems(scope, opts);
    },
    get(id: string): Promise<Item | null> {
      if (typeof id !== 'string' || id.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'items.get() requires a non-empty id',
          remediation: 'Pass the canonical item id from a previous list result.',
          context: { id },
        });
      }
      return client.getItem(id);
    },
  };

  return {
    open: handle.open,
    listSpaces(): Promise<Space[]> {
      return client.listSpaces();
    },
    getUncategorizedCount(): Promise<number> {
      return client.getUncategorizedCount();
    },
    items,
  };
}
