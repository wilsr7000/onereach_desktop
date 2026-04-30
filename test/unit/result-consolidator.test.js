/**
 * Result Consolidator - Unit Tests
 *
 * Covers each primitive + the composite envelope builder + a
 * legacy-equivalence test that reproduces the inline field-fallback
 * logic from exchange-bridge.js's task:settled handler.
 *
 * Run:  npx vitest run test/unit/result-consolidator.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  normalizeResult,
  extractDeliveryMessage,
  extractLearningMessage,
  hasPanel,
  agentIdToDisplayName,
  buildDeliveryEnvelope,
  DEFAULT_LEARNING_MESSAGE_MAX_LEN,
  DONE_MESSAGE,
} = require('../../lib/hud-core/result-consolidator');

describe('normalizeResult', () => {
  it('null / undefined -> {}', () => {
    expect(normalizeResult(null)).toEqual({});
    expect(normalizeResult(undefined)).toEqual({});
  });

  it('non-object primitives -> {}', () => {
    expect(normalizeResult('hello')).toEqual({});
    expect(normalizeResult(42)).toEqual({});
    expect(normalizeResult(true)).toEqual({});
  });

  it('passes objects through unchanged', () => {
    const r = { success: true, output: 'x' };
    expect(normalizeResult(r)).toBe(r);
  });
});

describe('extractDeliveryMessage - fallback chain', () => {
  it('prefers result.output', () => {
    const r = { output: 'primary', data: { output: 'nope', message: 'nope' }, success: true };
    expect(extractDeliveryMessage(r)).toBe('primary');
  });

  it('falls back to data.output', () => {
    expect(extractDeliveryMessage({ data: { output: 'from data' }, success: true })).toBe('from data');
  });

  it('falls back to data.message', () => {
    expect(extractDeliveryMessage({ data: { message: 'data msg' }, success: true })).toBe('data msg');
  });

  it('falls back to DONE_MESSAGE when success=true and no text', () => {
    expect(extractDeliveryMessage({ success: true })).toBe(DONE_MESSAGE);
    expect(DONE_MESSAGE).toBe('All done');
  });

  it('returns null on failure with no message', () => {
    expect(extractDeliveryMessage({ success: false })).toBeNull();
    expect(extractDeliveryMessage({})).toBeNull();
  });

  it('returns null on null/undefined input', () => {
    expect(extractDeliveryMessage(null)).toBeNull();
    expect(extractDeliveryMessage(undefined)).toBeNull();
  });

  it('empty-string output falls through to next level', () => {
    expect(extractDeliveryMessage({ output: '', data: { output: 'x' }, success: true })).toBe('x');
  });

  it('non-string output is ignored', () => {
    expect(
      extractDeliveryMessage({ output: 42, data: { output: 'valid' }, success: true })
    ).toBe('valid');
  });

  it('non-object data is tolerated (falls through to success fallback)', () => {
    expect(extractDeliveryMessage({ data: 'not an object', success: true })).toBe(DONE_MESSAGE);
  });
});

describe('extractLearningMessage', () => {
  it('prefers .output over .message', () => {
    expect(extractLearningMessage({ output: 'out', message: 'msg' })).toBe('out');
  });

  it('falls back to .message when output is missing', () => {
    expect(extractLearningMessage({ message: 'msg' })).toBe('msg');
  });

  it('returns empty string when neither is present', () => {
    expect(extractLearningMessage({})).toBe('');
    expect(extractLearningMessage(null)).toBe('');
  });

  it('truncates to DEFAULT_LEARNING_MESSAGE_MAX_LEN', () => {
    const long = 'x'.repeat(DEFAULT_LEARNING_MESSAGE_MAX_LEN + 100);
    const r = extractLearningMessage({ output: long });
    expect(r.length).toBe(DEFAULT_LEARNING_MESSAGE_MAX_LEN);
    expect(DEFAULT_LEARNING_MESSAGE_MAX_LEN).toBe(500);
  });

  it('honors custom maxLen', () => {
    const r = extractLearningMessage({ output: 'abcdefghij' }, { maxLen: 4 });
    expect(r).toBe('abcd');
  });

  it('ignores non-string fields', () => {
    expect(extractLearningMessage({ output: 42, message: 'yes' })).toBe('yes');
  });
});

describe('hasPanel', () => {
  it('truthy html -> true', () => {
    expect(hasPanel({ html: '<div>hi</div>' })).toBe(true);
    expect(hasPanel({ html: ' ' })).toBe(true);
  });

  it('falsy / missing html -> false', () => {
    expect(hasPanel({})).toBe(false);
    expect(hasPanel({ html: '' })).toBe(false);
    expect(hasPanel({ html: null })).toBe(false);
    expect(hasPanel(null)).toBe(false);
  });
});

describe('agentIdToDisplayName', () => {
  it('hyphen to space + titlecase', () => {
    expect(agentIdToDisplayName('weather-agent')).toBe('Weather Agent');
    expect(agentIdToDisplayName('music-dj-agent')).toBe('Music Dj Agent');
    expect(agentIdToDisplayName('singleword')).toBe('Singleword');
  });

  it('empty / null / non-string -> ""', () => {
    expect(agentIdToDisplayName('')).toBe('');
    expect(agentIdToDisplayName(null)).toBe('');
    expect(agentIdToDisplayName(undefined)).toBe('');
    expect(agentIdToDisplayName(42)).toBe('');
  });
});

describe('buildDeliveryEnvelope', () => {
  it('builds a complete envelope from a normal success result', () => {
    const r = {
      success: true,
      output: 'Playing jazz for you',
      data: { track: 'A Love Supreme' },
      html: '<div>now playing</div>',
    };
    const env = buildDeliveryEnvelope(r, {
      taskId: 't-123',
      agentId: 'dj-agent',
    });
    expect(env).toEqual({
      success: true,
      message: 'Playing jazz for you',
      html: '<div>now playing</div>',
      data: { track: 'A Love Supreme' },
      hasPanel: true,
      agentId: 'dj-agent',
      agentName: 'Dj Agent',
      taskId: 't-123',
    });
  });

  it('derives agentName from agentId when no override supplied', () => {
    const env = buildDeliveryEnvelope({ success: true }, { agentId: 'weather-agent' });
    expect(env.agentName).toBe('Weather Agent');
  });

  it('respects agentName override', () => {
    const env = buildDeliveryEnvelope(
      { success: true },
      { agentId: 'weather-agent', agentName: 'Forecasts Inc.' }
    );
    expect(env.agentName).toBe('Forecasts Inc.');
  });

  it('success defaults to true when not explicitly false', () => {
    expect(buildDeliveryEnvelope({}).success).toBe(true);
    expect(buildDeliveryEnvelope({ success: undefined }).success).toBe(true);
    expect(buildDeliveryEnvelope({ success: false }).success).toBe(false);
  });

  it('message is null on failure with no content', () => {
    const env = buildDeliveryEnvelope({ success: false }, { agentId: 'dj' });
    expect(env.message).toBeNull();
    expect(env.success).toBe(false);
  });

  it('defaults html / data to null when absent', () => {
    const env = buildDeliveryEnvelope({ success: true }, { agentId: 'a' });
    expect(env.html).toBeNull();
    expect(env.data).toBeNull();
  });

  it('tolerates null input', () => {
    const env = buildDeliveryEnvelope(null, { taskId: 't', agentId: 'a' });
    expect(env.taskId).toBe('t');
    expect(env.agentId).toBe('a');
    expect(env.message).toBeNull();
  });
});

describe('legacy equivalence to task:settled inline logic', () => {
  // Reproduces the inline field-fallback rule from
  // src/voice-task-sdk/exchange-bridge.js:
  //   let message = result.output || result.data?.output
  //               || result.data?.message
  //               || (result.success ? 'All done' : null);
  function legacyMessage(result) {
    return (
      result.output ||
      result.data?.output ||
      result.data?.message ||
      (result.success ? 'All done' : null)
    );
  }

  const cases = [
    { label: 'output present', r: { output: 'X', success: true } },
    { label: 'data.output present', r: { data: { output: 'X' }, success: true } },
    { label: 'data.message present', r: { data: { message: 'X' }, success: true } },
    { label: 'success with no text', r: { success: true } },
    { label: 'failure with no text', r: { success: false } },
    { label: 'failure with output (error message)', r: { success: false, output: 'failed: X' } },
    { label: 'completely empty', r: {} },
  ];

  for (const { label, r } of cases) {
    it(`legacy === extracted for: ${label}`, () => {
      expect(extractDeliveryMessage(r)).toBe(legacyMessage(r));
    });
  }

  // Reproduces the inline "hasPanel" rule:
  //   const hasPanel = !!result.html;
  function legacyHasPanel(result) {
    return !!result.html;
  }
  const panelCases = [
    {},
    { html: '<x/>' },
    { html: '' },
    { html: null },
    { html: 0 },
  ];
  for (const r of panelCases) {
    it(`hasPanel legacy === extracted for ${JSON.stringify(r)}`, () => {
      expect(hasPanel(r)).toBe(legacyHasPanel(r));
    });
  }

  // Reproduces the inline learning-message rule:
  //   (safeResult.output || safeResult.message || '').slice(0, 500);
  function legacyLearning(safeResult) {
    return (safeResult.output || safeResult.message || '').slice(0, 500);
  }
  const learningCases = [
    {},
    { output: 'x' },
    { message: 'x' },
    { output: 'x', message: 'y' },
    { output: 'x'.repeat(1000) },
  ];
  for (const r of learningCases) {
    it(`learning legacy === extracted for output=${r.output?.length || 0}chars`, () => {
      expect(extractLearningMessage(r)).toBe(legacyLearning(r));
    });
  }

  // Agent-name legacy rule:
  //   agentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  function legacyDisplayName(agentId) {
    return agentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const nameCases = ['weather-agent', 'dj', 'multi-word-agent-name'];
  for (const id of nameCases) {
    it(`display name legacy === extracted for "${id}"`, () => {
      expect(agentIdToDisplayName(id)).toBe(legacyDisplayName(id));
    });
  }
});
