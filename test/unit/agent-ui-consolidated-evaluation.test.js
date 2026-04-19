/**
 * Agent UI Renderer -- consolidatedEvaluation spec (Phase 1)
 *
 * Verifies the new council-mode renderer produces well-formed HTML with
 * the expected structural bits (aggregate score, agent list, conflicts,
 * suggestions, recommendsHumanReview badge).
 */

import { describe, it, expect } from 'vitest';

const { renderAgentUI } = require('../../lib/agent-ui-renderer');

describe('consolidatedEvaluation renderer', () => {
  it('returns empty string when spec has no type', () => {
    expect(renderAgentUI({})).toBe('');
    expect(renderAgentUI(null)).toBe('');
  });

  it('renders an aggregate score prominently', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 87,
      confidence: 'high',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [],
      suggestions: [],
    });
    expect(html).toContain('87');
    expect(html).toContain('high');
    expect(html).toContain('uniform');
  });

  it('includes a row per agent score with name and numeric score', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 72,
      confidence: 'medium',
      weightingMode: 'uniform',
      agentScores: [
        { agentType: 'calendar-query', agentId: 'calendar-query-agent', score: 85 },
        { agentType: 'weather', agentId: 'weather-agent', score: 60 },
      ],
      conflicts: [],
      suggestions: [],
    });
    expect(html).toContain('calendar-query');
    expect(html).toContain('85');
    expect(html).toContain('weather');
    expect(html).toContain('60');
    expect(html).toMatch(/Agents \(2\)/);
  });

  it('renders conflict block only when conflicts present', () => {
    const htmlNoConflicts = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 72,
      confidence: 'medium',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [],
      suggestions: [],
    });
    expect(htmlNoConflicts).not.toContain('Conflicts');

    const htmlWithConflicts = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 72,
      confidence: 'medium',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [
        {
          criterion: 'clarity',
          spread: 25,
          highScorer: { agentType: 'expert', score: 85 },
          lowScorer: { agentType: 'beginner', score: 60 },
          resolution: 'Human review recommended.',
        },
      ],
      suggestions: [],
    });
    expect(htmlWithConflicts).toMatch(/Conflicts \(1\)/);
    expect(htmlWithConflicts).toContain('clarity');
    expect(htmlWithConflicts).toContain('expert');
    expect(htmlWithConflicts).toContain('beginner');
    expect(htmlWithConflicts).toContain('Human review recommended');
  });

  it('caps suggestions at 3', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 72,
      confidence: 'medium',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [],
      suggestions: [
        { text: 'first', source: 's1' },
        { text: 'second', source: 's2' },
        { text: 'third', source: 's3' },
        { text: 'fourth -- should not render', source: 's4' },
      ],
    });
    expect(html).toContain('first');
    expect(html).toContain('second');
    expect(html).toContain('third');
    expect(html).not.toContain('fourth');
  });

  it('shows the review-recommended badge when flagged', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 55,
      confidence: 'low',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [],
      suggestions: [],
      recommendsHumanReview: true,
    });
    expect(html).toContain('Review recommended');
  });

  it('renders primary drivers when provided', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 75,
      confidence: 'medium',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [],
      suggestions: [],
      primaryDrivers: ['clarity', 'feasibility', 'specificity'],
    });
    expect(html).toContain('Primary drivers');
    expect(html).toContain('clarity');
    expect(html).toContain('feasibility');
  });

  it('renders primary drivers given as {name} objects', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 75,
      confidence: 'medium',
      weightingMode: 'uniform',
      agentScores: [],
      conflicts: [],
      suggestions: [],
      primaryDrivers: [{ name: 'clarity' }, { name: 'risk' }],
    });
    expect(html).toContain('clarity');
    expect(html).toContain('risk');
  });

  it('escapes HTML in agent names and suggestions', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 50,
      confidence: 'low',
      weightingMode: 'uniform',
      agentScores: [{ agentType: '<script>', score: 50 }],
      conflicts: [],
      suggestions: [{ text: '<img onerror=alert(1)>', source: 'evil' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles missing agentScores / conflicts / suggestions gracefully', () => {
    const html = renderAgentUI({
      type: 'consolidatedEvaluation',
      aggregateScore: 42,
      confidence: 'low',
      weightingMode: 'uniform',
    });
    // Should not throw, and should render at least the aggregate
    expect(html).toContain('42');
    expect(html).toContain('low');
  });
});
