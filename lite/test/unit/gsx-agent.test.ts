/**
 * GSX UI-automation agent tests -- the pure contracts (ADR-054):
 * name validation, param scanning, deterministic fallbacks, the
 * create-agent LLM contract (describe + generalize + document params
 * in one call), param extraction from free-form details, and the OKF
 * rendering for the "GSX Build" Space.
 *
 * Store-level orchestration (create -> invoke -> publish) is covered
 * in `gsx-store.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_NAME_PATTERN,
  requireValidAgentName,
  scanScriptParams,
  titleFromAgentName,
  fallbackAgentMeta,
  buildAgentCreateInput,
  parseAgentCreateResponse,
  buildParamExtractionInput,
  parseParamExtractionResponse,
  buildAgentOkf,
} from '../../gsx/agent.js';
import type { GsxAgent, GsxScript } from '../../gsx/types.js';
import type { GsxRecordedEvent } from '../../gsx/recorder.js';
import { GSX_ERROR_CODES } from '../../gsx/errors.js';

const SCRIPT: GsxScript = {
  id: 'agent.open-flow',
  title: 'open-flow',
  description: '',
  version: 1,
  source: 'learned',
  steps: [
    { kind: 'navigate', url: 'https://studio.{env}.onereach.ai/flows?accountId={accountId}' },
    { kind: 'click', selector: '[data-flow-name="{flowName}"]', textFallback: ['{flowName}'] },
    { kind: 'fill', selector: '#search', value: '{searchTerm}' },
    { kind: 'assertUrl', pattern: '/designer' },
  ],
};

const EVENTS: GsxRecordedEvent[] = [
  {
    type: 'click',
    candidates: ['[data-testid="flow-row"]'],
    text: 'Billing Bot',
    label: 'Flow name',
    tag: 'li',
  },
];

const AGENT: GsxAgent = {
  name: 'open-flow',
  title: 'Open a Flow',
  description: 'Opens a named flow from the Flows list into the designer.',
  scriptId: 'agent.open-flow',
  params: [
    { name: 'flowName', description: 'The display name of the flow to open, as shown in the Flows list' },
    { name: 'searchTerm', description: 'Text typed into the flows search box' },
  ],
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
};

describe('agent names', () => {
  it.each(['open-designer', 'a1', 'flows-open-by-name'])('accepts %s', (name) => {
    expect(requireValidAgentName(name)).toBe(name);
    expect(AGENT_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each(['Open Designer', 'x', '-lead', 'UPPER', 'a'.repeat(70), 42, null])(
    'rejects %s with GSX_INVALID_AGENT_NAME',
    (bad) => {
      expect(() => requireValidAgentName(bad)).toThrowError(
        expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_AGENT_NAME })
      );
    }
  );

  it('derives a human title from the slug', () => {
    expect(titleFromAgentName('open-designer')).toBe('Open Designer');
  });
});

describe('scanScriptParams', () => {
  it('finds custom placeholders and skips built-ins', () => {
    expect(scanScriptParams(SCRIPT)).toEqual(['flowName', 'searchTerm']);
  });

  it('fallbackAgentMeta documents scanned params with empty descriptions', () => {
    const meta = fallbackAgentMeta('open-flow', SCRIPT);
    expect(meta.title).toBe('Open Flow');
    expect(meta.params).toEqual([
      { name: 'flowName', description: '' },
      { name: 'searchTerm', description: '' },
    ]);
  });
});

describe('create-agent contract', () => {
  it('the prompt asks for title+description+param docs and carries labels', () => {
    const input = buildAgentCreateInput(SCRIPT, EVENTS, 'open-flow', 'opens a flow by name');
    expect(input.system).toContain('DESCRIBE');
    expect(input.system).toContain('DOCUMENT PARAMS');
    expect(input.jsonMode).toBe(true);
    expect(input.feature).toBe('gsx-agent-create');
    const user = input.messages[0]?.content ?? '';
    expect(user).toContain('"open-flow"');
    expect(user).toContain('opens a flow by name'); // the hint
    expect(user).toContain('label="Flow name"');
  });

  it('parses a full definition (title, description, params, steps)', () => {
    const parsed = parseAgentCreateResponse(
      JSON.stringify({
        title: 'Open a Flow',
        description: 'Opens the named flow.',
        steps: SCRIPT.steps,
        params: [
          { name: 'flowName', description: 'Flow display name' },
          { name: 'searchTerm', description: 'Search text' },
          { bogus: true }, // dropped
        ],
        note: 'ok',
      }),
      SCRIPT
    );
    expect(parsed.title).toBe('Open a Flow');
    expect(parsed.params).toHaveLength(2);
    expect(parsed.script.params).toEqual(['flowName', 'searchTerm']);
  });

  it('falls back to a slug title when the model omits one; rejects bad steps', () => {
    const parsed = parseAgentCreateResponse(
      JSON.stringify({ steps: SCRIPT.steps }),
      SCRIPT
    );
    expect(parsed.title).toBe('Open Flow'); // from agent.open-flow
    expect(() =>
      parseAgentCreateResponse(JSON.stringify({ steps: [{ kind: 'teleport' }] }), SCRIPT)
    ).toThrowError(expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_SCRIPT }));
  });
});

describe('param extraction contract', () => {
  it('the prompt carries the agent description and per-param docs', () => {
    const input = buildParamExtractionInput(AGENT, ['flowName'], 'open the billing bot flow');
    expect(input.feature).toBe('gsx-agent-extract');
    const user = input.messages[0]?.content ?? '';
    expect(user).toContain(AGENT.description);
    expect(user).toContain('as shown in the Flows list');
    expect(user).toContain('open the billing bot flow');
  });

  it('parses extracted values and reports the rest missing', () => {
    const out = parseParamExtractionResponse(
      JSON.stringify({ params: { flowName: 'Billing Bot' }, missing: ['searchTerm'] }),
      ['flowName', 'searchTerm']
    );
    expect(out.params).toEqual({ flowName: 'Billing Bot' });
    expect(out.missing).toEqual(['searchTerm']);
  });

  it('garbage output degrades to everything-missing (never throws)', () => {
    const out = parseParamExtractionResponse('nonsense', ['flowName']);
    expect(out.params).toEqual({});
    expect(out.missing).toEqual(['flowName']);
  });

  it('ignores extracted values for params that were not asked for', () => {
    const out = parseParamExtractionResponse(
      JSON.stringify({ params: { flowName: 'X', sneaky: 'y' } }),
      ['flowName']
    );
    expect(out.params).toEqual({ flowName: 'X' });
  });
});

describe('buildAgentOkf', () => {
  it('renders a self-describing OKF with invocation instructions', () => {
    const okf = buildAgentOkf(AGENT, SCRIPT);
    expect(okf).toContain('name: open-flow');
    expect(okf).toContain('kind: ui-automation-agent');
    expect(okf).toContain("invokeAgent('open-flow'");
    expect(okf).toContain('flowName');
    expect(okf).toContain(AGENT.description);
    expect(okf).toContain('scriptVersion: 1');
  });
});
