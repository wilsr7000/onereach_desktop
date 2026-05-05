/**
 * Tab store -- KV-only persistence for the main-window's tab state.
 *
 * Per the kernel direction (no local files), all reads and writes go
 * to the Edison KV flow (`lite/kv/api.ts`) under collection
 * `lite-main-window-tabs`, key `default`. The whole tab list is one
 * JSON blob -- bounded by user choices, the window factory loads
 * everything into memory anyway, so keep-it-simple beats per-id keys.
 *
 * Per ADR-019 / Rule 11, this file is module-internal. Other lite
 * modules MUST consume `getMainWindowApi()` from `./api.ts` -- never
 * reach into TabStore directly.
 *
 * Validation rules:
 *  - URL must parse and use http or https
 *  - openTab dedupes by idwId (when supplied) -- focuses existing tab
 *  - closeTab on the active id picks a fallback active (next tab in
 *    order, or null if no tabs left)
 *  - partition string is auto-generated (callers cannot override) so
 *    we control the namespace
 *
 * @internal
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LiteError } from '../errors.js';
import type { Span, EventRecord } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { getKVApi, KVError } from '../kv/api.js';
import type { KVApi } from '../kv/api.js';
import { MainWindowError, MAIN_WINDOW_ERROR_CODES } from './errors.js';
import type { Tab, TabsBlob, OpenTabInput, OpenTabResult } from './types.js';
import { KV_COLLECTION, KV_KEY, PARTITION_PREFIX } from './types.js';
import {
  isMainWindowEvent,
  MAIN_WINDOW_EVENTS,
  type MainWindowEvent,
} from './events.js';

export interface StoreConfig {
  /** Optional KV API override (for tests). */
  kvApi?: KVApi;
  /** Optional logger. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, each store op
   * (`open/close/activate`) wraps its work in a `main-window.<op>.start`
   * / `.finish` / `.fail` span. ADR-030.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /** Optional clock for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Optional id + partition generator for deterministic tests.
   * Defaults to `tab-<short-uuid>` for the id and `persist:tab-<short-uuid>`
   * for the partition.
   */
  generateIds?: () => { id: string; partition: string };
}

/**
 * Module-internal class. Other lite modules MUST NOT import this directly --
 * use `getMainWindowApi()` from `./api.ts` instead.
 *
 * @internal
 */
export class TabStore {
  private readonly kv: KVApi;
  private readonly log: NonNullable<StoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<StoreConfig['spanEmitter']> | null;
  private readonly nowFn: () => Date;
  private readonly genIdsFn: NonNullable<StoreConfig['generateIds']>;
  private readonly emitter = new EventEmitter();
  private cache: TabsBlob | null = null;

  constructor(config: StoreConfig = {}) {
    this.kv = config.kvApi ?? getKVApi();
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.nowFn = config.now ?? ((): Date => new Date());
    this.genIdsFn = config.generateIds ?? defaultGenerateIds;
  }

  /** Read all tabs (cached). */
  async list(): Promise<Tab[]> {
    const blob = await this.readBlob();
    return [...blob.tabs];
  }

  /** Read a single tab by id, or null if absent. */
  async get(id: string): Promise<Tab | null> {
    const blob = await this.readBlob();
    return blob.tabs.find((t) => t.id === id) ?? null;
  }

  /** Get the active tab id (null when no tabs are open). */
  async getActiveId(): Promise<string | null> {
    const blob = await this.readBlob();
    return blob.activeId;
  }

