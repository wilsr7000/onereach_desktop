/**
 * Settings module -- shared types.
 *
 * v1 ships one section (Two-Factor). The `SectionDescriptor` shape
 * keeps the renderer entry point (`settings.ts`) forward-compatible:
 * adding a section means appending another `{id, title, mount}` to the
 * hand-written list. Promote to a real registry when there are 3+
 * sections (per ADR-031).
 */

/**
 * One section in the Settings window. The renderer walks an ordered
 * list of these and renders them as sidebar tabs; clicking a tab lazily
 * mounts the section into its content pane.
 *
 * `mount` returns an optional disposer. The shell calls all disposers
 * on window close so each section can clean up timers, listeners, etc.
 * (e.g. Two-Factor's countdown setInterval, Account's session listener).
 */
export interface SectionDescriptor {
  /** Stable id, e.g. 'account', 'two-factor', 'updates'. */
  id: string;
  /** Human-readable section title. Rendered in the sidebar tab and the section's `<h2>`. */
  title: string;
  /**
   * Inline SVG markup for the sidebar icon. 16x16 viewBox, single path,
   * uses `currentColor` for stroke/fill so the active-tab style swaps
   * the color. Kept as a string so each section owns its appearance.
   * Set to `undefined` to render the tab without an icon.
   */
  icon?: string;
  /**
   * Mount the section into the given container. Return a disposer that
   * removes any timers / listeners; return `undefined` if there's nothing
   * to clean up.
   */
  mount(container: HTMLElement): (() => void) | undefined;
}

/** Sentinel constant so types.ts has a value-level export (avoids dep-cruiser orphan warning). */
export const SETTINGS_MODULE_VERSION = 1 as const;
