/**
 * `friendlyMime` — the detail header speaks English, not wire format.
 *
 * The header showed `application/pdf` beside the kind badge. Accurate,
 * and the wrong register for the most-read line in the pane. The raw
 * value survives on the element's `title` so nothing is lost when
 * someone is actually debugging a mis-typed asset.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { friendlyMime } from '../../spaces/spaces.js';

describe('the formats people actually have', () => {
  const CASES: Array<[string, string]> = [
    ['application/pdf', 'PDF'],
    ['text/markdown', 'Markdown'],
    ['text/plain', 'Text'],
    ['text/csv', 'CSV'],
    ['application/json', 'JSON'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint'],
  ];
  for (const [mime, expected] of CASES) {
    it(`${mime} reads as ${expected}`, () => {
      expect(friendlyMime(mime)).toBe(expected);
    });
  }

  it('is case-insensitive about the incoming type', () => {
    expect(friendlyMime('APPLICATION/PDF')).toBe('PDF');
  });

  it('tolerates surrounding whitespace', () => {
    expect(friendlyMime('  application/pdf ')).toBe('PDF');
  });
});

describe('unmapped formats still read as a format', () => {
  // The point of the fallback: never show a slash-pair, even for
  // something nobody thought to map.
  it('falls back to the subtype in caps', () => {
    expect(friendlyMime('image/webp')).toBe('WEBP');
    expect(friendlyMime('audio/flac')).toBe('FLAC');
  });

  it('strips structured-syntax suffixes', () => {
    expect(friendlyMime('image/svg+xml')).toBe('SVG');
  });

  it('strips the experimental x- prefix', () => {
    expect(friendlyMime('audio/x-wav')).toBe('WAV');
  });

  it('never emits a slash', () => {
    for (const m of ['image/webp', 'audio/x-wav', 'image/svg+xml', 'video/quicktime']) {
      expect(friendlyMime(m)).not.toContain('/');
    }
  });
});

describe('absent input', () => {
  it('renders nothing rather than a placeholder', () => {
    expect(friendlyMime('')).toBe('');
    expect(friendlyMime(null)).toBe('');
    expect(friendlyMime(undefined)).toBe('');
    expect(friendlyMime('   ')).toBe('');
  });

  it('degrades gracefully on a malformed type', () => {
    expect(friendlyMime('notamime')).toBe('NOTAMIME');
  });
});
