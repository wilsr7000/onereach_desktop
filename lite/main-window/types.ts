/**
 * Main window module shared types.
 *
 * The main window is lite's tabbed agent browser: a single
 * `BaseWindow` whose top 36px is a chrome (tab bar) renderer, and
 * whose remainder hosts the active tab's `WebContentsView`. Each tab
 * is a sandboxed third-party agent in its own persistent partition.
 *
 * Public types are re-exported from `api.ts`. Internal-only helpers
 * stay here.
 */

/**
 * One tab in the main window. The `partition` string is the load-bearing
 * piece -- it pins the tab's session storage. Round-tripping through KV
 * with the same partition string rehydrates the agent's login state.
 *
 * `idwId` is set when the tab was opened via the IDW menu. The
 * dedupe rule "one tab per IDW" keys on this. Manual external bots
 * without an IDW always get a fresh tab; their `idwId` is absent.
 */
export interface Tab {
  /** Stable id (slug-safe; persisted across restarts). */
  id: string;
  /** Display label shown in the tab bar. */
  label: string;
  /** Last-known URL. Restored on relaunch. */
  url: string;
  /** Optional IDW link -- enables click-to-focus dedupe. */
  idwId?: string;
  /**
   * `Session.fromPartition(...)` partition string. Format:
   * `persist:tab-<short-uuid>`. Persisting this lets us rebuild the
   * tab on relaunch with the same cookie jar / localStorage / IndexedDB.
   */
  partition: string;
  /** Optional icon hint (SF Symbol or emoji fallback). */
  iconName?: string;
  /** ISO 8601 -- creation time. */
  createdAt: string;
  /** ISO 8601 -- last navigation or label change. */
  updatedAt: string;
}

/**
 * Persisted blob shape under KV `lite-main-window-tabs / default`.
 * Wrapped so the store can later add a top-level `schemaVersion` or
 * other metadata without breaking existing readers.
 */
export interface TabsBlob {
  schemaVersion: 1;
  tabs: Tab[];
  /** Id of the currently-active tab, or null if no tabs. */
  activeId: string | null;
}

/**
 * Input to `openTab` -- the caller supplies the URL and label, plus
 * optional metadata. The store fills in `id`, `partition`, `createdAt`,
 * `updatedAt`.
 */
export interface OpenTabInput {
  url: string;
  label: string;
  /** When set, dedupe path: focus the existing tab if any has this idwId. */
  idwId?: string;
  /** Optional icon hint. */
  iconName?: string;
}

/**
 * Result of `openTab`. `wasFocus=true` indicates the call hit the
 * dedupe path -- an existing tab matching `idwId` was focused rather
 * than a new one created. Callers can use this to choose toast copy.
 */
export interface OpenTabResult {
  tab: Tab;
  wasFocus: boolean;
}

/** Sentinel constant so types.ts has a value-level export (avoids dep-cruiser orphan warning). */
export const MAIN_WINDOW_MODULE_VERSION = 1 as const;

/** Tab-bar height in CSS pixels. The window factory subtracts this from content bounds. */
export const CHROME_HEIGHT_PX = 36 as const;

/** KV collection + key for tab persistence. */
export const KV_COLLECTION = 'lite-main-window-tabs';
export const KV_KEY = 'default';

/** Partition prefix used for per-tab session isolation. */
export const PARTITION_PREFIX = 'persist:tab-';
