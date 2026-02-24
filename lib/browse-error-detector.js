'use strict';

const CAPTCHA_MARKERS = [
  { type: 'selector', value: 'iframe[src*="recaptcha"]' },
  { type: 'selector', value: 'iframe[src*="hcaptcha"]' },
  { type: 'selector', value: 'iframe[src*="challenges.cloudflare.com"]' },
  { type: 'selector', value: '#turnstile-wrapper' },
  { type: 'selector', value: '.g-recaptcha' },
  { type: 'selector', value: '.h-captcha' },
  { type: 'selector', value: '[data-sitekey]' },
  { type: 'text', value: 'verify you are human' },
  { type: 'text', value: 'verify you\'re human' },
  { type: 'text', value: 'complete the security check' },
  { type: 'text', value: 'captcha' },
];

const AUTH_WALL_MARKERS = [
  { type: 'selector', value: 'form[action*="login"]' },
  { type: 'selector', value: 'form[action*="signin"]' },
  { type: 'selector', value: 'form[action*="sign-in"]' },
  { type: 'selector', value: 'input[type="password"]' },
  { type: 'text', value: 'sign in to continue' },
  { type: 'text', value: 'log in to continue' },
  { type: 'text', value: 'login required' },
  { type: 'text', value: 'please sign in' },
  { type: 'text', value: 'please log in' },
  { type: 'text', value: 'authentication required' },
];

const BOT_BLOCK_MARKERS = [
  { type: 'text', value: 'access denied' },
  { type: 'text', value: 'automated access' },
  { type: 'text', value: 'bot detected' },
  { type: 'text', value: 'unusual traffic' },
  { type: 'text', value: 'are you a robot' },
  { type: 'text', value: 'enable javascript' },
  { type: 'text', value: 'please enable cookies' },
  { type: 'title', value: 'just a moment' }, // Cloudflare challenge page
  { type: 'title', value: 'attention required' },
  { type: 'title', value: 'access denied' },
];

const CONTENT_GATE_MARKERS = [
  { type: 'text', value: 'subscribe to read' },
  { type: 'text', value: 'subscribe to continue' },
  { type: 'text', value: 'premium content' },
  { type: 'text', value: 'create a free account' },
  { type: 'text', value: 'paywall' },
  { type: 'selector', value: '[class*="paywall"]' },
  { type: 'selector', value: '[class*="subscriber"]' },
  { type: 'selector', value: '[data-paywall]' },
];

const MFA_MARKERS = [
  { type: 'selector', value: 'input[autocomplete="one-time-code"]' },
  { type: 'selector', value: 'input[name*="totp"]' },
  { type: 'selector', value: 'input[name*="otp"]' },
  { type: 'selector', value: 'input[name*="mfa"]' },
  { type: 'selector', value: 'input[name*="2fa"]' },
  { type: 'selector', value: 'input[name*="verification_code"]' },
  { type: 'selector', value: 'input[name*="verificationCode"]' },
  { type: 'selector', value: 'input[aria-label*="verification code"]' },
  { type: 'text', value: 'two-factor' },
  { type: 'text', value: 'two factor' },
  { type: 'text', value: '2-step verification' },
  { type: 'text', value: 'enter the code' },
  { type: 'text', value: 'enter verification code' },
  { type: 'text', value: 'authenticator app' },
  { type: 'text', value: 'check your phone' },
  { type: 'text', value: 'security code' },
  { type: 'text', value: 'one-time password' },
  { type: 'text', value: 'verify your identity' },
  { type: 'text', value: 'confirmation code' },
];

