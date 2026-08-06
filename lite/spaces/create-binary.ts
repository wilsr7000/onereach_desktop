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
    }
  ): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface CreateBinaryDeps {
  files: CreateBinaryFiles;
  /** Graph-side create (the SDK client's `createAsset`). */
  createAsset(input: CreateAssetInput): Promise<Item>;
  /** Best-effort warn channel for the orphan-cleanup failure path. */
  warn(message: string, data?: unknown): void;
  /** Test override for the generated unique file name. */
  uniqueNameFor?(originalName: string): string;
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

  // 1. Bytes -> GSX. Throws FilesError (NOT_AUTHENTICATED, ...) on
  //    failure; nothing has touched the graph yet so there is nothing
  //    to unwind.
  await deps.files.upload(SPACES_ASSETS_PREFIX, uniqueName, buf, {
    contentType,
    rewriteMode: 'prevent-rewrite',
    maxFileSize: MAX_BINARY_ASSET_BYTES,
  });

  // 2. Graph node with the fileKey. If THIS fails, best-effort delete
  //    the just-uploaded file so no orphan accrues in the bucket.
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
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  } catch (err) {
    try {
      await deps.files.delete(fileKey);
    } catch {
      deps.warn('createBinary: orphan cleanup failed', { fileKey });
    }
    throw err;
  }
}
