'use strict';

// ─── SELECTORS ──────────────────────────────────────────────────────────────────
// Single source of truth for all auth-related CSS selectors.
// Every consumer (browser-renderer, browserWindow, gsx-autologin) imports these.

const SELECTORS = {
  email:
    'input[type="email"], ' +
    'input[type="text"][name*="email" i], input[type="text"][name*="user" i], ' +
    'input[name="email"], input[name="username"], ' +
    'input[autocomplete="email"], input[autocomplete="username"], ' +
    'input[placeholder*="email" i], input[placeholder*="user" i]',

  password: 'input[type="password"]',

  totp:
    'input[name="totp"], input[name="code"], input[name="otp"], ' +
    'input[name="verificationCode"], input[name="twoFactorCode"], ' +
    'input[autocomplete="one-time-code"], ' +
    'input[inputmode="numeric"][maxlength="6"], ' +
    'input[maxlength="6"]:not([type="password"]):not([name*="email"]):not([name*="user"]), ' +
    'input[placeholder*="code" i], input[placeholder*="2fa" i], ' +
    'input[placeholder*="authenticator" i], ' +
    'input[type="text"][maxlength="6"], input[type="number"][maxlength="6"]',

  submit:
    'button[type="submit"], input[type="submit"], ' +
    'button.submit, button.login, button.signin',

  error: '.error, .alert-error, [class*="error-message"]',

  accountSelect:
    'a[href*="accountId"], [data-account-id], [data-account], ' +
    '.account-item, .account-card, .account-option',

  accountClickable:
    'a, button, [role="button"], [onclick], ' +
    'li[class*="account"], div[class*="account"], ' +
    '.account-item, .account-card, .account-option',

  authContent:
    '.chat-interface, [class*="message"], [class*="chat"], ' +
    'iframe[src*="chat"], [id*="onereach"], [class*="onereach"]',
};

const TWO_FA_TEXT_HINTS = [
  'two-factor', '2fa', 'verification code', 'authenticator',
  'enter the code', '6-digit', 'security code', 'authentication code',
];

const SUBMIT_FALLBACK_TEXTS = ['sign in', 'log in', 'login', 'submit', 'continue'];
const TOTP_SUBMIT_FALLBACK_TEXTS = ['verify', 'confirm', 'submit', 'continue'];

// ─── INTERNAL CODE-GENERATION HELPERS ───────────────────────────────────────────

function _esc(val) {
  return JSON.stringify(val);
}

function _fillInputFn() {
  return `
    function fillInput(input, value) {
      if (!input) return { filled: false, reason: 'not_found' };
      try {
        input.focus();
        var setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        if (setter) {
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setter.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return { filled: true, verified: input.value === value };
      } catch (e) {
        return { filled: false, reason: e.message };
      }
    }`;
}

function _clickSubmitFn(fallbackTexts) {
  return `
    function clickSubmit(root) {
      var btn = root.querySelector(${_esc(SELECTORS.submit)})
             || root.querySelector('form button:not([type="button"])');
      if (btn && !btn.disabled) { btn.click(); return true; }
      var texts = ${_esc(fallbackTexts)};
      var buttons = root.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].disabled) continue;
        var t = (buttons[i].textContent || '').toLowerCase();
        for (var j = 0; j < texts.length; j++) {
          if (t.includes(texts[j])) { buttons[i].click(); return true; }
        }
      }
      return false;
    }`;
}

// ─── DETECTION SCRIPTS ──────────────────────────────────────────────────────────

/**
 * Detect where the login form lives: main doc, same-origin iframe, or cross-origin iframe.
 * Returns { location: 'main'|'iframe'|'cross-origin'|'none', crossOrigin: boolean }
 */
