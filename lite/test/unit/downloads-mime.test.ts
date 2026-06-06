import { describe, it, expect } from 'vitest';
import {
  deriveKindFromMime,
  sanitizeFileName,
  composeStorageKey,
  composeStoragePrefix,
} from '../../downloads/mime.js';

describe('downloads/mime — deriveKindFromMime', () => {
  it('prefix MIME branches', () => {
    expect(deriveKindFromMime('image/png')).toBe('image');
    expect(deriveKindFromMime('image/jpeg')).toBe('image');
    expect(deriveKindFromMime('image/svg+xml')).toBe('image');
    expect(deriveKindFromMime('video/mp4')).toBe('video');
    expect(deriveKindFromMime('video/quicktime')).toBe('video');
    expect(deriveKindFromMime('audio/mp3')).toBe('audio');
    expect(deriveKindFromMime('audio/wav')).toBe('audio');
    expect(deriveKindFromMime('text/plain')).toBe('text');
    expect(deriveKindFromMime('text/csv')).toBe('text');
    expect(deriveKindFromMime('text/markdown')).toBe('text');
  });

  it('PDF maps to document', () => {
    expect(deriveKindFromMime('application/pdf')).toBe('document');
  });

  it('JSON/XML/YAML/JS/TS application MIME types map to text', () => {
    expect(deriveKindFromMime('application/json')).toBe('text');
    expect(deriveKindFromMime('application/xml')).toBe('text');
    expect(deriveKindFromMime('application/x-yaml')).toBe('text');
    expect(deriveKindFromMime('application/javascript')).toBe('text');
    expect(deriveKindFromMime('application/typescript')).toBe('text');
  });

  it('Office document MIMEs map to document', () => {
    expect(
      deriveKindFromMime(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).toBe('document');
    expect(
      deriveKindFromMime(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe('document');
    expect(
      deriveKindFromMime(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ).toBe('document');
    expect(deriveKindFromMime('application/msword')).toBe('document');
    expect(deriveKindFromMime('application/rtf')).toBe('document');
  });

  it('falls back to extension when MIME is empty / generic', () => {
    expect(deriveKindFromMime('', 'notes.md')).toBe('text');
    expect(deriveKindFromMime('', 'archive.tar.gz')).toBe('other');
    expect(deriveKindFromMime('application/octet-stream', 'photo.png')).toBe('image');
    expect(deriveKindFromMime('application/octet-stream', 'movie.mkv')).toBe('video');
    expect(deriveKindFromMime('application/octet-stream', 'song.flac')).toBe('audio');
    expect(deriveKindFromMime('application/octet-stream', 'report.pdf')).toBe('document');
    expect(deriveKindFromMime('application/octet-stream', 'config.yaml')).toBe('text');
  });

  it('returns "other" when nothing matches', () => {
    expect(deriveKindFromMime('application/x-novelty')).toBe('other');
    expect(deriveKindFromMime(null, 'file-without-extension')).toBe('other');
    expect(deriveKindFromMime(undefined)).toBe('other');
  });

  it('tolerates case + leading/trailing whitespace on the MIME', () => {
    expect(deriveKindFromMime('  IMAGE/PNG  ')).toBe('image');
    expect(deriveKindFromMime('TEXT/CSV')).toBe('text');
  });

  it('does not crash on non-string inputs', () => {
    // @ts-expect-error: defensive runtime check -- function tolerates non-string
    expect(deriveKindFromMime(42, 'thing.pdf')).toBe('document');
    expect(deriveKindFromMime(undefined, 'thing.unknown-ext')).toBe('other');
  });
});

describe('downloads/mime — sanitizeFileName', () => {
  it('strips path separators (slashes + backslashes)', () => {
    // Dots are preserved -- they're valid filename chars. The storage
    // composer's `lite-downloads/<spaceId>/<dlId>/<name>` prefix is what
    // prevents path traversal, not this sanitizer.
    expect(sanitizeFileName('../../etc/passwd')).toBe('....etcpasswd');
    expect(sanitizeFileName('C:\\Users\\bob\\file.txt')).toBe('C:Usersbobfile.txt');
  });

  it('collapses internal whitespace + trims edges', () => {
    expect(sanitizeFileName('  hello   world.txt  ')).toBe('hello world.txt');
  });

  it('returns "untitled" on empty / non-string', () => {
    expect(sanitizeFileName('')).toBe('untitled');
    expect(sanitizeFileName('   ')).toBe('untitled');
    // @ts-expect-error: defensive runtime check
    expect(sanitizeFileName(null)).toBe('untitled');
    // @ts-expect-error: defensive runtime check
    expect(sanitizeFileName(undefined)).toBe('untitled');
  });

  it('caps length at 180 but preserves the extension', () => {
    const long = 'a'.repeat(200) + '.pdf';
    const out = sanitizeFileName(long);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('hard-truncates when extension is not present / very long', () => {
    const noExt = 'b'.repeat(250);
    const out = sanitizeFileName(noExt);
    expect(out.length).toBe(180);
    expect(out).toMatch(/^b+$/);
  });
});

describe('downloads/mime — composeStorageKey', () => {
  it('produces the canonical layout', () => {
    expect(composeStorageKey('space-123', 'dl-abc', 'report.pdf')).toBe(
      'lite-downloads/space-123/dl-abc/report.pdf'
    );
  });

  it('sanitizes the filename (slashes stripped, dots preserved)', () => {
    expect(composeStorageKey('s', 'd', '../etc/passwd')).toBe(
      'lite-downloads/s/d/..etcpasswd'
    );
  });

  it('substitutes safe placeholders for empty space / download id', () => {
    expect(composeStorageKey('', '', 'a.txt')).toBe(
      'lite-downloads/unknown/d/a.txt'
    );
    expect(composeStorageKey('   ', '   ', 'a.txt')).toBe(
      'lite-downloads/unknown/d/a.txt'
    );
  });
});

describe('downloads/mime — composeStoragePrefix', () => {
  it('omits the filename', () => {
    expect(composeStoragePrefix('space-7', 'dl-zzz')).toBe(
      'lite-downloads/space-7/dl-zzz'
    );
  });
  it('uses safe placeholders when ids are blank', () => {
    expect(composeStoragePrefix('', '')).toBe('lite-downloads/unknown/d');
  });
});
