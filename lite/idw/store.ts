/**
 * IDW store -- KV-only persistence for the IDW menu's entries.
 *
 * Per the kernel direction (no local files), all reads and writes go
 * to the Edison KV flow (`lite/kv/api.ts`) under collection
 * `lite-idw-entries`, key `default`. The whole entry list is one
 * JSON blob -- size is bounded by user choices and the menu builder
 * loads everything into memory anyway, so keep-it-simple beats per-id
 * keys.
 *
 * Per ADR-019 / Rule 11, this file is module-internal. Other lite
 * modules MUST consume `getIdwApi()` from `./api.ts` -- never reach
 * into IdwStore directly. (The class is exported only because TS
 * cannot truly hide it without a barrel layer; the discipline is
 * enforced by the rule + dep-cruiser.)
 *
 * Validation rules:
 *  - Per-kind required fields enforced via `KIND_META[kind].requiredFields`
 *  - URL must parse and use http or https
 *  - audio-generator entries must have `audio.subCategory`
 *  - update() cannot change `kind` (use remove + add)
 *
 * Add semantics:
 *  - If `entry.id` matches an existing entry, throw IDW_DUPLICATE.
 *  - If `entry.source === 'store'` AND `entry.storeMetadata.catalogId`
 *    matches an existing entry's `storeMetadata.catalogId`, this is a
 *    Store re-install: UPDATE the existing entry in place, preserving
 *    its `id` and `installedAt`, setting `updatedAt`. Returns the
 *    updated entry; emits `idw.store.updated` (instead of installed).
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
import { IdwError, IDW_ERROR_CODES } from './errors.js';
import type { AgentKind, IdwEntry, IdwStorageBlob } from './types.js';
import { KIND_META } from './kind-metadata.js';
import { isIdwEvent, type IdwEvent, IDW_EVENTS } from './events.js';

export const KV_COLLECTION = 'lite-idw-entries';
/**
 * Legacy globally-shared KV key. PRESERVED FOR BACKWARD-COMPAT ONLY:
 * old installs (and the global anonymous KV namespace) still hold one
 * `default` blob with whoever's data won the last race. New reads /
 * writes use a per-account key (see `keyForAccount`), so multi-user
 * isolation is restored even though that legacy blob still exists.
 */
export const KV_KEY = 'default';

/**
 * Per-account KV key. The IDW catalog belongs to the user's OneReach
 * account, not to the local Mac, so we key by the captured `accountId`.
 */
function keyForAccount(accountId: string): string {
  return `edison:${accountId}`;
}

/**
 * The result of `add()`. `wasUpdate=true` indicates an existing Store
 * entry was updated (matched by `storeMetadata.catalogId`) rather than
 * a new entry created.
 */
export interface AddResult {
  entry: IdwEntry;
  wasUpdate: boolean;
}

export interface StoreConfig {
  /** Optional KV API override (for tests). */
  kvApi?: KVApi;
  /** Optional logger. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, each store op
   * (`add/update/remove`) wraps its work in a `idw.<op>.start` /
   * `.finish` / `.fail` span. ADR-030.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /**
   * Optional clock for deterministic tests. Defaults to `() => new Date()`.
   */
  now?: () => Date;
  /**
   * Optional id generator for deterministic tests. Defaults to a slug
   * + short random suffix.
   */
  generateId?: (entry: Pick<IdwEntry, 'kind' | 'label'>) => string;
  /**
   * Resolver for the active OneReach `accountId`. When `null`, the
   * store treats the user as signed-out: reads return an empty list
   * and writes are refused. Wired in `lite/idw/api.ts` to
   * `getAuthApi().getSession('edison')?.accountId ?? null`.
   *
   * If omitted (e.g. legacy tests), the store falls back to the
   * globally-shared `'default'` key for backward compatibility -- but
   * runtime callers always pass this resolver so multi-user isolation
   * is enforced.
   */
  getActiveAccountId?: () => string | null;
}

/**
 * Module-internal class. Other lite modules MUST NOT import this directly --
 * use `getIdwApi()` from `./api.ts` instead (rule 11 in
 * lite/LITE-RULES.md, ADR-019 in lite/DECISIONS.md).
 *
 * @internal
 */