function buildDetectFormLocationScript() {
  return `(function() {
    if (document.querySelector(${_esc(SELECTORS.password)})) {
      return { location: 'main', crossOrigin: false };
    }
    var iframes = document.querySelectorAll('iframe');
    var hasCrossOrigin = false;
    for (var i = 0; i < iframes.length; i++) {
      var src = iframes[i].src || '';
      try {
        var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
        if (doc && doc.querySelector(${_esc(SELECTORS.password)})) {
          return { location: 'iframe', crossOrigin: false };
        }
      } catch (e) {
        if (src.includes('auth.') && src.includes('onereach.ai')) {
          hasCrossOrigin = true;
        }
      }
    }
    if (hasCrossOrigin) return { location: 'cross-origin', crossOrigin: true };
    return { location: 'none', crossOrigin: false };
  })()`;
}

/**
 * Classify the current page: 'login', 'password-only', '2fa', 'account-select', or 'other'.
 * Includes heuristic 2FA fallback for pages that redesign their TOTP input.
 */
function buildDetectPageTypeScript() {
  return `(function() {
    var totpInputs = document.querySelectorAll(${_esc(SELECTORS.totp)});
    var visible2FA = Array.from(totpInputs).find(function(inp) {
      var rect = inp.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (visible2FA) return '2fa';

    var pageText = document.body ? document.body.innerText.toLowerCase() : '';
    var hints = ${_esc(TWO_FA_TEXT_HINTS)};
    var has2FAText = hints.some(function(h) { return pageText.includes(h); });
    var passwordInput = document.querySelector(${_esc(SELECTORS.password)});

    if (has2FAText && !passwordInput) return '2fa';

    if (has2FAText) {
      var allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="password"])');
      var shortInputs = Array.from(allInputs).filter(function(inp) {
        var rect = inp.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && inp.maxLength > 0 && inp.maxLength <= 8;
      });
      if (shortInputs.length === 1) return '2fa';
    }

    var emailInput = document.querySelector(${_esc(SELECTORS.email)});
    if (emailInput && passwordInput) return 'login';
    if (passwordInput) return 'password-only';

    var accountLinks = document.querySelectorAll(${_esc(SELECTORS.accountSelect)});
    var hasAccountText = pageText.includes('choose') || pageText.includes('select')
      || pageText.includes('switch') || pageText.includes('account');
    var clickables = document.querySelectorAll('a, button, [role="button"]');
    var accountClickable = Array.from(clickables).filter(function(el) {
      return (el.outerHTML || '').includes('account') || (el.outerHTML || '').includes('Account');
    });
    if (accountLinks.length > 0 || (hasAccountText && accountClickable.length > 0)) {
      return 'account-select';
    }

    return 'other';
  })()`;
}

/**
 * Check specifically for a 2FA page. Returns { is2FAPage: boolean, reason: string }.
 * Lighter-weight than buildDetectPageTypeScript for cross-origin frame probing.
 */
function buildDetect2FAScript() {
  return `(function() {
    var totpInput = document.querySelector(${_esc(SELECTORS.totp)});
    var passwordField = document.querySelector(${_esc(SELECTORS.password)});

    if (totpInput) return { is2FAPage: true, reason: 'totp_input_found' };

    var pageText = document.body ? document.body.innerText.toLowerCase() : '';
    var hints = ${_esc(TWO_FA_TEXT_HINTS)};
    var has2FAText = hints.some(function(h) { return pageText.includes(h); });

    if (has2FAText && !passwordField) return { is2FAPage: true, reason: '2fa_text_found' };

    if (has2FAText) {
      var allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="password"])');
      var shortInputs = Array.from(allInputs).filter(function(inp) {
        var rect = inp.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && inp.maxLength > 0 && inp.maxLength <= 8;
      });
      if (shortInputs.length === 1) return { is2FAPage: true, reason: 'heuristic_single_short_input' };
    }

    if (passwordField) return { is2FAPage: false, reason: 'still_login_page' };
    return { is2FAPage: false, reason: 'unknown' };
  })()`;
}

// ─── FORM FILLING SCRIPTS ───────────────────────────────────────────────────────

/**
 * Fill login form in the current document context. Works in main doc and cross-origin frames.
 * @param {string} email
 * @param {string} password
 * @param {Object} [options]
 * @param {boolean} [options.autoSubmit=true] Include auto-submit after delay
 * @param {number}  [options.submitDelay=500] ms before clicking submit
 */
