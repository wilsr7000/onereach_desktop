import { describe, it, expect } from 'vitest';
import {
  shouldInlineTextFile,
  isTextLikeFile,
  decodeDataUrlText,
  INLINE_TEXT_MAX_BYTES,
} from '../../spaces/text-asset.js';

describe('isTextLikeFile', () => {
  it.each([
    ['notes.md', ''],
    ['notes.markdown', ''],
    ['readme.txt', ''],
    ['data.csv', ''],
    ['config.yaml', ''],
    ['script.py', ''],
    ['anything.bin', 'text/markdown'],
    ['anything.bin', 'text/plain'],
    ['payload.bin', 'application/json'],
  ])('accepts %s (mime=%s)', (name, mime) => {
    expect(isTextLikeFile(name, mime)).toBe(true);
  });

  it.each([
    ['photo.png', 'image/png'],
    ['movie.mp4', 'video/mp4'],
    ['archive.zip', 'application/zip'],
    ['doc.pdf', 'application/pdf'],
    ['unknown.bin', ''],
  ])('rejects %s (mime=%s)', (name, mime) => {
    expect(isTextLikeFile(name, mime)).toBe(false);
  });
});

describe('shouldInlineTextFile', () => {
  it('inlines a small markdown file', () => {
    expect(shouldInlineTextFile('notes.md', 'text/markdown', 4_000)).toBe(true);
    // Browsers often report empty mime for .md — extension carries it.
    expect(shouldInlineTextFile('notes.md', '', 4_000)).toBe(true);
  });

  it('routes over-cap text files to GSX', () => {
    expect(shouldInlineTextFile('big.md', 'text/markdown', INLINE_TEXT_MAX_BYTES + 1)).toBe(false);
  });

  it('routes binaries to GSX regardless of size', () => {
    expect(shouldInlineTextFile('pic.png', 'image/png', 1_000)).toBe(false);
  });

  it('rejects empty / bogus sizes', () => {
    expect(shouldInlineTextFile('notes.md', 'text/markdown', 0)).toBe(false);
    expect(shouldInlineTextFile('notes.md', 'text/markdown', Number.NaN)).toBe(false);
  });
});

describe('decodeDataUrlText', () => {
  const enc = (s: string, mime = 'text/markdown'): string =>
    `data:${mime};base64,${Buffer.from(s, 'utf8').toString('base64')}`;

  it('round-trips UTF-8 markdown', () => {
    const md = '# Título\n\n- emoji ✨\n- ünïcode';
    expect(decodeDataUrlText(enc(md))).toBe(md);
  });

  it('tolerates whitespace in the payload', () => {
    const url = enc('hello world');
    const wrapped = url.slice(0, 30) + '\n' + url.slice(30);
    expect(decodeDataUrlText(wrapped)).toBe('hello world');
  });

  it('rejects non-base64 data URLs', () => {
    expect(decodeDataUrlText('data:text/plain,hello')).toBeNull();
  });

  it('rejects binary payloads (NUL bytes)', () => {
    const bin = `data:application/octet-stream;base64,${Buffer.from([0x89, 0x00, 0x47]).toString('base64')}`;
    expect(decodeDataUrlText(bin)).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(decodeDataUrlText('not a data url')).toBeNull();
    expect(decodeDataUrlText('')).toBeNull();
  });
});
