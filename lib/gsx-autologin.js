/**
 * GSX Auto-Login System
 *
 * Resilient auto-login for GSX windows with:
 * - Rate limiting with exponential backoff
 * - React-compatible form filling
 * - TOTP 2FA handling with timing awareness
 * - Window destruction safety
 * - Loading overlay management
 * - Error detection and smart retry
 *
 * Extracted from menu.js for separation of concerns.
 */

const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { registerGSXWindow } = require('./gsx-window-tracker');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ============================================
// RESILIENT AUTO-LOGIN SYSTEM
// ============================================

/**
 * Custom error for window destruction during async operations
 */
class WindowDestroyedError extends Error {
  constructor(message = 'Window was closed') {
    super(message);
    this.name = 'WindowDestroyedError';
  }
}

/**
 * Sleep utility for async delays
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rate limit tracking for login attempts per environment
 */
const loginAttempts = new Map(); // environment -> { count, lastAttempt, lastSuccess }

/**
 * Check if we can attempt login (rate limit protection)
 * @param {string} environment - The IDW environment
 * @returns {{ allowed: boolean, waitMs?: number }}
 */
function canAttemptLogin(environment) {
  const record = loginAttempts.get(environment) || { count: 0, lastAttempt: 0, lastSuccess: 0 };

  // Reset count if last success was recent (within 5 minutes)
  if (record.lastSuccess > 0 && Date.now() - record.lastSuccess < 300000) {
    return { allowed: true };
  }

  // Exponential backoff: 5s, 10s, 15s, 20s, 25s, 30s (max)
  const cooldown = Math.min(record.count * 5000, 30000);

  if (record.count > 0 && Date.now() - record.lastAttempt < cooldown) {
    const waitMs = cooldown - (Date.now() - record.lastAttempt);
    log.info('app', 'Rate limited for , wait s', { environment: environment, Math: Math.ceil(waitMs / 1000) });
    return { allowed: false, waitMs };
  }
  return { allowed: true };
}

/**
 * Record a login attempt
 * @param {string} environment - The IDW environment
 * @param {boolean} success - Whether the attempt succeeded
 */
function recordLoginAttempt(environment, success) {
  const record = loginAttempts.get(environment) || { count: 0, lastAttempt: 0, lastSuccess: 0 };

  if (success) {
    // Reset on success
    loginAttempts.set(environment, { count: 0, lastAttempt: Date.now(), lastSuccess: Date.now() });
  } else {
    // Increment failure count
    loginAttempts.set(environment, {
      count: record.count + 1,
      lastAttempt: Date.now(),
      lastSuccess: record.lastSuccess,
    });
  }
}

/**
 * Safe execution wrapper for frame.executeJavaScript calls
 * Works with webFrameMain
 *
 * @param {BrowserWindow} gsxWindow - The parent window (for destruction check)
 * @param {WebFrameMain} frame - The frame to execute in
 * @param {string} script - JavaScript to execute
 * @param {Object} options - Options: timeout (ms), retries (count)
 * @returns {Promise<any>} Result of script execution
 */
async function safeFrameExecute(gsxWindow, frame, script, options = {}) {
  const { timeout = 5000, retries = 1 } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Check if window still exists
    if (!gsxWindow || gsxWindow.isDestroyed()) {
      throw new WindowDestroyedError('Window closed during operation');
    }

    // Check if frame is still valid
    if (!frame || !frame.url) {
      throw new Error('Frame is no longer valid');
    }

    try {
      const result = await Promise.race([
        frame.executeJavaScript(script),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Frame script execution timeout')), timeout);
        }),
      ]);
      return result;
    } catch (err) {
      if (gsxWindow.isDestroyed()) {
        throw new WindowDestroyedError('Window closed during frame script execution');
      }

      if (attempt === retries) {
        log.error('app', 'Failed after attempts', { retries1: retries + 1, error: err.message });
        throw err;
      }

      log.info('app', 'Attempt failed, retrying...', { attempt1: attempt + 1 });
      await sleep(100);
    }
  }
}

/**
 * Update the status overlay in the GSX window
 * @param {BrowserWindow} gsxWindow - The window
 * @param {string} status - Status message to display
 * @param {string} type - Type: 'loading', 'success', 'error', 'waiting'
 * @param {Object} extra - Extra options: countdown, showRetry, showManual
 */
async function updateStatusOverlay(gsxWindow, status, type = 'loading', extra = {}) {
  if (!gsxWindow || gsxWindow.isDestroyed()) return;

  const { countdown, showRetry, showManual } = extra;

  try {
    await gsxWindow.webContents.executeJavaScript(`
      (function() {
        let overlay = document.getElementById('gsx-loading-overlay');
        if (!overlay) {
          // Create overlay if it doesn't exist
          overlay = document.createElement('div');
          overlay.id = 'gsx-loading-overlay';
          document.body.appendChild(overlay);
        }
        
        // Remove fade-out class if present
        overlay.classList.remove('gsx-fade-out');
        
        const type = ${JSON.stringify(type)};
        const status = ${JSON.stringify(status)};
        const countdown = ${countdown || 'null'};
        const showRetry = ${!!showRetry};
        const showManual = ${!!showManual};
        
        let iconHtml = '';
        if (type === 'loading' || type === 'waiting') {
          iconHtml = '<div id="gsx-loading-spinner"></div>';
        } else if (type === 'success') {
          iconHtml = '<div style="font-size:48px;margin-bottom:20px;">&#10003;</div>';
        } else if (type === 'error') {
          iconHtml = '<div style="font-size:48px;margin-bottom:20px;color:#ff6b6b;">&#9888;</div>';
        }
        
        let buttonsHtml = '';
        if (showRetry || showManual) {
          buttonsHtml = '<div style="display:flex;gap:12px;margin-top:20px;">';
          if (showRetry) {
            buttonsHtml += '<button onclick="window.__gsxRetryLogin && window.__gsxRetryLogin()" style="background:#4f8cff;color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;">Try Again</button>';
          }
          if (showManual) {
            buttonsHtml += '<button onclick="document.getElementById(\\'gsx-loading-overlay\\').classList.add(\\'gsx-fade-out\\')" style="background:transparent;color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.3);padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;">Login Manually</button>';
          }
          buttonsHtml += '</div>';
        }
        
        let countdownHtml = '';
        if (countdown !== null) {
          countdownHtml = '<div style="margin-top:8px;font-size:24px;font-weight:600;">' + countdown + 's</div>';
        }
        
        overlay.innerHTML = iconHtml + 
          '<div id="gsx-loading-text">' + status + '</div>' +
          '<div id="gsx-loading-status">' + (countdown !== null ? 'Fresh code in' : '') + '</div>' +
          countdownHtml +
          buttonsHtml;
        
        // Apply type-specific styling
        const textEl = overlay.querySelector('#gsx-loading-text');
        if (textEl) {
          if (type === 'error') {
            textEl.style.color = '#ff6b6b';
          } else if (type === 'success') {
            textEl.style.color = '#6bff8a';
          } else {
            textEl.style.color = 'rgba(255,255,255,0.9)';
          }
        }
      })();
    `);
  } catch (_err) {
    // Silently ignore - overlay update is non-critical
  }
}

