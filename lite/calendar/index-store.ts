/**
 * Schedule-index storage (ADR-090): a local file under userData for
 * instant warm starts, mirrored to the account's KV so the platform-side
 * feed regenerator can share the same answers. Load prefers local;
 * save writes both, and a KV failure is logged, never fatal.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexStore } from './api.js';
import type { ScheduleIndex } from './index.js';

export const INDEX_KV_COLLECTION = 'calendar';
export const indexKvKey = (accountId: string): string => `schedule-index:${accountId}`;

export function fileIndexStore(dir: string): IndexStore {
  const pathFor = (accountId: string): string => join(dir, `calendar-schedule-index-${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  return {
    async load(accountId) {
      try {
        return JSON.parse(await readFile(pathFor(accountId), 'utf8')) as unknown;
      } catch {
        return null;
      }
    },
    async save(accountId, index) {
      await mkdir(dir, { recursive: true });
      const target = pathFor(accountId);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(index), 'utf8');
      await rename(tmp, target);
    },
  };
}

export function kvIndexStore(kv: { get(collection: string, key: string): Promise<unknown | null>; set(collection: string, key: string, value: unknown): Promise<void> }): IndexStore {
  return {
    load: (accountId) => kv.get(INDEX_KV_COLLECTION, indexKvKey(accountId)),
    save: (accountId, index: ScheduleIndex) => kv.set(INDEX_KV_COLLECTION, indexKvKey(accountId), index),
  };
}

/** First store that answers wins on load; every store is written on save (later failures logged by the caller). */
export function compositeIndexStore(stores: IndexStore[], warn: (message: string, data?: unknown) => void = () => undefined): IndexStore {
  return {
    async load(accountId) {
      for (const s of stores) {
        try {
          const v = await s.load(accountId);
          if (v !== null && v !== undefined) return v;
        } catch (err) {
          warn('schedule index store failed to load', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return null;
    },
    async save(accountId, index) {
      const results = await Promise.allSettled(stores.map((s) => s.save(accountId, index)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      for (const f of failed) warn('schedule index store failed to save', { error: f.reason instanceof Error ? f.reason.message : String(f.reason) });
      if (failed.length === results.length && results.length > 0) throw new Error('no schedule index store could save');
    },
  };
}
