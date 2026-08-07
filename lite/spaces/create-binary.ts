/**
 * GSX-first binary asset creation (ADR-050) — the orchestration behind
 * `items.createBinary`.
 *
 * Bytes → GSX bucket → `:Asset {url: fileKey}`. Inline base64 never
 * enters the graph, which is what makes a binary asset readable from
 * every app on the account (full app, Lite, agents) — they all resolve
 * the same key from the same bucket.
 *
 * Extracted from `main.ts` behind an injected-deps seam so the
 * validation rules, upload-before-create ordering, and the
 * orphan-cleanup path are unit-testable without Electron or a live
 * account.
 */

import { SpacesError } from './errors.js';
import type { CreateAssetInput, CreateBinaryAssetInput, Item } from './types.js';
import {
  MAX_BINARY_ASSET_BYTES,
  SPACES_ASSETS_PREFIX,
  buildAssetFileName,
  buildAssetKey,
  toBuffer,
} from './binary-asset.js';

/** Slice of the FilesApi the orchestration needs. */
export interface CreateBinaryFiles {
  upload(
    prefix: string,
    fileName: string,
    content: Buffer,
    options?: {
      contentType?: string;
      rewriteMode?: 'rewrite' | 'prevent-rewrite';
      maxFileSize?: number;
      isPublic?: boolean;
      expiresAt?: string;
    }
  ): Promise<string>;
  delete(key: string, options?: { isPublic?: boolean }): Promise<void>;
}

export interface CreateBinaryDeps {
  files: CreateBinaryFiles;
  /** Graph-side create (the SDK client's `createAsset`). */
  createAsset(input: CreateAssetInput): Promise<Item>;
  /** Best-effort warn channel for the orphan-cleanup failure path. */
  warn(message: string, data?: unknown): void;
  /**
   * True when a live asset points at the fileKey — the ambiguity
   * guard consulted before orphan cleanup deletes uploaded bytes.
   * Optional so hermetic tests (and legacy callers) keep working;
   * absent = never delete (safe default).
   */
  assetExistsForFileKey?(fileKey: string): Promise<boolean>;
  /** Test override for the generated unique file name. */
  uniqueNameFor?(originalName: string): string;
}

/**
 * Validate an optional expiry into a canonical ISO string.
 *
 * Rejects rather than ignores. A TTL the caller believes is set but
 * that was silently dropped is the worst outcome available here: the
 * user thinks the file self-destructs, and it lives forever. An expiry
 * in the past is equally rejected — it reads as "delete immediately",
 * which is never what an upload means.
 */
export function normalizeExpiresAt(
  value: string | undefined,
  now: number = Date.now()
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'expiresAt must be a non-empty ISO-8601 timestamp',
      remediation: 'Pass an ISO string such as 2026-12-31T00:00:00.000Z, or omit it for no expiry.',
      context: { op: 'items.createBinary', expiresAt: String(value) },
    });
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `expiresAt is not a valid date: ${value}`,
      remediation: 'Pass an ISO-8601 timestamp, or omit it for no expiry.',
      context: { op: 'items.createBinary', expiresAt: value },
    });
  }
  if (parsed <= now) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'expiresAt is in the past',
      remediation: 'Pick a future time, or omit it for no expiry.',
      context: { op: 'items.createBinary', expiresAt: value },
    });
  }
  return new Date(parsed).toISOString();
}

/**
 * Upload the bytes, then create the graph node with the resulting
 * fileKey. If the graph create fails after the upload succeeded, the
 * just-uploaded file is best-effort deleted so no orphan remains.
 */
