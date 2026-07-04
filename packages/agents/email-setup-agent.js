/**
 * Email Setup Agent
 *
 * A guided in-chat wizard that connects an IMAP email account: email ->
 * provider (auto-inferred for common domains) -> app-password -> a LIVE IMAP
 * connection test -> stored in Keychain. Built on the multi-turn needsInput
 * relay (each answer routes back to this agent with the accumulated state) and
 * the modal renderer (provider picked from a modal select).
 *
 * The branching lives in lib/email-setup-flow.js (pure + tested); this agent is
 * the thin wrapper that threads state across turns and calls the email service
 * only at the final 'connect' step.
 */

'use strict';

const BaseAgent = require('./base-agent');
const flow = require('../../lib/email-setup-flow');

// Test seam: override the email service so the connect step can be tested
// without real IMAP. Defaults to the real singleton.
let _serviceOverride = null;
function _emailService() {
  if (_serviceOverride) return _serviceOverride;
  return require('../../lib/email-service').getEmailService();
}
function _presets() {
  try {
    return require('../../lib/email-service').PROVIDER_PRESETS;
  } catch (_e) {
    return {};
  }
}

const CONNECTED_STATES = new Set(['connected', 'idle', 'authenticated', 'ready']);

function askNext(plan, state) {
  const needsInput = {
    agentId: 'email-setup-agent',
    prompt: plan.prompt,
    field: plan.field,
    // Thread the accumulated state + which field we asked, so the follow-up
    // turn can fold the answer into the right slot.
    context: { emailSetup: state, emailSetupField: plan.field },
  };
  const result = { success: true, needsInput, message: plan.prompt };

  if (plan.step === 'ask-provider') {
    // A one-click modal select beats typing "gmail".
    needsInput.options = plan.options;
    result.ui = { type: 'select', title: plan.prompt, options: plan.options };
    result.displayMode = 'modal';
    result.panelWidth = 420;
  }
  if (plan.step === 'ask-password' && plan.setupUrl) {
    const withLink = `${plan.prompt}\n\nGet an app password here: ${plan.setupUrl}`;
    needsInput.prompt = withLink;
    result.message = withLink;
  }
  return result;
}

function retryPassword(state, reason) {
  const s = { ...state };
  delete s.password;
  const prompt = `${reason} Double-check the app password (not your login password) and paste it again.`;
  return {
    success: true,
    message: prompt,
    needsInput: {
      agentId: 'email-setup-agent',
      prompt,
      field: 'password',
      context: { emailSetup: s, emailSetupField: 'password' },
    },
  };
}

/**
 * Pure-ish step driver, exported for tests. Given the task context, returns the
 * next agent result. `deps.service` lets tests inject a fake email service.
 */
async function runStep(task, deps = {}) {
  const presets = deps.presets || _presets();
  const ctx = (task && task.context) || {};
  let state = { ...(ctx.emailSetup || {}) };
  const answer = String(ctx.userInput || task.content || task.text || task.query || '').trim();
  const isFollowup = ctx.userInput != null;

  if (isFollowup && ctx.emailSetupField) {
    // Fold the user's answer into the field we last asked for.
    state = flow.applyInput(state, ctx.emailSetupField, answer);
  } else if (!isFollowup && answer) {
    // First turn: if the opening request already contains an email, seed it so
    // we skip a question ("connect my email robb@gmail.com").
    const m = answer.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (m) state = flow.applyInput(state, 'email', m[0]);
  }

  const plan = flow.planEmailSetup(state, presets);

  if (plan.step !== 'connect') {
    return askNext(plan, state);
  }

  // Final step: create the account + run a LIVE IMAP connection test.
  const service = deps.service || _emailService();
  try {
    const cfg = await service.addAccount({
      email: state.email,
      provider: state.provider,
      password: state.password,
    });
    const res = await service.connectAccount(cfg.id);
    const st = res && res.state;
    if (st && CONNECTED_STATES.has(st)) {
      return {
        success: true,
        message: `Connected ${state.email}. I'll include your email in your daily brief from now on.`,
        data: { emailConnected: true, accountId: cfg.id, email: state.email, provider: state.provider },
      };
    }
    return retryPassword(state, `That didn't authenticate${st ? ` (state: ${st})` : ''}.`);
  } catch (err) {
    return retryPassword(state, `I couldn't connect: ${err.message}.`);
  }
}

module.exports = BaseAgent.create({
  id: 'email-setup-agent',
  name: 'Email Setup',
  description:
    'Connects an email account (Gmail, Outlook, Yahoo, iCloud) by walking the user through email, provider, and an app password, then testing the IMAP connection. Use when email is not yet connected or the user wants to add/connect/set up an email account.',
  voice: 'sage',
  acks: ["Let's get your email connected.", 'Setting up email.'],
  categories: ['email', 'setup', 'system'],
  keywords: [
    'connect email',
    'set up email',
    'setup email',
    'add email',
    'add email account',
    'link email',
    'connect my email',
    'connect gmail',
    'connect outlook',
    'email setup',
    'email account',
    'no email account',
  ],
  executionType: 'action',
  estimatedExecutionMs: 4000,
  multiTurn: true,
  memoryConfig: { displayName: 'Email Setup' },

  prompt: `Email Setup connects a user's email account so other features (daily brief, email triage) can read it.

Use this agent when:
- The user asks to connect / set up / add / link an email account
- Email is not yet connected and the user wants to fix that

Do NOT use this agent to read, send, search, or triage email -- those are the email-agent's job. This agent ONLY handles first-time connection/setup.

It walks the user through: email address -> provider (auto-detected for common domains) -> app password -> a live IMAP test.`,

  async onExecute(task) {
    return runStep(task);
  },

  // Test seams
  _runStep: runStep,
  _setEmailService(fn) {
    _serviceOverride = fn;
  },
  _resetEmailService() {
    _serviceOverride = null;
  },
});
