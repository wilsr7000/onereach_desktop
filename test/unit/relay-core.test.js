/**
 * Relay Core — pure inbound/outbound decision brain shared by the Voice Relay,
 * Chat, and Modal agents. See docs/internal/ORB-EXCHANGE-AGENTS.md.
 *
 * Run: npx vitest run test/unit/relay-core.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  classifyInbound,
  planOutbound,
  buildModalSubmit,
  shouldSurfaceNeedsInput,
} = require('../../lib/exchange/relay-core');

describe('relay-core classifyInbound', () => {
  describe('voice / text utterances', () => {
    it('a plain voice utterance submits with no correlation', () => {
      const d = classifyInbound({ source: 'voice', text: 'give me the daily brief' });
      expect(d).toEqual({
        submit: true,
        text: 'give me the daily brief',
        kind: 'utterance',
        correlation: {},
      });
    });

    it('a typed text utterance behaves the same as voice', () => {
      const d = classifyInbound({ source: 'text', text: 'what time is it' });
      expect(d.submit).toBe(true);
      expect(d.kind).toBe('utterance');
      expect(d.correlation).toEqual({});
    });

    it('empty / whitespace text is a noop (never submits)', () => {
      expect(classifyInbound({ source: 'voice', text: '   ' }).submit).toBe(false);
      expect(classifyInbound({ source: 'text', text: '' }).kind).toBe('noop');
      expect(classifyInbound({ source: 'voice' }).submit).toBe(false);
    });

    it('an utterance while an agent awaits a followup correlates to that agent', () => {
      const d = classifyInbound({
        source: 'voice',
        text: 'the 3pm one',
        awaitingAgentId: 'calendar-mutate-agent',
      });
      expect(d.kind).toBe('followup');
      expect(d.correlation).toEqual({ targetAgentId: 'calendar-mutate-agent' });
    });
  });

  describe('modal interactions (UC4 — the input path that was missing)', () => {
    it('a button click becomes a text utterance correlated to the originating agent', () => {
      const d = classifyInbound({
        source: 'modal',
        interaction: { value: 'confirm', label: 'Yes, book it', agentId: 'calendar-mutate-agent' },
      });
      expect(d).toEqual({
        submit: true,
        text: 'confirm',
        kind: 'modal-choice',
        correlation: { targetAgentId: 'calendar-mutate-agent' },
      });
    });

    it('falls back to the human label when there is no machine value', () => {
      const d = classifyInbound({
        source: 'modal',
        interaction: { label: 'Tuesday 3 PM', agentId: 'a1', field: 'slot' },
      });
      expect(d.text).toBe('Tuesday 3 PM');
      expect(d.correlation).toEqual({ targetAgentId: 'a1', field: 'slot' });
    });

    it('carries the field name through for form inputs', () => {
      const d = classifyInbound({
        source: 'modal',
        interaction: { value: 'robb@onereach.com', field: 'email', agentId: 'email-agent' },
      });
      expect(d.correlation.field).toBe('email');
      expect(d.correlation.targetAgentId).toBe('email-agent');
    });

    it('an interaction with neither value nor label is a noop', () => {
      const d = classifyInbound({ source: 'modal', interaction: { agentId: 'a1' } });
      expect(d.submit).toBe(false);
      expect(d.kind).toBe('noop');
    });

    it('a modal choice without an agentId still submits but cannot correlate', () => {
      const d = classifyInbound({ source: 'modal', interaction: { value: 'ok' } });
      expect(d.submit).toBe(true);
      expect(d.correlation.targetAgentId).toBeUndefined();
    });
  });
});

describe('relay-core planOutbound', () => {
  it('daily-brief shape: speaks summary, appends chat, renders a modal (UC1)', () => {
    const plan = planOutbound({
      success: true,
      spokenSummary: 'You have two meetings today.',
      visualText: 'You have two meetings today.',
      html: '<div>day view</div>',
      displayMode: 'modal',
      panelWidth: 480,
      panelHeight: 600,
      agentId: 'daily-brief-agent',
    });
    expect(plan.speak).toEqual({ text: 'You have two meetings today.' });
    expect(plan.chat.role).toBe('assistant');
    expect(plan.chat.cardHtml).toBeNull(); // modal card does not ride inline in chat
    expect(plan.modal).toEqual({
      html: '<div>day view</div>',
      width: 480,
      height: 600,
      agentId: 'daily-brief-agent',
    });
    expect(plan.listenAfter).toBe(false);
  });

  it('voice off: no speak channel, chat still updates (UC2)', () => {
    const plan = planOutbound(
      { success: true, spokenSummary: 'It is 3 PM.', visualText: 'It is 3 PM.' },
      { voiceMode: false }
    );
    expect(plan.speak).toBeNull();
    expect(plan.chat.text).toBe('It is 3 PM.');
  });

  it('inline result: card rides in the chat, no modal window', () => {
    const plan = planOutbound({
      success: true,
      visualText: 'Here are your tickets',
      html: '<ul>...</ul>',
      displayMode: 'inline',
    });
    expect(plan.modal).toBeNull();
    expect(plan.chat.cardHtml).toBe('<ul>...</ul>');
  });

  it('followup: prompt drives speak + chat and re-opens the mic (UC3)', () => {
    const plan = planOutbound({
      success: true,
      needsInput: { agentId: 'calendar-mutate-agent', prompt: 'Which calendar?' },
    });
    expect(plan.speak).toEqual({ text: 'Which calendar?' });
    expect(plan.chat.text).toBe('Which calendar?');
    expect(plan.listenAfter).toBe(true);
  });

  it('followup with voice off still shows the prompt in chat and re-opens input', () => {
    const plan = planOutbound(
      { success: true, needsInput: { agentId: 'a1', prompt: 'Which one?' } },
      { voiceMode: false }
    );
    expect(plan.speak).toBeNull();
    expect(plan.chat.text).toBe('Which one?');
    expect(plan.listenAfter).toBe(true);
  });

  it('falls back to message when spoken/visual summaries are absent', () => {
    const plan = planOutbound({ success: true, message: 'Done!' });
    expect(plan.speak).toEqual({ text: 'Done!' });
    expect(plan.chat.text).toBe('Done!');
  });

  it('empty result produces no channels and no listen', () => {
    const plan = planOutbound({ success: true });
    expect(plan.speak).toBeNull();
    expect(plan.chat).toBeNull();
    expect(plan.modal).toBeNull();
    expect(plan.listenAfter).toBe(false);
  });

  it('a modal followup carries the agentId onto the modal channel for correlation', () => {
    const plan = planOutbound({
      success: true,
      needsInput: { agentId: 'email-agent', prompt: 'Pick a recipient' },
      html: '<form>...</form>',
      displayMode: 'modal',
      panelWidth: 420,
    });
    expect(plan.modal.agentId).toBe('email-agent');
    expect(plan.listenAfter).toBe(true);
  });
});

describe('relay-core buildModalSubmit (UC4 wiring — modal click -> submitTask)', () => {
  it('produces the exact submitTask args that route back to the originating agent', () => {
    const s = buildModalSubmit({ value: 'confirm', label: 'Yes', agentId: 'calendar-mutate-agent' });
    expect(s.submit).toBe(true);
    expect(s.text).toBe('confirm');
    expect(s.options).toEqual({
      toolId: 'agent-ui-modal',
      skipFilter: true,
      metadata: {
        targetAgentId: 'calendar-mutate-agent',
        field: undefined,
        inputModality: 'modal',
      },
    });
  });

  it('carries a form field name into the routing metadata', () => {
    const s = buildModalSubmit({ value: 'robb@onereach.com', field: 'email', agentId: 'email-agent' });
    expect(s.options.metadata.field).toBe('email');
    expect(s.options.metadata.targetAgentId).toBe('email-agent');
  });

  it('an empty interaction does not submit (no options)', () => {
    const s = buildModalSubmit({ agentId: 'a1' });
    expect(s.submit).toBe(false);
    expect(s.options).toBeNull();
  });

  it('is null-safe against a missing payload', () => {
    expect(buildModalSubmit(undefined).submit).toBe(false);
  });
});

describe('relay-core shouldSurfaceNeedsInput (UC5 — proactive prompts)', () => {
  it('surfaces an orb-owned followup', () => {
    expect(shouldSurfaceNeedsInput({ toolId: 'orb', agentId: 'a1' })).toBe(true);
  });

  it('surfaces a request with no toolId', () => {
    expect(shouldSurfaceNeedsInput({ agentId: 'a1', prompt: 'Which one?' })).toBe(true);
  });

  it('surfaces a proactive/background agent needing a decision (the UC5 win)', () => {
    // A meeting-monitor agent the user never invoked asks a question.
    expect(shouldSurfaceNeedsInput({ toolId: 'meeting-monitor', proactive: true })).toBe(true);
    // Even without the explicit flag, a non-self-handling tool is surfaced.
    expect(shouldSurfaceNeedsInput({ toolId: 'meeting-monitor-agent' })).toBe(true);
  });

  it('defers to a self-prompting interactive surface (no double-prompt)', () => {
    expect(shouldSurfaceNeedsInput({ toolId: 'command-hud' })).toBe(false);
  });

  it('a proactive request from a self-handling tool is still surfaced (proactive wins)', () => {
    expect(shouldSurfaceNeedsInput({ toolId: 'command-hud', proactive: true })).toBe(true);
  });

  it('honors a custom self-handling set', () => {
    expect(
      shouldSurfaceNeedsInput({ toolId: 'agent-ui-modal' }, { selfHandlingTools: ['agent-ui-modal'] })
    ).toBe(false);
  });

  it('is null-safe', () => {
    expect(shouldSurfaceNeedsInput(null)).toBe(false);
  });
});
