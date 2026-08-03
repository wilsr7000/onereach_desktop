/**
 * result-quality -- "resolved success" is the only success that counts
 *
 * Regression for the alarm-request cache poisoning: app-agent settled with
 * success:true + needsInput ("what app should I open?") and the exchange
 * recorded reputation 1.0 AND cached the route (alarm -> app-agent conf=0.85),
 * so future alarm requests would skip the auction entirely. A clarifying
 * question is not a completed outcome.
 */

import { describe, it, expect } from 'vitest';

const { isResolvedSuccess } = require('../../lib/exchange/result-quality.js');

describe('isResolvedSuccess', () => {
  it('true for a plain completed success', () => {
    expect(isResolvedSuccess({ success: true, message: '3 meetings today' })).toBe(true);
  });

  it('true when success is undefined but nothing is unresolved (legacy agents)', () => {
    expect(isResolvedSuccess({ message: 'done' })).toBe(true);
  });

  it('false for explicit failure', () => {
    expect(isResolvedSuccess({ success: false, error: 'boom' })).toBe(false);
  });

  it('false for a needsInput settle — THE cache-poisoning case', () => {
    expect(
      isResolvedSuccess({
        success: true,
        needsInput: { prompt: "I couldn't find that app. What would you like me to open?" },
      })
    ).toBe(false);
  });

  it('false for needsClarification', () => {
    expect(isResolvedSuccess({ success: true, needsClarification: true, message: 'Did you mean…?' })).toBe(false);
  });

  it('false for null/undefined/non-object', () => {
    expect(isResolvedSuccess(null)).toBe(false);
    expect(isResolvedSuccess(undefined)).toBe(false);
    expect(isResolvedSuccess('ok')).toBe(false);
  });
});
