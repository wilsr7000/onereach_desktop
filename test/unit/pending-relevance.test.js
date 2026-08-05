/**
 * pending-relevance -- answers route to the pending agent; commands never get
 * hijacked. Replays both live incidents.
 */
import { describe, it, expect } from 'vitest';
const { isAnswerToPending } = require('../../lib/exchange/pending-relevance.js');

describe('option-less pendings (yes/no consents)', () => {
  it('"What\'s the weather today?" is a COMMAND, not an answer (2026-08-05 live)', () => {
    expect(isAnswerToPending({ text: "What's the weather today?" }).route).toBe(false);
  });
  it('affirmatives route: yes / build it / go ahead / not now', () => {
    for (const t of ['yes', 'Yes, build it', 'go ahead', 'not now']) {
      expect(isAnswerToPending({ text: t }).route).toBe(true);
    }
  });
  it('short replies route ("the morning one")', () => {
    expect(isAnswerToPending({ text: 'the morning one' }).route).toBe(true);
  });
  it('long sentences are commands', () => {
    expect(isAnswerToPending({ text: 'Can you set an alarm for six thirty tomorrow morning' }).route).toBe(false);
  });
  it('questions are commands even when short', () => {
    expect(isAnswerToPending({ text: 'What time is it?' }).route).toBe(false);
  });
});

describe('options-bearing pendings', () => {
  const options = ['Prep me for the next meeting', 'Show my focus window'];
  it('"set an alarm for 6:32" does not match prep options (2026-08-04 live)', () => {
    expect(isAnswerToPending({ text: 'Can you set an alarm for 6:32', options }).route).toBe(false);
  });
  it('overlapping words route ("the prep one")', () => {
    expect(isAnswerToPending({ text: 'do the prep one', options }).route).toBe(true);
  });
  it('affirmatives still route with options present', () => {
    expect(isAnswerToPending({ text: 'yes', options }).route).toBe(true);
  });
});
