/**
 * Map a MIME type / filename to a Spaces `ItemKind`.
 *
 * Used by the download handler so a freshly-captured file lands in the
 * graph with the right `:Asset.type`, which controls preview behavior
 * in the detail rail (inline image / audio / video player / PDF embed
 * / Markdown render / generic download link).
 *
 * Pure; exported for tests. Mirrors the kinds enumerated by
 * `lite/spaces/types.ts` (`document` / `image` / `url` / `text` /
 * `audio` / `video` / `other`).
 */

export type DerivedItemKind =
  | 'document'
  | 'image'
  | 'url'
  | 'text'
  | 'audio'
  | 'video'
  | 'other';

/**
 * Determine the Spaces ItemKind for a captured file based on its MIME
 * type, with a filename fallback so `.md` / `.json` / etc. still pick
 * up the right preview when the server hands us `application/
 * octet-stream`.
 *
 * Priority:
 *   1. MIME type prefix (image/* video/* audio/* text/*)
 *   2. PDF -> document
 *   3. Common code extensions (.md, .json, .csv, .ts, .py, ...) -> text
 *   4. Office docs (.docx, .pptx, .xlsx) -> document
 *   5. Otherwise -> other
 */
export function deriveKindFromMime(
  mimeType: string | null | undefined,
  fileName?: string
): DerivedItemKind {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase().trim() : '';

  // Prefix-based MIME branches: catch the common-case wins first.
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  if (mime.startsWith('text/')) {
    // text/csv lands as `text` — the renderer detects CSV-shaped content
    // and dispatches a tabular preview. Same goes for markdown.
    return 'text';
  }
  // Code / JSON / YAML often arrives as application/* but reads as text.
  if (
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript'
  ) {
    return 'text';
  }

  // Office docs land as `document` so the kind label reads accurately
  // even though we don't render them inline.
  if (
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/rtf'
  ) {
    return 'document';
  }

  // Filename fallback for the application/octet-stream and "no mime" cases.
  const ext = extensionOf(fileName ?? '');
  if (ext.length > 0) {
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  }

  return 'other';
}

/**
 * Lower-case filename extension (without the leading dot), or '' when
 * no extension is present. Tolerates double extensions ("foo.tar.gz"
 * -> "gz" -- we only care about the outermost type signal).
 */
function extensionOf(name: string): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf('.');
  if (idx < 0 || idx === trimmed.length - 1) return '';
  return trimmed.slice(idx + 1).toLowerCase();
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'log',
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'csv',
  'tsv',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'graphql',
  'gql',
  'env',
]);

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'tiff',
  'tif',
  'avif',
  'heic',
  'heif',
]);

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'ogv',
  'm4v',
  'wmv',
]);

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'm4a',
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'aac',
  'wma',
]);

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'rtf',
  'odt',
  'ods',
  'odp',
  'epub',
  'mobi',
]);

/**
 * Defensive sanitizer for filenames going into a storage key. Strips
 * path separators, trims whitespace, collapses internal whitespace,
 * and caps the length. Returns a fallback (`'untitled'`) on empty.
 */
export function sanitizeFileName(raw: string): string {
  if (typeof raw !== 'string') return 'untitled';
  const stripped = raw.replace(/[\\/]/g, '').trim();
  const collapsed = stripped.replace(/\s+/g, ' ');
  if (collapsed.length === 0) return 'untitled';
  // Cap at a reasonable storage-friendly length. Keep extension if
  // possible by truncating from the middle.
  const MAX = 180;
  if (collapsed.length <= MAX) return collapsed;
  const dot = collapsed.lastIndexOf('.');
  if (dot > 0 && dot > collapsed.length - 12) {
    const ext = collapsed.slice(dot);
    const head = collapsed.slice(0, MAX - ext.length);
    return `${head}${ext}`;
  }
  return collapsed.slice(0, MAX);
}

/**
 * Compose the storage key for a downloaded file. Layout keeps each
 * Space's downloads in their own prefix so listing / cleanup by Space
 * is straightforward.
 *
 *   lite-downloads/<spaceId>/<download-id>/<filename>
 *
 * The per-download id (a short random string) lets two downloads of
 * the same filename to the same Space coexist without overwriting
 * each other.
 */
export function composeStorageKey(
  spaceId: string,
  downloadId: string,
  fileName: string
): string {
  const safeSpace = spaceId.trim().length > 0 ? spaceId.trim() : 'unknown';
  const safeDl = downloadId.trim().length > 0 ? downloadId.trim() : 'd';
  const safeName = sanitizeFileName(fileName);
  return `lite-downloads/${safeSpace}/${safeDl}/${safeName}`;
}

/** Storage prefix for a given Space, without a filename or download id. */
export function composeStoragePrefix(spaceId: string, downloadId: string): string {
  const safeSpace = spaceId.trim().length > 0 ? spaceId.trim() : 'unknown';
  const safeDl = downloadId.trim().length > 0 ? downloadId.trim() : 'd';
  return `lite-downloads/${safeSpace}/${safeDl}`;
}
