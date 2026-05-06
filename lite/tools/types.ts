/**
 * Tools module shared types.
 *
 * The Tools menu hosts a flat list of user-curated shortcuts: a label
 * shown in the menu and a URL that opens when clicked. There are no
 * kinds, no per-entry partition, no presets -- this is the lightest
 * possible "bookmarks-as-menu" surface.
 *
 * Public types are re-exported from `api.ts`. Internal helpers stay
 * here.
 */

/**
 * Source of truth for one entry in the Tools menu.
 *
 * One blob in KV (`lite-tool-entries / default`) stores
 * `{ schemaVersion: 1, entries: ToolEntry[] }`. The TS store applies
 * URL validation, dedupes by `id`, and refuses writes when the user is
 * signed-out (mirrors IDW's multi-user isolation).
 */
export interface ToolEntry {
  /** Stable unique id (slugified label + short suffix when absent on add). */
  id: string;
  /** Human-readable name shown in the Tools menu and the manager. */
  label: string;
  /** Target URL (http/https only). Opens in the user's default browser. */
  url: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * Persisted blob shape under KV `lite-tool-entries / default`.
 * Wrapped so the store can later add a top-level schemaVersion or
 * other metadata without breaking existing readers.
 */
export interface ToolStorageBlob {
  schemaVersion: 1;
  entries: ToolEntry[];
}

/** Sentinel constant so types.ts has a value-level export (avoids dep-cruiser orphan warning). */
export const TOOLS_MODULE_VERSION = 1 as const;
