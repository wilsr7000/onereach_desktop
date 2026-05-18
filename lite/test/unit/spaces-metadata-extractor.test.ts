/**
 * Pure-function tests for the metadata extractor module.
 *
 * Covers the side-effect-free extractors (CSV / JSON / text / PDF
 * byte-scan) plus dispatch via `extractMetadataFromText`. DOM-based
 * extractors (image / audio / video) require real media decoding,
 * which jsdom doesn't do; those are covered indirectly via the
 * integration tests + manual QA.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import {
  extractCsvMetadata,
  extractJsonMetadata,
  extractTextMetadata,
  extractMetadataFromText,
  scanPdfTextForMetadata,
} from '../../spaces/metadata-extractor.js';

// ─── extractCsvMetadata ─────────────────────────────────────────────────

describe('extractCsvMetadata', () => {
  it('returns zero counts for empty input', () => {
    expect(extractCsvMetadata('')).toEqual({ rowCount: 0, columnCount: 0 });
  });

  it('counts header columns + data rows for comma-delimited input', () => {
    const meta = extractCsvMetadata('name,age,role\nAlice,30,Eng\nBob,40,Mgr');
    expect(meta).toMatchObject({
      delimiter: 'comma',
      columnCount: 3,
      rowCount: 2,
      headers: ['name', 'age', 'role'],
    });
  });

  it('auto-detects tab delimiter when the first line contains tabs', () => {
    const meta = extractCsvMetadata('name\tage\nAlice\t30');
    expect(meta).toMatchObject({
      delimiter: 'tab',
      columnCount: 2,
      rowCount: 1,
    });
  });

  it('parses quoted fields with embedded commas', () => {
    const meta = extractCsvMetadata('name,note\n"Smith, Alice","hi"');
    expect(meta).toMatchObject({
      columnCount: 2,
      rowCount: 1,
      headers: ['name', 'note'],
    });
  });

  it('handles CRLF line endings', () => {
    const meta = extractCsvMetadata('a,b\r\n1,2\r\n3,4');
    expect(meta).toMatchObject({ rowCount: 2, columnCount: 2 });
  });

  it('ignores blank lines for row counting', () => {
    const meta = extractCsvMetadata('a,b\n\n1,2\n\n');
    expect(meta).toMatchObject({ rowCount: 1, columnCount: 2 });
  });
});

// ─── extractJsonMetadata ────────────────────────────────────────────────

describe('extractJsonMetadata', () => {
  it('flags malformed JSON as invalid', () => {
    expect(extractJsonMetadata('{not json}')).toEqual({ valid: false });
    expect(extractJsonMetadata('')).toEqual({ valid: false });
  });

  it('describes object roots with key count + sample keys', () => {
    const meta = extractJsonMetadata('{"a":1,"b":2,"c":3}');
    expect(meta).toMatchObject({
      valid: true,
      rootShape: 'object',
      topLevelKeyCount: 3,
      topLevelKeys: ['a', 'b', 'c'],
    });
  });

  it('caps topLevelKeys at 20 for very wide objects', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 30; i++) obj[`k${i}`] = i;
    const meta = extractJsonMetadata(JSON.stringify(obj));
    expect(meta['topLevelKeyCount']).toBe(30);
    expect((meta['topLevelKeys'] as string[]).length).toBe(20);
  });

  it('describes array roots with length', () => {
    expect(extractJsonMetadata('[1,2,3,4]')).toEqual({
      valid: true,
      rootShape: 'array',
      arrayLength: 4,
    });
  });

  it('handles primitive roots', () => {
    expect(extractJsonMetadata('"hello"')).toMatchObject({
      valid: true,
      rootShape: 'string',
    });
    expect(extractJsonMetadata('42')).toMatchObject({
      valid: true,
      rootShape: 'number',
    });
  });
});

// ─── extractTextMetadata ────────────────────────────────────────────────

describe('extractTextMetadata', () => {
  it('returns zero counts for empty input', () => {
    expect(extractTextMetadata('')).toEqual({
      charCount: 0,
      wordCount: 0,
      lineCount: 0,
    });
  });

  it('counts characters, words, and lines', () => {
    const meta = extractTextMetadata('hello world\nfoo bar baz\n');
    expect(meta).toMatchObject({
      charCount: 24,
      wordCount: 5,
      lineCount: 3, // trailing newline produces an empty third line
    });
  });

  it('treats runs of non-whitespace as a single word', () => {
    expect(extractTextMetadata('one   two\t\tthree')['wordCount']).toBe(3);
  });

  it('handles single-line text without newlines', () => {
    const meta = extractTextMetadata('just one line');
    expect(meta).toMatchObject({ lineCount: 1, wordCount: 3 });
  });
});

// ─── extractMetadataFromText (dispatch) ─────────────────────────────────

describe('extractMetadataFromText (dispatch)', () => {
  it('routes CSV hints to the CSV extractor', () => {
    const meta = extractMetadataFromText('a,b\n1,2', { language: 'csv' });
    expect(meta).toMatchObject({ rowCount: 1, columnCount: 2 });
  });

  it('routes JSON MIME to the JSON extractor', () => {
    const meta = extractMetadataFromText('{"x":1}', { mimeType: 'application/json' });
    expect(meta).toMatchObject({ valid: true, rootShape: 'object' });
  });

  it('falls back to plain-text extractor when no hint is recognized', () => {
    const meta = extractMetadataFromText('hello world');
    expect(meta).toMatchObject({ wordCount: 2 });
    expect(meta).toHaveProperty('charCount');
  });

  it('always includes sizeBytes', () => {
    const meta = extractMetadataFromText('abc');
    expect(meta['sizeBytes']).toBe(3);
  });
});

// ─── scanPdfTextForMetadata (pure scanner) ──────────────────────────────

describe('scanPdfTextForMetadata', () => {
  it('returns {} for malformed PDF bytes', () => {
    expect(scanPdfTextForMetadata('not a pdf at all')).toEqual({});
  });

  it('returns {} for empty input', () => {
    expect(scanPdfTextForMetadata('')).toEqual({});
  });

  it('counts /Type /Page markers (but not /Pages root)', () => {
    const fakePdf =
      '%PDF-1.4 /Type /Pages /Count 3 ' +
      '/Type /Page /Foo ' +
      '/Type /Page /Bar ' +
      '/Type /Page /Baz';
    const meta = scanPdfTextForMetadata(fakePdf);
    expect(meta['pageCount']).toBe(3);
  });

  it('extracts /Title from the info dictionary when present', () => {
    const fakePdf =
      '%PDF-1.4 /Type /Page ' +
      '/Title (Quarterly Audit) /Author (Alice)';
    const meta = scanPdfTextForMetadata(fakePdf);
    expect(meta['pdfTitle']).toBe('Quarterly Audit');
    expect(meta['pdfAuthor']).toBe('Alice');
  });

  it('returns no pageCount when the scan finds no Page markers', () => {
    const fakePdf = '%PDF-1.4 (encrypted or stripped)';
    const meta = scanPdfTextForMetadata(fakePdf);
    expect(meta).not.toHaveProperty('pageCount');
  });
});