function buildFillLoginScript(email, password, options) {
  const opts = Object.assign({ autoSubmit: true, submitDelay: 500 }, options);

  const submitBlock = opts.autoSubmit ? `
    ${_clickSubmitFn(SUBMIT_FALLBACK_TEXTS)}
    setTimeout(function() { clickSubmit(document); }, ${opts.submitDelay});` : '';

  return `(function() {
    var _email = ${_esc(email)};
    var _password = ${_esc(password)};
    ${_fillInputFn()}

    var emailInput = document.querySelector(${_esc(SELECTORS.email)});
    if (!emailInput) {
      emailInput = document.querySelector('input[type="text"]:not([name*="search"]):not([type="hidden"])');
    }
    var passwordInput = document.querySelector(${_esc(SELECTORS.password)});

    if (!passwordInput) return { success: false, reason: 'no_password_field' };

    var emailResult = emailInput ? fillInput(emailInput, _email) : { filled: false, reason: 'not_found' };
    var passwordResult = fillInput(passwordInput, _password);
    ${submitBlock}

    return {
      success: passwordResult.filled,
      emailFound: !!emailInput,
      passwordFound: true,
      email: emailResult,
      password: passwordResult
    };
  })()`;
}

/**
 * Fill login form inside a same-origin iframe. Iterates all iframes from the
 * parent document to find the one containing a password field.
 * @param {string} email
 * @param {string} password
 */
function buildIframeLoginScript(email, password) {
  return `(function() {
    var _email = ${_esc(email)};
    var _password = ${_esc(password)};
    ${_fillInputFn()}
    ${_clickSubmitFn(SUBMIT_FALLBACK_TEXTS)}

    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
        if (!doc) continue;

        var passwordField = doc.querySelector(${_esc(SELECTORS.password)});
        if (!passwordField) continue;

        var emailField = doc.querySelector(${_esc(SELECTORS.email)});
        if (emailField) fillInput(emailField, _email);
        fillInput(passwordField, _password);

        setTimeout(function() { clickSubmit(doc); }, 500);
        return true;
      } catch (e) {
        /* cross-origin iframe, skip */
      }
    }
    return false;
  })()`;
}

/**
 * Fill a TOTP / 2FA code input.
 * @param {string} code - The TOTP code
 * @param {Object} [options]
 * @param {boolean} [options.autoSubmit=true] Include auto-submit after delay
 * @param {number}  [options.submitDelay=300] ms before clicking submit
 */
function buildFillTOTPScript(code, options) {
  const opts = Object.assign({ autoSubmit: true, submitDelay: 300 }, options);

  const submitBlock = opts.autoSubmit ? `
    ${_clickSubmitFn(TOTP_SUBMIT_FALLBACK_TEXTS)}
    setTimeout(function() { clickSubmit(document); }, ${opts.submitDelay});` : '';

  return `(function() {
    var _code = ${_esc(code)};
    ${_fillInputFn()}

    var totpInput = document.querySelector(${_esc(SELECTORS.totp)});

    if (!totpInput) {
      var candidates = document.querySelectorAll(
        'input[type="text"], input[type="tel"], input[type="number"], input[inputmode="numeric"]'
      );
      for (var i = 0; i < candidates.length; i++) {
        var inp = candidates[i];
        if (inp.maxLength === 6 || (inp.placeholder || '').toLowerCase().includes('code')) {
          var rect = inp.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) { totpInput = inp; break; }
        }
      }
    }

    if (!totpInput) return { success: false, reason: 'no_totp_input' };

    var result = fillInput(totpInput, _code);
    ${submitBlock}

    return { success: result.filled, verified: result.verified, method: totpInput.name ? 'named' : 'heuristic' };
  })()`;
}

// ─── ACTION SCRIPTS ─────────────────────────────────────────────────────────────

/**
 * Find and click the submit / verify button.
 * @param {string[]} [fallbackTexts] Button text to match. Defaults to login texts.
 */
