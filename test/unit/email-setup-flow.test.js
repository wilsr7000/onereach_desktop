/**
 * Email setup flow — the pure wizard step-machine.
 * See lib/email-setup-flow.js. Run: npx vitest run test/unit/email-setup-flow.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  isValidEmail,
  inferProvider,
  normalizeProvider,
  applyInput,
  planEmailSetup,
} = require('../../lib/email-setup-flow');

const PRESETS = {
  gmail: { setupUrl: 'https://myaccount.google.com/apppasswords', setupNote: 'Generate an App Password (requires 2-Step Verification).' },
  outlook: { setupUrl: 'https://account.live.com/proofs', setupNote: 'Create an App Password.' },
};

describe('email validation + provider inference', () => {
  it('validates emails', () => {
    expect(isValidEmail('robb@onereach.com')).toBe(true);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  it('infers provider from common domains', () => {
    expect(inferProvider('x@gmail.com')).toBe('gmail');
    expect(inferProvider('x@hotmail.com')).toBe('outlook');
    expect(inferProvider('x@yahoo.com')).toBe('yahoo');
    expect(inferProvider('x@icloud.com')).toBe('icloud');
    expect(inferProvider('x@onereach.com')).toBeNull(); // custom domain -> ask
  });

  it('normalizes free-text provider answers', () => {
    expect(normalizeProvider('Gmail')).toBe('gmail');
    expect(normalizeProvider("it's google")).toBe('gmail');
    expect(normalizeProvider('microsoft')).toBe('outlook');
    expect(normalizeProvider('Yahoo!')).toBe('yahoo');
    expect(normalizeProvider('apple')).toBe('icloud');
    expect(normalizeProvider('carrier pigeon')).toBeNull();
  });
});

describe('applyInput folds answers, ignores invalid', () => {
  it('email: stores + auto-infers provider', () => {
    const s = applyInput({}, 'email', 'ROBB@Gmail.com');
    expect(s.email).toBe('robb@gmail.com');
    expect(s.provider).toBe('gmail');
  });

  it('email on a custom domain does not set provider', () => {
    const s = applyInput({}, 'email', 'robb@onereach.com');
    expect(s.email).toBe('robb@onereach.com');
    expect(s.provider).toBeUndefined();
  });

  it('invalid email is ignored (no advance)', () => {
    expect(applyInput({}, 'email', 'not-an-email').email).toBeUndefined();
  });

  it('provider + password fold in; short password ignored', () => {
    expect(applyInput({}, 'provider', 'outlook').provider).toBe('outlook');
    expect(applyInput({}, 'password', 'abcd1234efgh').password).toBe('abcd1234efgh');
    expect(applyInput({}, 'password', 'ab').password).toBeUndefined();
  });
});

describe('planEmailSetup step machine', () => {
  it('empty -> ask-email', () => {
    expect(planEmailSetup({}, PRESETS)).toMatchObject({ step: 'ask-email', field: 'email' });
  });

  it('custom-domain email -> ask-provider with options', () => {
    const plan = planEmailSetup({ email: 'robb@onereach.com' }, PRESETS);
    expect(plan.step).toBe('ask-provider');
    expect(plan.options.map((o) => o.value)).toEqual(['gmail', 'outlook', 'yahoo', 'icloud']);
  });

  it('email+provider -> ask-password with setup url/note', () => {
    const plan = planEmailSetup({ email: 'x@gmail.com', provider: 'gmail' }, PRESETS);
    expect(plan.step).toBe('ask-password');
    expect(plan.setupUrl).toBe('https://myaccount.google.com/apppasswords');
    expect(plan.prompt).toMatch(/App Password/);
  });

  it('all fields -> connect', () => {
    const plan = planEmailSetup({ email: 'x@gmail.com', provider: 'gmail', password: 'app-pass-1234' }, PRESETS);
    expect(plan).toMatchObject({ step: 'connect', provider: 'gmail', email: 'x@gmail.com' });
  });

  it('a full gmail run reaches connect in two answers (provider auto-inferred)', () => {
    let s = {};
    // turn 1: ask email
    expect(planEmailSetup(s, PRESETS).field).toBe('email');
    s = applyInput(s, 'email', 'robb@gmail.com'); // provider auto-set
    // turn 2: skips provider, asks password
    expect(planEmailSetup(s, PRESETS).field).toBe('password');
    s = applyInput(s, 'password', 'abcd efgh ijkl mnop'.replace(/ /g, ''));
    // turn 3: connect
    expect(planEmailSetup(s, PRESETS).step).toBe('connect');
  });

  it('a custom-domain run needs the provider question', () => {
    let s = applyInput({}, 'email', 'robb@onereach.com');
    expect(planEmailSetup(s, PRESETS).field).toBe('provider');
    s = applyInput(s, 'provider', 'gmail');
    expect(planEmailSetup(s, PRESETS).field).toBe('password');
  });
});
