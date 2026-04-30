/**
 * Stakes Classifier - Unit Tests
 *
 * Verifies the resolution order (agent-declared > pattern > default)
 * and the main regex families. Tests are authored as "what a user
 * might actually say" so a regression reads as a UX issue, not a
 * regex debugging puzzle.
 *
 * Run:  npx vitest run test/unit/stakes-classifier.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  classifyStakes,
  getPatterns,
  STAKES,
} = require('../../lib/naturalness/stakes-classifier');

// Convenience helper -- just content -> stakes.
const fromContent = (content) => classifyStakes({ task: { content } });

describe('stakes-classifier', () => {
  describe('agent-declared stakes wins', () => {
    it('respects agent.stakes=high even when content looks benign', () => {
      const r = classifyStakes({
        task: { content: 'play jazz' },
        agent: { id: 'dj-agent', stakes: STAKES.HIGH },
      });
      expect(r).toBe(STAKES.HIGH);
    });

    it('respects agent.stakes=low even when content looks destructive', () => {
      const r = classifyStakes({
        task: { content: 'delete all the things' },
        agent: { stakes: STAKES.LOW },
      });
      expect(r).toBe(STAKES.LOW);
    });

    it('ignores invalid agent.stakes values and falls through to heuristics', () => {
      const r = classifyStakes({
        task: { content: 'delete all my emails' },
        agent: { stakes: 'nuclear' },
      });
      expect(r).toBe(STAKES.HIGH);
    });
  });

  describe('high-stakes patterns', () => {
    it('flags bulk deletion', () => {
      expect(fromContent('delete all my emails')).toBe(STAKES.HIGH);
      expect(fromContent('remove everything from my calendar')).toBe(STAKES.HIGH);
      expect(fromContent('erase all my notes')).toBe(STAKES.HIGH);
      expect(fromContent('clear all notifications')).toBe(STAKES.HIGH);
    });

    it('flags money movement verbs', () => {
      expect(fromContent('purchase the premium plan')).toBe(STAKES.HIGH);
      expect(fromContent('buy the book on amazon')).toBe(STAKES.HIGH);
      expect(fromContent('pay my rent')).toBe(STAKES.HIGH);
      expect(fromContent('transfer 500 dollars to savings')).toBe(STAKES.HIGH);
    });

    it('flags broadcast sends', () => {
      expect(fromContent('email everyone about the meeting')).toBe(STAKES.HIGH);
      expect(fromContent('text the team that I\'m running late')).toBe(STAKES.HIGH);
      expect(fromContent('send a message to all contacts')).toBe(STAKES.HIGH);
    });

    it('flags public posts', () => {
      expect(fromContent('tweet this publicly')).toBe(STAKES.HIGH);
      expect(fromContent('share to twitter')).toBe(STAKES.HIGH);
      expect(fromContent('post publicly to linkedin')).toBe(STAKES.HIGH);
    });

    it('flags subscription cancellation and unsubscribe', () => {
      expect(fromContent('cancel my netflix subscription')).toBe(STAKES.HIGH);
      expect(fromContent('unsubscribe me from this list')).toBe(STAKES.HIGH);
    });

    it('flags unrecoverable verbs', () => {
      expect(fromContent('wipe my drive')).toBe(STAKES.HIGH);
      expect(fromContent('factory reset this device')).toBe(STAKES.HIGH);
    });
  });

  describe('medium-stakes patterns', () => {
    it('flags calendar creation', () => {
      expect(fromContent('schedule a meeting tomorrow at 3')).toBe(STAKES.MEDIUM);
      expect(fromContent('book an appointment with Alice')).toBe(STAKES.MEDIUM);
      expect(fromContent('add an event to my calendar')).toBe(STAKES.MEDIUM);
    });

    it('flags single-recipient sends', () => {
      expect(fromContent('send alice a quick update')).toBe(STAKES.MEDIUM);
      expect(fromContent('email bob the spec')).toBe(STAKES.MEDIUM);
      expect(fromContent('text mom happy birthday')).toBe(STAKES.MEDIUM);
    });

    it('flags targeted deletions', () => {
      expect(fromContent('delete this note')).toBe(STAKES.MEDIUM);
      expect(fromContent('cancel the 3pm meeting')).toBe(STAKES.MEDIUM);
      expect(fromContent('remove that reminder')).toBe(STAKES.MEDIUM);
    });

    it('flags persistent artefacts', () => {
      expect(fromContent('record the meeting')).toBe(STAKES.MEDIUM);
      expect(fromContent('save the transcript')).toBe(STAKES.MEDIUM);
      expect(fromContent('export my notes to markdown')).toBe(STAKES.MEDIUM);
    });

    it('flags launching flows / automations', () => {
      expect(fromContent('run the morning flow')).toBe(STAKES.MEDIUM);
      expect(fromContent('launch the browser automation')).toBe(STAKES.MEDIUM);
      expect(fromContent('start the playbook')).toBe(STAKES.MEDIUM);
    });

    it('flags settings changes', () => {
      expect(fromContent('change my default voice')).toBe(STAKES.MEDIUM);
      expect(fromContent('update my password')).toBe(STAKES.MEDIUM);
      expect(fromContent('set the default timezone')).toBe(STAKES.MEDIUM);
    });
  });

  describe('low-stakes defaults', () => {
    it('returns low for informational reads', () => {
      expect(fromContent('what time is it')).toBe(STAKES.LOW);
      expect(fromContent('tell me the weather')).toBe(STAKES.LOW);
      expect(fromContent('what is on my calendar today')).toBe(STAKES.LOW);
    });

    it('returns low for reversible media controls', () => {
      expect(fromContent('play some jazz')).toBe(STAKES.LOW);
      expect(fromContent('pause the music')).toBe(STAKES.LOW);
      expect(fromContent('skip this track')).toBe(STAKES.LOW);
    });

    it('returns low for empty or missing content', () => {
      expect(classifyStakes({})).toBe(STAKES.LOW);
      expect(classifyStakes({ task: {} })).toBe(STAKES.LOW);
      expect(classifyStakes({ task: { content: '' } })).toBe(STAKES.LOW);
    });
  });

  describe('reads action and params as fallback content', () => {
    it('inspects task.action string when content is empty', () => {
      const r = classifyStakes({
        task: { content: '', action: 'email.delete.all' },
      });
      expect(r).toBe(STAKES.HIGH);
    });

    it('inspects string values in task.params', () => {
      const r = classifyStakes({
        task: { content: 'do it', params: { verb: 'purchase', target: 'item' } },
      });
      expect(r).toBe(STAKES.HIGH);
    });

    it('ignores non-string params silently', () => {
      const r = classifyStakes({
        task: { content: 'do it', params: { nested: { verb: 'purchase' } } },
      });
      expect(r).toBe(STAKES.LOW);
    });
  });

  describe('getPatterns', () => {
    it('exposes high and medium pattern lists', () => {
      const p = getPatterns();
      expect(Array.isArray(p.high)).toBe(true);
      expect(Array.isArray(p.medium)).toBe(true);
      expect(p.high.length).toBeGreaterThan(0);
      expect(p.medium.length).toBeGreaterThan(0);
    });
  });

  describe('high wins over medium on ties', () => {
    it('"delete all my notes" is HIGH even though "delete" also matches a medium pattern', () => {
      expect(fromContent('delete all my notes')).toBe(STAKES.HIGH);
    });
  });
});