/**
 * Hide the status overlay with fade animation
 * @param {BrowserWindow} gsxWindow - The window
 * @param {boolean} showSuccess - Whether to briefly show success state first
 */
async function hideStatusOverlay(gsxWindow, showSuccess = false) {
  if (!gsxWindow || gsxWindow.isDestroyed()) return;

  try {
    if (showSuccess) {
      await updateStatusOverlay(gsxWindow, 'Signed in!', 'success');
      await sleep(800);
    }

    await gsxWindow.webContents.executeJavaScript(`
      const overlay = document.getElementById('gsx-loading-overlay');
      if (overlay) {
        overlay.classList.add('gsx-fade-out');
        setTimeout(() => overlay.remove(), 300);
      }
    `);
  } catch (_err) {
    // Silently ignore
  }
}

/**
 * Attempt auto-login for GSX windows with full resilience
 * @param {BrowserWindow} gsxWindow - The GSX window
 * @param {string} url - The current URL
 * @param {Object} state - Auto-login state tracker
 * @param {string} environment - The IDW environment
 */
async function attemptGSXAutoLogin(gsxWindow, url, state, environment) {
  const credentialManager = require('../credential-manager');
  const getLogger = require('../event-logger');
  const logger = getLogger();

  logger.info('[Auth GSX] Login attempt started', { event: 'auth:gsx-start', url, environment, feature: 'auto-login' });

  try {
    // Check for window destruction
    if (!gsxWindow || gsxWindow.isDestroyed()) {
      logger.warn('[Auth GSX] Window destroyed before login', {
        event: 'auth:gsx-window-destroyed',
        environment,
        feature: 'auto-login',
      });
      return;
    }

    // Check rate limiting
    const rateCheck = canAttemptLogin(environment);
    if (!rateCheck.allowed) {
      logger.info('[Auth GSX] Rate limited', {
        event: 'auth:gsx-rate-limited',
        environment,
        waitMs: rateCheck.waitMs,
        feature: 'auto-login',
      });
      await updateStatusOverlay(gsxWindow, `Please wait ${Math.ceil(rateCheck.waitMs / 1000)}s...`, 'waiting');
      await sleep(rateCheck.waitMs);
    }

    // Get stored credentials
    const credentials = await credentialManager.getOneReachCredentials();
    if (!credentials || !credentials.email || !credentials.password) {
      logger.warn('[Auth GSX] No credentials configured', {
        event: 'auth:gsx-no-credentials',
        environment,
        feature: 'auto-login',
      });
      await updateStatusOverlay(gsxWindow, 'No saved credentials', 'error', {
        showManual: true,
      });
      state.inProgress = false;
      return;
    }

    // Update status
    await updateStatusOverlay(gsxWindow, 'Signing in...', 'loading');

    // Check if window is still valid
    if (gsxWindow.isDestroyed()) {
      throw new WindowDestroyedError();
    }

    // Find auth frame
    const mainFrame = gsxWindow.webContents.mainFrame;
    const allFrames = [mainFrame, ...mainFrame.framesInSubtree];

    let authFrame = null;
    for (const frame of allFrames) {
      if (frame.url && frame.url.includes('auth.') && frame.url.includes('onereach.ai')) {
        authFrame = frame;
        break;
      }
    }

    if (!authFrame) {
      log.info('app', 'No auth frame found');
      state.inProgress = false;
      await hideStatusOverlay(gsxWindow);
      return;
    }

    log.info('app', 'Found auth frame', { authFrame: authFrame.url });

    // Check what type of page we're on (login or 2FA)
    const pageType = await safeFrameExecute(
      gsxWindow,
      authFrame,
      `
      (function() {
        const allInputs = document.querySelectorAll('input:not([type="hidden"])');
        
        // Broader TOTP detection
        const totpInput = document.querySelector(
          'input[name="totp"], input[name="code"], input[name="otp"], ' +
          'input[type="number"][maxlength="6"], input[autocomplete="one-time-code"], ' +
          'input[inputmode="numeric"][maxlength="6"], input[placeholder*="code" i]'
        );
        
        // Broader email detection (but exclude password fields)
        const emailInput = document.querySelector(
          'input[type="email"], input[name="email"], input[autocomplete="email"], ' +
          'input[type="text"][placeholder*="email" i], input[type="text"]:not([type="password"]):not([type="hidden"])'
        );
        
        const passwordInput = document.querySelector('input[type="password"]');
        
        // Detect page type with reasoning
        if (totpInput) {
          return { is2FAPage: true, reason: 'totp_input_found' };
        } else if (emailInput && passwordInput) {
          return { isLoginPage: true, reason: 'login_form_found' };
        } else if (emailInput) {
          return { isLoginPage: true, reason: 'email_only' };
        } else if (passwordInput) {
          return { isLoginPage: true, reason: 'password_only' };
        }
        
        return { isLoginPage: false, is2FAPage: false, reason: 'no_form_found', inputCount: allInputs.length };
      })()
    `
    );

    logger.info('[Auth GSX] Page type detected', {
      event: 'auth:gsx-page-type',
      environment,
      isLogin: !!pageType.isLoginPage,
      is2FA: !!pageType.is2FAPage,
      reason: pageType.reason,
      feature: 'auto-login',
    });

    if (pageType.isLoginPage) {
      // Fill login form with React-compatible approach
      const fillScript = `
        (function() {
          const email = ${JSON.stringify(credentials.email)};
          const password = ${JSON.stringify(credentials.password)};
          
          // React-compatible input fill function with verification
          function fillInput(input, value) {
            if (!input) return { filled: false, reason: 'input_not_found' };
            
            try {
              // Focus the input first
              input.focus();
              
              // Clear any existing value
              input.value = '';
              
              // Use native value setter to bypass React's controlled input handling
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              ).set;
              nativeInputValueSetter.call(input, value);
              
              // Dispatch all the events React listens for
              input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              
              // Verify the value was set
              const actualValue = input.value;
              const verified = actualValue === value;
              
              console.log('[GSX AutoLogin] Filled:', input.type || input.name, 
                'expected:', value.length, 'chars, actual:', actualValue.length, 'chars, verified:', verified);
              
              return { filled: true, verified, actualLength: actualValue.length };
            } catch (err) {
              console.error('[GSX AutoLogin] Fill error:', err.message);
              return { filled: false, reason: err.message };
            }
          }
          
          // Find inputs with broader selectors
          const emailInput = document.querySelector(
            'input[type="email"], input[name="email"], input[autocomplete="email"], ' +
            'input[type="text"][placeholder*="email" i], input[type="text"][placeholder*="Email" i], ' +
            'input[type="text"]:not([type="password"]):not([type="hidden"])'
          );
          const passwordInput = document.querySelector('input[type="password"]');
          
          console.log('[GSX AutoLogin] Found email input:', !!emailInput, emailInput?.type, emailInput?.name);
          console.log('[GSX AutoLogin] Found password input:', !!passwordInput);
          
          const emailResult = fillInput(emailInput, email);
          const passwordResult = fillInput(passwordInput, password);
          
          // Store references for submit button click
          window.__gsxEmailInput = emailInput;
          window.__gsxPasswordInput = passwordInput;
          
          return { 
            success: emailResult.filled && passwordResult.filled,
            email: emailResult,
            password: passwordResult,
            emailValue: emailInput?.value?.length || 0,
            passwordValue: passwordInput?.value?.length || 0
          };
        })()
      `;
      const result = await safeFrameExecute(gsxWindow, authFrame, fillScript);

      logger.info('[Auth GSX] Login form fill result', {
        event: 'auth:gsx-form-fill',
        success: !!(result && result.success),
        environment,
        feature: 'auto-login',
      });

      // Verify fill succeeded
      if (!result || !result.success) {
        logger.warn('[Auth GSX] Form fill verification failed', {
          event: 'auth:gsx-fill-failed',
          environment,
          feature: 'auto-login',
        });
        return 'no_form'; // Signal retry
      }

      // Click submit button in separate step for reliability
      await sleep(100);
      await safeFrameExecute(
        gsxWindow,
        authFrame,
        `
        (function() {
          // Find and click submit button
          const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
          if (submitBtn && !submitBtn.disabled) {
            console.log('[GSX AutoLogin] Clicking submit button');
            submitBtn.click();
            return { clicked: true, buttonType: 'submit' };
          }
          
          // Try finding button by text
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase().trim();
            if ((text.includes('sign in') || text.includes('log in') || text.includes('continue')) && !btn.disabled) {
              console.log('[GSX AutoLogin] Clicking button:', btn.textContent.trim());
              btn.click();
              return { clicked: true, buttonType: 'text', buttonText: text };
            }
          }
          
          // Last resort: try form submit
          const form = document.querySelector('form');
          if (form) {
            console.log('[GSX AutoLogin] Submitting form directly');
            form.submit();
            return { clicked: true, buttonType: 'form' };
          }
          
          return { clicked: false, reason: 'no_submit_found' };
        })()
      `
      ).catch((err) => log.info('app', 'Submit click error (may be expected)', { error: err.message }));

      // Wait for 2FA page and handle it
      await sleep(1500);

      // Check window still exists before continuing
      if (!gsxWindow.isDestroyed()) {
        await handleGSX2FA(gsxWindow, state, environment, 0);
      }
    } else if (pageType.is2FAPage) {
      await handleGSX2FA(gsxWindow, state, environment, 0);
    } else {
      log.info('app', 'No actionable form found, inputCount', { pageType: pageType.inputCount });
      // Return indicator for retry mechanism (don't reset state yet)
      return 'no_form';
    }
  } catch (err) {
    if (err instanceof WindowDestroyedError) {
      logger.info('[Auth GSX] Window closed during login', {
        event: 'auth:gsx-window-closed',
        environment,
        feature: 'auto-login',
      });
      return;
    }

    logger.error('[Auth GSX] Login error', {
      event: 'auth:gsx-error',
      environment,
      error: err.message,
      feature: 'auto-login',
    });
    recordLoginAttempt(environment, false);

    // Show error with retry option
    if (gsxWindow && !gsxWindow.isDestroyed()) {
      await updateStatusOverlay(gsxWindow, 'Login failed', 'error', {
        showRetry: true,
        showManual: true,
      });

      // Setup retry handler
      try {
        await gsxWindow.webContents.executeJavaScript(`
          window.__gsxRetryLogin = function() {
            window.electronAPI && window.electronAPI.retryAutoLogin && window.electronAPI.retryAutoLogin();
          };
        `);
      } catch (_e) {
        // Ignore - retry button just won't work
      }
    }

    state.inProgress = false;
  }
}