const OAUTH_MARKERS = [
  { type: 'selector', value: 'form[action*="oauth"]' },
  { type: 'selector', value: 'form[action*="authorize"]' },
  { type: 'selector', value: 'form[action*="consent"]' },
  { type: 'text', value: 'wants to access your' },
  { type: 'text', value: 'grant access' },
  { type: 'text', value: 'authorize application' },
  { type: 'text', value: 'allow access' },
  { type: 'text', value: 'requesting permission' },
  { type: 'text', value: 'sign in with google' },
  { type: 'text', value: 'sign in with microsoft' },
  { type: 'text', value: 'sign in with github' },
  { type: 'text', value: 'sign in with apple' },
  { type: 'text', value: 'continue with google' },
  { type: 'text', value: 'continue with microsoft' },
  { type: 'text', value: 'continue with github' },
];

const CONSENT_MARKERS = [
  { type: 'selector', value: '[class*="consent"]' },
  { type: 'selector', value: '[class*="cookie-banner"]' },
  { type: 'selector', value: '[id*="cookie-consent"]' },
  { type: 'selector', value: '[id*="onetrust"]' },
  { type: 'selector', value: '[class*="cookie-notice"]' },
  { type: 'text', value: 'accept all cookies' },
  { type: 'text', value: 'accept cookies' },
  { type: 'text', value: 'we use cookies' },
];

const DETECTION_SCRIPT = `
(function() {
  const body = document.body ? document.body.innerText.toLowerCase() : '';
  const title = document.title.toLowerCase();
  const html = document.documentElement.innerHTML.toLowerCase();
  const results = { selectors: {}, textMatches: {}, titleMatches: {}, httpStatus: null };

  function checkSelector(sel) {
    try { return !!document.querySelector(sel); } catch(_) { return false; }
  }

  function checkText(text) {
    return body.includes(text.toLowerCase());
  }

  function checkTitle(text) {
    return title.includes(text.toLowerCase());
  }

  function checkMarkers(markers, key) {
    for (const m of markers) {
      if (m.type === 'selector' && checkSelector(m.value)) {
        results[key] = { detected: true, marker: m.value, method: 'selector' };
        return true;
      }
      if (m.type === 'text' && checkText(m.value)) {
        results[key] = { detected: true, marker: m.value, method: 'text' };
        return true;
      }
      if (m.type === 'title' && checkTitle(m.value)) {
        results[key] = { detected: true, marker: m.value, method: 'title' };
        return true;
      }
    }
    results[key] = { detected: false };
    return false;
  }

  checkMarkers(CAPTCHA_MARKERS_JSON, 'captcha');
  checkMarkers(AUTH_WALL_MARKERS_JSON, 'authWall');
  checkMarkers(MFA_MARKERS_JSON, 'mfa');
  checkMarkers(OAUTH_MARKERS_JSON, 'oauth');
  checkMarkers(BOT_BLOCK_MARKERS_JSON, 'botBlock');
  checkMarkers(CONTENT_GATE_MARKERS_JSON, 'contentGate');
  checkMarkers(CONSENT_MARKERS_JSON, 'consent');

  const contentLen = body.trim().length;
  results.emptyPage = contentLen < 50;
  results.bodyLength = contentLen;
  results.url = window.location.href;
  results.title = document.title;

  return results;
})();
`;

function buildDetectionScript() {
  return DETECTION_SCRIPT
    .replace('CAPTCHA_MARKERS_JSON', JSON.stringify(CAPTCHA_MARKERS))
    .replace('AUTH_WALL_MARKERS_JSON', JSON.stringify(AUTH_WALL_MARKERS))
    .replace('MFA_MARKERS_JSON', JSON.stringify(MFA_MARKERS))
    .replace('OAUTH_MARKERS_JSON', JSON.stringify(OAUTH_MARKERS))
    .replace('BOT_BLOCK_MARKERS_JSON', JSON.stringify(BOT_BLOCK_MARKERS))
    .replace('CONTENT_GATE_MARKERS_JSON', JSON.stringify(CONTENT_GATE_MARKERS))
    .replace('CONSENT_MARKERS_JSON', JSON.stringify(CONSENT_MARKERS));
}

