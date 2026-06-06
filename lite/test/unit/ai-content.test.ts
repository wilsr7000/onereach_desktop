import { describe, it, expect } from 'vitest';
import {
  resolveMetadataText,
  isTextMediaType,
  parseDataUrl,
  MAX_METADATA_TEXT_CHARS,
} from '../../ai/content.js';

function dataUrl(media: string, text: string): string {
  return `data:${media};base64,${Buffer.from(text, 'utf-8').toString('base64')}`;
}

describe('isTextMediaType', () => {
  it('accepts text/* and text-shaped application types', () => {
    for (const m of [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'application/xml',
      'text/html',
    ]) {
      expect(isTextMediaType(m)).toBe(true);
    }
  });
  it('rejects binary media types', () => {
    for (const m of ['image/png', 'application/pdf', 'audio/mpeg', 'video/mp4']) {
      expect(isTextMediaType(m)).toBe(false);
    }
  });
});

describe('resolveMetadataText', () => {
  it('returns raw pasted text unchanged', () => {
    expect(resolveMetadataText('hello world')).toBe('hello world');
  });

  it('decodes an uploaded text file stored as a data:text/plain URL (the .txt case)', () => {
    const txt = 'Neo4j-40c812ef notes\nsecond line';
    expect(resolveMetadataText(dataUrl('text/plain', txt))).toBe(txt);
  });

  it('decodes text-shaped application types (csv / json)', () => {
    expect(resolveMetadataText(dataUrl('text/csv', 'a,b\n1,2'))).toBe('a,b\n1,2');
    expect(resolveMetadataText(dataUrl('application/json', '{"k":1}'))).toBe('{"k":1}');
  });

  it('returns null for a non-text data URL (image/pdf are routed separately)', () => {
    expect(resolveMetadataText(dataUrl('image/png', 'fakebytes'))).toBeNull();
    expect(resolveMetadataText(dataUrl('application/pdf', '%PDF-1.4'))).toBeNull();
  });

  it('returns null for empty / whitespace content', () => {
    expect(resolveMetadataText('')).toBeNull();
    expect(resolveMetadataText('   ')).toBeNull();
  });

  it('caps very long text at MAX_METADATA_TEXT_CHARS', () => {
    const big = 'x'.repeat(MAX_METADATA_TEXT_CHARS + 5000);
    expect(resolveMetadataText(big)?.length).toBe(MAX_METADATA_TEXT_CHARS);
  });
});

describe('parseDataUrl', () => {
  it('parses a base64 data URL', () => {
    expect(parseDataUrl('data:text/plain;base64,SGk=')).toEqual({
      mediaType: 'text/plain',
      base64: 'SGk=',
    });
  });
  it('returns null for non-data-url strings', () => {
    expect(parseDataUrl('hello')).toBeNull();
    expect(parseDataUrl('https://example.com')).toBeNull();
  });
});
