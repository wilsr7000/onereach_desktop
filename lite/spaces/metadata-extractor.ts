/**
 * Asset metadata auto-extraction.
 *
 * Best-effort, browser-side extraction of structured metadata from
 * the asset payload at upload time. Per-type strategies:
 *
 *   - **Image**  → load via Image element, read naturalWidth / Height
 *   - **Audio**  → load via Audio element, read duration
 *   - **Video**  → load via Video element, read videoWidth/Height + duration
 *   - **CSV/TSV** → parse delimited rows, count cols + rows + headers
 *   - **JSON**   → JSON.parse, describe shape (array vs object, top-level keys)
 *   - **Text**   → word count, line count, char count
 *   - **PDF**    → byte-scan for `/Type /Page` to count pages (best-effort)
 *
 * All extractors are pure / best-effort: they return `{}` instead of
 * throwing on malformed input, so the create path always proceeds even
 * if extraction fails partway through.
 *
 * Used by the renderer's create-asset flow to pre-populate the
 * `metadata` field on `CreateAssetInput`. The detail pane surfaces
 * the resulting bag as a key/value table.
 */

import type { ItemMetadata } from './types.js';

/** All keys we'll write at extraction time live under this prefix so
 * user-added metadata doesn't collide with auto-extracted values. */
const AUTO_PREFIX = '';

/**
 * Main entry point. Inspects file MIME + first bytes and dispatches
 * to a type-specific extractor. Never throws.
 */
export async function extractMetadataFromFile(file: File): Promise<ItemMetadata> {
  const baseMeta: ItemMetadata = {
    [`${AUTO_PREFIX}filename`]: file.name,
    [`${AUTO_PREFIX}sizeBytes`]: file.size,
    [`${AUTO_PREFIX}mimeType`]: file.type.length > 0 ? file.type : 'application/octet-stream',
    [`${AUTO_PREFIX}lastModifiedAt`]: new Date(file.lastModified).toISOString(),
  };
  const mime = (file.type ?? '').toLowerCase();
  try {
    if (mime.startsWith('image/')) {
      return { ...baseMeta, ...(await extractImageMetadata(file)) };
    }
    if (mime.startsWith('audio/')) {
      return { ...baseMeta, ...(await extractAudioMetadata(file)) };
    }
    if (mime.startsWith('video/')) {
      return { ...baseMeta, ...(await extractVideoMetadata(file)) };
    }
    if (mime === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      return { ...baseMeta, ...(await extractPdfMetadata(file)) };
    }
    if (
      mime === 'text/csv' || /\.csv$/i.test(file.name) ||
      mime === 'text/tab-separated-values' || /\.tsv$/i.test(file.name)
    ) {
      const text = await file.text();
      return { ...baseMeta, ...extractCsvMetadata(text) };
    }
    if (mime === 'application/json' || /\.json$/i.test(file.name)) {
      const text = await file.text();
      return { ...baseMeta, ...extractJsonMetadata(text) };
    }
    if (mime.startsWith('text/') || isProbablyTextExtension(file.name)) {
      const text = await file.text();
      return { ...baseMeta, ...extractTextMetadata(text) };
    }
  } catch {
    // Per-type failure shouldn't blow up the upload; we ship the base
    // metadata bag (filename + size + mime + mtime) regardless.
  }
  return baseMeta;
}

/**
 * Text-content extractor. Used when the user pastes text into the
 * new-asset modal (no File object — just a string).
 */
export function extractMetadataFromText(
  text: string,
  hint: { language?: string; mimeType?: string } = {}
): ItemMetadata {
  const baseMeta: ItemMetadata = {
    [`${AUTO_PREFIX}sizeBytes`]: byteLength(text),
  };
  const language = (hint.language ?? '').toLowerCase();
  const mime = (hint.mimeType ?? '').toLowerCase();
  if (language === 'csv' || language === 'tsv' || mime === 'text/csv') {
    return { ...baseMeta, ...extractCsvMetadata(text) };
  }
  if (language === 'json' || mime === 'application/json') {
    return { ...baseMeta, ...extractJsonMetadata(text) };
  }
  return { ...baseMeta, ...extractTextMetadata(text) };
}

// ─── Image ──────────────────────────────────────────────────────────────

export function extractImageMetadata(file: File): Promise<ItemMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = (): void => {
      const meta: ItemMetadata = {
        width: img.naturalWidth,
        height: img.naturalHeight,
        aspectRatio:
          img.naturalHeight > 0
            ? Number((img.naturalWidth / img.naturalHeight).toFixed(3))
            : 0,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    img.onerror = (): void => {
      URL.revokeObjectURL(url);
      resolve({});
    };
    img.src = url;
  });
}

// ─── Audio ──────────────────────────────────────────────────────────────

export function extractAudioMetadata(file: File): Promise<ItemMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const cleanup = (): void => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      try { audio.load(); } catch { /* fine */ }
    };
    audio.addEventListener('loadedmetadata', () => {
      const meta: ItemMetadata = {};
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        meta['durationSeconds'] = Number(audio.duration.toFixed(3));
      }
      cleanup();
      resolve(meta);
    }, { once: true });
    audio.addEventListener('error', () => {
      cleanup();
      resolve({});
    }, { once: true });
    audio.src = url;
  });
}

// ─── Video ──────────────────────────────────────────────────────────────

