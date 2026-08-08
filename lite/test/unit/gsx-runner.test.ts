/**
 * GSX runner tests -- step compilation, param substitution, script
 * validation, and the execute/grade semantics (ADR-052).
 *
 * The executor is faked, so this covers the whole runner without
 * Electron: compiled step strings are asserted structurally (they run
 * for real only inside a GSX window's page context).
 */

import { describe, it, expect } from 'vitest';
import {
  compileStep,
  executeSteps,
  gradeSteps,
  substituteParams,
  takeSnapshot,
  validateScript,
  SNAPSHOT_SCRIPT,
  type GsxExecutor,
} from '../../gsx/runner.js';
import type { GsxScript, GsxScriptStep } from '../../gsx/types.js';
import { GSX_ERROR_CODES } from '../../gsx/errors.js';

function script(steps: GsxScriptStep[], overrides?: Partial<GsxScript>): GsxScript {
  return {
    id: 'test.script',
    title: 'Test',
    description: 'Test script',
    version: 1,
    source: 'learned',
    steps,
    ...overrides,
  };
}

/** Fake executor: exec pops queued results; snapshot calls answered inline. */
function fakeExecutor(opts?: {
  results?: Array<{ ok: boolean; detail?: string } | Error>;
  url?: string;
}): GsxExecutor & { execCalls: string[]; navigations: string[] } {
  const queue = [...(opts?.results ?? [])];
  const calls: string[] = [];
  const navigations: string[] = [];
  return {
    execCalls: calls,
    navigations,
    async exec(js: string): Promise<unknown> {
      calls.push(js);
      if (js === SNAPSHOT_SCRIPT) {
        return { url: opts?.url ?? 'https://studio.edison.onereach.ai/', title: 'GSX', elements: [] };
      }
      const next = queue.shift() ?? { ok: true };
      if (next instanceof Error) throw next;
      return next;
    },
    async navigate(url: string): Promise<void> {
      navigations.push(url);
    },
    currentUrl: () => opts?.url ?? 'https://studio.edison.onereach.ai/flows',
  };
}

describe('substituteParams', () => {
  it('substitutes placeholders in urls, selectors, values, and fallbacks', () => {
    const input = script([
      { kind: 'navigate', url: 'https://studio.{env}.onereach.ai/?accountId={accountId}' },
      { kind: 'click', selector: '[data-flow="{flowName}"]', textFallback: ['{flowName}'] },
      { kind: 'fill', selector: '#search', value: '{flowName}' },
      { kind: 'assertUrl', pattern: '/{env}/' },
    ]);
    const out = substituteParams(input, {
      env: 'edison',
      accountId: 'acc-1',
      flowName: 'My Flow',
    });
    expect(out.steps[0]).toMatchObject({
      url: 'https://studio.edison.onereach.ai/?accountId=acc-1',
    });
    expect(out.steps[1]).toMatchObject({
      selector: '[data-flow="My Flow"]',
      textFallback: ['My Flow'],
    });
    expect(out.steps[2]).toMatchObject({ value: 'My Flow' });
    expect(out.steps[3]).toMatchObject({ pattern: '/edison/' });
  });

  it('leaves unknown placeholders intact and never mutates the input', () => {
    const input = script([{ kind: 'waitFor', selector: '#{mystery}' }]);
    const out = substituteParams(input, {});
    expect(out.steps[0]).toMatchObject({ selector: '#{mystery}' });
    expect(out).not.toBe(input);
    expect(out.steps).not.toBe(input.steps);
  });
});

describe('validateScript', () => {
  it('accepts a well-formed script', () => {
    expect(() =>
      validateScript(
        script([
          { kind: 'navigate', url: 'https://studio.edison.onereach.ai/' },
          { kind: 'assertUrl', pattern: 'onereach' },
        ])
      )
    ).not.toThrow();
  });

  it.each([
    ['not an object', 42],
    ['missing id', { ...script([{ kind: 'wait', ms: 1 }]), id: '' }],
    ['empty steps', script([])],
    ['unknown kind', script([{ kind: 'teleport' } as unknown as GsxScriptStep])],
    ['bad regex', script([{ kind: 'assertUrl', pattern: '[' }])],
    ['bad wait ms', script([{ kind: 'wait', ms: -5 }])],
    [
      'bad source',
      { ...script([{ kind: 'wait', ms: 1 }]), source: 'divine' },
    ],
  ])('rejects %s with GSX_INVALID_SCRIPT', (_label, bad) => {
    expect(() => validateScript(bad)).toThrowError(
      expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_SCRIPT })
    );
  });
});

