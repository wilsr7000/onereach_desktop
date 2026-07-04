/**
 * Email Setup Agent — the guided connect wizard's turn logic.
 * The pure branching is covered in email-setup-flow.test.js; this pins the
 * agent's state-threading across turns and the connect/retry outcomes with a
 * fake email service (no real IMAP).
 *
 * Run: npx vitest run test/unit/email-setup-agent.test.js
 */

import { describe, it, expect } from 'vitest';

const agent = require('../../packages/agents/email-setup-agent');

// Fake email service injected via the agent's test seam / deps.
function fakeService({ connectState = 'connected', throwOn } = {}) {
  return {
    addAccount: async (cfg) => ({ id: 'acct-1', ...cfg }),
    connectAccount: async () => {
      if (throwOn) throw new Error(throwOn);
      return { accountId: 'acct-1', state: connectState };
    },
  };
}

describe('email-setup-agent is a valid agent', () => {
  it('exposes the built-in agent contract', () => {
    expect(agent.id).toBe('email-setup-agent');
    expect(typeof agent.execute).toBe('function');
    expect(agent.multiTurn).toBe(true);
  });
});

describe('wizard turns thread state forward', () => {
  it('turn 1 asks for the email address', async () => {
    const r = await agent._runStep({ content: 'set up email' });
    expect(r.needsInput.field).toBe('email');
    expect(r.needsInput.agentId).toBe('email-setup-agent');
  });

  it('seeds the email if the opening request already contains one (skips a step)', async () => {
    const r = await agent._runStep({ content: 'connect my email robb@gmail.com' });
    // gmail -> provider auto-inferred -> next question is the password
    expect(r.needsInput.field).toBe('password');
    expect(r.needsInput.context.emailSetup).toMatchObject({ email: 'robb@gmail.com', provider: 'gmail' });
  });

  it('a custom-domain email asks provider via a modal select', async () => {
    const r = await agent._runStep({
      context: { emailSetup: {}, emailSetupField: 'email', userInput: 'robb@onereach.com' },
    });
    expect(r.needsInput.field).toBe('provider');
    expect(r.displayMode).toBe('modal');
    expect(r.ui.type).toBe('select');
    expect(r.ui.options.map((o) => o.value)).toEqual(['gmail', 'outlook', 'yahoo', 'icloud']);
  });

  it('the password step carries the accumulated state and (for known providers) a setup link', async () => {
    const r = await agent._runStep({
      context: { emailSetup: { email: 'robb@onereach.com' }, emailSetupField: 'provider', userInput: 'gmail' },
    });
    expect(r.needsInput.field).toBe('password');
    expect(r.needsInput.context.emailSetup).toMatchObject({ email: 'robb@onereach.com', provider: 'gmail' });
    expect(r.message).toMatch(/https?:\/\//); // app-password link
  });
});

describe('connect step tests the live IMAP connection', () => {
  const connectTask = {
    context: {
      emailSetup: { email: 'robb@gmail.com', provider: 'gmail' },
      emailSetupField: 'password',
      userInput: 'abcd efgh ijkl mnop',
    },
  };

  it('a successful IMAP connect reports connected + emits emailConnected data', async () => {
    const r = await agent._runStep(connectTask, { service: fakeService({ connectState: 'connected' }) });
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/Connected robb@gmail\.com/);
    expect(r.data).toMatchObject({ emailConnected: true, email: 'robb@gmail.com', provider: 'gmail' });
    expect(r.needsInput).toBeUndefined(); // done, not another turn
  });

  it('a bad auth (connect throws) re-asks for the password, keeping email/provider', async () => {
    const r = await agent._runStep(connectTask, { service: fakeService({ throwOn: 'AUTHENTICATIONFAILED' }) });
    expect(r.needsInput.field).toBe('password');
    expect(r.needsInput.context.emailSetup).toMatchObject({ email: 'robb@gmail.com', provider: 'gmail' });
    expect(r.needsInput.context.emailSetup.password).toBeUndefined(); // cleared for retry
    expect(r.message).toMatch(/couldn't connect/i);
  });

  it('a non-connected state also re-asks the password', async () => {
    const r = await agent._runStep(connectTask, { service: fakeService({ connectState: 'error' }) });
    expect(r.needsInput.field).toBe('password');
    expect(r.message).toMatch(/authenticate/i);
  });
});
