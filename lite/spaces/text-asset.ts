/**
 * Text-asset helpers — markdown/code/plain-text files in Spaces.
 *
 * The platform stores TEXT in the graph (searchable, editable with the
 * existing Markdown editor) and BINARIES in GSX (ADR-050). These pure
 * helpers implement that split for file uploads and for reading back
 * text files that already live in GSX:
 *
 *   - `shouldInlineTextFile` — upload-time routing: a small text-like
 *     file becomes inline `content` (renders + edits immediately);
 *     anything else takes the GSX path.
 *   - `decodeDataUrlText` — turn `items.readFileData`'s base64 data URL
 *     back into a UTF-8 string so GSX-resident text/markdown can feed
 *     the same renderer.
 *
 * Kept free of DOM/Electron imports so the rules are unit-testable.
 */

/** Inline-content ceiling for uploaded text files (bytes). */
export const INLINE_TEXT_MAX_BYTES = 512 * 1024; // 512 KB

/** Extensions the detail pane can render as text/markdown/code/CSV. */
const TEXT_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.text',
  '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sql',
  '.sh', '.bash', '.zsh',
  '.html', '.htm', '.mmd', '.mermaid',
  '.vtt', '.srt',
] as const;

/** Whether a file name / mime pair is text-like (renderable as text). */
export function isTextLikeFile(fileName: string, mimeType: string): boolean {
  const name = (fileName ?? '').toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (
    mime === 'application/json' ||
    mime === 'application/yaml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/xml'
  ) {
    return true;
  }
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Upload-time routing: small text-like files become inline graph
 * `content` (instant render + edit via the existing Markdown pipeline);
 * everything else goes to GSX. Size-capped so a 40 MB log file doesn't
 * land in a graph property.
 */
export function shouldInlineTextFile(
  fileName: string,
  mimeType: string,
  sizeBytes: number
): boolean {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return false;
  if (sizeBytes > INLINE_TEXT_MAX_BYTES) return false;
  return isTextLikeFile(fileName, mimeType);
}

/**
 * Decode a `data:<mime>;base64,<payload>` URL to UTF-8 text. Returns
 * null for non-base64 data URLs, undecodable payloads, or payloads that
 * are clearly binary (NUL bytes) — callers fall back to the generic
 * binary preview.
 */
export function decodeDataUrlText(dataUrl: string): string | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (m === null || m[1] === undefined) return null;
  try {
    const b64 = m[1].replace(/\s+/g, '');
    // atob in renderers, Buffer under Node (tests).
    const bin =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.includes(0)) return null; // binary masquerading as text
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}