export async function createBinaryAsset(
  deps: CreateBinaryDeps,
  input: CreateBinaryAssetInput
): Promise<Item> {
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : '';
  if (fileName.length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'items.createBinary requires a non-empty fileName',
      remediation: 'Pass the original file name (used to build the GSX key).',
      context: { op: 'items.createBinary' },
    });
  }
  const buf = toBuffer(input.bytes);
  if (buf.byteLength === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'items.createBinary requires non-empty bytes',
      remediation: 'Read the file before calling createBinary.',
      context: { op: 'items.createBinary', fileName },
    });
  }
  if (buf.byteLength > MAX_BINARY_ASSET_BYTES) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `File exceeds the ${Math.floor(MAX_BINARY_ASSET_BYTES / (1024 * 1024))} MB asset limit`,
      remediation: 'Upload a smaller file, or link it as a URL asset instead.',
      context: { op: 'items.createBinary', fileName, bytes: buf.byteLength },
    });
  }

  const uniqueName =
    deps.uniqueNameFor !== undefined
      ? deps.uniqueNameFor(fileName)
      : buildAssetFileName(fileName);
  const fileKey = buildAssetKey(uniqueName);
  const contentType =
    typeof input.mimeType === 'string' && input.mimeType.length > 0
      ? input.mimeType
      : 'application/octet-stream';

  // PRIVATE BY DEFAULT. `isPublic` is opt-in per asset and must be an
  // explicit `true` -- any other value (undefined, null, a truthy
  // string that snuck through an IPC boundary) lands in the private
  // bucket. Getting this wrong exposes a user's file to the world, so
  // the check is deliberately strict rather than merely truthy.
  const isPublic = input.isPublic === true;

  // Optional auto-expiry. Validated here rather than trusted: a bad
  // date silently dropped by the bucket would leave the user believing
  // the file expires when it never will.
  const expiresAt = normalizeExpiresAt(input.expiresAt);

  // 1. Bytes -> GSX. Throws FilesError (NOT_AUTHENTICATED, ...) on
  //    failure; nothing has touched the graph yet so there is nothing
  //    to unwind.
  await deps.files.upload(SPACES_ASSETS_PREFIX, uniqueName, buf, {
    contentType,
    rewriteMode: 'prevent-rewrite',
    maxFileSize: MAX_BINARY_ASSET_BYTES,
    isPublic,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });

  // 2. Graph node with the fileKey. If THIS fails, best-effort delete
  //    the just-uploaded file so no orphan accrues in the bucket.
  // The bucket is part of the file's IDENTITY, not a transient upload
  // setting: a key written to the public bucket cannot be read or
  // deleted as private. Record it on the node so every later
  // resolve/download/delete targets the same bucket the bytes went to.
  // Only stamped when public -- absence means private, which matches
  // the default and leaves every existing asset untouched.
  const metadata =
    isPublic || expiresAt !== undefined || input.metadata !== undefined
      ? {
          ...(input.metadata ?? {}),
          ...(isPublic ? { fileIsPublic: true } : {}),
          // Mirrored so the UI can show "expires <when>" without a
          // round-trip to the bucket. The bucket remains the authority
          // on actual deletion.
          ...(expiresAt !== undefined ? { fileExpiresAt: expiresAt } : {}),
        }
      : undefined;

  try {
    return await deps.createAsset({
      spaceId: input.spaceId,
      title: input.title,
      kind: input.kind ?? 'other',
      fileKey,
      mimeType: contentType,
      size: buf.byteLength,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.creatorId !== undefined ? { creatorId: input.creatorId } : {}),
      ...(input.creatorName !== undefined ? { creatorName: input.creatorName } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  } catch (err) {
    // Ambiguity guard: a create that "failed" may still have landed
    // (Edison read-after-write/timeout ambiguity — observed live
    // 2026-08-06, where cleanup tried to delete bytes a live node
    // pointed at). Only delete when we can POSITIVELY confirm no live
    // asset references the key; if the check itself fails, keep the
    // orphan — recoverable, unlike deleted live bytes.
    let safeToDelete = false;
    if (deps.assetExistsForFileKey !== undefined) {
      try {
        safeToDelete = !(await deps.assetExistsForFileKey(fileKey));
      } catch {
        deps.warn('createBinary: existence check failed -- keeping bytes', { fileKey });
      }
    }
    if (safeToDelete) {
      try {
        // Must target the same bucket the upload went to, or the orphan
        // survives -- a public file left behind is a public file nobody
        // knows about.
        await deps.files.delete(fileKey, { isPublic });
      } catch {
        deps.warn('createBinary: orphan cleanup failed', { fileKey, isPublic });
      }
    } else if (deps.assetExistsForFileKey !== undefined) {
      deps.warn('createBinary: create failed but bytes kept (node may exist)', {
        fileKey,
      });
    }
    throw err;
  }
}
