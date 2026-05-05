/**
 * Menu Registry -- typed, EventEmitter-based registry of menu entries.
 *
 * Every port adds menu entries by registering them; the builder reacts on
 * `change` events and rebuilds the Electron menu. Top-level menus with no
 * children do NOT render -- so pre-registered placeholders (top:tools,
 * top:idw, etc.) appear automatically when the first child registers.
 *
 * This shape is a superset of Electron MenuItemConstructorOptions, so it
 * can describe the entirety of full's eventual menu surface without
 * changes to the registry or builder.
 *
 * See lite/PORTING.md for the registration template each port copies.
 *
 * Borrowed pattern: EventEmitter-based atomic data layer from
 *   menu-data-manager.js (full app, not imported, only studied).
 */

import { EventEmitter } from 'node:events';

export type MenuEntryType = 'top-level' | 'item' | 'separator';

export interface MenuEntry {
  /** Unique stable id, e.g. 'help:report-bug', 'top:tools', 'tools:open-spaces' */
  id: string;
  type: MenuEntryType;
  /** Omit for top-level entries. Reference another entry's id. */
  parentId?: string;
  /** Display label. Function form re-evaluates each rebuild for dynamic labels. */
  label?: string | (() => string);
  /** Electron accelerator string, e.g. 'CmdOrCtrl+Q', 'CmdOrCtrl+Shift+/' */
  accelerator?: string;
  /** Electron standard role, e.g. 'about', 'quit', 'appMenu', 'help', 'copy' */
  role?: Electron.MenuItemConstructorOptions['role'];
  /** Static or dynamic enabled state */
  enabled?: boolean | (() => boolean);
  /** Static or dynamic visible state */
  visible?: boolean | (() => boolean);
  /** Click handler for items. Ignored for top-level / separator. */
  click?: () => void | Promise<void>;
  /** Sort order within the parent. Lower numbers appear first. Ties broken by registration order. */
  order?: number;
}

const REGISTRY_CHANGE_EVENT = 'change';

export class MenuRegistry extends EventEmitter {
  private readonly entries = new Map<string, MenuEntry>();
  /** Tracks insertion order for tie-breaking when `order` is equal */
  private readonly insertionOrder = new Map<string, number>();
  private nextInsertionIndex = 0;

  /**
   * Register a menu entry. Throws if the id is already registered (use
   * `update` for idempotent re-registration). Emits `change`.
   */
  register(entry: MenuEntry): void {
    if (this.entries.has(entry.id)) {
      throw new Error(`MenuRegistry: entry id '${entry.id}' is already registered. Use update() instead.`);
    }
    this.entries.set(entry.id, entry);
    this.insertionOrder.set(entry.id, this.nextInsertionIndex++);
    this.emit(REGISTRY_CHANGE_EVENT);
  }

  /** Idempotent register-or-replace. Emits `change`. */
  upsert(entry: MenuEntry): void {
    const isNew = !this.entries.has(entry.id);
    this.entries.set(entry.id, entry);
    if (isNew) {
      this.insertionOrder.set(entry.id, this.nextInsertionIndex++);
    }
    this.emit(REGISTRY_CHANGE_EVENT);
  }

  /** Remove an entry by id. No-op if not present. Emits `change`. */
  unregister(id: string): void {
    if (this.entries.delete(id)) {
      this.insertionOrder.delete(id);
      this.emit(REGISTRY_CHANGE_EVENT);
    }
  }

  /** Look up an entry by id. */
  get(id: string): MenuEntry | undefined {
    return this.entries.get(id);
  }

  /** Whether an id is registered. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Get children of a parent (or top-level entries if parentId is undefined),
   * sorted by `order` ascending (default 0), ties broken by registration order.
   */
  getChildren(parentId?: string): MenuEntry[] {
    const children: MenuEntry[] = [];
    for (const entry of this.entries.values()) {
      const parent = entry.parentId;
      const matches = parentId === undefined ? entry.type === 'top-level' : parent === parentId;
      if (matches) children.push(entry);
    }
    children.sort((a, b) => {
      const orderDiff = (a.order ?? 0) - (b.order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      const aIdx = this.insertionOrder.get(a.id) ?? 0;
      const bIdx = this.insertionOrder.get(b.id) ?? 0;
      return aIdx - bIdx;
    });
    return children;
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.on(REGISTRY_CHANGE_EVENT, listener);
    return () => {
      this.off(REGISTRY_CHANGE_EVENT, listener);
    };
  }

  /** Total number of registered entries (for tests + diagnostics). */
  size(): number {
    return this.entries.size;
  }

  /** Reset the registry. For tests only. */
  _resetForTesting(): void {
    this.entries.clear();
    this.insertionOrder.clear();
    this.nextInsertionIndex = 0;
  }
}

/**
 * Singleton registry. Use this everywhere unless you specifically need
 * an isolated instance for tests.
 */
export const registry = new MenuRegistry();
