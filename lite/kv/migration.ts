/**
 * One-shot KV migration -- copy legacy anonymous-shared blobs into
 * the user's authenticated KV on first sign-in.
 *
 * Background: prior to the lite-kv-via-sdk chunk (see `lite/PORTING.md`),
 * Lite wrote every collection (idw entries, tabs, neon config, AI key,
 * bug index) to a single anonymous Edison KV endpoint with no per-user
 * isolation. That meant any user signing in to any Lite install would
 * see whoever's data won the last write race.
 *
 * The architectural fix (server-side per-account scoping via
 * `@or-sdk/key-value-storage`) lands at the same time as this
 * migration. Without migration, every user with existing data would
 * see an empty Lite on first launch after the upgrade -- losing
 * IDW entries, tabs, etc.
 *
 * This module:
 *   1. Reads each known collection's blob from BOTH legacy shapes:
 *        - the original global `default` key (pre-Apr-2026)
 *        - the per-account `edison:<accountId>` key (the interim
 *          client-side scoping that yesterday's fix introduced)
 *   2. If the user's authenticated KV is EMPTY for the same logical
 *      key (`default` post-server-scoping), copies the legacy blob in.
 *   3. Writes a sentinel under `lite-migrations` so we never run twice.
 *
 * Idempotent + best-effort: failures log a warning but never block
 * sign-in. Retried on every `onSessionChanged` until the sentinel
 * is set.
 *
 * @internal
 */

import type { KVApi } from './api.js';
import { getKVApi } from './api.js';
import { EdisonKVClient } from './client.js';
import { getLoggingApi } from '../logging/api.js';

/** KV collection where the migration sentinel persists. */
export const MIGRATION_COLLECTION = 'lite-migrations';

/** Sentinel key written once migration completes for the active accountId. */
export const MIGRATION_SENTINEL_KEY = 'migrated-from-default-v1';

/**
 * Collections we know to migrate. The "logical key" in the user's
 * authenticated KV is always `default` -- per-account scoping is
 * server-side now.
 *
 * Adding a collection here only matters for users upgrading from a
 * pre-server-scoping install. New installs never need migration.
 */
export const COLLECTIONS_TO_MIGRATE: ReadonlyArray<{
  /** KV collection name, e.g. `'lite-idw-entries'`. */
  collection: string;
  /** Friendly description for logs. */
  label: string;
}> = [
  { collection: 'lite-idw-entries', label: 'IDW entries' },
  { collection: 'lite-main-window-tabs', label: 'Open tabs' },
  { collection: 'lite-neon-config', label: 'Neon config' },
  { collection: 'lite-ai-config', label: 'AI key + profiles' },
];

/** Legacy globally-shared key used pre-Apr-2026. */
const LEGACY_GLOBAL_KEY = 'default';

/** Legacy per-account key used in the interim client-side scoping fix. */
function legacyAccountKey(accountId: string): string {
  return `edison:${accountId}`;
}

/** Logical key in the user's authenticated KV (server-scoped by accountId). */
const USER_KEY = 'default';

