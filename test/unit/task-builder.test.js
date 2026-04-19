/**
 * Task Builder -- Unit Tests
 *
 * Verifies `buildTask` produces a canonical task shape that matches the
 * TypeScript Task interface plus the agent-system upgrade additions.
 *
 * Design principle: existing code paths that pass ad-hoc task literals
 * still get a valid task after buildTask(). New optional fields
 * (variant, criteria, rubric, etc.) pass through when present and are
 * omitted when absent.
 */

import { describe, it, expect } from 'vitest';

const {
  buildTask,
  normalizeTask,
  toSubmitPayload,
  VALID_VARIANTS,
  VALID_STATUSES,
} = require('../../lib/task');

describe('buildTask -- required fields', () => {
  it('rejects missing/empty content', () => {
    expect(() => buildTask({})).toThrow(/content is required/);
    expect(() => buildTask({ content: '   ' })).toThrow(/content is required/);
    expect(() => buildTask(null)).toThrow(/must be an object/);
  });

  it('generates an id when omitted', () => {
    const t = buildTask({ content: 'hello' });
    expect(t.id).toBeTruthy();
    expect(typeof t.id).toBe('string');
    // uuid v4-ish shape
    expect(t.id.length).toBeGreaterThan(16);
  });

  it('preserves an explicit id', () => {
    const t = buildTask({ id: 'fixed-id-123', content: 'x' });
    expect(t.id).toBe('fixed-id-123');
  });

  it('trims whitespace from content', () => {
    expect(buildTask({ content: '  hello world  ' }).content).toBe('hello world');
  });
});

describe('buildTask -- defaults', () => {
  it('status defaults to pending', () => {
    expect(buildTask({ content: 'x' }).status).toBe('pending');
  });

  it('priority defaults to 2 (normal)', () => {
    expect(buildTask({ content: 'x' }).priority).toBe(2);
  });

  it('queue defaults to "default"', () => {
    expect(buildTask({ content: 'x' }).queue).toBe('default');
  });

  it('maxAttempts defaults to 3', () => {
    expect(buildTask({ content: 'x' }).maxAttempts).toBe(3);
  });

  it('attempt defaults to 0', () => {
    expect(buildTask({ content: 'x' }).attempt).toBe(0);
  });

  it('params defaults to empty object', () => {
    expect(buildTask({ content: 'x' }).params).toEqual({});
  });
});

describe('buildTask -- validation / normalization', () => {
  it('coerces invalid status back to default', () => {
    const t = buildTask({ content: 'x', status: 'bogus' });
    expect(t.status).toBe('pending');
  });

  it('accepts any valid status', () => {
    for (const s of VALID_STATUSES) {
      expect(buildTask({ content: 'x', status: s }).status).toBe(s);
    }
  });

  it('accepts numeric-string priority', () => {
    expect(buildTask({ content: 'x', priority: '3' }).priority).toBe(3);
  });

  it('rejects out-of-range priority by defaulting', () => {
    expect(buildTask({ content: 'x', priority: 99 }).priority).toBe(2);
    expect(buildTask({ content: 'x', priority: 0 }).priority).toBe(2);
    expect(buildTask({ content: 'x', priority: 'bogus' }).priority).toBe(2);
  });

  it('ignores unknown variant values', () => {
    const t = buildTask({ content: 'x', variant: 'not-a-variant' });
    expect(t.variant).toBeUndefined();
  });

  it('accepts every valid variant', () => {
    for (const v of VALID_VARIANTS) {
      expect(buildTask({ content: 'x', variant: v }).variant).toBe(v);
    }
  });
});

