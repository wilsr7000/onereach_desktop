/**
 * Asset enrichment orchestrator (main process).
 *
 * Ties three modules together to "auto-add metadata to an asset":
 *   1. `spaces.items.get(id)`        -> fetch the asset
 *   2. resolve its content:
 *        - text body (text / url / markdown / code / csv / json)
 *        - image bytes  (download fileKey -> base64) for vision
 *        - PDF bytes    (download fileKey -> base64) for documents
 *   3. `ai.extractAssetMetadata(...)` -> Claude 4.8 structured metadata
 *   4. `spaces.items.patchMetadata(id, bag)` -> persist under `ai_*` keys
 *
 * Per ADR-019 / Rule 11, this orchestrator only imports other modules'
 * public `api.ts`. It is the only place that depends on spaces + files +
 * ai together; the trigger (renderer button / auto-on-create) reaches it
 * through the `lite:ai:enrich-asset` IPC channel, so there's no direct
 * spaces -> ai import cycle.
 *
 * SECURITY: asset bytes ARE sent to Anthropic (that's the feature). The
 * API key never appears here. Logs carry only ids, kind, modality, and
 * byte counts.
 */

import { getAiApi, type AssetMetadataInput, type AssetMetadataResult } from './api.js';
import { getSpacesApi, type Item } from '../spaces/api.js';
import { getFilesApi } from '../files/api.js';
import { getLoggingApi } from '../logging/api.js';
import { loadAiConfigFromDisk, DEFAULT_CLAUDE_MODEL } from './config.js';
import { parseDataUrl, withinBase64, resolveMetadataText } from './content.js';

/** Skip vision/doc download above these sizes (Anthropic per-request limits + cost). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_PDF_BYTES = 24 * 1024 * 1024; // 24 MB

/** Metadata-bag key prefix so AI-written keys never collide with user keys. */
const AI_PREFIX = 'ai_';

export interface EnrichResult {
  /** The structured metadata Claude produced. */
  metadata: AssetMetadataResult;
  /** The flat bag written under `ai_*` keys. */
  written: Record<string, string | string[]>;
  /** Which content modality was used. */
  modality: 'text' | 'image' | 'pdf' | 'hints';
}

/**
 * Enrich one asset: extract metadata via Claude and persist it. Returns
 * the metadata + the bag written. Throws `AiError` / `SpacesError` on
 * failure (the IPC layer projects these into the standard envelope).
 *
 * Eligibility (is there anything Claude can read?) is decided by the
 * caller: the renderer's auto-on-create path pre-checks
 * `isAutoEnrichEligibleRenderer` to avoid spending tokens on near-empty
 * assets, while the manual "Auto-fill metadata" button runs this
 * unconditionally. So `enrichAsset` itself never gates — a hints-only
 * asset still gets best-effort metadata from its title / filename.
 */
export async function enrichAsset(assetId: string): Promise<EnrichResult> {
  if (typeof assetId !== 'string' || assetId.length === 0) {
    throw new Error('enrichAsset requires a non-empty asset id');
  }
  const log = getLoggingApi();
  const span = log.start('ai.enrich-asset', { assetId });
  try {
    const item = await getSpacesApi().items.get(assetId);
    if (item === null) {
      throw new Error(`Asset ${assetId} not found`);
    }

    const input = await buildMetadataInput(item);
    const modality = pickModality(input);
    log.event('ai.enrich.modality', { assetId, kind: item.kind, modality });

    const metadata = await getAiApi().extractAssetMetadata(input);
    const written = toMetadataBag(metadata);
    await getSpacesApi().items.patchMetadata(assetId, written);

    span.finish({ assetId, modality, tags: metadata.tags.length });
    return { metadata, written, modality };
  } catch (err) {
    span.fail(err);
    throw err;
  }
}

// ─── content resolution ──────────────────────────────────────────────────

