/**
 * Tools store -- KV-only persistence for the Tools menu's user-curated
 * shortcuts. Mirrors `lite/idw/store.ts` but with a far simpler data
 * model (label + url, no kinds).
 *
 * Per ADR-019 / Rule 11, this file is module-internal. Other lite
 * modules MUST consume `getToolsApi()` from `./api.ts`.
 *
 * Validation:
 *  - `label` non-empty string
 *  - `url` parses and uses http or https
 *
 * Multi-user isolation: scoped by the signed-in OneReach `accountId`
 * via `getActiveAccountId`. Signed-out reads return an empty list;
 * signed-out writes throw.
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
import { ToolsError, TOOLS_ERROR_CODES } from './errors.js';
import type { ToolEntry, ToolStorageBlob } from './types.js';
import { isToolsEvent, type ToolsEvent, TOOLS_EVENTS } from './events.js';

export const KV_COLLECTION = 'lite-tool-entries';
export const KV_KEY = 'default';

export interface StoreConfig {
  kvApi?: KVApi;
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  spanEmitter?: (name: string, data?: unknown) => Span;
  now?: () => Date;
  generateId?: (entry: Pick<ToolEntry, 'label'>) => string;
  /**
   * Resolver for the active OneReach `accountId`. Returns null when the
   * user is signed-out (then reads return [] and writes throw). Omitted
   * in unit tests, in which case the store falls back to a sentinel
   * accountId for backward compatibility.
   */
  getActiveAccountId?: () => string | null;
}

/** @internal -- consumers go through `getToolsApi()`. */
export class ToolsStore {
  private readonly kv: KVApi;
  private readonly log: NonNullable<StoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<StoreConfig['spanEmitter']> | null;
  private readonly nowFn: () => Date;
  private readonly genIdFn: NonNullable<StoreConfig['generateId']>;
  private readonly getActiveAccountId: NonNullable<StoreConfig['getActiveAccountId']> | null;
  private readonly emitter = new EventEmitter();
  private cache: ToolStorageBlob | null = null;
  private cachedForAccountId: string | null | undefined = undefined;

  constructor(config: StoreConfig = {}) {
    this.kv = config.kvApi ?? getKVApi();
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.nowFn = config.now ?? ((): Date => new Date());
    this.genIdFn = config.generateId ?? defaultGenerateId;
    this.getActiveAccountId = config.getActiveAccountId ?? null;
  }

  async list(): Promise<ToolEntry[]> {
    const blob = await this.readBlob();
    return [...blob.entries];
  }

  async get(id: string): Promise<ToolEntry | null> {
    const all = await this.list();
    return all.find((e) => e.id === id) ?? null;
  }