async function detect(webContents) {
  try {
    const result = await webContents.executeJavaScript(buildDetectionScript());
    return classify(result);
  } catch (err) {
    return {
      blocked: false,
      type: 'error',
      error: err.message,
      details: {},
      action: 'continue',
    };
  }
}

function classify(raw) {
  if (raw.captcha && raw.captcha.detected) {
    return {
      blocked: true,
      type: 'captcha',
      details: raw.captcha,
      action: 'promote-hitl',
      message: 'Please solve the CAPTCHA to continue.',
    };
  }

  if (raw.botBlock && raw.botBlock.detected) {
    return {
      blocked: true,
      type: 'bot-block',
      details: raw.botBlock,
      action: 'retry-then-hitl',
      message: 'Bot detection triggered. Retrying with fresh session...',
    };
  }

  if (raw.emptyPage && !raw.consent?.detected) {
    return {
      blocked: true,
      type: 'challenge-page',
      details: { bodyLength: raw.bodyLength },
      action: 'wait-then-hitl',
      message: 'Page appears to be a challenge page. Waiting for resolution...',
    };
  }

  if (raw.mfa && raw.mfa.detected) {
    return {
      blocked: true,
      type: 'mfa',
      details: raw.mfa,
      action: 'promote-hitl',
      message: 'Two-factor authentication required. Please enter the verification code.',
    };
  }

  if (raw.oauth && raw.oauth.detected) {
    return {
      blocked: true,
      type: 'oauth',
      details: raw.oauth,
      action: 'promote-hitl',
      message: 'OAuth authorization required. Please approve access.',
    };
  }

  if (raw.authWall && raw.authWall.detected) {
    return {
      blocked: true,
      type: 'auth-wall',
      details: raw.authWall,
      action: 'promote-hitl',
      message: 'Login required. Please sign in to continue.',
    };
  }

  if (raw.contentGate && raw.contentGate.detected) {
    return {
      blocked: false,
      type: 'content-gate',
      details: raw.contentGate,
      action: 'extract-partial',
      message: 'Content is behind a paywall. Extracting available content.',
    };
  }

  if (raw.consent && raw.consent.detected) {
    return {
      blocked: false,
      type: 'consent',
      details: raw.consent,
      action: 'dismiss-consent',
      message: 'Cookie consent banner detected. Attempting to dismiss.',
    };
  }

  return {
    blocked: false,
    type: 'clear',
    details: {},
    action: 'continue',
  };
}

async function detectHttpStatus(webContents) {
  try {
    const url = webContents.getURL();
    return { url, status: 200 };
  } catch {
    return { url: '', status: 0 };
  }
}

const CONSENT_DISMISS_SCRIPT = `
(function() {
  const selectors = [
    'button[id*="accept"]', 'button[class*="accept"]',
    'button[id*="agree"]', 'button[class*="agree"]',
    'button[data-testid*="accept"]', 'button[data-testid*="agree"]',
    '[class*="consent"] button:first-of-type',
    '[class*="cookie-banner"] button:first-of-type',
    '#onetrust-accept-btn-handler',
    '.cookie-notice__accept',
  ];
  for (const sel of selectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) { btn.click(); return { dismissed: true, selector: sel }; }
    } catch(_) {}
  }
  return { dismissed: false };
})();
`;

async function dismissConsent(webContents) {
  try {
    return await webContents.executeJavaScript(CONSENT_DISMISS_SCRIPT);
  } catch {
    return { dismissed: false, error: 'execution failed' };
  }
}

module.exports = {
  detect,
  classify,
  detectHttpStatus,
  dismissConsent,
  buildDetectionScript,
  CAPTCHA_MARKERS,
  AUTH_WALL_MARKERS,
  MFA_MARKERS,
  OAUTH_MARKERS,
  BOT_BLOCK_MARKERS,
  CONTENT_GATE_MARKERS,
  CONSENT_MARKERS,
};