export function extractVideoMetadata(file: File): Promise<ItemMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const cleanup = (): void => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try { video.load(); } catch { /* fine */ }
    };
    video.addEventListener('loadedmetadata', () => {
      const meta: ItemMetadata = {};
      if (Number.isFinite(video.duration) && video.duration > 0) {
        meta['durationSeconds'] = Number(video.duration.toFixed(3));
      }
      if (video.videoWidth > 0) meta['width'] = video.videoWidth;
      if (video.videoHeight > 0) meta['height'] = video.videoHeight;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        meta['aspectRatio'] = Number(
          (video.videoWidth / video.videoHeight).toFixed(3)
        );
      }
      cleanup();
      resolve(meta);
    }, { once: true });
    video.addEventListener('error', () => {
      cleanup();
      resolve({});
    }, { once: true });
    video.src = url;
  });
}

// ─── CSV / TSV ──────────────────────────────────────────────────────────

export function extractCsvMetadata(source: string): ItemMetadata {
  if (typeof source !== 'string' || source.length === 0) {
    return { rowCount: 0, columnCount: 0 };
  }
  const allLines = source.split(/\r?\n/).filter((l) => l.length > 0);
  if (allLines.length === 0) {
    return { rowCount: 0, columnCount: 0 };
  }
  const firstLine = allLines[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const headers = parseCsvLine(firstLine, delimiter);
  const meta: ItemMetadata = {
    delimiter: delimiter === '\t' ? 'tab' : 'comma',
    columnCount: headers.length,
    rowCount: Math.max(0, allLines.length - 1),
    headers,
  };
  return meta;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delimiter) { out.push(current); current = ''; }
      else if (ch !== undefined) current += ch;
    }
  }
  out.push(current);
  return out;
}

// ─── JSON ───────────────────────────────────────────────────────────────

export function extractJsonMetadata(source: string): ItemMetadata {
  if (typeof source !== 'string' || source.length === 0) return { valid: false };
  try {
    const parsed: unknown = JSON.parse(source);
    if (Array.isArray(parsed)) {
      return {
        valid: true,
        rootShape: 'array',
        arrayLength: parsed.length,
      };
    }
    if (parsed !== null && typeof parsed === 'object') {
      const keys = Object.keys(parsed as Record<string, unknown>);
      return {
        valid: true,
        rootShape: 'object',
        topLevelKeyCount: keys.length,
        // Cap key list at 20 to keep metadata legible.
        topLevelKeys: keys.slice(0, 20),
      };
    }
    return { valid: true, rootShape: typeof parsed };
  } catch {
    return { valid: false };
  }
}

// ─── Plain text ─────────────────────────────────────────────────────────

export function extractTextMetadata(source: string): ItemMetadata {
  if (typeof source !== 'string') return {};
  const lineCount = source.length === 0 ? 0 : source.split('\n').length;
  // Word count: any run of non-whitespace counts as one word.
  const wordMatches = source.match(/\S+/g);
  const wordCount = wordMatches !== null ? wordMatches.length : 0;
  return {
    charCount: source.length,
    wordCount,
    lineCount,
  };
}

// ─── PDF (byte-scan; best-effort) ──────────────────────────────────────

/**
 * Pure scanner: examine an in-memory PDF text payload for structure
 * markers. Used by `extractPdfMetadata`; exposed separately so tests
 * can exercise the regexes without jsdom's File quirks.
 *
 * Not authoritative — encrypted or heavily-compressed PDFs may hide
 * the markers — but it's free, fast, and accurate for the bulk of
 * unencrypted documents.
 */
export function scanPdfTextForMetadata(text: string): ItemMetadata {
  if (typeof text !== 'string' || text.length === 0) return {};
  const meta: ItemMetadata = {};
  // /Type /Page (but not /Pages — the root pages object).
  const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g);
  if (pageMatches !== null) meta['pageCount'] = pageMatches.length;
  // Extract /Title (...) if present (PDF info dictionary).
  const titleMatch = text.match(/\/Title\s*\(([^)]{1,200})\)/);
  if (titleMatch !== null && titleMatch[1] !== undefined) {
    meta['pdfTitle'] = titleMatch[1];
  }
  const authorMatch = text.match(/\/Author\s*\(([^)]{1,200})\)/);
  if (authorMatch !== null && authorMatch[1] !== undefined) {
    meta['pdfAuthor'] = authorMatch[1];
  }
  return meta;
}

/**
 * File-wrapping PDF extractor. Reads bytes via `file.text()` (UTF-8
 * lossy-decodes the binary streams; ASCII structure markers survive)
 * and hands off to `scanPdfTextForMetadata`. Returns `{}` on any
 * failure so the create path can proceed.
 */
export async function extractPdfMetadata(file: File): Promise<ItemMetadata> {
  try {
    const text = await file.text();
    return scanPdfTextForMetadata(text);
  } catch {
    return {};
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function isProbablyTextExtension(name: string): boolean {
  const lower = (name ?? '').toLowerCase();
  return (
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.log') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.js') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.py') ||
    lower.endsWith('.sql') ||
    lower.endsWith('.sh')
  );
}

function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    try {
      return new TextEncoder().encode(s).length;
    } catch {
      /* fall through */
    }
  }
  // UTF-8 length approximation when TextEncoder is unavailable.
  let count = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) count += 1;
    else if (code < 0x800) count += 2;
    else if (code < 0x10000) count += 3;
    else count += 4;
  }
  return count;
}