  /**
   * Open a new tab, OR (when `idwId` matches an existing tab) focus
   * the existing one. Returns `{ tab, wasFocus }`.
   */
  async openTab(input: OpenTabInput): Promise<OpenTabResult> {
    const span = this.spanEmitter?.('main-window.open-tab', {
      hasIdwId: typeof input.idwId === 'string' && input.idwId.length > 0,
      isDedupe: false, // will be updated below if dedupe path hits
    });
    try {
      this.assertUrl(input.url, 'url');
      this.assertLabel(input.label);

      const blob = await this.readBlob();
      const now = this.nowFn().toISOString();

      // Dedupe path: focus existing tab matching idwId.
      if (typeof input.idwId === 'string' && input.idwId.length > 0) {
        const existingIdx = blob.tabs.findIndex((t) => t.idwId === input.idwId);
        if (existingIdx >= 0) {
          const existing = blob.tabs[existingIdx];
          if (existing === undefined) {
            // Unreachable given idx check, but narrows for TS.
            throw new MainWindowError({
              code: MAIN_WINDOW_ERROR_CODES.PERSISTENCE_FAILED,
              message: 'TabStore.openTab: index race during dedupe',
              context: { op: 'openTab', idwId: input.idwId },
            });
          }
          const updated: Tab = {
            ...existing,
            // Refresh label/url -- caller may have a newer URL than the
            // one we last saved (e.g. IDW environment change).
            label: input.label,
            url: input.url,
            ...(input.iconName !== undefined ? { iconName: input.iconName } : {}),
            updatedAt: now,
          };
          const next = blob.tabs.slice();
          next[existingIdx] = updated;
          await this.writeBlob({ ...blob, tabs: next, activeId: updated.id });
          this.emitChanged(next, updated.id);
          span?.finish({ id: updated.id, wasFocus: true });
          return { tab: updated, wasFocus: true };
        }
      }

      // New tab path. Generate id + partition; assert partition is unique.
      const { id, partition } = this.genIdsFn();
      if (blob.tabs.some((t) => t.id === id)) {
        throw new MainWindowError({
          code: MAIN_WINDOW_ERROR_CODES.PERSISTENCE_FAILED,
          message: `Generated tab id collides: ${id}`,
          context: { op: 'openTab', id },
        });
      }
      if (blob.tabs.some((t) => t.partition === partition)) {
        throw new MainWindowError({
          code: MAIN_WINDOW_ERROR_CODES.DUPLICATE_PARTITION,
          message: `Generated partition collides: ${partition}`,
          context: { op: 'openTab', partition },
        });
      }
      const tab: Tab = {
        id,
        label: input.label,
        url: input.url,
        ...(typeof input.idwId === 'string' && input.idwId.length > 0
          ? { idwId: input.idwId }
          : {}),
        partition,
        ...(input.iconName !== undefined ? { iconName: input.iconName } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const next = [...blob.tabs, tab];
      await this.writeBlob({ ...blob, tabs: next, activeId: tab.id });
      this.emitChanged(next, tab.id);
      span?.finish({ id: tab.id, wasFocus: false });
      return { tab, wasFocus: false };
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'openTab');
    }
  }

  /**
   * Close a tab. If the closed tab was active, picks the next-or-prev
   * sibling as the new active; if no tabs remain, sets `activeId` to null.
   */
  async closeTab(id: string): Promise<void> {
    const span = this.spanEmitter?.('main-window.close-tab', { id });
    try {
      const blob = await this.readBlob();
      const idx = blob.tabs.findIndex((t) => t.id === id);
      if (idx < 0) {
        throw new MainWindowError({
          code: MAIN_WINDOW_ERROR_CODES.NOT_FOUND,
          message: `Tab not found: ${id}`,
          context: { op: 'closeTab', id },
          remediation: 'Refresh the tab list -- the tab may have already been closed.',
        });
      }
      const next = blob.tabs.slice();
      next.splice(idx, 1);

      let nextActive: string | null = blob.activeId;
      if (blob.activeId === id) {
        // Pick the next tab in order, or the previous one if we removed
        // the last tab. Empty list -> null.
        if (next.length === 0) {
          nextActive = null;
        } else {
          const replacement = next[idx] ?? next[idx - 1];
          nextActive = replacement?.id ?? null;
        }
      }

      await this.writeBlob({ ...blob, tabs: next, activeId: nextActive });
      this.emitChanged(next, nextActive);
      span?.finish({ id });
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'closeTab');
    }
  }

  /**
   * Clear the active tab id. The chrome's "Home" pill calls this
   * when the user wants to see the welcome view without closing any
   * tab. No-op if already cleared.
   */
  async goHome(): Promise<void> {
    const blob = await this.readBlob();
    if (blob.activeId === null) return;
    await this.writeBlob({ ...blob, activeId: null });
    this.emitChanged(blob.tabs, null);
  }