function buildSubmitButtonScript(fallbackTexts) {
  const texts = fallbackTexts || SUBMIT_FALLBACK_TEXTS;
  return `(function() {
    ${_clickSubmitFn(texts)}
    if (clickSubmit(document)) return { clicked: true };

    var form = document.querySelector('form');
    if (form) { form.submit(); return { clicked: true, method: 'form' }; }

    return { clicked: false, reason: 'no_submit_found' };
  })()`;
}

/**
 * Auto-select the correct account on an account picker page.
 * Tries 4 strategies: href match, data attributes, HTML content, form submit.
 * @param {string} targetAccountId
 */
function buildSelectAccountScript(targetAccountId) {
  return `(function() {
    var targetId = ${_esc(targetAccountId)};

    var allLinks = document.querySelectorAll('a');
    for (var i = 0; i < allLinks.length; i++) {
      if (allLinks[i].href && allLinks[i].href.includes(targetId)) {
        allLinks[i].click();
        return { success: true, method: 'link-href', text: (allLinks[i].textContent || '').trim() };
      }
    }

    var dataEls = document.querySelectorAll('[data-account-id], [data-id], [data-account]');
    for (var j = 0; j < dataEls.length; j++) {
      var d = dataEls[j].dataset;
      if ((d.accountId || d.id || d.account) === targetId) {
        dataEls[j].click();
        return { success: true, method: 'data-attribute' };
      }
    }

    var clickable = document.querySelectorAll(${_esc(SELECTORS.accountClickable)});
    for (var k = 0; k < clickable.length; k++) {
      if ((clickable[k].outerHTML || '').includes(targetId)) {
        clickable[k].click();
        return { success: true, method: 'html-content-match', text: (clickable[k].textContent || '').trim().substring(0, 60) };
      }
    }

    var forms = document.querySelectorAll('form');
    for (var m = 0; m < forms.length; m++) {
      if ((forms[m].outerHTML || '').includes(targetId)) {
        var btn = forms[m].querySelector('button[type="submit"], button, input[type="submit"]');
        if (btn) { btn.click(); return { success: true, method: 'form-submit' }; }
      }
    }

    return { success: false, reason: 'no_matching_account' };
  })()`;
}

// ─── STATE CHECK SCRIPTS ────────────────────────────────────────────────────────

/**
 * Comprehensive auth state probe. Used after login submit and after 2FA submit.
 * Returns { has2FA, hasPassword, hasError, hasRateLimit, isAccountSelect, errorMessage }
 */
function buildAuthStateCheckScript() {
  return `(function() {
    var totpInput = document.querySelector(${_esc(SELECTORS.totp)});
    var errorEl = document.querySelector(${_esc(SELECTORS.error)});
    var bodyText = (document.body && document.body.innerText || '').toLowerCase();

    var hasError = !!errorEl
      || bodyText.includes('invalid password') || bodyText.includes('incorrect password')
      || bodyText.includes('authentication failed')
      || bodyText.includes('invalid code') || bodyText.includes('incorrect code')
      || bodyText.includes('expired');
    var hasRateLimit = bodyText.includes('too many') || bodyText.includes('try again later');

    var accountLinks = document.querySelectorAll(${_esc(SELECTORS.accountSelect)});
    var hasAccountText = bodyText.includes('choose') || bodyText.includes('select')
      || bodyText.includes('switch') || bodyText.includes('account');
    var clickables = document.querySelectorAll('a, button, [role="button"]');
    var accountClickable = Array.from(clickables).filter(function(el) {
      return (el.outerHTML || '').includes('account') || (el.outerHTML || '').includes('Account');
    });
    var isAccountSelect = accountLinks.length > 0 || (hasAccountText && accountClickable.length > 0);

    return {
      has2FA: !!totpInput,
      hasPassword: !!document.querySelector(${_esc(SELECTORS.password)}),
      hasError: hasError,
      hasRateLimit: hasRateLimit,
      isAccountSelect: isAccountSelect,
      errorMessage: errorEl ? errorEl.textContent : ''
    };
  })()`;
}