async function buildMetadataInput(item: Item): Promise<AssetMetadataInput> {
  const base: AssetMetadataInput = { kind: item.kind };
  if (typeof item.title === 'string' && item.title.length > 0) base.title = item.title;
  if (typeof item.mimeType === 'string' && item.mimeType.length > 0) base.mimeType = item.mimeType;
  if (typeof item.sourceUrl === 'string' && item.sourceUrl.length > 0) {
    base.sourceUrl = item.sourceUrl;
  }
  // Best-effort filename hint from the fileKey tail.
  if (typeof item.fileKey === 'string' && item.fileKey.includes('/')) {
    const tail = item.fileKey.slice(item.fileKey.lastIndexOf('/') + 1);
    if (tail.length > 0) base.fileName = tail;
  }

  const mime = (item.mimeType ?? '').toLowerCase();
  const fileKey = typeof item.fileKey === 'string' ? item.fileKey : '';
  const content = typeof item.content === 'string' ? item.content : '';
  // The new-asset dialog stores uploaded bytes as a `data:` URL in
  // `content` (no fileKey); the downloads module stores a real fileKey.
  // Handle both so enrichment works regardless of how the asset landed.
  const inline = parseDataUrl(content);

  // Image -> vision. Prefer a real fileKey download; fall back to an
  // inline data-URL; skip if too large either way.
  if (item.kind === 'image') {
    if (fileKey.length > 0) {
      const bytes = await tryDownload(fileKey, MAX_IMAGE_BYTES);
      if (bytes !== null) {
        base.imageBase64 = bytes;
        base.imageMediaType = mime.startsWith('image/') ? mime : 'image/png';
        return base;
      }
    }
    if (inline !== null && inline.mediaType.startsWith('image/') && withinBase64(inline.base64, MAX_IMAGE_BYTES)) {
      base.imageBase64 = inline.base64;
      base.imageMediaType = inline.mediaType;
      return base;
    }
  }

  // PDF -> document block. fileKey download or inline data-URL.
  if (mime === 'application/pdf') {
    if (fileKey.length > 0) {
      const bytes = await tryDownload(fileKey, MAX_PDF_BYTES);
      if (bytes !== null) {
        base.pdfBase64 = bytes;
        return base;
      }
    }
    if (inline !== null && inline.mediaType === 'application/pdf' && withinBase64(inline.base64, MAX_PDF_BYTES)) {
      base.pdfBase64 = inline.base64;
      return base;
    }
  }

  // Text body: pasted text (raw content) OR an uploaded text file stored
  // as a `data:text/...;base64` URL (decoded back to UTF-8). Returns null
  // for a non-text data URL (image/pdf handled above; opaque binary ->
  // hints-only), so uploaded .txt/.md/.csv/.json/code files get their
  // actual content read instead of being skipped.
  const textBody = resolveMetadataText(content);
  if (textBody !== null) {
    base.text = textBody;
    return base;
  }

  // Otherwise: hints-only (audio / video / opaque binary).
  return base;
}

/**
 * Download a file's bytes and base64-encode them, or null on failure /
 * over-size. Never throws (a missing/too-big binary just degrades to a
 * different modality or hints-only).
 */
async function tryDownload(fileKey: string, maxBytes: number): Promise<string | null> {
  try {
    const buf = await getFilesApi().download(fileKey);
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) {
      getLoggingApi().info('ai', 'enrich: binary skipped (size)', {
        bytes: buf.byteLength,
        maxBytes,
      });
      return null;
    }
    return Buffer.from(buf).toString('base64');
  } catch (err) {
    getLoggingApi().warn('ai', 'enrich: binary download failed', {
      error: (err as Error).message,
    });
    return null;
  }
}

function pickModality(input: AssetMetadataInput): EnrichResult['modality'] {
  if (input.imageBase64) return 'image';
  if (input.pdfBase64) return 'pdf';
  if (input.text) return 'text';
  return 'hints';
}

// ─── metadata bag projection ──────────────────────────────────────────────

/**
 * Flatten the structured result into the `ItemMetadata` bag shape
 * (string | string[] values), dropping empties so we never write blank
 * keys. Every key is prefixed `ai_` to stay clear of user-authored keys.
 */
function toMetadataBag(m: AssetMetadataResult): Record<string, string | string[]> {
  const bag: Record<string, string | string[]> = {};
  const setStr = (key: string, v: string): void => {
    if (v.trim().length > 0) bag[`${AI_PREFIX}${key}`] = v.trim();
  };
  const setList = (key: string, v: string[]): void => {
    if (v.length > 0) bag[`${AI_PREFIX}${key}`] = v;
  };
  setStr('summary', m.summary);
  setStr('suggested_title', m.suggestedTitle);
  setList('tags', m.tags);
  setList('topics', m.topics);
  setList('entities', m.entities);
  setStr('content_type', m.contentType);
  setStr('language', m.language);
  setList('key_points', m.keyPoints);
  // Provenance so the UI can show "generated by Claude" + when.
  setStr('model', resolveModelLabel());
  return bag;
}

/** Best-effort current model id for provenance (no secrets). */
function resolveModelLabel(): string {
  const cfg = loadAiConfigFromDisk(null);
  return cfg !== null && cfg.provider === 'claude' ? cfg.model : DEFAULT_CLAUDE_MODEL;
}
