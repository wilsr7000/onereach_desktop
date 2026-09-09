/**
 * ConvertApi unit tests (Rule 12 / HARNESS.md, ADR-100):
 *   1. `runApiConformanceContract` + `runErrorConformanceContract`.
 *   2. Module behaviour: spans around a run, error mapping, events.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runApiConformanceContract, runErrorConformanceContract } from '../harness/conformance.js';
import {
  getConvertApi,
  _resetConvertApiForTesting,
  _setConvertApiForTesting,
  _buildConvertApiForTesting,
  ConvertError,
  CONVERT_ERROR_CODES,
} from '../../convert/api.js';
import { ConvertService } from '../../convert/service.js';
import { createDefaultRegistry } from '../../convert/converters/index.js';
import type { Span, EventRecord } from '../../logging/events.js';

runApiConformanceContract({
  name: 'ConvertApi',
  getInstance: getConvertApi,
  resetForTesting: _resetConvertApiForTesting,
  setForTesting: _setConvertApiForTesting,
  expectedMethods: ['convert', 'pipeline', 'capabilities', 'onEvent'],
});

runErrorConformanceContract({
  name: 'ConvertError',
  ErrorClass: ConvertError,
  codeEnum: CONVERT_ERROR_CODES,
  modulePrefix: 'CONVERT_',
  constructErrorWithCode: (code) =>
    new ConvertError({ code: code as never, message: 'sample', context: { op: 'sample' }, remediation: 'try again' }),
});

interface RecordedSpan {
  name: string;
  data: unknown;
  finished: unknown[];
  failed: unknown[];
}

function fakeSpans(): { spans: RecordedSpan[]; emitter: (name: string, data?: unknown) => Span } {
  const spans: RecordedSpan[] = [];
  return {
    spans,
    emitter: (name, data) => {
      const rec: RecordedSpan = { name, data, finished: [], failed: [] };
      spans.push(rec);
      return {
        finish: (d?: unknown) => rec.finished.push(d),
        fail: (e: unknown) => rec.failed.push(e),
      } as unknown as Span;
    },
  };
}

describe('ConvertApi behaviour', () => {
  beforeEach(() => _resetConvertApiForTesting());

  it('wraps a run in a convert.run span carrying formats, pipeline and sizes', async () => {
    const { spans, emitter } = fakeSpans();
    const api = _buildConvertApiForTesting({ spanEmitter: emitter });
    const result = await api.convert({ input: '# Hi\n\nThere', from: 'markdown', to: 'html' });
    expect(result.output).toContain('<h1>Hi</h1>');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('convert.run');
    expect(spans[0]?.data).toMatchObject({ from: 'markdown', to: 'html', inputBytes: 11 });
    expect(spans[0]?.finished[0]).toMatchObject({ pipeline: ['md-to-html'], warnings: 0 });
    expect(spans[0]?.failed).toHaveLength(0);
  });

  it('fails the span and rethrows the typed error on an unknown format', async () => {
    const { spans, emitter } = fakeSpans();
    const api = _buildConvertApiForTesting({ spanEmitter: emitter });
    await expect(api.convert({ input: 'x', from: 'md', to: 'docx' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.UNKNOWN_FORMAT });
    expect(spans[0]?.failed).toHaveLength(1);
  });

  it('refuses oversized input before resolving anything', async () => {
    const service = new ConvertService({ registry: createDefaultRegistry(), maxInputBytes: 16 });
    const api = _buildConvertApiForTesting({ service, spanEmitter: fakeSpans().emitter });
    await expect(api.convert({ input: 'a'.repeat(17), from: 'md', to: 'html' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.TOO_LARGE });
  });

  it('pipeline and capabilities pass through; onEvent filters to convert events', () => {
    const handlers: Array<(e: EventRecord) => void> = [];
    const api = _buildConvertApiForTesting({
      spanEmitter: fakeSpans().emitter,
      subscribe: (_pattern, handler) => {
        handlers.push(handler);
        return () => undefined;
      },
    });
    expect(api.pipeline('csv', 'json').steps.map((s) => s.converterId)).toEqual(['csv-to-json']);
    expect(api.capabilities().converters.map((c) => c.id)).toContain('md-to-html');
    const seen: string[] = [];
    api.onEvent((e) => seen.push(e.name));
    const base = { id: '1', timestamp: 't', category: 'convert', spanId: 's', data: {} } as unknown as EventRecord;
    handlers[0]?.({ ...base, name: 'convert.run.finish' } as EventRecord);
    handlers[0]?.({ ...base, name: 'files.upload.start' } as EventRecord);
    expect(seen).toEqual(['convert.run.finish']);
  });
});