  async add(input: Partial<ToolEntry> & Pick<ToolEntry, 'label' | 'url'>): Promise<ToolEntry> {
    const span = this.spanEmitter?.('tools.add', {
      hasId: typeof input.id === 'string' && input.id.length > 0,
    });
    try {
      this.assertLabel(input.label);
      this.assertUrl(input.url);

      const blob = await this.readBlob();
      const now = this.nowFn().toISOString();
      const id =
        typeof input.id === 'string' && input.id.length > 0
          ? input.id
          : this.genIdFn({ label: input.label });
      if (blob.entries.some((e) => e.id === id)) {
        throw new ToolsError({
          code: TOOLS_ERROR_CODES.DUPLICATE,
          message: `A tool with id '${id}' already exists.`,
          context: { op: 'add', id },
          remediation: 'Choose a different label, or update the existing tool instead.',
        });
      }
      const entry: ToolEntry = {
        id,
        label: input.label,
        url: input.url,
        createdAt: now,
        updatedAt: now,
      };
      const next = [...blob.entries, entry];
      await this.writeBlob({ ...blob, entries: next });
      this.emitChanged(next);
      span?.finish({ id: entry.id });
      return entry;
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'add');
    }
  }

  async update(id: string, patch: Partial<ToolEntry>): Promise<ToolEntry> {
    const span = this.spanEmitter?.('tools.update', { id, fields: Object.keys(patch) });
    try {
      const blob = await this.readBlob();
      const idx = blob.entries.findIndex((e) => e.id === id);
      if (idx < 0) {
        throw new ToolsError({
          code: TOOLS_ERROR_CODES.NOT_FOUND,
          message: `Tool not found: ${id}`,
          context: { op: 'update', id },
          remediation: 'Refresh the list -- the tool may have been removed.',
        });
      }
      const existing = blob.entries[idx];
      if (existing === undefined) {
        // Unreachable but narrows for TS.
        throw new ToolsError({
          code: TOOLS_ERROR_CODES.PERSISTENCE_FAILED,
          message: 'ToolsStore.update: index race',
          context: { op: 'update', id },
        });
      }
      if (patch.label !== undefined) this.assertLabel(patch.label);
      if (patch.url !== undefined) this.assertUrl(patch.url);

      const now = this.nowFn().toISOString();
      const merged: ToolEntry = {
        ...existing,
        ...this.cleanInput(patch),
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      const next = blob.entries.slice();
      next[idx] = merged;
      await this.writeBlob({ ...blob, entries: next });
      this.emitChanged(next);
      span?.finish({ id: merged.id });
      return merged;
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'update');
    }
  }

  async remove(id: string): Promise<void> {
    const span = this.spanEmitter?.('tools.remove', { id });
    try {
      const blob = await this.readBlob();
      const idx = blob.entries.findIndex((e) => e.id === id);
      if (idx < 0) {
        throw new ToolsError({
          code: TOOLS_ERROR_CODES.NOT_FOUND,
          message: `Tool not found: ${id}`,
          context: { op: 'remove', id },
          remediation: 'Refresh the list -- the tool may have already been removed.',
        });
      }
      const next = blob.entries.slice();
      next.splice(idx, 1);
      await this.writeBlob({ ...blob, entries: next });
      this.emitChanged(next);
      span?.finish({ id });
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'remove');
    }
  }

  onChange(handler: (entries: ToolEntry[]) => void): () => void {
    this.emitter.on('change', handler);
    return (): void => {
      this.emitter.off('change', handler);
    };
  }

  onEvent(handler: (event: ToolsEvent) => void): () => void {
    return getLoggingApi().onEvent('tools.*', (ev: EventRecord) => {
      if (isToolsEvent(ev)) {
        handler(ev as unknown as ToolsEvent);
      }
    });
  }

  /**
   * Force a fresh KV read and broadcast through `onChange`. Mirrors
   * `IdwStore.refreshAfterAccountChange` -- the kernel hooks this
   * onto `auth.onSessionChanged` so the Tools menu lights up right
   * after sign-in instead of waiting for the user to open the
   * manager. Best-effort; KV failures surface as an empty list.
   */
  async refreshAfterAccountChange(): Promise<void> {
    try {
      const blob = await this.readBlob();
      this.emitChanged(blob.entries);
    } catch (err) {
      this.log('warn', 'tools-store: refreshAfterAccountChange failed', {
        error: (err as Error).message,
      });
      this.emitChanged([]);
    }
  }

  // ─── internals ────────────────────────────────────────────────────────

  private currentAccountId(): string | null {
    if (this.getActiveAccountId === null) return '__legacy__';
    const accountId = this.getActiveAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return accountId;
  }

  private async readBlob(): Promise<ToolStorageBlob> {
    const accountId = this.currentAccountId();
    if (accountId === null) return { schemaVersion: 1, entries: [] };
    if (this.cache !== null && this.cachedForAccountId === accountId) return this.cache;
    try {
      const raw = await this.kv.get(KV_COLLECTION, KV_KEY);
      if (raw === null || raw === undefined) {
        this.cache = { schemaVersion: 1, entries: [] };
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        this.log('warn', 'tools-store: unexpected KV blob shape, resetting in-memory', {
          actualType: Array.isArray(raw) ? 'array' : typeof raw,
        });
        this.cache = { schemaVersion: 1, entries: [] };
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      const blob = raw as Partial<ToolStorageBlob>;
      const entries = Array.isArray(blob.entries) ? blob.entries.filter(isLikelyEntry) : [];
      this.cache = { schemaVersion: 1, entries };
      this.cachedForAccountId = accountId;
      return this.cache;
    } catch (err) {
      if (err instanceof KVError) {
        this.log('warn', 'tools-store: KV read failed, returning empty', { code: err.code });
        this.cache = { schemaVersion: 1, entries: [] };
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      throw err;
    }
  }

  private async writeBlob(blob: ToolStorageBlob): Promise<void> {
    const accountId = this.currentAccountId();
    if (accountId === null) {
      throw new ToolsError({
        code: TOOLS_ERROR_CODES.PERSISTENCE_FAILED,
        message: 'Cannot save Tools changes while signed out. Sign in to OneReach first.',
        context: { op: 'write', collection: KV_COLLECTION, reason: 'signed-out' },
        remediation: 'Open Settings -> Account and sign in.',
      });
    }
    try {
      await this.kv.set(KV_COLLECTION, KV_KEY, blob);
      this.cache = blob;
      this.cachedForAccountId = accountId;
    } catch (err) {
      const message = (err as Error).message;
      throw new ToolsError({
        code: TOOLS_ERROR_CODES.PERSISTENCE_FAILED,
        message: `Tools persistence failed: ${message}`,
        context: {
          op: 'write',
          collection: KV_COLLECTION,
          key: KV_KEY,
          ...(err instanceof KVError ? { kvCode: err.code, kvStatus: err.status } : {}),
        },
        remediation:
          err instanceof KVError ? err.remediation : 'Check your network connection and try again.',
        cause: err,
      });
    }
  }

  private emitChanged(entries: ToolEntry[]): void {
    getLoggingApi().event(TOOLS_EVENTS.CHANGED, { count: entries.length });
    const snapshot = entries.slice();
    const listeners = this.emitter.listeners('change') as Array<(entries: ToolEntry[]) => void>;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.log('warn', 'tools-store: onChange subscriber threw', {
          error: (err as Error).message,
        });
      }
    }
  }

  private assertLabel(label: unknown): void {
    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new ToolsError({
        code: TOOLS_ERROR_CODES.INVALID_INPUT,
        message: 'label is required and must be a non-empty string',
        context: { op: 'validate', field: 'label' },
        remediation: 'Give the tool a human-readable name.',
      });
    }
  }

  private assertUrl(url: unknown): void {
    if (typeof url !== 'string' || url.length === 0) {
      throw new ToolsError({
        code: TOOLS_ERROR_CODES.INVALID_URL,
        message: 'url is required and must be a non-empty string',
        context: { op: 'validate', field: 'url' },
        remediation: 'Provide an https:// URL.',
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolsError({
        code: TOOLS_ERROR_CODES.INVALID_URL,
        message: `url is not a valid URL: ${url}`,
        context: { op: 'validate', field: 'url', value: url },
        remediation: 'Provide an https:// URL.',
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ToolsError({
        code: TOOLS_ERROR_CODES.INVALID_URL,
        message: `url must use http or https (got ${parsed.protocol})`,
        context: { op: 'validate', field: 'url', value: url, protocol: parsed.protocol },
        remediation: 'Only http:// and https:// URLs are allowed.',
      });
    }
  }

  /** Strip undefined fields and disallow caller-set id/createdAt/updatedAt. */
  private cleanInput(input: Partial<ToolEntry>): Partial<ToolEntry> {
    const out: Partial<ToolEntry> = {};
    if (input.label !== undefined) out.label = input.label;
    if (input.url !== undefined) out.url = input.url;
    return out;
  }

  private normalizeError(err: unknown, op: string): unknown {
    if (err instanceof ToolsError) return err;
    if (err instanceof LiteError) return err;
    if (err instanceof Error) {
      return new ToolsError({
        code: TOOLS_ERROR_CODES.PERSISTENCE_FAILED,
        message: `Tools ${op} failed: ${err.message}`,
        context: { op },
        cause: err,
      });
    }
    return err;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function defaultGenerateId(entry: Pick<ToolEntry, 'label'>): string {
  const base = `tool-${slug(entry.label)}`;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  return `${base}-${suffix}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'entry'
  );
}

function isLikelyEntry(value: unknown): value is ToolEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' && typeof v['label'] === 'string' && typeof v['url'] === 'string'
  );
}
