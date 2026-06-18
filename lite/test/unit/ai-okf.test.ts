/**
 * OKF conversion unit tests — pure parse/validate + the Claude-call
 * request shape (stubbed creator, no network).
 */

import { describe, it, expect } from 'vitest';
import {
  parseOkfResult,
  validateOkfShape,
  buildOkfUserContent,
  callClaudeOkf,
  OKF_SYSTEM_PROMPT,
} from '../../ai/okf.js';
import { AiError } from '../../ai/errors.js';

describe('OKF parse + validate', () => {
  it('parses a valid JSON result', () => {
    const r = parseOkfResult('{"okf":"name: Bot","agentType":"conversational","name":"Bot"}');
    expect(r.okf).toBe('name: Bot');
    expect(r.agentType).toBe('conversational');
    expect(r.name).toBe('Bot');
  });

  it('strips a ```json code fence', () => {
    const r = parseOkfResult('```json\n{"okf":"x: 1","agentType":"tool","name":"X"}\n```');
    expect(r.agentType).toBe('tool');
    expect(r.okf).toBe('x: 1');
  });

  it('defaults agentType to "other" when blank', () => {
    const r = validateOkfShape({ okf: 'a: b', agentType: '', name: 'N' });
    expect(r.agentType).toBe('other');
  });

  it('throws (AiError) on empty OKF', () => {
    expect(() => validateOkfShape({ okf: '   ', agentType: 'tool', name: 'N' })).toThrow(AiError);
  });

  it('throws (AiError) on invalid JSON and non-objects', () => {
    expect(() => parseOkfResult('not json at all')).toThrow(AiError);
    expect(() => parseOkfResult('')).toThrow(AiError);
    expect(() => validateOkfShape([])).toThrow(AiError);
    expect(() => validateOkfShape(null)).toThrow(AiError);
  });
});

describe('OKF request shape', () => {
  it('wraps the source in AGENT_SOURCE markers', () => {
    const c = buildOkfUserContent('some agent definition');
    expect(c).toContain('AGENT_SOURCE');
    expect(c).toContain('some agent definition');
  });

  it('callClaudeOkf sends the OKF system prompt + parses the stubbed reply', async () => {
    let sawPrompt = '';
    const r = await callClaudeOkf('def', {
      model: 'claude-opus-4-8',
      createMessage: async (params) => {
        sawPrompt = params.system;
        return {
          content: [
            { type: 'text', text: '{"okf":"k: v","agentType":"workflow","name":"W"}' },
          ],
        };
      },
    });
    expect(sawPrompt).toBe(OKF_SYSTEM_PROMPT);
    expect(r.agentType).toBe('workflow');
    expect(r.okf).toBe('k: v');
    expect(r.name).toBe('W');
  });

  it('callClaudeOkf throws AiError on a refusal stop_reason', async () => {
    await expect(
      callClaudeOkf('def', {
        model: 'claude-opus-4-8',
        createMessage: async () => ({ content: [], stop_reason: 'refusal' }),
      })
    ).rejects.toBeInstanceOf(AiError);
  });
});
