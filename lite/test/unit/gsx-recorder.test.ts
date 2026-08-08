/**
 * GSX teach-mode recorder tests (ADR-053).
 *
 * Pins (1) the in-page recorder script's safety properties, (2) the
 * recording -> deterministic-steps conversion (selector ranking,
 * {accountId}/{env} back-substitution, self-evaluating final assert),
 * (3) the LLM generalization contract (labels drive param names) and
 * its parse/validation gate.
 */

import { describe, it, expect } from 'vitest';
import {
  RECORDER_INSTALL_SCRIPT,
  RECORDER_DRAIN_SCRIPT,
  templatizeUrl,
  buildStepsFromRecording,
  buildGeneralizeInput,
  parseGeneralizeResponse,
  generalizeRecording,
  type GsxRecordedEvent,
} from '../../gsx/recorder.js';
import type { GsxScript } from '../../gsx/types.js';
import { GSX_ERROR_CODES } from '../../gsx/errors.js';
import type { AiChatResult } from '../../ai/chat.js';

const EVENTS: GsxRecordedEvent[] = [
  { type: 'navigate', url: 'https://studio.edison.onereach.ai/flows?accountId=acc-123' },
  {
    type: 'click',
    candidates: ['[data-testid="flow-row-billing"]', 'li.flow-row'],
    text: 'Billing Bot',
    label: 'Flow name',
    tag: 'li',
  },
  {
    type: 'fill',
    candidates: ['input[name="search"]'],
    label: 'Search flows',
    tag: 'input',
    value: 'billing',
  },
  { type: 'navigate', url: 'https://studio.edison.onereach.ai/flows/f-1/designer' },
];

describe('recorder page scripts', () => {
  it('buffer survives navigation via sessionStorage write-through', () => {
    expect(RECORDER_INSTALL_SCRIPT).toContain('sessionStorage');
    expect(RECORDER_DRAIN_SCRIPT).toContain('sessionStorage');
    expect(RECORDER_DRAIN_SCRIPT).toContain('removeItem');
  });

  it('never records passwords', () => {
    expect(RECORDER_INSTALL_SCRIPT).toContain("el.type === 'password'");
  });

  it('is idempotent (guarded install flag)', () => {
    expect(RECORDER_INSTALL_SCRIPT).toContain('__gsxRecInstalled');
  });
});

describe('templatizeUrl', () => {
  it('back-substitutes accountId and env', () => {
    const out = templatizeUrl(
      'https://studio.edison.onereach.ai/flows?accountId=acc-123',
      'edison',
      'acc-123'
    );
    expect(out).toBe('https://studio.{env}.onereach.ai/flows?accountId={accountId}');
  });

  it('handles a null accountId and non-studio hosts', () => {
    const out = templatizeUrl('https://files.edison.onereach.ai/x', 'edison', null);
    expect(out).toBe('https://files.{env}.onereach.ai/x');
  });
});

describe('buildStepsFromRecording', () => {
  it('maps navigate/click/fill and appends a final assertUrl', () => {
    const steps = buildStepsFromRecording(EVENTS, { env: 'edison', accountId: 'acc-123' });
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatchObject({
      kind: 'navigate',
      url: 'https://studio.{env}.onereach.ai/flows?accountId={accountId}',
    });
    expect(steps[1]).toMatchObject({
      kind: 'click',
      selector: '[data-testid="flow-row-billing"]', // best candidate wins
      textFallback: ['Billing Bot'],
    });
    expect(steps[2]).toMatchObject({ kind: 'fill', selector: 'input[name="search"]', value: 'billing' });
    expect(steps[3]).toMatchObject({ kind: 'navigate' });
    // Self-evaluating: recording pins where it ended up.
    expect(steps[4]).toMatchObject({ kind: 'assertUrl' });
    expect((steps[4] as { pattern: string }).pattern).toContain('designer');
  });

  it('skips events with no usable selector', () => {
    const steps = buildStepsFromRecording(
      [{ type: 'click', candidates: [] }],
      { env: 'edison', accountId: null }
    );
    expect(steps).toHaveLength(0);
  });
});

describe('generalization contract', () => {
  const base: GsxScript = {
    id: 'flows.open-recorded',
    title: 'Open a flow (taught)',
    description: 'Opens the flow the user picks from the list',
    version: 1,
    source: 'learned',
    steps: buildStepsFromRecording(EVENTS, { env: 'edison', accountId: 'acc-123' }),
  };

  it('the prompt carries labels, typed values, and alternate selectors', () => {
    const input = buildGeneralizeInput(base.steps, EVENTS, {
      scriptId: base.id,
      title: base.title,
      description: base.description,
    });
    expect(input.jsonMode).toBe(true);
    expect(input.system).toContain('{param}');
    expect(input.system).toContain('assert');
    const user = input.messages[0]?.content ?? '';
    expect(user).toContain('label="Flow name"'); // param-naming evidence
    expect(user).toContain('typed "billing"');
    expect(user).toContain('li.flow-row'); // alternate selector surfaced
    expect(user).toContain(base.description);
  });

  it('parses a valid template with params', () => {
    const { script, note } = parseGeneralizeResponse(
      JSON.stringify({
        steps: [
          { kind: 'navigate', url: 'https://studio.{env}.onereach.ai/flows?accountId={accountId}' },
          { kind: 'click', selector: '[data-testid="flow-row"]', textFallback: ['{flowName}'] },
          { kind: 'assertUrl', pattern: '/designer' },
        ],
        params: ['flowName'],
        note: 'parameterized the flow name',
      }),
      base
    );
    expect(script.params).toEqual(['flowName']);
    expect(script.version).toBe(1); // stopRecording sets the version, not the LLM
    expect(note).toContain('parameterized');
  });

  it('rejects garbage with GSX_REPAIR_FAILED and bad steps with GSX_INVALID_SCRIPT', () => {
    expect(() => parseGeneralizeResponse('nope', base)).toThrowError(
      expect.objectContaining({ code: GSX_ERROR_CODES.REPAIR_FAILED })
    );
    expect(() =>
      parseGeneralizeResponse(JSON.stringify({ steps: [{ kind: 'teleport' }] }), base)
    ).toThrowError(expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_SCRIPT }));
  });

  it('generalizeRecording round-trips through the chat seam', async () => {
    const chat = async (): Promise<AiChatResult> => ({
      content: JSON.stringify({
        steps: [
          { kind: 'click', selector: '[data-testid="flow-row"]', textFallback: ['{flowName}'] },
          { kind: 'assertUrl', pattern: '/designer' },
        ],
        params: ['flowName'],
        note: 'ok',
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'claude-fable-5',
      provider: 'claude',
      cost: 0,
    });
    const { script } = await generalizeRecording(chat, base, EVENTS);
    expect(script.params).toEqual(['flowName']);
    expect(script.steps).toHaveLength(2);
  });
});
