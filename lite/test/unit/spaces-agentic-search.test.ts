/**
 * The agentic tier of the one search (2026-08-20: "agentic search
 * should be part of it"). Ported from the full app's playbook walk,
 * generalized to every asset kind, run on Lite's viewer-gated APIs.
 *
 * The caps ARE the contract: keyword hits first, stopAfter ends the
 * walk, maxEvaluations bounds model spend, a failed evaluation skips
 * the item rather than sinking the search, and an invisible item is
 * never guessed about.
 */
import { describe, it, expect, vi } from 'vitest';
import { runAgenticSearch, parseVerdict } from '../../spaces/agentic-search.js';
import type { AiApi } from '../../ai/api.js';
import type { SpacesApi } from '../../spaces/api.js';

const ROWS = [
  { id: 'a-hit', title: 'Deploy Runbook', kind: 'playbook' },
  { id: 'b-rest', title: 'Quarterly Notes', kind: 'doc' },
  { id: 'c-rest', title: 'Old Diagram', kind: 'image' },
] as never[];

function fakeApis(opts: {
  verdictFor?: (title: string) => { match: boolean; confidence: number; reason: string } | 'throw';
  content?: (id: string) => string | null;
} = {}): { spacesApi: SpacesApi; ai: AiApi; calls: () => string[] } {
  const prompts: string[] = [];
  const spacesApi = {
    items: {
      search: vi.fn(async () => [ROWS[0]]),
      list: vi.fn(async () => ROWS),
      get: vi.fn(async (id: string) => {
        const body = opts.content ? opts.content(id) : 'content';
        return body === null ? null : { id, content: body };
      }),
    },
  } as unknown as SpacesApi;
  const ai = {
    chat: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      const prompt = input.messages[0]!.content;
      prompts.push(prompt);
      const title = /Asset title: (.*)\n/.exec(prompt)?.[1] ?? '';
      const v = opts.verdictFor?.(title) ?? { match: false, confidence: 0, reason: '' };
      if (v === 'throw') throw new Error('model down');
      return { content: JSON.stringify(v) };
    }),
  } as unknown as AiApi;
  return { spacesApi, ai, calls: () => prompts };
}

describe('parseVerdict — models fence and preface despite orders', () => {
  it('extracts the JSON object from noise and clamps confidence', () => {
    expect(parseVerdict('Sure!\n```json\n{"match":true,"confidence":7,"reason":"r"}\n```')).toEqual({
      match: true,
      confidence: 1,
      reason: 'r',
    });
    expect(parseVerdict('no json here')).toBeNull();
  });
});

describe('runAgenticSearch', () => {
  it('examines keyword hits before the rest', async () => {
    const f = fakeApis({ verdictFor: () => ({ match: false, confidence: 0, reason: '' }) });
    await runAgenticSearch('deploy', { spaceId: 'sp-1' }, f);
    expect(f.calls()[0]).toContain('Deploy Runbook');
  });

  it('stops after stopAfter matches and reports it', async () => {
    const f = fakeApis({ verdictFor: () => ({ match: true, confidence: 0.9, reason: 'yes' }) });
    const out = await runAgenticSearch('x', { spaceId: 'sp-1', stopAfter: 1 }, f);
    expect(out.matches).toHaveLength(1);
    expect(out.stoppedEarly).toBe(true);
    expect(f.calls()).toHaveLength(1);
  });

  it('a failed evaluation skips the item, never the walk', async () => {
    const f = fakeApis({
      verdictFor: (t) => (t === 'Deploy Runbook' ? 'throw' : { match: true, confidence: 0.7, reason: 'ok' }),
    });
    const out = await runAgenticSearch('x', { spaceId: 'sp-1' }, f);
    expect(out.matches.map((m) => m.id)).toEqual(['b-rest', 'c-rest']);
    expect(out.evaluated).toBe(2); // the throw is not an evaluation
  });

  it('an invisible or vanished item is skipped, never guessed about', async () => {
    const f = fakeApis({
      content: (id) => (id === 'b-rest' ? null : 'content'),
      verdictFor: () => ({ match: true, confidence: 0.5, reason: 'ok' }),
    });
    const out = await runAgenticSearch('x', { spaceId: 'sp-1' }, f);
    expect(out.matches.find((m) => m.id === 'b-rest')).toBeUndefined();
  });

  it('maxEvaluations bounds model calls hard', async () => {
    const f = fakeApis({ verdictFor: () => ({ match: false, confidence: 0, reason: '' }) });
    const out = await runAgenticSearch('x', { spaceId: 'sp-1', maxEvaluations: 2 }, f);
    expect(f.calls().length).toBeLessThanOrEqual(2);
    expect(out.totalCandidates).toBeLessThanOrEqual(2);
  });

  it('matches rank by confidence, not evaluation order', async () => {
    const f = fakeApis({
      verdictFor: (t) => ({ match: true, confidence: t === 'Old Diagram' ? 0.95 : 0.4, reason: 'r' }),
    });
    const out = await runAgenticSearch('x', { spaceId: 'sp-1' }, f);
    expect(out.matches[0]!.id).toBe('c-rest');
  });

  it('an empty query never touches the model', async () => {
    const f = fakeApis();
    const out = await runAgenticSearch('   ', {}, f);
    expect(out.matches).toEqual([]);
    expect(f.calls()).toHaveLength(0);
  });
});
