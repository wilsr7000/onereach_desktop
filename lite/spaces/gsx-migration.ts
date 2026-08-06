/**
 * GSX migration sweep (ADR-050) — lift v1 inline-base64 asset stubs
 * out of the graph and into the account's GSX file bucket.
 *
 * Before ADR-050, the upload dialog stored file bytes as a `data:` URL
 * in `a.content`. Those assets can't be shared across apps (the full
 * app resolves binaries by `fileKey` → GSX) and bloat the graph. This
 * sweep finds them, uploads each payload to GSX, and converts the node
 * to the fileKey-backed form. Idempotent by construction: a converted
 * node no longer matches the sweep's predicate.
 *
 * Runs in the background after Spaces init (see `main.ts`), throttled
 * and soft-failing:
 *   - not signed in → the first Files call throws NOT_AUTHENTICATED
 *     and the sweep aborts quietly (retried on next boot),
 *   - a single bad asset (corrupt base64, upload failure) is counted
 *     and skipped — it never stops the sweep,
 *   - per-boot page cap keeps a giant backlog from monopolizing boot.
 *
 * Fully dependency-injected so tests can drive it without Electron,
 * a live graph, or GSX.
 */

import { SPACES_EVENTS } from './events.js';
import {
  buildAssetFileName,
  buildAssetKey,
  parseDataUrlToBytes,
  MAX_BINARY_ASSET_BYTES,
} from './binary-asset.js';
import type { InlineBinaryAssetRow } from './sdk-client.js';

/** Page size per LIST query. */
const PAGE_SIZE = 25;
/** Per-run ceiling on processed assets (backlog spread across boots). */
const MAX_ITEMS_PER_RUN = 200;

/** Slice of the SdkSpacesClient the sweep needs. */
export interface GsxMigrationClient {
  listInlineBinaryAssets(limit?: number): Promise<InlineBinaryAssetRow[]>;
  convertInlineAssetToFile(id: string, fileKey: string, size: number): Promise<boolean>;
}

/** Slice of the FilesApi the sweep needs. */
export interface GsxMigrationFiles {
  upload(
    prefix: string,
    fileName: string,
    content: Buffer,
    options?: { contentType?: string; rewriteMode?: 'rewrite' | 'prevent-rewrite' }
  ): Promise<string>;
}

/** Slice of the LoggingApi the sweep needs. */
export interface GsxMigrationLog {
  start(name: string, data?: unknown): {
    finish(data?: unknown): void;
    fail(err: unknown): void;
  };
  event(name: string, data?: unknown): void;
  info(category: string, message: string, data?: unknown): void;
  warn(category: string, message: string, data?: unknown): void;
}

export interface GsxMigrationDeps {
  client: GsxMigrationClient;
  files: GsxMigrationFiles;
  log: GsxMigrationLog;
  /** Test override for the per-run cap. */
  maxItems?: number;
  /** Test override for the GSX prefix (production uses the shared one). */
  assetsPrefix?: string;
}

export interface GsxMigrationResult {
  /** How many stub assets the sweep looked at. */
  scanned: number;
  /** Successfully uploaded + converted. */
  migrated: number;
  /** Parse/upload/convert failures (left in place; retried next run). */
  failed: number;
  /** True when the sweep stopped early because auth was unavailable. */
  aborted: boolean;
}

/**
 * Run one sweep. Never throws — every outcome (including "signed
 * out") resolves to a result the caller can log and forget.
 */
export async function runGsxMigration(deps: GsxMigrationDeps): Promise<GsxMigrationResult> {
  const max = deps.maxItems ?? MAX_ITEMS_PER_RUN;
  const result: GsxMigrationResult = { scanned: 0, migrated: 0, failed: 0, aborted: false };
  const span = deps.log.start('spaces.gsxMigrate');

  try {
    // Track ids that failed this run so a failing page doesn't loop
    // forever (the LIST query would keep returning the same rows).
    const failedIds = new Set<string>();

    while (result.scanned < max) {
      let rows: InlineBinaryAssetRow[];
      try {
        rows = await deps.client.listInlineBinaryAssets(PAGE_SIZE);
      } catch (err) {
        // Graph unavailable (signed out / offline) — abort quietly.
        deps.log.info('spaces', 'gsx-migrate: graph unavailable; aborting sweep', {
          error: (err as Error).message,
        });
        result.aborted = true;
        break;
      }
      const fresh = rows.filter((r) => !failedIds.has(r.id));
      if (fresh.length === 0) break; // done (or only failures remain)

      for (const row of fresh) {
        if (result.scanned >= max) break;
        result.scanned += 1;

        const parsed = parseDataUrlToBytes(row.content);
        if (parsed === null || parsed.bytes.byteLength > MAX_BINARY_ASSET_BYTES) {
          // Not actually a decodable inline binary (or over-cap):
          // leave the node alone but skip it for this run.
          failedIds.add(row.id);
          result.failed += 1;
          deps.log.event(SPACES_EVENTS.GSX_MIGRATE_ITEM, {
            assetId: row.id,
            outcome: 'skipped',
          });
          continue;
        }

        const contentType =
          row.mimeType.length > 0 ? row.mimeType : parsed.mediaType;
        const uniqueName = buildAssetFileName(
          row.title.length > 0 ? row.title : row.id
        );
        const prefix = deps.assetsPrefix ?? 'lite-spaces/assets';
        const fileKey =
          deps.assetsPrefix !== undefined
            ? `${deps.assetsPrefix}/${uniqueName}`
            : buildAssetKey(uniqueName);

        try {
          await deps.files.upload(prefix, uniqueName, parsed.bytes, {
            contentType,
            rewriteMode: 'prevent-rewrite',
          });
        } catch (err) {
          const code = (err as { code?: string }).code ?? '';
          if (code === 'FILES_NOT_AUTHENTICATED') {
            // No session — nothing else in this run can succeed.
            deps.log.info('spaces', 'gsx-migrate: not signed in; aborting sweep', {});
            result.aborted = true;
            result.scanned -= 1; // this one wasn't really processed
            break;
          }
          failedIds.add(row.id);
          result.failed += 1;
          deps.log.event(SPACES_EVENTS.GSX_MIGRATE_ITEM, {
            assetId: row.id,
            outcome: 'failed',
          });
          continue;
        }

        try {
          const converted = await deps.client.convertInlineAssetToFile(
            row.id,
            fileKey,
            parsed.bytes.byteLength
          );
          if (converted) {
            result.migrated += 1;
            deps.log.event(SPACES_EVENTS.GSX_MIGRATE_ITEM, {
              assetId: row.id,
              outcome: 'migrated',
              bytes: parsed.bytes.byteLength,
            });
          } else {
            failedIds.add(row.id);
            result.failed += 1;
            deps.log.event(SPACES_EVENTS.GSX_MIGRATE_ITEM, {
              assetId: row.id,
              outcome: 'failed',
            });
          }
        } catch (err) {
          failedIds.add(row.id);
          result.failed += 1;
          deps.log.warn('spaces', 'gsx-migrate: convert failed after upload', {
            assetId: row.id,
            fileKey,
            error: (err as Error).message,
          });
          deps.log.event(SPACES_EVENTS.GSX_MIGRATE_ITEM, {
            assetId: row.id,
            outcome: 'failed',
          });
        }
      }

      if (result.aborted) break;
    }

    span.finish({
      scanned: result.scanned,
      migrated: result.migrated,
      failed: result.failed,
    });
  } catch (err) {
    // Defensive: the loop soft-fails everything, so this is unexpected.
    span.fail(err);
  }
  return result;
}