/**
 * Handle 2FA for GSX windows with full resilience
 * Includes TOTP timing awareness, error detection, and smart retry
 */
async function handleGSX2FA(gsxWindow, state, environment, attempt = 0) {
  const credentialManager = require('../credential-manager');
  const { TOTPManager } = require('./totp-manager');
  const getLogger = require('../event-logger');
  const logger = getLogger();

  const MAX_ATTEMPTS = 5;

  try {
    // Check window destruction
    if (!gsxWindow || gsxWindow.isDestroyed()) {
      throw new WindowDestroyedError();
    }

    if (attempt >= MAX_ATTEMPTS) {
      logger.warn('[Auth GSX] 2FA max attempts exhausted', {
        event: 'auth:gsx-2fa-exhausted',
        environment,
        maxAttempts: MAX_ATTEMPTS,
        feature: 'auto-login',
      });
      recordLoginAttempt(environment, false);
      await updateStatusOverlay(gsxWindow, '2FA verification failed', 'error', {
        showRetry: true,
        showManual: true,
      });
      state.inProgress = false;
      return;
    }

    logger.info(`[Auth GSX] 2FA attempt ${attempt + 1}/${MAX_ATTEMPTS}`, {
      event: 'auth:gsx-2fa-attempt',
      environment,
      attempt: attempt + 1,
      maxAttempts: MAX_ATTEMPTS,
      feature: 'auto-login',
    });

    // Update status
    await updateStatusOverlay(gsxWindow, 'Verifying 2FA...', 'loading');

    // Find auth frame
    const mainFrame = gsxWindow.webContents.mainFrame;
    const allFrames = [mainFrame, ...mainFrame.framesInSubtree];

    let authFrame = null;
    for (const frame of allFrames) {
      if (frame.url && frame.url.includes('auth.') && frame.url.includes('onereach.ai')) {
        authFrame = frame;
        break;
      }
    }

    if (!authFrame) {
      logger.info('[Auth GSX] Auth frame gone - login likely succeeded', {
        event: 'auth:gsx-2fa-frame-lost',
        environment,
        feature: 'auto-login',
      });
      recordLoginAttempt(environment, true);
      await hideStatusOverlay(gsxWindow, true);
      state.complete = true;
      state.inProgress = false;
      return;
    }

    // Check if 2FA input exists
    const formCheck = await safeFrameExecute(
      gsxWindow,
      authFrame,
      `
      (function() {
        const totpInput = document.querySelector('input[name="totp"], input[type="number"][maxlength="6"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
        const errorEl = document.querySelector('.error, .alert-error, [class*="error-message"]');
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        
        return {
          has2FA: !!totpInput,
          hasError: !!errorEl || bodyText.includes('invalid code') || bodyText.includes('incorrect code'),
          errorMessage: errorEl?.textContent || '',
          hasRateLimit: bodyText.includes('too many') || bodyText.includes('try again later')
        };
      })()
    `
    );

    // Handle rate limiting from server
    if (formCheck.hasRateLimit) {
      logger.warn('[Auth GSX] Server rate limit detected', {
        event: 'auth:gsx-rate-limit-server',
        environment,
        feature: 'auto-login',
      });
      recordLoginAttempt(environment, false);
      await updateStatusOverlay(gsxWindow, 'Too many attempts - please wait', 'error', {
        showManual: true,
      });
      state.inProgress = false;
      return;
    }

    // Handle invalid code error - retry with fresh code
    if (formCheck.hasError && attempt > 0) {
      logger.warn('[Auth GSX] Invalid 2FA code, waiting for fresh code', {
        event: 'auth:gsx-2fa-invalid',
        environment,
        attempt,
        feature: 'auto-login',
      });
      // Wait for fresh TOTP window
      const totpManager = new TOTPManager();
      const timeRemaining = totpManager.getTimeRemaining();

      await updateStatusOverlay(gsxWindow, 'Code expired, waiting for new code...', 'waiting', {
        countdown: timeRemaining + 1,
      });

      // Wait for fresh code
      await sleep((timeRemaining + 1) * 1000);

      // Retry with fresh code
      if (!gsxWindow.isDestroyed()) {
        await handleGSX2FA(gsxWindow, state, environment, attempt + 1);
      }
      return;
    }

    if (!formCheck.has2FA) {
      log.info('app', 'No 2FA input found, retrying...');
      await sleep(500);
      if (!gsxWindow.isDestroyed()) {
        await handleGSX2FA(gsxWindow, state, environment, attempt + 1);
      }
      return;
    }

    // Get TOTP secret
    const totpSecret = await credentialManager.getTOTPSecret();
    if (!totpSecret) {
      logger.warn('[Auth GSX] No TOTP secret configured', {
        event: 'auth:gsx-no-totp',
        environment,
        feature: 'auto-login',
      });
      await updateStatusOverlay(gsxWindow, 'No 2FA secret configured', 'error', {
        showManual: true,
      });
      state.inProgress = false;
      return;
    }

    // TOTP TIMING CHECK - Wait for fresh code if near expiration
    const totpManager = new TOTPManager();
    let timeRemaining = totpManager.getTimeRemaining();

    if (timeRemaining < 5) {
      logger.info('[Auth GSX] TOTP near expiration, waiting for fresh code', {
        event: 'auth:gsx-totp-wait',
        environment,
        timeRemaining,
        feature: 'auto-login',
      });
      await updateStatusOverlay(gsxWindow, 'Waiting for fresh code...', 'waiting', {
        countdown: timeRemaining + 1,
      });

      // Wait for fresh code with countdown
      while (timeRemaining > 0 && !gsxWindow.isDestroyed()) {
        await sleep(1000);
        timeRemaining = totpManager.getTimeRemaining();
        if (timeRemaining > 25) break; // Fresh code is ready
        await updateStatusOverlay(gsxWindow, 'Waiting for fresh code...', 'waiting', {
          countdown: timeRemaining,
        });
      }

      await updateStatusOverlay(gsxWindow, 'Verifying 2FA...', 'loading');
    }

    // Generate TOTP code
    let totpCode;
    try {
      totpCode = totpManager.generateCode(totpSecret);
      logger.info('[Auth GSX] TOTP code generated', {
        event: 'auth:gsx-totp-generated',
        environment,
        feature: 'auto-login',
      });
    } catch (err) {
      logger.error('[Auth GSX] TOTP generation failed', {
        event: 'auth:gsx-totp-error',
        environment,
        error: err.message,
        feature: 'auto-login',
      });
      await updateStatusOverlay(gsxWindow, 'Invalid 2FA secret', 'error', {
        showManual: true,
      });
      state.inProgress = false;
      return;
    }

    // Fill 2FA form with React-compatible approach
    const result = await safeFrameExecute(
      gsxWindow,
      authFrame,
      `
      (function() {
        const code = ${JSON.stringify(totpCode)};
        const totpInput = document.querySelector('input[name="totp"], input[type="number"][maxlength="6"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
        
        if (totpInput) {
          try {
            // Focus the input
            totpInput.focus();
            
            // Clear existing value first using native setter
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(totpInput, '');
            totpInput.dispatchEvent(new Event('input', { bubbles: true }));
            
            // Set new value using native setter (React-compatible)
            nativeInputValueSetter.call(totpInput, code);
            
            // Dispatch all events React listens for
            totpInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            totpInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            totpInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            totpInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            // Verify value was set
            const verified = totpInput.value === code;
            console.log('[GSX AutoLogin] 2FA code filled, verified:', verified, 'value length:', totpInput.value.length);
            
            return { success: true, verified, valueLength: totpInput.value.length };
          } catch (err) {
            console.error('[GSX AutoLogin] 2FA fill error:', err.message);
            return { success: false, reason: err.message };
          }
        }
        return { success: false, reason: 'totp_input_not_found' };
      })()
    `
    );

    logger.info('[Auth GSX] 2FA fill result', {
      event: 'auth:gsx-2fa-fill',
      environment,
      success: !!(result && result.success),
      verified: result?.verified,
      reason: result?.reason,
      feature: 'auto-login',
    });

    // Verify fill succeeded before clicking submit
    if (!result || !result.success) {
      logger.warn('[Auth GSX] 2FA fill failed', {
        event: 'auth:gsx-2fa-fill-failed',
        environment,
        reason: result?.reason,
        feature: 'auto-login',
      });
      await sleep(500);
      if (!gsxWindow.isDestroyed()) {
        await handleGSX2FA(gsxWindow, state, environment, attempt + 1);
      }
      return;
    }

    // Click submit button in separate step for reliability
    await sleep(100);
    await safeFrameExecute(
      gsxWindow,
      authFrame,
      `
      (function() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if ((text.includes('verify') || text.includes('submit') || text.includes('continue') || btn.type === 'submit') && !btn.disabled) {
            console.log('[GSX AutoLogin] Clicking 2FA button:', btn.textContent?.trim());
            btn.click();
            return { clicked: true };
          }
        }
        
        // Fallback: try form submit
        const totpInput = document.querySelector('input[name="totp"], input[inputmode="numeric"]');
        const form = totpInput?.closest('form');
        if (form) {
          console.log('[GSX AutoLogin] Submitting 2FA form directly');
          form.submit();
          return { clicked: true, method: 'form' };
        }
        
        return { clicked: false };
      })()
    `
    ).catch((err) => log.info('app', '2FA submit error (may be expected)', { error: err.message }));

    // Wait a moment then check for errors
    await sleep(1500);

    // Check if we're still on auth page (indicates failure)
    if (!gsxWindow.isDestroyed()) {
      const stillOnAuth = await safeFrameExecute(
        gsxWindow,
        authFrame,
        `
        (function() {
          const totpInput = document.querySelector('input[name="totp"], input[type="number"][maxlength="6"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
          const errorEl = document.querySelector('.error, .alert-error, [class*="error"]');
          const bodyText = document.body?.innerText?.toLowerCase() || '';
          
          return {
            stillOnPage: !!totpInput,
            hasError: !!errorEl || bodyText.includes('invalid') || bodyText.includes('incorrect') || bodyText.includes('expired')
          };
        })()
      `
      ).catch(() => ({ stillOnPage: false, hasError: false }));

      if (stillOnAuth.stillOnPage && stillOnAuth.hasError) {
        logger.warn('[Auth GSX] 2FA error on page, retrying', {
          event: 'auth:gsx-2fa-rejected',
          environment,
          attempt,
          feature: 'auto-login',
        });
        await handleGSX2FA(gsxWindow, state, environment, attempt + 1);
        return;
      }
    }

    // Success!
    logger.info('[Auth GSX] 2FA completed, login successful', {
      event: 'auth:gsx-complete',
      environment,
      attempts: attempt + 1,
      feature: 'auto-login',
    });
    recordLoginAttempt(environment, true);
    await hideStatusOverlay(gsxWindow, true);
    state.complete = true;
    state.inProgress = false;
  } catch (err) {
    if (err instanceof WindowDestroyedError) {
      logger.info('[Auth GSX] Window closed during 2FA', {
        event: 'auth:gsx-2fa-window-closed',
        environment,
        feature: 'auto-login',
      });
      return;
    }

    logger.error('[Auth GSX] 2FA error', {
      event: 'auth:gsx-2fa-error',
      environment,
      error: err.message,
      attempt,
      feature: 'auto-login',
    });

    // Retry on transient errors
    if (attempt < MAX_ATTEMPTS - 1 && !gsxWindow.isDestroyed()) {
      logger.info('[Auth GSX] Retrying 2FA after error', {
        event: 'auth:gsx-2fa-retry',
        environment,
        attempt: attempt + 1,
        feature: 'auto-login',
      });
      await sleep(500);
      await handleGSX2FA(gsxWindow, state, environment, attempt + 1);
      return;
    }

    // Show error on final failure
    if (gsxWindow && !gsxWindow.isDestroyed()) {
      recordLoginAttempt(environment, false);
      await updateStatusOverlay(gsxWindow, '2FA failed', 'error', {
        showRetry: true,
        showManual: true,
      });
    }

    state.inProgress = false;
  }
}