export class IdwStore {
  private readonly kv: KVApi;
  private readonly log: NonNullable<StoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<StoreConfig['spanEmitter']> | null;
  private readonly nowFn: () => Date;
  private readonly genIdFn: NonNullable<StoreConfig['generateId']>;
  private readonly getActiveAccountId: NonNullable<StoreConfig['getActiveAccountId']> | null;
  private readonly emitter = new EventEmitter();
  /** Cached blob -- read on first access, refreshed after every write. */
  private cache: IdwStorageBlob | null = null;
  /** accountId we last cached for; used to invalidate cache on user switch. */
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

  /**
   * Resolve the KV key for the current sign-in state. Returns null
   * when no account is active and the legacy global-default fallback
   * is disabled (i.e. `getActiveAccountId` was provided in config).
   * Returns 'default' (the legacy global key) only when no resolver
   * was provided -- preserves backward-compat for tests.
   */
  private resolveKey(): string | null {
    if (this.getActiveAccountId === null) return KV_KEY; // legacy fallback
    const accountId = this.getActiveAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return keyForAccount(accountId);
  }

  /** Read all entries (cached). */
  async list(): Promise<IdwEntry[]> {
    const blob = await this.readBlob();
    return [...blob.entries];
  }

  /** Read all entries of a given kind. */
  async listByKind(kind: AgentKind): Promise<IdwEntry[]> {
    const all = await this.list();
    return all.filter((e) => e.kind === kind);
  }

  /** Read a single entry by id, or null if absent. */
  async get(id: string): Promise<IdwEntry | null> {
    const all = await this.list();
    return all.find((e) => e.id === id) ?? null;
  }