export interface MigrationConfig {
  /** Override the legacy reader (for tests). Defaults to a fresh `EdisonKVClient`. */
  legacyReader?: EdisonKVClient;
  /** Override the authenticated KV (for tests). Defaults to `getKVApi()`. */
  authedKv?: KVApi;
  /** Optional logger override -- defaults to `getLoggingApi()`. */
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

export interface MigrationResult {
  accountId: string;
  /** True when the sentinel was already set; the migration was a no-op. */
  alreadyMigrated: boolean;
  /** Collections actually copied during this run. Empty when no legacy data existed. */
  copied: string[];
  /** Collections we tried to read but failed on. Migration still completes. */
  failed: Array<{ collection: string; error: string }>;
}

/**
 * Run the one-shot migration for the active `accountId`.
 *
 * Best-effort and idempotent: subsequent calls for the same accountId
 * become no-ops once the sentinel is set. Per-collection read failures
 * are logged and skipped so a single broken legacy blob doesn't strand
 * the rest of the user's data.
 */
export async function runKvMigration(
  accountId: string,
  config: MigrationConfig = {}
): Promise<MigrationResult> {
  const log = config.logger ?? {
    info: (msg, data) => getLoggingApi().info('kv-migration', msg, data),
    warn: (msg, data) => getLoggingApi().warn('kv-migration', msg, data),
    error: (msg, data) => getLoggingApi().error('kv-migration', msg, data),
  };
  const result: MigrationResult = {
    accountId,
    alreadyMigrated: false,
    copied: [],
    failed: [],
  };

  if (typeof accountId !== 'string' || accountId.length === 0) {
    log.warn('migration skipped: no accountId');
    return result;
  }

  const authedKv = config.authedKv ?? getKVApi();
  const legacyReader = config.legacyReader ?? new EdisonKVClient();

  // Sentinel check FIRST: bail before doing any I/O if we already
  // migrated this account on this install.
  try {
    const sentinel = await authedKv.get(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY);
    if (sentinel !== null && sentinel !== undefined) {
      log.info('migration: already complete (sentinel found)', { accountId });
      result.alreadyMigrated = true;
      return result;
    }
  } catch (err) {
    // Sentinel read failure is non-fatal -- proceed and try to migrate.
    // The worst case is a duplicate copy (which is itself harmless
    // because we only write when the user's authed key is empty).
    log.warn('migration: sentinel read failed, proceeding cautiously', {
      accountId,
      error: (err as Error).message,
    });
  }

  log.info('migration: starting', { accountId, collectionCount: COLLECTIONS_TO_MIGRATE.length });

  for (const { collection, label } of COLLECTIONS_TO_MIGRATE) {
    try {
      // Don't overwrite -- if the user already has data in their
      // authenticated KV, leave it alone.
      const userExisting = await authedKv.get(collection, USER_KEY);
      if (userExisting !== null && userExisting !== undefined) {
        log.info('migration: skip (user already has data)', { collection, label });
        continue;
      }

      // Try the per-account legacy key first (the more recent shape),
      // then fall back to the global default key (the original shape).
      let legacy: unknown = null;
      try {
        legacy = await legacyReader.get(collection, legacyAccountKey(accountId));
      } catch (err) {
        log.warn('migration: legacy per-account read failed, trying global fallback', {
          collection,
          error: (err as Error).message,
        });
      }
      if (legacy === null || legacy === undefined) {
        try {
          legacy = await legacyReader.get(collection, LEGACY_GLOBAL_KEY);
        } catch (err) {
          log.warn('migration: legacy global read also failed; skipping collection', {
            collection,
            error: (err as Error).message,
          });
          result.failed.push({ collection, error: (err as Error).message });
          continue;
        }
      }

      if (legacy === null || legacy === undefined) {
        log.info('migration: no legacy data found', { collection, label });
        continue;
      }

      await authedKv.set(collection, USER_KEY, legacy);
      result.copied.push(collection);
      log.info('migration: copied legacy blob into authenticated KV', {
        collection,
        label,
      });
    } catch (err) {
      log.error('migration: collection failed (continuing)', {
        collection,
        error: (err as Error).message,
      });
      result.failed.push({ collection, error: (err as Error).message });
    }
  }

  // Always write the sentinel -- even if every collection failed --
  // so we don't keep retrying every sign-in. A failed read isn't a
  // signal to retry indefinitely; surface the failures via the
  // `failed[]` array and the warn-level log so users / dev can act.
  try {
    await authedKv.set(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY, {
      migratedAt: new Date().toISOString(),
      copied: result.copied,
      failed: result.failed.map((f) => f.collection),
      schemaVersion: 1,
    });
    log.info('migration: sentinel written', {
      accountId,
      copiedCount: result.copied.length,
      failedCount: result.failed.length,
    });
  } catch (err) {
    log.error('migration: failed to write sentinel; will retry on next sign-in', {
      accountId,
      error: (err as Error).message,
    });
  }

  return result;
}
