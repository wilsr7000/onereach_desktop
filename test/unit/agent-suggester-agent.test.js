/**
 * Unit tests for agent-suggester-agent -- the "what agents should I build?"
 * flow: empty-profile interview -> profile persistence -> suggestion menu,
 * all through the _setTestDeps seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), query: vi.fn(() => []) }),
}));

vi.mock('../../lib/ai-service', () => ({
  json: vi.fn(),
  complete: vi.fn(),
  chat: vi.fn(),
}));

import suggester from '../../packages/agents/agent-suggester-agent';
import { INTERVIEW_QUESTIONS } from '../../lib/agent-suggest.js';

const SUGGESTIONS = [
  { name: 'Inbox Summarizer', description: 'Summarizes email.', why: 'You ask about email.', effort: 'easy' },
  { name: 'OKR Tracker', description: 'Tracks OKRs.', why: 'OKR chats.', effort: 'medium' },
];

function makeProfile(facts = {}) {
  return {
    load: vi.fn(),
    save: vi.fn(),
    getFacts: vi.fn(() => facts),
    updateFacts: vi.fn(),
  };
}

let profile;
let shownHtml;
let aiJson;

function wire({ facts = {}, suggestions = SUGGESTIONS } = {}) {
  profile = makeProfile(facts);
  shownHtml = [];
  aiJson = vi.fn(async () => ({ suggestions }));
  suggester._setTestDeps({
    getProfile: () => profile,
    showModal: (html) => shownHtml.push(html),
    ai: { json: aiJson },
    signalDeps: () => ({
      queryLog: () => [{ data: { userInput: 'transcribe my voicemails' } }],
      getConversation: () => [{ role: 'user', content: 'summarize my inbox' }],
      searchChats: () => ['OKR thread from Slack'],
      listAgents: () => [{ name: 'Event Manager', description: 'events' }],
    }),
  });
}

beforeEach(() => {
  wire();
});

describe('empty profile -> interview', () => {
  it('starts the interview instead of guessing', async () => {
    const out = await suggester.execute({ content: 'what agents should I build?' });
    expect(out.needsInput).toBeDefined();
    expect(out.needsInput.prompt).toContain(INTERVIEW_QUESTIONS[0].question);
    expect(out.needsInput.context.pendingInterview).toEqual({ step: 0, answers: [] });
    expect(aiJson).not.toHaveBeenCalled(); // no suggestions before it knows the user
  });

  it('walks all three questions, saves the profile, then suggests', async () => {
    let out = await suggester.execute({
      content: 'I run product at a fintech startup',
      context: { pendingInterview: { step: 0, answers: [] } },
    });
    expect(out.needsInput.prompt).toContain(INTERVIEW_QUESTIONS[1].question);

    out = await suggester.execute({
      content: 'Slack and Linear mostly',
      context: { pendingInterview: out.needsInput.context.pendingInterview },
    });
    expect(out.needsInput.prompt).toContain(INTERVIEW_QUESTIONS[2].question);

    out = await suggester.execute({
      content: 'writing weekly status updates',
      context: { pendingInterview: out.needsInput.context.pendingInterview },
    });

    // Interview done: persisted to the cross-agent profile...
    expect(profile.updateFacts).toHaveBeenCalledWith({
      workRole: 'I run product at a fintech startup',
      workTools: 'Slack and Linear mostly',
      workPains: 'writing weekly status updates',
    });
    expect(profile.save).toHaveBeenCalled();
    // ...and it flows straight into suggestions with the menu shown.
    expect(out.needsInput).toBeUndefined();
    expect(shownHtml).toHaveLength(1);
    expect(out.message).toContain('Inbox Summarizer');
  });
});

describe('populated profile -> menu', () => {
  beforeEach(() => {
    wire({
      facts: {
        workRole: 'I run product for the mobile team at a fintech startup',
        workTools: 'Slack, Linear',
        workPains: 'status updates',
      },
    });
  });

  it('skips the interview and shows the menu with descriptions', async () => {
    const out = await suggester.execute({ content: 'suggest agents' });
    expect(out.success).toBe(true);
    expect(out.needsInput).toBeUndefined();
    expect(shownHtml).toHaveLength(1);
    expect(shownHtml[0]).toContain('Summarizes email.');
    expect(shownHtml[0]).toMatch(/data-value="build an agent: Inbox Summarizer/);
    expect(out.data.suggestions.map((s) => s.name)).toEqual(['Inbox Summarizer', 'OKR Tracker']);
  });

  it('the LLM prompt is grounded in profile + demand signals + roster', async () => {
    await suggester.execute({ content: 'suggest agents' });
    const prompt = aiJson.mock.calls[0][0];
    expect(prompt).toContain('fintech startup');
    expect(prompt).toContain('transcribe my voicemails'); // capability gap
    expect(prompt).toContain('summarize my inbox'); // conversation
    expect(prompt).toContain('OKR thread from Slack'); // chat history
    expect(prompt).toContain('Event Manager'); // roster to avoid
  });

  it('roster collisions are filtered out of the menu', async () => {
    wire({
      facts: { workRole: 'I run product for the mobile team at a fintech startup' },
      suggestions: [
        { name: 'Event Manager', description: 'dupe' },
        { name: 'Inbox Summarizer', description: 'Summarizes email.' },
      ],
    });
    const out = await suggester.execute({ content: 'suggest agents' });
    expect(out.data.suggestions.map((s) => s.name)).toEqual(['Inbox Summarizer']);
  });

  it('"update what you know about my work" restarts the interview', async () => {
    const out = await suggester.execute({ content: 'update what you know about my work' });
    expect(out.needsInput.context.pendingInterview).toEqual({ step: 0, answers: [] });
  });

  it('LLM failure degrades to an honest message', async () => {
    aiJson.mockRejectedValue(new Error('llm down'));
    const out = await suggester.execute({ content: 'suggest agents' });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/couldn't put suggestions together/i);
    expect(shownHtml).toHaveLength(0);
  });
});

describe('bid surface', () => {
  it('keywords cover the suggest/menu/profile intents', () => {
    expect(suggester.keywords).toContain('suggest agents');
    expect(suggester.keywords).toContain('what agents should i build');
    expect(suggester.keywords).toContain('update what you know about my work');
  });

  it('registry lists the agent', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../packages/agents/agent-registry.js'), 'utf8');
    expect(src).toContain("'agent-suggester-agent'");
  });
});