  /**
   * Add a new entry (or, for source='store' entries with a matching
   * `storeMetadata.catalogId`, update the existing one in place).
   * Returns `{ entry, wasUpdate }`.
   */
  async add(input: Partial<IdwEntry> & Pick<IdwEntry, 'kind' | 'label' | 'url'>): Promise<AddResult> {
    const span = this.spanEmitter?.('idw.add', {
      kind: input.kind,
      hasId: typeof input.id === 'string' && input.id.length > 0,
    });
    try {
      this.assertKind(input.kind);
      this.assertUrl(input.url, 'url');
      if (input.apiUrl !== undefined && input.apiUrl !== '') {
        this.assertUrl(input.apiUrl, 'apiUrl');
      }
      this.assertPerKindFields(input as IdwEntry);

      const blob = await this.readBlob();
      const now = this.nowFn().toISOString();

      // Store re-install path: match by source='store' + catalogId.
      if (input.source === 'store' && input.storeMetadata?.catalogId !== undefined) {
        const catalogId = input.storeMetadata.catalogId;
        const existingIdx = blob.entries.findIndex(
          (e) => e.source === 'store' && e.storeMetadata?.catalogId === catalogId
        );
        if (existingIdx >= 0) {
          // Update the existing entry in place. Preserve id + createdAt
          // + storeMetadata.installedAt; refresh everything else.
          const existing = blob.entries[existingIdx];
          if (existing === undefined) {
            // Should be unreachable given the index check, but TS narrowing.
            throw new IdwError({
              code: IDW_ERROR_CODES.PERSISTENCE_FAILED,
              message: 'IdwStore.add: index race during catalog dedupe',
              context: { op: 'add', catalogId },
            });
          }
          if (existing.kind !== input.kind) {
            throw new IdwError({
              code: IDW_ERROR_CODES.KIND_MISMATCH,
              message: `Catalog entry ${catalogId} has kind '${existing.kind}'; cannot install as '${input.kind}'.`,
              context: { op: 'add', catalogId, existingKind: existing.kind, newKind: input.kind },
              remediation: 'Remove the existing entry first, then re-install.',
            });
          }
          const merged: IdwEntry = {
            ...existing,
            ...this.cleanInput(input, existing.kind),
            id: existing.id,
            kind: existing.kind,
            createdAt: existing.createdAt,
            updatedAt: now,
            storeMetadata: {
              ...existing.storeMetadata,
              ...input.storeMetadata,
              catalogId,
              installedAt: existing.storeMetadata?.installedAt ?? now,
              updatedAt: now,
            },
          };
          const next = blob.entries.slice();
          next[existingIdx] = merged;
          await this.writeBlob({ ...blob, entries: next });
          getLoggingApi().event(IDW_EVENTS.STORE_UPDATED, {
            id: merged.id,
            kind: merged.kind,
            catalogId,
          });
          this.emitChanged(next);
          span?.finish({
            id: merged.id,
            kind: merged.kind,
            source: merged.source,
            wasUpdate: true,
          });
          return { entry: merged, wasUpdate: true };
        }
      }

      // New-entry path. Generate id if absent; reject if id collides.
      const id = (input.id ?? '').length > 0 ? (input.id as string) : this.genIdFn({ kind: input.kind, label: input.label });
      if (blob.entries.some((e) => e.id === id)) {
        throw new IdwError({
          code: IDW_ERROR_CODES.DUPLICATE,
          message: `An entry with id '${id}' already exists.`,
          context: { op: 'add', id },
          remediation: 'Choose a different label, or update the existing entry instead.',
        });
      }
      const entry: IdwEntry = {
        ...this.cleanInput(input, input.kind),
        id,
        kind: input.kind,
        label: input.label,
        url: input.url,
        source: input.source ?? 'manual',
        createdAt: now,
        updatedAt: now,
      };
      const next = [...blob.entries, entry];
      await this.writeBlob({ ...blob, entries: next });
      if (entry.source === 'store' && entry.storeMetadata !== undefined) {
        getLoggingApi().event(IDW_EVENTS.STORE_INSTALLED, {
          id: entry.id,
          kind: entry.kind,
          catalogId: entry.storeMetadata.catalogId,
        });
      }
      this.emitChanged(next);
      span?.finish({ id: entry.id, kind: entry.kind, source: entry.source, wasUpdate: false });
      return { entry, wasUpdate: false };
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'add');
    }
  }

  /**
   * Update mutable fields on an existing entry. Throws IDW_NOT_FOUND
   * when the id doesn't resolve, IDW_KIND_MISMATCH if the patch
   * attempts to change `kind`.
   */
  async update(id: string, patch: Partial<IdwEntry>): Promise<IdwEntry> {
    const span = this.spanEmitter?.('idw.update', { id, fields: Object.keys(patch) });
    try {
      const blob = await this.readBlob();
      const idx = blob.entries.findIndex((e) => e.id === id);
      if (idx < 0) {
        throw new IdwError({
          code: IDW_ERROR_CODES.NOT_FOUND,
          message: `Entry not found: ${id}`,
          context: { op: 'update', id },
          remediation: 'Refresh the list -- the entry may have been removed.',
        });
      }
      const existing = blob.entries[idx];
      if (existing === undefined) {
        // Unreachable given idx check, but narrows for TS.
        throw new IdwError({
          code: IDW_ERROR_CODES.PERSISTENCE_FAILED,
          message: 'IdwStore.update: index race',
          context: { op: 'update', id },
        });
      }
      if (patch.kind !== undefined && patch.kind !== existing.kind) {
        throw new IdwError({
          code: IDW_ERROR_CODES.KIND_MISMATCH,
          message: `Cannot change entry kind from '${existing.kind}' to '${patch.kind}'.`,
          context: { op: 'update', id, oldKind: existing.kind, newKind: patch.kind },
          remediation: 'Remove the existing entry and add a new one of the desired kind.',
        });
      }
      if (patch.url !== undefined) {
        this.assertUrl(patch.url, 'url');
      }
      if (patch.apiUrl !== undefined && patch.apiUrl !== '') {
        this.assertUrl(patch.apiUrl, 'apiUrl');
      }
      const now = this.nowFn().toISOString();
      const merged: IdwEntry = {
        ...existing,
        ...this.cleanInput(patch, existing.kind),
        id: existing.id,
        kind: existing.kind,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      this.assertPerKindFields(merged);
      const next = blob.entries.slice();
      next[idx] = merged;
      await this.writeBlob({ ...blob, entries: next });
      this.emitChanged(next);
      span?.finish({ id: merged.id, kind: merged.kind });
      return merged;
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'update');
    }
  }

  /** Remove an entry. Throws IDW_NOT_FOUND if missing. */
  async remove(id: string): Promise<void> {
    const span = this.spanEmitter?.('idw.remove', { id });
    try {
      const blob = await this.readBlob();
      const idx = blob.entries.findIndex((e) => e.id === id);
      if (idx < 0) {
        throw new IdwError({
          code: IDW_ERROR_CODES.NOT_FOUND,
          message: `Entry not found: ${id}`,
          context: { op: 'remove', id },
          remediation: 'Refresh the list -- the entry may have already been removed.',
        });
      }
      const removed = blob.entries[idx];
      const next = blob.entries.slice();
      next.splice(idx, 1);
      await this.writeBlob({ ...blob, entries: next });
      this.emitChanged(next);
      span?.finish({ id, kind: removed?.kind });
    } catch (err) {
      span?.fail(err);
      throw this.normalizeError(err, 'remove');
    }
  }

  /**
   * Subscribe to changes. Handler receives the latest entry list each
   * time the store mutates. Returns an unsubscribe function.
   */
  onChange(handler: (entries: IdwEntry[]) => void): () => void {
    this.emitter.on('change', handler);
    return (): void => {
      this.emitter.off('change', handler);
    };
  }

  /**
   * Subscribe to typed IDW events (ADR-032). Internally subscribes to
   * `getLoggingApi().onEvent('idw.*', ...)` and casts each matching
   * record to `IdwEvent`.
   */
  onEvent(handler: (event: IdwEvent) => void): () => void {
    return getLoggingApi().onEvent('idw.*', (ev: EventRecord) => {
      if (isIdwEvent(ev)) {
        handler(ev as unknown as IdwEvent);
      }
    });
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async readBlob(): Promise<IdwStorageBlob> {
    const key = this.resolveKey();
    // Signed-out: empty list. Don't read or write the shared global
    // default blob -- doing so historically leaked one user's IDWs to
    // every other Lite install.
    if (key === null) {
      return { schemaVersion: 1, entries: [] };
    }
    // Cache invalidation on account switch.
    if (this.cache !== null && this.cachedForAccountId === key) return this.cache;
    try {
      const raw = await this.kv.get(KV_COLLECTION, key);
      if (raw === null || raw === undefined) {
        this.cache = { schemaVersion: 1, entries: [] };
        this.cachedForAccountId = key;
        return this.cache;
      }
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        // Recover gracefully: log and treat as empty rather than crash.
        this.log('warn', 'idw-store: unexpected KV blob shape, resetting in-memory', {
          actualType: Array.isArray(raw) ? 'array' : typeof raw,
        });
        this.cache = { schemaVersion: 1, entries: [] };
        this.cachedForAccountId = key;
        return this.cache;
      }
      const blob = raw as Partial<IdwStorageBlob>;
      const entries = Array.isArray(blob.entries) ? blob.entries.filter(isLikelyEntry) : [];
      this.cache = { schemaVersion: 1, entries };
      this.cachedForAccountId = key;
      return this.cache;
    } catch (err) {
      if (err instanceof KVError) {
        // Soft-fail reads -- modal/menu can render an empty state.
        this.log('warn', 'idw-store: KV read failed, returning empty', {
          code: err.code,
        });
        this.cache = { schemaVersion: 1, entries: [] };
        this.cachedForAccountId = key;
        return this.cache;
      }
      throw err;
    }
  }

  private async writeBlob(blob: IdwStorageBlob): Promise<void> {
    const key = this.resolveKey();
    if (key === null) {
      // Signed-out: refuse the write rather than corrupt the shared
      // global default blob. UI should not be exposing add/remove when
      // signed-out, but defend in depth.
      throw new IdwError({
        code: IDW_ERROR_CODES.PERSISTENCE_FAILED,
        message: 'Cannot save IDW changes while signed out. Sign in to OneReach first.',
        context: { op: 'write', collection: KV_COLLECTION, reason: 'signed-out' },
        remediation: 'Open Settings -> Account and sign in.',
      });
    }
    try {
      await this.kv.set(KV_COLLECTION, key, blob);
      this.cache = blob;
      this.cachedForAccountId = key;
    } catch (err) {
      const message = (err as Error).message;
      throw new IdwError({
        code: IDW_ERROR_CODES.PERSISTENCE_FAILED,
        message: `IDW persistence failed: ${message}`,
        context: {
          op: 'write',
          collection: KV_COLLECTION,
          key,
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

  private emitChanged(entries: IdwEntry[]): void {
    getLoggingApi().event(IDW_EVENTS.CHANGED, { count: entries.length });
    // Iterate listeners explicitly so a thrown handler doesn't stop
    // the chain. (Node's EventEmitter halts on first throw -- not
    // what we want for cross-window broadcast subscribers.)
    const snapshot = entries.slice();
    const listeners = this.emitter.listeners('change') as Array<(entries: IdwEntry[]) => void>;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.log('warn', 'idw-store: onChange subscriber threw', {
          error: (err as Error).message,
        });
      }
    }
  }

  private assertKind(kind: unknown): void {
    if (typeof kind !== 'string' || KIND_META[kind as AgentKind] === undefined) {
      throw new IdwError({
        code: IDW_ERROR_CODES.INVALID_INPUT,
        message: `Invalid kind: ${String(kind)}`,
        context: { op: 'validate', field: 'kind', value: String(kind) },
        remediation: 'Use one of: idw, external-bot, image-creator, video-creator, audio-generator, ui-design-tool.',
      });
    }
  }

  private assertUrl(url: unknown, field: string): void {
    if (typeof url !== 'string' || url.length === 0) {
      throw new IdwError({
        code: IDW_ERROR_CODES.INVALID_URL,
        message: `${field} is required and must be a non-empty string`,
        context: { op: 'validate', field },
        remediation: 'Provide an https:// URL.',
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new IdwError({
        code: IDW_ERROR_CODES.INVALID_URL,
        message: `${field} is not a valid URL: ${url}`,
        context: { op: 'validate', field, value: url },
        remediation: 'Provide an https:// URL.',
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new IdwError({
        code: IDW_ERROR_CODES.INVALID_URL,
        message: `${field} must use http or https (got ${parsed.protocol})`,
        context: { op: 'validate', field, value: url, protocol: parsed.protocol },
        remediation: 'Only http:// and https:// URLs are allowed.',
      });
    }
  }

  private assertPerKindFields(entry: Partial<IdwEntry>): void {
    const kind = entry.kind;
    if (kind === undefined) return; // assertKind catches this elsewhere
    if (typeof entry.label !== 'string' || entry.label.length === 0) {
      throw new IdwError({
        code: IDW_ERROR_CODES.INVALID_INPUT,
        message: 'label is required',
        context: { op: 'validate', field: 'label', kind },
        remediation: 'Give the entry a human-readable name.',
      });
    }
    const meta = KIND_META[kind];
    if (meta.requiresAudioSubCategory) {
      const sub = entry.audio?.subCategory;
      if (sub === undefined) {
        throw new IdwError({
          code: IDW_ERROR_CODES.INVALID_INPUT,
          message: `${meta.label} requires an audio sub-category`,
          context: { op: 'validate', field: 'audio.subCategory', kind },
          remediation: 'Choose music, effects, narration, or custom.',
        });
      }
    }
  }

  /**
   * Strip undefined fields from a Partial<IdwEntry> so spread doesn't
   * paint over real values with `undefined`. Also drops fields the
   * caller is not allowed to set directly (id/createdAt/updatedAt --
   * the store owns those).
   *
   * `kind` (when supplied) gates kind-specific fields: `botType` is
   * only meaningful on `external-bot` entries, so it's dropped
   * silently for any other kind. Add passes `input.kind`; update
   * passes `existing.kind` since update cannot change kind.
   */
  private cleanInput(input: Partial<IdwEntry>, kind?: AgentKind): Partial<IdwEntry> {
    const out: Partial<IdwEntry> = {};
    const assignable: ReadonlyArray<keyof IdwEntry> = [
      'label',
      'url',
      'apiUrl',
      'source',
      'description',
      'category',
      'iconName',
      'thumbnailUrl',
      'environment',
      'audio',
      'storeMetadata',
      'botType',
    ];
    for (const key of assignable) {
      const value = input[key];
      if (value === undefined) continue;
      if (key === 'botType' && kind !== undefined && kind !== 'external-bot') continue;
      // Type-safe assignment: each key maps to its own type in IdwEntry.
      // Cast through `Partial<IdwEntry>` rather than asserting per-key.
      (out as Record<string, unknown>)[key] = value;
    }
    return out;
  }

  private normalizeError(err: unknown, op: string): unknown {
    if (err instanceof IdwError) return err;
    if (err instanceof LiteError) {
      // Preserve other LiteErrors (e.g. KVError) so consumers can branch.
      return err;
    }
    if (err instanceof Error) {
      return new IdwError({
        code: IDW_ERROR_CODES.PERSISTENCE_FAILED,
        message: `IDW ${op} failed: ${err.message}`,
        context: { op },
        cause: err,
      });
    }
    return err;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Default id generator -- slugified label + 6-char random suffix.
 * Suffix avoids collisions when the same label is reused (e.g. two
 * "DALL-E" image creators).
 */
function defaultGenerateId(entry: Pick<IdwEntry, 'kind' | 'label'>): string {
  const base = `${entry.kind}-${slug(entry.label)}`;
  // Use 6 hex chars from a UUID for a short suffix.
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  return `${base}-${suffix}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'entry';
}

/** Loose runtime check used during blob recovery. Not full validation. */
function isLikelyEntry(value: unknown): value is IdwEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['kind'] === 'string' &&
    typeof v['label'] === 'string' &&
    typeof v['url'] === 'string'
  );
}
