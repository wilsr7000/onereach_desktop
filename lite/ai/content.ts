/**
 * Pure content-resolution helpers for asset metadata extraction.
 *
 * Kept separate from `enrich.ts` (which pulls spaces/files/ai/logging) so
 * the decoding logic is unit-testable in isolation with no electron or
 * network deps. Used by the enrichment orchestrator to turn an asset's
 * stored `content` into the text body Claude reads.
 */

/** Max characters of text content sent to the model (token + cost guard). */
export const MAX_METADATA_TEXT_CHARS = 100_000;

export interface DataUrlParts {
  mediaType: string;
  base64: string;
}

/** Parse a `data:<media>;base64,<data>` URL, or null if not one. */
export function parseDataUrl(s: string): DataUrlParts | null {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(s.trim());
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { mediaType: m[1].toLowerCase(), base64: m[2] };
}

/** Approximate byte size of a base64 string and compare to a cap. */
export function withinBase64(base64: string, maxBytes: number): boolean {
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes > 0 && bytes <= maxBytes;
}

/**
 * Whether a media type is text Claude can read directly (covers
 * `text/*` plus the common text-shaped application types).
 */
export function isTextMediaType(mediaType: string): boolean {
  const m = mediaType.toLowerCase();
  return (
    m.startsWith('text/') ||
    /(json|csv|xml|yaml|markdown|javascript|ecmascript|typescript|html)/.test(m)
  );
}

/**
 * Resolve the text body to send to the model from an asset's stored
 * `content`:
 *
 *   - pasted/raw text                       -> the content (capped)
 *   - an uploaded text file stored as a
 *     `data:text/...;base64` URL            -> decoded UTF-8 (capped)
 *   - a non-text data URL (image/pdf/binary)-> null (handled elsewhere)
 *   - empty / undecodable                   -> null (hints-only)
 */
export function resolveMetadataText(content: string): string | null {
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  const data = parseDataUrl(content);
  if (data === null) {
    // Raw, non-data-URL content = pasted text / markdown / code / etc.
    return capText(content);
  }
  if (isTextMediaType(data.mediaType)) {
    try {
      const decoded = Buffer.from(data.base64, 'base64').toString('utf-8');
      return decoded.trim().length > 0 ? capText(decoded) : null;
    } catch {
      return null;
    }
  }
  // Non-text data URL (image/pdf routed by the caller; opaque binary -> hints).
  return null;
}

function capText(s: string): string {
  return s.length > MAX_METADATA_TEXT_CHARS ? s.slice(0, MAX_METADATA_TEXT_CHARS) : s;
}