/**
 * Helper function to open GSX content in a large app window
 * @param {string} url The URL to load
 * @param {string} title The window title
 * @param {string} windowTitle The full window title
 * @param {string} loadingMessage The loading message to display
 * @param {string} idwEnvironment The IDW environment for session isolation
 * @returns {Promise<BrowserWindow>} The created window
 */
async function openGSXLargeWindow(url, title, windowTitle, loadingMessage = 'Loading...', idwEnvironment = null) {
  const getLogger = require('../event-logger');
  const logger = getLogger();

  // Log the window access
  if (logger && logger.info) {
    logger.info('GSX Large Window Opened', {
      action: 'window_open',
      title: title,
      url: url,
      timestamp: new Date().toISOString(),
    });
  }
  log.info('app', 'Opening GSX large window: -', { title: title, url: url });

  // Extract environment from URL if not provided
  // Use the multi-tenant-store's extraction logic for consistency
  if (!idwEnvironment) {
    try {
      const multiTenantStore = require('../multi-tenant-store');
      idwEnvironment = multiTenantStore.extractEnvironmentFromUrl(url);
      log.info('app', "Extracted environment '' from URL", { idwEnvironment: idwEnvironment, url: url });
    } catch (err) {
      log.error('app', 'Error parsing GSX URL to extract environment:', { error: err });
      idwEnvironment = 'production'; // Default to production, not 'default'
    }
  }

  // Extract and persist accountId from the GSX URL if present.
  // This ensures the account ID captured from GSX tool URLs is available
  // to browser tabs (via settingsManager) for account selection after auth.
  try {
    const accountIdMatch = url.match(/accountId=([a-f0-9-]+)/i);
    if (accountIdMatch) {
      const { getSettingsManager } = require('../settings-manager');
      const settingsManager = getSettingsManager();
      const currentId = settingsManager.get('gsxAccountId');
      if (currentId !== accountIdMatch[1]) {
        settingsManager.set('gsxAccountId', accountIdMatch[1]);
        log.info('app', 'Persisted accountId from GSX URL to settings', { accountId: accountIdMatch[1] });
      }
    }
  } catch (err) {
    log.warn('app', 'Could not persist accountId from GSX URL', { error: err.message });
  }

  // Create session partition name based ONLY on the IDW environment
  // This allows all GSX windows in the same IDW group to share cookies
  // while keeping different IDW groups sandboxed from each other
  const partitionName = idwEnvironment ? `gsx-${idwEnvironment}` : `gsx-tool-${Date.now()}`;
  const fullPartition = `persist:${partitionName}`;

  log.info('app', 'Using shared session partition for IDW group', { partitionName: partitionName });

  // Multi-tenant token injection - inject BEFORE creating window
  // This ensures the token is available when the window first loads
  // Uses the hardened injection function with retry logic and verification
  if (idwEnvironment) {
    const multiTenantStore = require('../multi-tenant-store');

    // Use centralized injection with automatic registration
    const injectionResult = await multiTenantStore.injectAndRegister(idwEnvironment, fullPartition, {
      source: 'menu.openGSXLargeWindow',
    });

    if (injectionResult.success) {
      log.info('app', 'Token injection successful: cookies on', {
        injectionResult: injectionResult.cookieCount,
        injectionResult: injectionResult.domains.join(', '),
      });
    } else if (injectionResult.error) {
      log.warn('app', 'Token injection issue: - user may need to login manually', {
        injectionResult: injectionResult.error,
      });
    }
  }

  const gsxWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: windowTitle || title,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      partition: fullPartition, // Session partitioning for cookie isolation
      sandbox: false,
      webSecurity: true,
      webviewTag: false,
    },
    backgroundColor: '#1a1a1a',
    show: false,
  });

  // PERFORMANCE: Show responsive animated loading indicator immediately
  let loadingIndicatorInserted = false;
  gsxWindow.webContents.on('did-start-loading', () => {
    if (!loadingIndicatorInserted) {
      loadingIndicatorInserted = true;
      gsxWindow.webContents.insertCSS(`
        @keyframes gsx-pulse {
          0%, 100% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.02); }
        }
        @keyframes gsx-spin {
          to { transform: rotate(360deg); }
        }
        #gsx-loading-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          z-index: 99999;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          transition: opacity 0.3s ease-out;
        }
        #gsx-loading-overlay.gsx-fade-out {
          opacity: 0;
          pointer-events: none;
        }
        #gsx-loading-spinner {
          width: 48px;
          height: 48px;
          border: 3px solid rgba(255, 255, 255, 0.1);
          border-top-color: #4f8cff;
          border-radius: 50%;
          animation: gsx-spin 0.8s linear infinite;
          margin-bottom: 20px;
        }
        #gsx-loading-text {
          color: rgba(255, 255, 255, 0.9);
          font-size: 18px;
          font-weight: 500;
          animation: gsx-pulse 2s ease-in-out infinite;
        }
        #gsx-loading-status {
          color: rgba(255, 255, 255, 0.5);
          font-size: 12px;
          margin-top: 8px;
        }
      `);
      // Inject overlay HTML immediately
      gsxWindow.webContents
        .executeJavaScript(
          `
        if (!document.getElementById('gsx-loading-overlay')) {
          const overlay = document.createElement('div');
          overlay.id = 'gsx-loading-overlay';
          overlay.innerHTML = '<div id="gsx-loading-spinner"></div><div id="gsx-loading-text">${loadingMessage}</div><div id="gsx-loading-status">Connecting...</div>';
          document.body.appendChild(overlay);
        }
      `
        )
        .catch((err) => console.warn('[gsx-autologin] inject overlay:', err.message));
    }
  });

  // PERFORMANCE: Single consolidated did-finish-load handler
  gsxWindow.webContents.on('did-finish-load', () => {
    // Single executeJavaScript call with all UI setup
    gsxWindow.webContents
      .executeJavaScript(
        `
      (function() {
        // Hide loading overlay with animation
        const overlay = document.getElementById('gsx-loading-overlay');
        if (overlay) {
          overlay.classList.add('gsx-fade-out');
          setTimeout(() => overlay.remove(), 300);
        }
        
        // Skip if already initialized
        if (window.__gsxUIInitialized) return;
        window.__gsxUIInitialized = true;
        
        // ===== TOOLBAR =====
        if (!document.getElementById('gsx-minimal-toolbar')) {
          const toolbar = document.createElement('div');
          toolbar.id = 'gsx-minimal-toolbar';
          toolbar.innerHTML = '<button id="gsx-back" title="Back">&#9664;</button><button id="gsx-forward" title="Forward">&#9654;</button><button id="gsx-refresh" title="Refresh">&#8635;</button><button id="gsx-mission-control" title="Show All Windows">&#8862;</button><button id="gsx-close" title="Close Window">&times;</button>';
          
          const style = document.createElement('style');
          style.textContent = '#gsx-minimal-toolbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);padding:4px 8px;display:flex;gap:4px;border-radius:8px 8px 0 0;opacity:0.4;transition:opacity 0.3s,padding 0.2s}#gsx-minimal-toolbar:hover{opacity:1;padding:6px 10px}#gsx-minimal-toolbar button{background:transparent;border:none;color:rgba(255,255,255,0.7);width:28px;height:28px;border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all 0.2s}#gsx-minimal-toolbar button:hover{background:rgba(255,255,255,0.15);color:#fff;transform:scale(1.1)}#gsx-minimal-toolbar button:active{transform:scale(0.95)}#gsx-minimal-toolbar button:disabled{opacity:0.3;cursor:not-allowed}#gsx-minimal-toolbar button#gsx-close{margin-left:8px;border-left:1px solid rgba(255,255,255,0.1);padding-left:12px}#gsx-minimal-toolbar button#gsx-close:hover{background:rgba(255,59,48,0.2);color:#ff3b30}';
          document.head.appendChild(style);
          document.body.appendChild(toolbar);
          
          document.getElementById('gsx-back').onclick = () => history.back();
          document.getElementById('gsx-forward').onclick = () => history.forward();
          document.getElementById('gsx-refresh').onclick = () => window.electronAPI?.clearCacheAndReload?.() || location.reload();
          document.getElementById('gsx-mission-control').onclick = () => window.electronAPI?.triggerMissionControl?.();
          document.getElementById('gsx-close').onclick = () => window.close();
        }
        
        // ===== KEEP-ALIVE (lazy loaded after 5 seconds) =====
        setTimeout(() => {
          if (window.__gsxKeepAliveInitialized) return;
          window.__gsxKeepAliveInitialized = true;
          
          let lastPong = Date.now();
          let lastActivity = Date.now();
          let emergencyUIShown = false;
          
          if (window.electronAPI?.onPong) {
            window.electronAPI.onPong(() => { lastPong = Date.now(); });
          }
          
          // Backup ping only when idle for 4 minutes
          setInterval(() => {
            if (Date.now() - lastActivity > 240000 && window.electronAPI?.ping) {
              window.electronAPI.ping();
            }
          }, 60000);
          
          // Detect zombie state (no pong for 10 minutes)
          setInterval(() => {
            if (Date.now() - lastPong > 600000 && !emergencyUIShown) {
              emergencyUIShown = true;
              const banner = document.createElement('div');
              banner.innerHTML = '<div style="display:flex;align-items:center;gap:12px"><span style="font-size:20px">Warning</span><div style="flex:1"><div style="font-weight:600;margin-bottom:4px">Window Connection Lost</div><div style="font-size:12px;opacity:0.9">Close button may not work. Use Cmd+Q to quit the app.</div></div><button onclick="window.close()" style="background:rgba(255,59,48,0.2);border:1px solid #ff3b30;color:#ff3b30;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px">Try Close</button></div>';
              banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999999;background:rgba(255,165,0,0.95);color:white;padding:16px 24px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px';
              document.body.appendChild(banner);
            }
          }, 30000);
          
          // Track activity
          if (window.electronAPI) {
            const orig = window.electronAPI;
            window.electronAPI = new Proxy(orig, {
              get(t, p) {
                if (typeof t[p] === 'function' && p !== 'onPong') {
                  return (...a) => { lastActivity = Date.now(); return t[p](...a); };
                }
                return t[p];
              }
            });
          }
        }, 5000); // Lazy load keep-alive after 5 seconds
      })();
    `
      )
      .catch((err) => log.error('app', 'Error injecting UI', { error: err }));
  });

  // Auto-login handling for GSX windows - ONLY when idwEnvironment is explicitly set
  // This prevents auto-login for non-GSX tools or when user wants manual login
  if (idwEnvironment) {
    const gsxAutoLoginState = { inProgress: false, complete: false };

    // Handle full page navigation (for auth redirects from GSX apps)
    gsxWindow.webContents.on('did-navigate', async (event, navUrl) => {
      log.info('app', 'Full navigation', { navUrl: navUrl });

      // Auto-login for auth pages (when GSX redirects to auth.*.onereach.ai)
      if (navUrl && navUrl.includes('auth.') && navUrl.includes('onereach.ai')) {
        if (gsxAutoLoginState.inProgress || gsxAutoLoginState.complete) {
          log.info('app', 'Skipping - already in progress or complete');
          return;
        }
        gsxAutoLoginState.inProgress = true;
        log.info('app', 'Auth page detected via redirect, starting auto-login...');

        // Update loading status to show auto-login in progress
        gsxWindow.webContents
          .executeJavaScript(
            `
          const status = document.getElementById('gsx-loading-status');
          if (status) status.textContent = 'Signing in...';
        `
          )
          .catch((err) => console.warn('[gsx-autologin] update loading status:', err.message));

        // Wait for form to render, then attempt login with retries
        const attemptWithRetries = async (attempt = 0) => {
          const maxAttempts = 5;
          const delay = 800 + attempt * 400; // 800ms, 1200ms, 1600ms, 2000ms, 2400ms

          log.info('app', 'Attempt / after ms delay', {
            attempt1: attempt + 1,
            maxAttempts: maxAttempts,
            delay: delay,
          });

          await new Promise((resolve) => {
            setTimeout(resolve, delay);
          });

          // Check window state before attempting
          if (gsxWindow.isDestroyed()) {
            log.info('app', 'Window destroyed, aborting retries');
            return;
          }

          // Check if already completed (e.g., user manually logged in)
          if (gsxAutoLoginState.complete) {
            log.info('app', 'Login already completed, skipping');
            return;
          }

          try {
            const result = await attemptGSXAutoLogin(gsxWindow, navUrl, gsxAutoLoginState, idwEnvironment);

            // If form wasn't found and we have retries left, try again
            if (result === 'no_form' && attempt < maxAttempts - 1 && !gsxAutoLoginState.complete) {
              log.info('app', 'Form not found or fill failed, retrying...');
              await attemptWithRetries(attempt + 1);
            } else if (result === 'no_form' && attempt >= maxAttempts - 1) {
              log.info('app', 'Max retries reached, giving up');
              gsxAutoLoginState.inProgress = false;
            }
          } catch (err) {
            // Don't log window destroyed errors as they're expected
            if (err.message && !err.message.includes('destroyed')) {
              log.error('app', 'Error', { error: err.message });
            }

            if (attempt < maxAttempts - 1 && !gsxWindow.isDestroyed()) {
              log.info('app', 'Error occurred, retrying...');
              await attemptWithRetries(attempt + 1);
            } else {
              gsxAutoLoginState.inProgress = false;
            }
          }
        };

        attemptWithRetries(0);
      }
    });
  }

  // Error handling - show helpful messages for access issues
  gsxWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.info('app', 'Load failed: - for', {
      errorCode: errorCode,
      errorDescription: errorDescription,
      validatedURL: validatedURL,
    });

    const errorPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
          }
          .error-container {
            max-width: 500px;
            text-align: center;
            background: rgba(255,255,255,0.05);
            padding: 40px;
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.1);
          }
          h1 { color: #ff6b6b; margin-bottom: 16px; font-size: 24px; }
          .error-code { color: #888; font-size: 14px; margin-bottom: 24px; }
          p { line-height: 1.6; margin-bottom: 16px; }
          .suggestions { text-align: left; background: rgba(0,0,0,0.2); padding: 20px; border-radius: 8px; margin-top: 20px; }
          .suggestions h3 { margin-top: 0; color: #4ecdc4; }
          .suggestions ul { margin: 0; padding-left: 20px; }
          .suggestions li { margin-bottom: 8px; }
          .btn { display: inline-block; padding: 12px 24px; background: #4ecdc4; color: #1a1a2e; border-radius: 8px; text-decoration: none; margin-top: 20px; font-weight: 600; cursor: pointer; border: none; }
          .btn:hover { background: #45b7aa; }
          .url { word-break: break-all; font-size: 12px; color: #666; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="error-container">
          <h1>Unable to Load GSX</h1>
          <p class="error-code">Error: ${errorDescription || 'Connection failed'} (${errorCode})</p>
          <p>The GSX application couldn't be loaded. This might be a temporary issue or an access problem.</p>
          
          <div class="suggestions">
            <h3>Possible Solutions</h3>
            <ul>
              <li><strong>Check your internet connection</strong> - Make sure you're connected to the network</li>
              <li><strong>Verify access permissions</strong> - You may need to request access from your administrator</li>
              <li><strong>Guest users</strong> - If you only have guest access, you may need to upgrade to user access for GSX tools</li>
              <li><strong>VPN required</strong> - Some environments require VPN connection</li>
              <li><strong>Try again later</strong> - The service might be temporarily unavailable</li>
            </ul>
          </div>
          
          <button class="btn" onclick="location.reload()">Try Again</button>
          <p class="url">URL: ${validatedURL}</p>
        </div>
      </body>
      </html>
    `;

    gsxWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPage)}`);
  });

  // Detect access denied errors from page content
  gsxWindow.webContents.on('did-finish-load', async () => {
    // Check for common access error patterns after page loads
    try {
      const accessCheck = await gsxWindow.webContents.executeJavaScript(`
        (function() {
          const body = document.body ? document.body.innerText : '';
          const title = document.title || '';
          
          // Check for common access error patterns
          const accessDenied = /access denied|unauthorized|forbidden|not authorized|permission denied|403|401/i;
          const noAccount = /unexpected account|account not found|invalid account|no access/i;
          const needsAccess = /request access|contact administrator|upgrade.*account/i;
          
          if (accessDenied.test(body) || accessDenied.test(title)) {
            return { error: true, type: 'access_denied', message: body.substring(0, 500) };
          }
          if (noAccount.test(body)) {
            return { error: true, type: 'wrong_account', message: body.substring(0, 500) };
          }
          if (needsAccess.test(body)) {
            return { error: true, type: 'needs_access', message: body.substring(0, 500) };
          }
          return { error: false };
        })()
      `);

      if (accessCheck.error) {
        log.info('app', 'Access issue detected', { accessCheck: accessCheck.type });

        const errorMessages = {
          access_denied: {
            title: 'Access Denied',
            desc: 'You do not have permission to access this GSX tool.',
            tip: 'Contact your administrator to request access to this account.',
          },
          wrong_account: {
            title: 'Account Mismatch',
            desc: 'This GSX tool is configured for a different account than you have access to.',
            tip: 'The account ID in the URL may not match your permissions. Contact your administrator.',
          },
          needs_access: {
            title: 'Access Required',
            desc: 'Additional permissions are needed to use this tool.',
            tip: 'You may have guest access only. Request user-level access from your administrator.',
          },
        };

        const errInfo = errorMessages[accessCheck.type] || errorMessages.access_denied;

        const accessErrorPage = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                color: #e0e0e0;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                padding: 20px;
                box-sizing: border-box;
              }
              .error-container {
                max-width: 550px;
                text-align: center;
                background: rgba(255,255,255,0.05);
                padding: 40px;
                border-radius: 16px;
                border: 1px solid rgba(255,255,255,0.1);
              }
              h1 { color: #feca57; margin-bottom: 16px; font-size: 24px; }
              p { line-height: 1.6; margin-bottom: 16px; }
              .tip { background: rgba(78, 205, 196, 0.1); border-left: 3px solid #4ecdc4; padding: 16px; text-align: left; border-radius: 4px; margin: 20px 0; }
              .tip strong { color: #4ecdc4; }
              .actions { margin-top: 24px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
              .btn { padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; cursor: pointer; border: none; }
              .btn-primary { background: #4ecdc4; color: #1a1a2e; }
              .btn-secondary { background: rgba(255,255,255,0.1); color: #e0e0e0; }
              .btn:hover { opacity: 0.9; }
            </style>
          </head>
          <body>
            <div class="error-container">
              <h1>${errInfo.title}</h1>
              <p>${errInfo.desc}</p>
              
              <div class="tip">
                <strong>Tip:</strong> ${errInfo.tip}
              </div>
              
              <div class="actions">
                <button class="btn btn-primary" onclick="location.reload()">Try Again</button>
                <button class="btn btn-secondary" onclick="window.close()">Close Window</button>
              </div>
            </div>
          </body>
          </html>
        `;

        gsxWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(accessErrorPage)}`);
      }
    } catch (_err) {
      // Ignore errors from checking - page might be navigating
    }
  });

  // Load the URL
  gsxWindow.loadURL(url);

  // Handle navigation to keep everything in the app window
  gsxWindow.webContents.on('new-window', (event, navUrl) => {
    event.preventDefault();
    // Navigate in the same window for onereach domains
    if (navUrl.includes('onereach.ai')) {
      gsxWindow.loadURL(navUrl);
    } else {
      // Open external URLs in browser
      shell.openExternal(navUrl);
    }
  });

  // Show window when ready
  gsxWindow.once('ready-to-show', () => {
    gsxWindow.show();
  });

  // Add forced close handler to prevent zombie windows
  let isClosing = false;
  gsxWindow.on('close', (event) => {
    if (isClosing) return; // Already closing, don't interfere

    log.info('app', 'Close requested', { title: title });
    isClosing = true;

    // Prevent default to control the shutdown
    event.preventDefault();

    // Try to notify renderer
    try {
      gsxWindow.webContents.send('window-closing');
    } catch (e) {
      log.info('app', 'Could not send closing signal', { error: e.message });
    }

    // Force destroy after short delay (500ms for state save)
    setTimeout(() => {
      if (!gsxWindow.isDestroyed()) {
        log.info('app', 'Force destroying', { title: title });
        gsxWindow.destroy();
      }
    }, 500);
  });

  // Register for tracking
  registerGSXWindow(gsxWindow, title);

  return gsxWindow;
}

/**
 * Helper function to open learning content in an app window
 * @param {string} url The URL to load
 * @param {string} title The window title
 * @returns {BrowserWindow} The created window
 */
function openLearningWindow(url, title = 'Agentic University') {
  const getLogger = require('../event-logger');
  const logger = getLogger();

  // Log the learning content access
  if (logger && logger.info) {
    logger.info('Learning Content Accessed', {
      action: 'learning_window_open',
      title: title,
      url: url,
      timestamp: new Date().toISOString(),
    });
  }
  log.info('app', 'User opened learning content: -', { title: title, url: url });

  const learningWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: `Agentic University - ${title}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      sandbox: false,
      webSecurity: true,
      webviewTag: false,
    },
    backgroundColor: '#1a1a1a',
    show: false,
  });

  // Show loading indicator with a unique class
  let loadingIndicatorInserted = false;
  learningWindow.webContents.on('did-start-loading', () => {
    if (!loadingIndicatorInserted) {
      loadingIndicatorInserted = true;
      learningWindow.webContents.insertCSS(`
        body::before {
          content: 'Loading...';
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 24px;
          color: #666;
          z-index: 99999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: rgba(255, 255, 255, 0.95);
          padding: 20px 40px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        body.learning-loaded::before {
          display: none !important;
        }
      `);
    }
  });

  // Remove loading indicator when page finishes loading
  learningWindow.webContents.on('did-finish-load', () => {
    // Add class to hide the loading indicator
    learningWindow.webContents
      .executeJavaScript(
        `
      document.body.classList.add('learning-loaded');
    `
      )
      .catch((err) => log.error('app', 'Error hiding loading indicator', { error: err }));

    // Apply custom CSS for Wiser Method site (fix dark text on dark bg)
    if (url.includes('wisermethod.com')) {
      learningWindow.webContents
        .insertCSS(
          `
        /* Fix text visibility on Wiser Method */
        body, p, span, div, h1, h2, h3, h4, h5, h6, li, a, td, th, label {
          color: #e0e0e0 !important;
        }
        a {
          color: #7eb3ff !important;
        }
        a:hover {
          color: #aaccff !important;
        }
        /* Keep buttons and specific elements readable */
        button, input, select, textarea {
          color: #333 !important;
          background-color: #fff !important;
        }
        /* Ensure headings stand out */
        h1, h2, h3 {
          color: #ffffff !important;
        }
      `
        )
        .catch((err) => log.error('app', 'Error injecting Wiser Method CSS', { error: err }));
    }
  });

  // Also remove on did-stop-loading as a fallback
  learningWindow.webContents.on('did-stop-loading', () => {
    learningWindow.webContents
      .executeJavaScript(
        `
      document.body.classList.add('learning-loaded');
    `
      )
      .catch((err) => log.error('app', 'Error hiding loading indicator', { error: err }));
  });

  // Load the URL
  learningWindow.loadURL(url);

  // Handle navigation to keep everything in the app window
  learningWindow.webContents.on('new-window', (event, navUrl) => {
    event.preventDefault();
    // If it's a learning.staging.onereach.ai URL, navigate in the same window
    if (navUrl.includes('learning.staging.onereach.ai') || navUrl.includes('learning.onereach.ai')) {
      learningWindow.loadURL(navUrl);
    } else {
      // Otherwise open in external browser
      shell.openExternal(navUrl);
    }
  });

  // Handle will-navigate for links
  learningWindow.webContents.on('will-navigate', (event, navUrl) => {
    // Allow navigation within the learning domain
    if (!navUrl.includes('learning.staging.onereach.ai') && !navUrl.includes('learning.onereach.ai')) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  // Show window when ready
  learningWindow.once('ready-to-show', () => {
    learningWindow.show();
  });

  // Log window creation
  log.info('app', 'Created learning window for', { title: title });

  return learningWindow;
}

module.exports = {
  openGSXLargeWindow,
  openLearningWindow,
  attemptGSXAutoLogin,
  handleGSX2FA,
  WindowDestroyedError,
  sleep,
};