  /** Set the active tab. Throws `MW_NOT_FOUND` if no tab matches. */
  async activateTab(id: string): Promise<void> {
    const span = this.spanEmitter?.('main-window.activate-tab', { id });
    try {
      const blob = await this.readBlob();
      if (!blob.tabs.some((t) => t.id === id)) {
        throw new MainWindowError({
          code: MAIN_WINDOW_ERROR_CODES.NOT_FOUND,
          message: `Tab not found: ${id}`,
          context: { op: 'activateTab', id },
          remediation: 'Refresh the tab list -- the tab may have been closed.',
        });
      }
      if (blob.activeId === id) {
        // No-op; still emit changed for UI symmetry.
        span?.finish({ id });
        return;
      }
      await this.writeBlob({ ...blob, activeId: id });
      this.emitChanged(blob.tabs, id);
      span?.finish({ id });
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'activateTab');
    }
  }

  /**
   * Update a tab's last-known URL (called on `did-navigate` events).
   * Soft-fails: if the tab is gone (race), just no-ops. Does not emit
   * a changed broadcast -- navigation churn would spam the bus.
   */
  async setUrl(id: string, url: string): Promise<void> {
    try {
      this.assertUrl(url, 'url');
      const blob = await this.readBlob();
      const idx = blob.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return; // soft no-op
      const existing = blob.tabs[idx];
      if (existing === undefined || existing.url === url) return;
      const updated: Tab = {
        ...existing,
        url,
        updatedAt: this.nowFn().toISOString(),
      };
      const next = blob.tabs.slice();
      next[idx] = updated;
      await this.writeBlob({ ...blob, tabs: next });
      // Emit the navigation event for log timeline; skip the full
      // 'changed' broadcast -- callers don't need to re-render on
      // every URL tick.
      getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_NAVIGATED, { id, url });
    } catch (err) {
      this.log('warn', 'main-window-store: setUrl failed; ignoring', {
        id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Update a tab's label (e.g. when the page title resolves). Soft-fail
   * on missing id; emits changed so the tab bar re-renders.
   */
  async setLabel(id: string, label: string): Promise<void> {
    try {
      this.assertLabel(label);
      const blob = await this.readBlob();
      const idx = blob.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const existing = blob.tabs[idx];
      if (existing === undefined || existing.label === label) return;
      const updated: Tab = {
        ...existing,
        label,
        updatedAt: this.nowFn().toISOString(),
      };
      const next = blob.tabs.slice();
      next[idx] = updated;
      await this.writeBlob({ ...blob, tabs: next });
      this.emitChanged(next, blob.activeId);
    } catch (err) {
      this.log('warn', 'main-window-store: setLabel failed; ignoring', {
        id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Subscribe to changes. Handler receives the latest tab list +
   * activeId each time the store mutates. Returns an unsubscribe.
   */
  onChange(handler: (tabs: Tab[], activeId: string | null) => void): () => void {
    this.emitter.on('change', handler);
    return (): void => {
      this.emitter.off('change', handler);
    };
  }

  /** Subscribe to typed main-window events (ADR-032). */
  onEvent(handler: (event: MainWindowEvent) => void): () => void {
    return getLoggingApi().onEvent('main-window.*', (ev: EventRecord) => {
      if (isMainWindowEvent(ev)) {
        handler(ev as unknown as MainWindowEvent);
      }
    });
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async readBlob(): Promise<TabsBlob> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = await this.kv.get(KV_COLLECTION, KV_KEY);
      if (raw === null || raw === undefined) {
        this.cache = { schemaVersion: 1, tabs: [], activeId: null };
        return this.cache;
      }
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        this.log('warn', 'main-window-store: unexpected KV blob shape, resetting in-memory', {
          actualType: Array.isArray(raw) ? 'array' : typeof raw,
        });
        this.cache = { schemaVersion: 1, tabs: [], activeId: null };
        return this.cache;
      }
      const blob = raw as Partial<TabsBlob>;
      const tabs = Array.isArray(blob.tabs) ? blob.tabs.filter(isLikelyTab) : [];
      const activeId =
        typeof blob.activeId === 'string' && tabs.some((t) => t.id === blob.activeId)
          ? blob.activeId
          : null;
      this.cache = { schemaVersion: 1, tabs, activeId };
      return this.cache;
    } catch (err) {
      if (err instanceof KVError) {
        // Soft-fail reads -- fresh kernel can render an empty tab list.
        this.log('warn', 'main-window-store: KV read failed, returning empty', {
          code: err.code,
        });
        this.cache = { schemaVersion: 1, tabs: [], activeId: null };
        return this.cache;
      }
      throw err;
    }
  }

  private async writeBlob(blob: TabsBlob): Promise<void> {
    try {
      await this.kv.set(KV_COLLECTION, KV_KEY, blob);
      this.cache = blob;
    } catch (err) {
      const message = (err as Error).message;
      throw new MainWindowError({
        code: MAIN_WINDOW_ERROR_CODES.PERSISTENCE_FAILED,
        message: `main-window persistence failed: ${message}`,
        context: {
          op: 'write',
          collection: KV_COLLECTION,
          key: KV_KEY,
          ...(err instanceof KVError ? { kvCode: err.code, kvStatus: err.status } : {}),
        },
        remediation:
          err instanceof KVError
            ? err.remediation
            : 'Check your network connection and try again.',
        cause: err,
      });
    }
  }

  private emitChanged(tabs: Tab[], activeId: string | null): void {
    getLoggingApi().event(MAIN_WINDOW_EVENTS.CHANGED, {
      count: tabs.length,
      activeId,
    });
    const snapshot = tabs.slice();
    const listeners = this.emitter.listeners('change') as Array<
      (tabs: Tab[], activeId: string | null) => void
    >;
    for (const listener of listeners) {
      try {
        listener(snapshot, activeId);
      } catch (err) {
        this.log('warn', 'main-window-store: onChange subscriber threw', {
          error: (err as Error).message,
        });
      }
    }
  }

  private assertUrl(url: unknown, field: string): void {
    if (typeof url !== 'string' || url.length === 0) {
      throw new MainWindowError({
        code: MAIN_WINDOW_ERROR_CODES.INVALID_URL,
        message: `${field} is required and must be a non-empty string`,
        context: { op: 'validate', field },
        remediation: 'Provide an https:// URL.',
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MainWindowError({
        code: MAIN_WINDOW_ERROR_CODES.INVALID_URL,
        message: `${field} is not a valid URL: ${url}`,
        context: { op: 'validate', field, value: url },
        remediation: 'Provide an https:// URL.',
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new MainWindowError({
        code: MAIN_WINDOW_ERROR_CODES.INVALID_URL,
        message: `${field} must use http or https (got ${parsed.protocol})`,
        context: { op: 'validate', field, value: url, protocol: parsed.protocol },
        remediation: 'Only http:// and https:// URLs are allowed.',
      });
    }
  }

  private assertLabel(label: unknown): void {
    if (typeof label !== 'string' || label.length === 0) {
      throw new MainWindowError({
        code: MAIN_WINDOW_ERROR_CODES.INVALID_INPUT,
        message: 'label is required',
        context: { op: 'validate', field: 'label' },
        remediation: 'Give the tab a human-readable name.',
      });
    }
  }

  private normalizeError(err: unknown, op: string): unknown {
    if (err instanceof MainWindowError) return err;
    if (err instanceof LiteError) return err;
    if (err instanceof Error) {
      return new MainWindowError({
        code: MAIN_WINDOW_ERROR_CODES.PERSISTENCE_FAILED,
        message: `main-window ${op} failed: ${err.message}`,
        context: { op },
        cause: err,
      });
    }
    return err;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Default id + partition generator. Uses 8 hex chars from a UUID for
 * a short, slug-safe id and the same suffix for the partition. The
 * partition string is what session.fromPartition(...) consumes; format
 * is fixed (`persist:tab-<8 hex>`) so we can validate it later.
 */
function defaultGenerateIds(): { id: string; partition: string } {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return { id: `tab-${suffix}`, partition: `${PARTITION_PREFIX}${suffix}` };
}

/** Loose runtime check used during blob recovery. Not full validation. */
function isLikelyTab(value: unknown): value is Tab {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['label'] === 'string' &&
    typeof v['url'] === 'string' &&
    typeof v['partition'] === 'string'
  );
}
