/**
 * Unit tests for lib/agent-suggest.js -- the Agent Suggester engine:
 * work-profile interview, demand-signal collection, suggestion filtering,
 * and the menu UI contract (descriptions + one-click Build data-values).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), query: vi.fn() }),
}));

import {
  INTERVIEW_QUESTIONS,
  isWorkProfileEmpty,
  advanceInterview,
  collectSignals,
  buildSuggestionPrompt,
  filterSuggestions,
  renderAgentMenu,
  MENU_PANEL,
} from '../../lib/agent-suggest.js';

describe('interview', () => {
  it('asks three questions covering role, tools, and pain points', () => {
    expect(INTERVIEW_QUESTIONS).toHaveLength(3);
    expect(INTERVIEW_QUESTIONS.map((q) => q.key)).toEqual(['workRole', 'workTools', 'workPains']);
  });

  it('advances question by question and finishes with facts', () => {
    let step = advanceInterview({ step: -1, answers: [] }, '');
    expect(step.done).toBe(false);
    expect(step.nextQuestion).toBe(INTERVIEW_QUESTIONS[0].question);

    step = advanceInterview(step.state, 'I run product at a startup');
    expect(step.done).toBe(false);
    expect(step.nextQuestion).toBe(INTERVIEW_QUESTIONS[1].question);

    step = advanceInterview(step.state, 'Slack, Figma, Linear');
    expect(step.done).toBe(false);

    step = advanceInterview(step.state, 'Writing status updates');
    expect(step.done).toBe(true);
    expect(step.facts).toEqual({
      workRole: 'I run product at a startup',
      workTools: 'Slack, Figma, Linear',
      workPains: 'Writing status updates',
    });
  });

  it('isWorkProfileEmpty needs real signal, not fragments', () => {
    expect(isWorkProfileEmpty({})).toBe(true);
    expect(isWorkProfileEmpty({ workRole: 'PM' })).toBe(true);
    expect(
      isWorkProfileEmpty({ workRole: 'I run product for the mobile team at a fintech startup' })
    ).toBe(false);
  });
});

describe('collectSignals', () => {
  it('collects from every source and shapes the output', () => {
    const signals = collectSignals({
      queryLog: () => [
        { data: { userInput: 'set an alarm for my standup' } },
        { message: 'capability-gap: transcribe my voicemails please' },
      ],
      getConversation: () => [
        { role: 'user', content: 'summarize my inbox' },
        { role: 'assistant', content: 'done' },
      ],
      searchChats: () => ['thread about quarterly OKRs'],
      listAgents: () => [{ name: 'Event Manager', description: 'events' }],
    });
    expect(signals.gapEvents).toContain('set an alarm for my standup');
    expect(signals.conversation).toEqual(['summarize my inbox']);
    expect(signals.chatSnippets).toEqual(['thread about quarterly OKRs']);
    expect(signals.existingAgents).toEqual([{ name: 'Event Manager', description: 'events' }]);
  });

  it('isolates source failures (one broken source cannot empty the rest)', () => {
    const signals = collectSignals({
      queryLog: () => {
        throw new Error('log dead');
      },
      getConversation: () => [{ role: 'user', content: 'hello there' }],
      searchChats: () => {
        throw new Error('spaces dead');
      },
      listAgents: () => [],
    });
    expect(signals.gapEvents).toEqual([]);
    expect(signals.conversation).toEqual(['hello there']);
    expect(signals.chatSnippets).toEqual([]);
  });
});

describe('buildSuggestionPrompt', () => {
  it('grounds the prompt in profile, gaps, chats, and the existing roster', () => {
    const prompt = buildSuggestionPrompt(
      'workRole: product manager',
      {
        gapEvents: ['set an alarm'],
        conversation: ['summarize my inbox'],
        chatSnippets: ['OKR thread'],
        existingAgents: [{ name: 'Event Manager', description: 'manages events' }],
      },
      4
    );
    expect(prompt).toContain('product manager');
    expect(prompt).toContain('set an alarm');
    expect(prompt).toContain('summarize my inbox');
    expect(prompt).toContain('OKR thread');
    expect(prompt).toContain('Event Manager');
    expect(prompt).toContain('exactly 4 NEW agents');
  });
});

describe('filterSuggestions', () => {
  const existing = [{ name: 'Event Manager' }, { name: 'Meeting Starter' }];

  it('drops roster collisions and duplicates, normalizes effort', () => {
    const out = filterSuggestions(
      [
        { name: 'Event Manager', description: 'dupe of existing' },
        { name: 'Inbox Summarizer', description: 'summarizes email', effort: 'easy' },
        { name: 'inbox summarizer', description: 'again' },
        { name: 'OKR Tracker', description: 'tracks OKRs', effort: 'galactic' },
        { name: '', description: 'nameless' },
      ],
      existing
    );
    expect(out.map((s) => s.name)).toEqual(['Inbox Summarizer', 'OKR Tracker']);
    expect(out[1].effort).toBe('medium'); // unknown effort normalized
  });

  it('caps the list and survives junk input', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `A${i}`, description: 'd' }));
    expect(filterSuggestions(many, [], 6)).toHaveLength(6);
    expect(filterSuggestions(null, existing)).toEqual([]);
  });
});

describe('renderAgentMenu (the menu UI contract)', () => {
  const suggestions = [
    { name: 'Inbox Summarizer', description: 'Summarizes your email every morning.', why: 'You asked about your inbox 4 times.', effort: 'easy' },
    { name: 'OKR <Tracker>', description: 'Tracks objectives.', why: '', effort: 'hard' },
  ];

  it('every suggestion shows description + why and a one-click Build action', () => {
    const html = renderAgentMenu(suggestions, { profileSummary: 'product manager' });
    expect(html).toContain('Summarizes your email every morning.');
    expect(html).toContain('Why you: You asked about your inbox 4 times.');
    // Build button rides the data-value contract into the normal build pipeline
    expect(html).toMatch(/data-value="build an agent: Inbox Summarizer — Summarizes your email every morning\."/);
    // Escaping
    expect(html).toContain('OKR &lt;Tracker&gt;');
    expect(html).not.toContain('OKR <Tracker>');
    // Effort badges
    expect(html).toContain('class="badge easy"');
    expect(html).toContain('class="badge hard"');
    expect(html).toContain('Based on: product manager');
  });

  it('offers refresh and profile-update actions', () => {
    const html = renderAgentMenu(suggestions);
    expect(html).toMatch(/data-value="suggest different agents to build"/);
    expect(html).toMatch(/data-value="update what you know about my work"/);
  });

  it('shows an empty state, dark scrollbars, and a sane panel size', () => {
    expect(renderAgentMenu([])).toMatch(/No suggestions yet/);
    expect(renderAgentMenu(suggestions)).toMatch(/scrollbar-color:\s*#3a3f4b #16181d/);
    expect(MENU_PANEL.width).toBeGreaterThanOrEqual(400);
    expect(MENU_PANEL.height).toBeGreaterThanOrEqual(300);
  });
});
