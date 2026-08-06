/**
 * Binary-asset helpers — GSX-first asset storage (ADR-050).
 *
 * Pure functions shared by `items.createBinary` (main.ts) and the
 * inline-base64 migration sweep (gsx-migration.ts). Kept free of
 * Electron / SDK imports so unit tests can pin the key scheme, the
 * sanitization rules, and the data-URL parser without a harness.
 *
 * Key scheme: `lite-spaces/assets/<uuid>-<sanitized-name>` inside the
 * signed-in account's GSX bucket. The uuid guarantees uniqueness (two
 * uploads of `report.pdf` never collide); the sanitized original name
 * keeps keys human-readable in bucket listings and yields a sensible
 * filename hint for the AI metadata enricher.
 */

import { randomUUID } from 'node:crypto';

/** GSX prefix all Lite space assets live under. */
export const SPACES_ASSETS_PREFIX = 'lite-spaces/assets';

/**
 * Hard ceiling on a single binary asset (bytes). Matches the practical
 * IPC structured-clone comfort zone; GSX itself can take more, but a
 * >100MB ArrayBuffer round-trip through the renderer is where memory
 * pressure starts to show.
 */
export const MAX_BINARY_ASSET_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Sanitize an end-user file name for use inside a GSX key: strip path
 * separators and control characters, collapse anything outside
 * [A-Za-z0-9._-] to '-', trim leading/trailing separators, cap length.
 * Falls back to 'file' when nothing survives.
 */
export function sanitizeAssetFileName(raw: string): string {
  const base = typeof raw === 'string' ? raw : '';
  const cleaned = base
    .replace(/[/\\]+/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const capped = cleaned.slice(0, 120);
  return capped.length > 0 ? capped : 'file';
}

/**
 * Build the unique in-bucket file name for a new asset upload. The
 * uuid is injectable for tests; production callers omit it.
 */
export function buildAssetFileName(originalName: string, uuid?: string): string {
  const id = uuid !== undefined && uuid.length > 0 ? uuid : randomUUID();
  return `${id}-${sanitizeAssetFileName(originalName)}`;
}

/** Compose the full GSX key for an asset file name (prefix + name). */
export function buildAssetKey(assetFileName: string): string {
  return `${SPACES_ASSETS_PREFIX}/${assetFileName}`;
}

/**
 * Parse a `data:<media>;base64,<payload>` URL into its media type and
 * decoded bytes. Returns null for anything else (plain text, http urls,
 * malformed base64). Used by the migration sweep to lift the v1 inline
 * stubs out of the graph.
 */
export function parseDataUrlToBytes(
  s: string
): { mediaType: string; bytes: Buffer } | null {
  if (typeof s !== 'string') return null;
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(s.trim());
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const payload = m[2].replace(/\s+/g, '');
  if (payload.length === 0 || /[^A-Za-z0-9+/=]/.test(payload)) return null;
  try {
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.byteLength === 0) return null;
    return { mediaType: m[1].toLowerCase(), bytes };
  } catch {
    return null;
  }
}

/** Normalize createBinary bytes to a Buffer (ArrayBuffer | Uint8Array in). */
export function toBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return Buffer.from(bytes);
}