describe('buildTask -- agent-system upgrade additions', () => {
  it('passes through description, toolId, spaceId, targetAgentId', () => {
    const t = buildTask({
      content: 'x',
      description: 'user wants to see tomorrow',
      toolId: 'orb',
      spaceId: 'calendar-agents',
      targetAgentId: 'calendar-query-agent',
    });
    expect(t.description).toBe('user wants to see tomorrow');
    expect(t.toolId).toBe('orb');
    expect(t.spaceId).toBe('calendar-agents');
    expect(t.targetAgentId).toBe('calendar-query-agent');
  });

  it('normalizes criteria, dropping invalid entries', () => {
    const t = buildTask({
      content: 'x',
      criteria: [
        { id: 'clarity', label: 'Clarity', weight: 0.3 },
        { id: 'risk' }, // label falls back to id
        {}, // no id -> dropped
        { id: 'feasibility', label: 'Feasibility', description: 'Can it ship?' },
      ],
    });
    expect(t.criteria).toHaveLength(4);
    // entries without id are mapped to null (caller can filter)
    expect(t.criteria[2]).toBeNull();
    expect(t.criteria[0]).toMatchObject({ id: 'clarity', label: 'Clarity', weight: 0.3 });
    expect(t.criteria[1]).toMatchObject({ id: 'risk', label: 'risk' });
    expect(t.criteria[3].description).toBe('Can it ship?');
  });

  it('accepts rubric id string', () => {
    const t = buildTask({ content: 'x', rubric: 'code_generation' });
    expect(t.rubric).toBe('code_generation');
  });
});

describe('buildTask -- metadata handling', () => {
  it('seeds default metadata when none supplied', () => {
    const t = buildTask({ content: 'x', toolId: 'orb', createdAt: 1234 });
    expect(t.metadata).toBeTruthy();
    expect(t.metadata.source).toBe('orb');
    expect(t.metadata.timestamp).toBe(1234);
  });

  it('preserves caller-provided metadata and merges well-known fields', () => {
    const t = buildTask({
      content: 'x',
      toolId: 'recorder',
      spaceId: 'meeting-agents',
      metadata: { customKey: 'hello', source: 'overridden' },
    });
    expect(t.metadata.customKey).toBe('hello');
    // Caller's explicit source wins
    expect(t.metadata.source).toBe('overridden');
    // spaceId -> agentSpaceId mirror is filled in because caller didn't
    expect(t.metadata.agentSpaceId).toBe('meeting-agents');
  });

  it('populates agentFilter from targetAgentId', () => {
    const t = buildTask({ content: 'x', targetAgentId: 'weather-agent' });
    expect(t.metadata.agentFilter).toEqual(['weather-agent']);
    expect(t.metadata.targetAgentId).toBe('weather-agent');
  });

  it('respects caller-provided agentFilter over targetAgentId mirror', () => {
    const t = buildTask({
      content: 'x',
      targetAgentId: 'weather-agent',
      metadata: { agentFilter: ['search-agent', 'weather-agent'] },
    });
    expect(t.metadata.agentFilter).toEqual(['search-agent', 'weather-agent']);
  });
});

describe('normalizeTask', () => {
  it('accepts an already-canonical task and returns the same shape', () => {
    const original = buildTask({ content: 'x' });
    const norm = normalizeTask(original);
    expect(norm.id).toBe(original.id);
    expect(norm.content).toBe(original.content);
    expect(norm.status).toBe('pending');
  });

  it('brings a loose task literal up to canonical shape', () => {
    const loose = { content: 'hi', priority: 5 };
    const norm = normalizeTask(loose);
    expect(norm.priority).toBe(2); // invalid 5 -> default
    expect(norm.queue).toBe('default');
    expect(norm.status).toBe('pending');
    expect(norm.id).toBeTruthy();
  });

  it('throws on non-object input', () => {
    expect(() => normalizeTask(null)).toThrow(/must be an object/);
    expect(() => normalizeTask('hi')).toThrow(/must be an object/);
  });
});

describe('toSubmitPayload', () => {
  it('produces the legacy exchange.submit shape', () => {
    const t = buildTask({ content: 'hello', priority: 3, toolId: 'orb' });
    const p = toSubmitPayload(t);
    expect(p.content).toBe('hello');
    expect(p.priority).toBe(3);
    expect(p.metadata.source).toBe('orb');
  });
});
