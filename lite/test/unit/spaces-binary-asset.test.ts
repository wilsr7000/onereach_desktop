import { describe, it, expect } from 'vitest';
import {
  sanitizeAssetFileName,
  buildAssetFileName,
  buildAssetKey,
  parseDataUrlToBytes,
  toBuffer,
  SPACES_ASSETS_PREFIX,
  MAX_BINARY_ASSET_BYTES,
} from '../../spaces/binary-asset.js';

describe('sanitizeAssetFileName', () => {
  it('keeps a plain name unchanged', () => {
    expect(sanitizeAssetFileName('report-Q3_final.pdf')).toBe('report-Q3_final.pdf');
  });

  it('strips path separators (no traversal into the bucket key)', () => {
    expect(sanitizeAssetFileName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeAssetFileName('a/b\\c.png')).toBe('a-b-c.png');
  });

  it('collapses spaces and unicode to hyphens', () => {
    expect(sanitizeAssetFileName('board notes  final.png')).toBe('board-notes-final.png');
    expect(sanitizeAssetFileName('café menü.jpg')).toBe('caf-men-.jpg');
  });

  it('removes control characters', () => {
    expect(sanitizeAssetFileName('a\u0000b\u001fc.txt')).toBe('abc.txt');
  });

  it('trims leading/trailing dots and hyphens (no hidden files)', () => {
    expect(sanitizeAssetFileName('...hidden')).toBe('hidden');
    expect(sanitizeAssetFileName('--x--')).toBe('x');
  });

  it('caps length at 120 chars', () => {
    expect(sanitizeAssetFileName('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('falls back to "file" when nothing survives', () => {
    expect(sanitizeAssetFileName('///')).toBe('file');
    expect(sanitizeAssetFileName('')).toBe('file');
  });
});

describe('buildAssetFileName / buildAssetKey', () => {
  it('prefixes the sanitized name with the (injectable) uuid', () => {
    expect(buildAssetFileName('pic.png', 'u-1')).toBe('u-1-pic.png');
  });

  it('generates a uuid when none is supplied', () => {
    const name = buildAssetFileName('pic.png');
    expect(name).toMatch(/^[0-9a-f-]{36}-pic\.png$/);
  });

  it('two builds of the same original name never collide', () => {
    expect(buildAssetFileName('pic.png')).not.toBe(buildAssetFileName('pic.png'));
  });

  it('buildAssetKey composes prefix/name', () => {
    expect(buildAssetKey('u-1-pic.png')).toBe(`${SPACES_ASSETS_PREFIX}/u-1-pic.png`);
  });
});

describe('parseDataUrlToBytes', () => {
  const PNG_B64 = Buffer.from('PNGDATA').toString('base64');

  it('parses a well-formed data URL', () => {
    const out = parseDataUrlToBytes(`data:image/png;base64,${PNG_B64}`);
    expect(out).not.toBeNull();
    expect(out?.mediaType).toBe('image/png');
    expect(out?.bytes.toString()).toBe('PNGDATA');
  });

  it('tolerates whitespace inside the payload (FileReader line wraps)', () => {
    const wrapped = PNG_B64.slice(0, 4) + '\n' + PNG_B64.slice(4);
    const out = parseDataUrlToBytes(`data:image/png;base64,${wrapped}`);
    expect(out?.bytes.toString()).toBe('PNGDATA');
  });

  it('lowercases the media type', () => {
    const out = parseDataUrlToBytes(`data:IMAGE/PNG;base64,${PNG_B64}`);
    expect(out?.mediaType).toBe('image/png');
  });

  it('rejects non-data strings, plain text, and http urls', () => {
    expect(parseDataUrlToBytes('hello world')).toBeNull();
    expect(parseDataUrlToBytes('https://example.com/a.png')).toBeNull();
    expect(parseDataUrlToBytes('')).toBeNull();
  });

  it('rejects a data URL without base64 marker', () => {
    expect(parseDataUrlToBytes('data:text/plain,hello')).toBeNull();
  });

  it('rejects malformed base64 payloads', () => {
    expect(parseDataUrlToBytes('data:image/png;base64,@@@not-base64@@@')).toBeNull();
    expect(parseDataUrlToBytes('data:image/png;base64,')).toBeNull();
  });
});

describe('toBuffer', () => {
  it('converts an ArrayBuffer', () => {
    const ab = new TextEncoder().encode('abc').buffer;
    expect(toBuffer(ab as ArrayBuffer).toString()).toBe('abc');
  });

  it('respects Uint8Array views with offsets', () => {
    const backing = new TextEncoder().encode('xxabcxx');
    const view = new Uint8Array(backing.buffer, 2, 3);
    expect(toBuffer(view).toString()).toBe('abc');
  });
});

describe('constants', () => {
  it('cap is 100 MB', () => {
    expect(MAX_BINARY_ASSET_BYTES).toBe(100 * 1024 * 1024);
  });
});
