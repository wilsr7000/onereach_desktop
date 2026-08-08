/**
 * GSX repair tests -- the LLM contract (ADR-052).
 *
 * Pins (1) what evidence the repair prompt carries, (2) how model
 * output is parsed + validated, (3) that a repaired script is a
 * version-bumped `learned` variant. The chat seam is faked -- no
 * network, no key.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRepairInput,
  parseRepairResponse,
  repairScript,
} from '../../gsx/repair.js';
import type { GsxPageSnapshot, GsxRunRecord, GsxScript } from '../../gsx/types.js';
import { GSX_ERROR_CODES } from '../../gsx/errors.js';
import type { AiChatResult } from '../../ai/chat.js';

const SCRIPT: GsxScript = {
  id: 'flows.list',
  title: 'Open the Flows list',
  description: 'Navigate to the studio Flows view.',
  version: 3,
  source: 'learned',
  steps: [
    { kind: 'navigate', url: 'https://studio.{env}.onereach.ai/flows?accountId={accountId}' },
    { kind: 'waitFor', selector: '#old-root' },
    { kind: 'assertUrl', pattern: '/flows' },
  ],
};

const RUN: GsxRunRecord = {
  runId: 'r1',
  scriptId: 'flows.list',
  scriptVersion: 3,
  source: 'learned',
  windowId: 'gsx-1',
  params: { env: 'edison', accountId: 'acc' },
  startedAt: '2026-08-07T00:00:00.000Z',
  finishedAt: '2026-08-07T00:00:10.000Z',
  durationMs: 10_000,
  verdict: 'fail',
  steps: [
    { index: 0, kind: 'navigate', ok: true, durationMs: 500 },
    { index: 1, kind: 'waitFor', ok: false, detail: 'timeout waiting for #old-root', durationMs: 9_000 },
  ],
  failure: 'step 1 (waitFor): timeout waiting for #old-root',
};

const SNAPSHOT: GsxPageSnapshot = {
  url: 'https://studio.edison.onereach.ai/flows',
  title: 'Flows',
  elements: [
    { ref: 0, tag: 'div', text: '', attrs: { id: 'new-root', 'data-testid': 'flows-root' } },
  ],
};

describe('buildRepairInput', () => {
  it('carries the script, the failures, and the snapshot; asks for JSON', () => {
    const input = buildRepairInput(SCRIPT, RUN, SNAPSHOT);
    expect(input.jsonMode).toBe(true);
    expect(input.system).toContain('assertions');
    expect(input.system).toContain('{param}');
    const user = input.messages[0]?.content ?? '';
    expect(user).toContain('"flows.list" v3');
    expect(user).toContain('#old-root'); // the failing selector
    expect(user).toContain('timeout waiting for #old-root'); // the graded failure
    expect(user).toContain('data-testid'); // snapshot evidence
    expect(input.feature).toBe('gsx-repair');
  });

  it('caps snapshot elements at 120 in the prompt', () => {
    const big: GsxPageSnapshot = {
      ...SNAPSHOT,
      elements: Array.from({ length: 500 }, (_v, i) => ({
        ref: i,
        tag: 'button',
        text: `b${i}`,
        attrs: {},
      })),
    };
    const user = buildRepairInput(SCRIPT, RUN, big).messages[0]?.content ?? '';
    expect(user).toContain('"b119"');
    expect(user).not.toContain('"b120"');
  });
});

describe('parseRepairResponse', () => {
  const GOOD_STEPS = [
    { kind: 'navigate', url: 'https://studio.{env}.onereach.ai/flows?accountId={accountId}' },
    { kind: 'waitFor', selector: '[data-testid="flows-root"]' },
    { kind: 'assertUrl', pattern: '/flows' },
  ];

  it('parses a clean response into a version-bumped learned variant', () => {
    const { script, note } = parseRepairResponse(
      JSON.stringify({ steps: GOOD_STEPS, note: 'selector drift: #old-root -> data-testid' }),
      SCRIPT
    );
    expect(script.version).toBe(4);
    expect(script.source).toBe('learned');
    expect(script.id).toBe('flows.list');
    expect(script.steps).toHaveLength(3);
    expect(note).toContain('selector drift');
  });

  it('tolerates fenced/prefixed output (parses from the first brace)', () => {
    const fenced = '```json\n' + JSON.stringify({ steps: GOOD_STEPS }) + '\n```';
    const { script } = parseRepairResponse(fenced, SCRIPT);
    expect(script.version).toBe(4);
  });

  it.each([
    ['no JSON at all', 'I cannot help with that'],
    ['invalid JSON', '{steps: oops'],
    ['missing steps', '{"note":"hi"}'],
  ])('rejects %s with GSX_REPAIR_FAILED', (_label, content) => {
    expect(() => parseRepairResponse(content, SCRIPT)).toThrowError(
      expect.objectContaining({ code: GSX_ERROR_CODES.REPAIR_FAILED })
    );
  });

  it('rejects structurally invalid steps with GSX_INVALID_SCRIPT', () => {
    const bad = JSON.stringify({ steps: [{ kind: 'teleport', to: 'mars' }] });
    expect(() => parseRepairResponse(bad, SCRIPT)).toThrowError(
      expect.objectContaining({ code: GSX_ERROR_CODES.INVALID_SCRIPT })
    );
  });
});

describe('repairScript', () => {
  it('round-trips prompt -> chat -> validated script', async () => {
    let seenSystem = '';
    const chat = async (input: { system?: string }): Promise<AiChatResult> => {
      seenSystem = input.system ?? '';
      return {
        content: JSON.stringify({
          steps: [{ kind: 'waitFor', selector: '[data-testid="flows-root"]' }],
          note: 'fixed',
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'claude-fable-5',
        provider: 'claude',
        cost: 0,
      };
    };
    const { script } = await repairScript(chat, SCRIPT, RUN, SNAPSHOT);
    expect(seenSystem).toContain('repair UI automation scripts');
    expect(script.version).toBe(4);
  });
});
