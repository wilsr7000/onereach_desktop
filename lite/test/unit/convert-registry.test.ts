/**
 * Converter registry + format graph (ADR-100): aliases fold, bad
 * registrations are refused, and a pair with no direct converter is
 * answered by the shortest pipeline.
 */

import { describe, it, expect } from 'vitest';
import { ConverterRegistry, FORMATS, normalizeFormat, mimeTypeFor } from '../../convert/registry.js';
import { createDefaultRegistry, CONVERTERS } from '../../convert/converters/index.js';
import { ConvertService, mergeOptions } from '../../convert/service.js';
import { CONVERT_ERROR_CODES } from '../../convert/errors.js';
import type { Converter } from '../../convert/types.js';

function fake(id: string, from: string[], to: string[], out = (s: string): string => `${s}>${id}`): Converter {
  return {
    spec: { id, title: id, description: id, from, to, engine: 'pure', strategies: [{ id: 'only', description: '', when: '' }], defaultStrategy: 'only' },
    execute: async (input) => ({ output: out(input) }),
  };
}

describe('formats', () => {
  it('normalizes spellings and extensions', () => {
    expect(normalizeFormat('Markdown')).toBe('md');
    expect(normalizeFormat('.md')).toBe('md');
    expect(normalizeFormat('txt')).toBe('text');
    expect(normalizeFormat('yml')).toBe('yaml');
    expect(normalizeFormat('notebook')).toBe('ipynb');
    expect(normalizeFormat('HTM')).toBe('html');
    expect(normalizeFormat('docx')).toBeNull();
    expect(normalizeFormat('')).toBeNull();
    expect(normalizeFormat(42)).toBeNull();
  });
  it('ids and aliases never collide and every format has a mime type', () => {
    const seen = new Set<string>();
    for (const f of FORMATS) {
      for (const k of [f.id, ...f.aliases]) {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
      expect(mimeTypeFor(f.id)).toMatch(/\//);
    }
  });
});

describe('registry', () => {
  it('refuses duplicate ids, unknown formats, and a default strategy it does not have', () => {
    const r = new ConverterRegistry();
    r.register(fake('a', ['md'], ['html']));
    expect(() => r.register(fake('a', ['md'], ['html']))).toThrow(/twice/);
    expect(() => r.register(fake('b', ['docx'], ['html']))).toThrow(/unknown format/);
    const bad = fake('c', ['md'], ['text']);
    (bad.spec as { defaultStrategy: string }).defaultStrategy = 'nope';
    expect(() => r.register(bad)).toThrow(/unknown strategy/);
  });

  it('resolves direct pairs, same-format no-ops, and the shortest pipeline', () => {
    const r = new ConverterRegistry();
    r.register(fake('csv-json', ['csv'], ['json']));
    r.register(fake('json-md', ['json'], ['md']));
    r.register(fake('md-html', ['md'], ['html']));
    r.register(fake('json-html', ['json'], ['html']));
    expect(r.resolve('csv', 'json')?.steps.map((s) => s.converterId)).toEqual(['csv-json']);
    expect(r.resolve('md', 'md')?.steps).toEqual([]);
    // csv → html: csv-json + json-html (2 hops) beats csv-json + json-md + md-html.
    expect(r.resolve('csv', 'html')?.steps.map((s) => s.converterId)).toEqual(['csv-json', 'json-html']);
    expect(r.resolve('html', 'csv')).toBeNull();
    expect(r.reachablePairs().find((p) => p.from === 'csv' && p.to === 'html')?.hops).toBe(2);
  });

  it('the default registry registers every shipped converter once', () => {
    const r = createDefaultRegistry();
    expect(r.all().map((c) => c.spec.id).sort()).toEqual(CONVERTERS.map((c) => c.spec.id).sort());
    const caps = r.capabilities();
    expect(caps.formats.length).toBe(FORMATS.length);
    for (const c of caps.converters) expect(c.strategies.map((s) => s.id)).toContain(c.defaultStrategy);
  });
});

describe('service', () => {
  it('runs a pipeline, keeps per-step stats, and warns when a strategy cannot apply to a multi-step run', async () => {
    const r = new ConverterRegistry();
    r.register(fake('csv-json', ['csv'], ['json']));
    r.register(fake('json-md', ['json'], ['md']));
    const service = new ConvertService({ registry: r, now: (() => { let t = 0; return () => (t += 5); })() });
    const result = await service.convert({ input: 'x', from: 'CSV', to: 'markdown', strategy: 'only' });
    expect(result.output).toBe('x>csv-json>json-md');
    expect(result.steps.map((s) => s.converterId)).toEqual(['csv-json', 'json-md']);
    expect(result.mimeType).toBe('text/markdown');
    expect(result.warnings[0]).toMatch(/runs 2 steps/);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('typed errors: unknown format, no path, unknown strategy, converter failure', async () => {
    const r = new ConverterRegistry();
    r.register(fake('md-html', ['md'], ['html']));
    r.register({ ...fake('html-text', ['html'], ['text']), execute: async () => { throw new Error('boom'); } });
    const service = new ConvertService({ registry: r });
    await expect(service.convert({ input: 'x', from: 'pdf', to: 'md' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.UNKNOWN_FORMAT });
    await expect(service.convert({ input: 'x', from: 'text', to: 'md' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.NO_PATH });
    await expect(service.convert({ input: 'x', from: 'md', to: 'html', strategy: 'zany' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.UNKNOWN_STRATEGY });
    await expect(service.convert({ input: '<p>x</p>', from: 'html', to: 'text' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.FAILED, message: /boom/ });
    await expect(service.convert({ input: 42 as unknown as string, from: 'md', to: 'html' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.INVALID_INPUT });
  });

  it('same-format requests return the input with a warning', async () => {
    const service = new ConvertService({ registry: new ConverterRegistry() });
    const result = await service.convert({ input: 'same', from: 'md', to: 'markdown' });
    expect(result.output).toBe('same');
    expect(result.steps).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('mergeOptions layers the caller over declared defaults', () => {
    const c = fake('x', ['md'], ['html']);
    (c.spec as { options?: unknown }).options = [{ name: 'indent', type: 'number', description: '', default: 2 }];
    expect(mergeOptions(c, undefined)).toEqual({ indent: 2 });
    expect(mergeOptions(c, { indent: 0, title: 'T' })).toEqual({ indent: 0, title: 'T' });
  });
});
