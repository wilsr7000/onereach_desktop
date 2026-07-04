/**
 * Email setup flow — the pure step-machine behind the email connect wizard.
 *
 * The email-setup-agent walks the user through connecting an IMAP account in
 * chat (email -> provider -> app-password -> live IMAP test). All the branching
 * lives here as pure functions so it's testable without the agent, the email
 * service, or Electron. The agent threads the accumulated `state` through
 * needsInput.context between turns and calls the email service only at the
 * final 'connect' step.
 */

'use strict';

// Domain -> provider preset key. Common consumer domains auto-resolve so the
// user never has to pick a provider for them.
const PROVIDER_DOMAINS = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'yahoo.com': 'yahoo',
  'yahoo.co.uk': 'yahoo',
  'ymail.com': 'yahoo',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
};

const PROVIDER_LABELS = { gmail: 'Gmail', outlook: 'Outlook', yahoo: 'Yahoo', icloud: 'iCloud' };
const KNOWN_PROVIDERS = Object.keys(PROVIDER_LABELS);

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function inferProvider(email) {
  if (!isValidEmail(email)) return null;
  const domain = email.trim().toLowerCase().split('@')[1];
  return PROVIDER_DOMAINS[domain] || null;
}

// Map free-text ("it's gmail", "microsoft") to a preset key.
function normalizeProvider(input) {
  const s = String(input || '').trim().toLowerCase();
  if (KNOWN_PROVIDERS.includes(s)) return s;
  if (/gmail|google/.test(s)) return 'gmail';
  if (/outlook|hotmail|office|microsoft|\blive\b|msn/.test(s)) return 'outlook';
  if (/yahoo|ymail/.test(s)) return 'yahoo';
  if (/icloud|apple|\bme\.com\b|mac\.com/.test(s)) return 'icloud';
  return null;
}

/**
 * Fold a user's answer for `field` into the accumulated state. Invalid answers
 * are ignored (the planner will simply re-ask), so the caller never advances on
 * bad input.
 * @param {object} state  { email?, provider?, password? }
 * @param {string} field  'email' | 'provider' | 'password'
 * @param {string} value  the user's raw answer
 */
function applyInput(state, field, value) {
  const next = { ...(state || {}) };
  const v = String(value == null ? '' : value).trim();
  if (field === 'email') {
    if (isValidEmail(v)) {
      next.email = v.toLowerCase();
      const inferred = inferProvider(next.email);
      if (inferred) next.provider = inferred; // skip the provider question
    }
  } else if (field === 'provider') {
    const p = normalizeProvider(v);
    if (p) next.provider = p;
  } else if (field === 'password') {
    if (v.length >= 4) next.password = v; // app passwords are 16 chars; 4 is a sane floor
  }
  return next;
}

/**
 * Decide the next wizard step from the accumulated state.
 * @param {object} state    { email?, provider?, password? }
 * @param {object} [presets] PROVIDER_PRESETS (for setupUrl/setupNote); optional
 * @returns {{ step, field?, prompt?, options?, provider?, email?, setupUrl?, setupNote? }}
 */
function planEmailSetup(state, presets) {
  const s = state || {};
  if (!s.email) {
    return {
      step: 'ask-email',
      field: 'email',
      prompt: 'What email address would you like to connect?',
    };
  }
  if (!s.provider) {
    return {
      step: 'ask-provider',
      field: 'provider',
      prompt: `Which provider hosts ${s.email} — Gmail, Outlook, Yahoo, or iCloud?`,
      options: KNOWN_PROVIDERS.map((p) => ({ label: PROVIDER_LABELS[p], value: p })),
    };
  }
  if (!s.password) {
    const preset = presets && presets[s.provider];
    const note = (preset && preset.setupNote) || 'Create an app password for your account.';
    return {
      step: 'ask-password',
      field: 'password',
      provider: s.provider,
      setupUrl: preset && preset.setupUrl,
      setupNote: note,
      prompt: `Almost there. ${note} Then paste the app password here.`,
    };
  }
  return { step: 'connect', provider: s.provider, email: s.email };
}

module.exports = {
  isValidEmail,
  inferProvider,
  normalizeProvider,
  applyInput,
  planEmailSetup,
  PROVIDER_LABELS,
  KNOWN_PROVIDERS,
};