/**
 * Check if a tab needs authentication. Used by checkTabAuthentication.
 * Returns { needsAuth, currentUrl, title, bodyLength, ... }
 */
function buildCheckAuthStatusScript() {
  return `(function() {
    var href = window.location.href;
    var isLoginPage = href.includes('/login') || href.includes('/auth')
      || !!document.querySelector(${_esc(SELECTORS.password)});
    var hasLoginForm = !!document.querySelector('form[action*="login"]')
      || !!document.querySelector('button[type="submit"]');
    var bodyText = document.body ? document.body.innerText.toLowerCase() : '';
    var hasLoginKeywords = bodyText.includes('sign in') || bodyText.includes('log in')
      || bodyText.includes('login') || bodyText.includes('password');
    var hasAuthContent = !!document.querySelector(${_esc(SELECTORS.authContent)});
    var isEmptyPage = !document.body || document.body.innerText.trim().length < 50
      || document.body.children.length < 3;
    var hasOneReachChat = !!document.querySelector('[id*="onereach"]')
      || !!document.querySelector('[class*="onereach"]');
    var isOneReachChatUrl = href.includes('chat.') && href.includes('.onereach.ai');

    var needsAuth = (isLoginPage || hasLoginForm || hasLoginKeywords
      || (isOneReachChatUrl && isEmptyPage && !hasAuthContent)) && !hasAuthContent;

    return {
      needsAuth: needsAuth,
      currentUrl: href,
      title: document.title,
      bodyLength: document.body ? document.body.innerText.length : 0,
      hasAuthenticatedContent: hasAuthContent,
      isEmptyPage: isEmptyPage,
      isOneReachChatUrl: isOneReachChatUrl
    };
  })()`;
}

/**
 * MutationObserver-based wait for auth form to appear. Returns a Promise.
 * Used by gsx-autologin waitForAuthForm.
 * @param {number} [timeoutMs=10000]
 */
function buildWaitForAuthFormScript(timeoutMs) {
  const ms = timeoutMs || 10000;
  return `
    new Promise(function(resolve) {
      var TOTP_SEL = ${_esc(SELECTORS.totp)};
      var EMAIL_SEL = ${_esc(SELECTORS.email)};
      var PW_SEL = ${_esc(SELECTORS.password)};

      function check() {
        if (document.querySelector(TOTP_SEL))
          return { is2FAPage: true, reason: 'totp_input_found' };
        var hasEmail = !!document.querySelector(EMAIL_SEL);
        var hasPw = !!document.querySelector(PW_SEL);
        if (hasEmail && hasPw) return { isLoginPage: true, reason: 'login_form_found' };
        if (hasEmail) return { isLoginPage: true, reason: 'email_only' };
        if (hasPw) return { isLoginPage: true, reason: 'password_only' };
        return null;
      }

      var existing = check();
      if (existing) return resolve(existing);

      var observer = new MutationObserver(function() {
        var result = check();
        if (result) { observer.disconnect(); clearTimeout(timer); resolve(result); }
      });

      observer.observe(document.body || document.documentElement, {
        childList: true, subtree: true
      });

      var timer = setTimeout(function() {
        observer.disconnect();
        var allInputs = document.querySelectorAll('input:not([type="hidden"])');
        resolve({ isLoginPage: false, is2FAPage: false, reason: 'observer_timeout', inputCount: allInputs.length });
      }, ${ms});
    })`;
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────────

module.exports = {
  SELECTORS,
  TWO_FA_TEXT_HINTS,
  SUBMIT_FALLBACK_TEXTS,
  TOTP_SUBMIT_FALLBACK_TEXTS,

  buildDetectFormLocationScript,
  buildDetectPageTypeScript,
  buildDetect2FAScript,

  buildFillLoginScript,
  buildIframeLoginScript,
  buildFillTOTPScript,

  buildSubmitButtonScript,
  buildSelectAccountScript,

  buildAuthStateCheckScript,
  buildCheckAuthStatusScript,
  buildWaitForAuthFormScript,
};