describe('compileStep', () => {
  it('embeds the selector and timeout machinery for waitFor/click/fill', () => {
    for (const step of [
      { kind: 'waitFor', selector: '#target' },
      { kind: 'click', selector: '#target', textFallback: ['Open'] },
      { kind: 'fill', selector: '#target', value: 'hello' },
    ] as GsxScriptStep[]) {
      const js = compileStep(step);
      expect(js).toContain('"#target"');
      expect(js).toContain('DEADLINE');
      expect(js).toContain('Promise');
    }
  });

  it('escapes </script>-shaped selectors', () => {
    const js = compileStep({ kind: 'waitFor', selector: 'a[title="</script>"]' });
    expect(js).not.toContain('</script>');
  });

  it('refuses to compile runner-side steps (navigate, assertUrl)', () => {
    expect(() => compileStep({ kind: 'navigate', url: 'https://x' })).toThrowError(
      expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_SCRIPT })
    );
    expect(() => compileStep({ kind: 'assertUrl', pattern: 'x' })).toThrowError(
      expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_SCRIPT })
    );
  });
});

describe('executeSteps grading', () => {
  it('passes when every step succeeds (navigate + assertUrl run main-side)', async () => {
    const executor = fakeExecutor({ url: 'https://studio.edison.onereach.ai/flows' });
    const outcome = await executeSteps(
      script([
        { kind: 'navigate', url: 'https://studio.edison.onereach.ai/flows' },
        { kind: 'waitFor', selector: '#app' },
        { kind: 'assertUrl', pattern: '/flows' },
      ]),
      executor
    );
    expect(outcome.verdict).toBe('pass');
    expect(outcome.steps).toHaveLength(3);
    expect(executor.navigations).toEqual(['https://studio.edison.onereach.ai/flows']);
  });

  it('a failing ACTION step stops the run and grades fail', async () => {
    const executor = fakeExecutor({
      results: [{ ok: false, detail: 'timeout waiting for #app' }],
    });
    const outcome = await executeSteps(
      script([
        { kind: 'waitFor', selector: '#app' },
        { kind: 'click', selector: '#never-reached' },
      ]),
      executor
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.steps).toHaveLength(1); // stopped early
    expect(outcome.failure).toContain('step 0');
    expect(outcome.failure).toContain('timeout');
  });

  it('a failing ASSERTION records and continues (full eval picture)', async () => {
    const executor = fakeExecutor({
      results: [
        { ok: false, detail: 'found but not visible: nav' }, // assertVisible
        { ok: true }, // waitFor after the assertion still runs
      ],
    });
    const outcome = await executeSteps(
      script([
        { kind: 'assertVisible', selector: 'nav' },
        { kind: 'waitFor', selector: '#app' },
      ]),
      executor
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.steps[1]?.ok).toBe(true);
  });

  it('an executor throw aborts with verdict error', async () => {
    const executor = fakeExecutor({ results: [new Error('window destroyed')] });
    const outcome = await executeSteps(
      script([
        { kind: 'waitFor', selector: '#app' },
        { kind: 'waitFor', selector: '#later' },
      ]),
      executor
    );
    expect(outcome.verdict).toBe('error');
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.failure).toContain('window destroyed');
  });

  it('gradeSteps is pure and total', () => {
    expect(gradeSteps([], false)).toBe('pass');
    expect(gradeSteps([{ index: 0, kind: 'wait', ok: true, durationMs: 0 }], false)).toBe('pass');
    expect(gradeSteps([{ index: 0, kind: 'wait', ok: false, durationMs: 0 }], false)).toBe('fail');
    expect(gradeSteps([{ index: 0, kind: 'wait', ok: true, durationMs: 0 }], true)).toBe('error');
  });
});

describe('takeSnapshot', () => {
  it('returns the page census, falling back to an empty census on garbage', async () => {
    const good = await takeSnapshot(fakeExecutor());
    expect(good.url).toContain('onereach.ai');
    expect(Array.isArray(good.elements)).toBe(true);

    const brokenExecutor: GsxExecutor = {
      exec: async () => 'not-an-object',
      navigate: async () => undefined,
      currentUrl: () => 'https://studio.edison.onereach.ai/',
    };
    const fallback = await takeSnapshot(brokenExecutor);
    expect(fallback.elements).toEqual([]);
    expect(fallback.url).toBe('https://studio.edison.onereach.ai/');
  });
});
