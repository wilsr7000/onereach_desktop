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
const authScripts = require('./auth-scripts');

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
    log.info('app', 'Rate limited, please wait', { environment, waitSeconds: Math.ceil(waitMs / 1000) });
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

// Auth selectors and script builders from shared module (lib/auth-scripts.js)
const { SELECTORS: _AUTH_SELECTORS } = authScripts;

/**
 * Find the auth frame in the window's frame tree.
 * @param {BrowserWindow} gsxWindow
 * @returns {WebFrameMain|null}
 */
function findAuthFrame(gsxWindow) {
  if (!gsxWindow || gsxWindow.isDestroyed()) return null;
  try {
    const mainFrame = gsxWindow.webContents.mainFrame;
    const allFrames = [mainFrame, ...mainFrame.framesInSubtree];
    return allFrames.find((f) => f.url && f.url.includes('auth.') && f.url.includes('onereach.ai')) || null;
  } catch {
    return null;
  }
}

/**
 * Poll for the auth frame to appear in the frame tree.
 * Necessary because did-navigate may fire before sub-frames are enumerable.
 *
 * @param {BrowserWindow} gsxWindow
 * @param {number} timeoutMs
 * @returns {Promise<WebFrameMain|null>}
 */
async function waitForAuthFrame(gsxWindow, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (gsxWindow.isDestroyed()) throw new WindowDestroyedError();
    const frame = findAuthFrame(gsxWindow);
    if (frame) return frame;
    await sleep(200);
  }
  return null;
}

/**
 * Wait for auth form elements to render using a MutationObserver.
 * Resolves immediately if elements already exist, otherwise observes DOM
 * mutations until they appear or timeout is reached.
 *
 * @param {BrowserWindow} gsxWindow
 * @param {WebFrameMain} frame - The auth frame to observe
 * @param {number} timeoutMs - Max wait (default 10s)
 * @returns {Promise<Object>} Page type detection result
 */
async function waitForAuthForm(gsxWindow, frame, timeoutMs = 10000) {
  const script = authScripts.buildWaitForAuthFormScript(timeoutMs);
  return safeFrameExecute(gsxWindow, frame, script, { timeout: timeoutMs + 3000, retries: 0 });
}

/**
 * Wait for a page transition after submitting credentials or 2FA.
 * Alternates between checking if the auth frame has disappeared (success)
 * and injecting a short-lived MutationObserver for 2FA / error elements.
 *
 * @param {BrowserWindow} gsxWindow
 * @param {WebFrameMain} originalAuthFrame
 * @param {number} timeoutMs
 * @param {Function} [isCancelled] Optional callback that returns true to abort early
 * @returns {Promise<Object>}
 */
async function waitForPostSubmitTransition(gsxWindow, originalAuthFrame, timeoutMs = 8000, isCancelled) {
  const start = Date.now();
  await sleep(200);

  while (Date.now() - start < timeoutMs) {
    if (gsxWindow.isDestroyed()) throw new WindowDestroyedError();
    if (isCancelled && isCancelled()) return { authFrameGone: true };

    if (!findAuthFrame(gsxWindow)) return { authFrameGone: true };

    try {
      const state = await safeFrameExecute(
        gsxWindow,
        originalAuthFrame,
        authScripts.buildAuthStateCheckScript(),
        { timeout: 2000, retries: 0 },
      );

      if (state.has2FA) return { is2FAPage: true };
      if (state.hasError) return { hasError: true, message: state.errorMessage };
      if (state.isAccountSelect) return { isAccountSelect: true };
    } catch {
      if (!findAuthFrame(gsxWindow)) return { authFrameGone: true };
    }

    await sleep(300);
  }

  return { timeout: true };
}

/**
 * One-shot check for account selection elements on the auth frame.
 * Used as a final probe when waitForPostSubmitTransition times out.
 *
 * @param {BrowserWindow} gsxWindow
 * @param {WebFrameMain} authFrame
 * @returns {Promise<boolean>}
 */
async function checkForAccountSelection(gsxWindow, authFrame) {
  try {
    const state = await safeFrameExecute(
      gsxWindow,
      authFrame,
      authScripts.buildAuthStateCheckScript(),
      { timeout: 2000, retries: 0 },
    );
    return !!(state && state.isAccountSelect);
  } catch {
    return false;
  }
}

/**
 * Auto-select the correct account on an account picker page in a GSX auth frame.
 * After login + 2FA, multi-account users see an account selection page.
 * This finds and clicks the element matching the target accountId.
 *
 * @param {BrowserWindow} gsxWindow
 * @param {WebFrameMain} authFrame
 * @param {string} targetAccountId
 * @returns {Promise<boolean>} true if account was selected
 */
async function selectAccountInAuthFrame(gsxWindow, authFrame, targetAccountId) {
  if (!targetAccountId) return false;

  log.info('app', 'Attempting account selection in GSX auth frame', { targetAccountId });

  const result = await safeFrameExecute(
    gsxWindow,
    authFrame,
    authScripts.buildSelectAccountScript(targetAccountId),
    { timeout: 5000, retries: 1 },
  );

  if (result && result.success) {
    log.info('app', 'Account selected in GSX auth frame', { method: result.method, text: result.text, targetAccountId });
    return true;
  }

  log.warn('app', 'Could not find target account on selection page', { targetAccountId, reason: result?.reason, bodyText: result?.bodyText });
  return false;
}

/**
 * Handle account selection page during GSX auto-login.
 * Attempts to auto-select the target account, then waits for the auth frame
 * to disappear (indicating successful redirect to the GSX tool).
 */
async function handleAccountSelection(gsxWindow, authFrame, state, environment) {
  const getLogger = require('../event-logger');
  const logger = getLogger();

  // Resolve targetAccountId with fallback chain:
  // 1. state.targetAccountId (from creation URL)
  // 2. Re-extract from original URL (in case it was lost)
  // 3. Global gsxAccountId from settings
  let targetAccountId = state.targetAccountId;
  if (!targetAccountId && state.originalUrl) {
    const match = state.originalUrl.match(/accountId=([a-f0-9-]+)/i);
    if (match) targetAccountId = match[1];
  }
  if (!targetAccountId) {
    try {
      const { getSettingsManager } = require('../settings-manager');
      const settingsManager = getSettingsManager();
      targetAccountId = settingsManager.get('gsxAccountId') || null;
      if (targetAccountId) {
        log.info('app', 'Using gsxAccountId from settings as fallback', { targetAccountId });
      }
    } catch (_e) { /* settings unavailable */ }
  }

  logger.info('[Auth GSX] Account selection page detected', {
    event: 'auth:gsx-account-select',
    environment,
    targetAccountId,
    feature: 'auto-login',
  });

  if (!targetAccountId) {
    log.warn('app', 'Account selection page but no targetAccountId from any source');
    state.inProgress = false;
    return;
  }

  await updateStatusOverlay(gsxWindow, 'Selecting account...', 'loading');

  const selected = await selectAccountInAuthFrame(gsxWindow, authFrame, targetAccountId);
  if (selected) {
    // Wait for the auth frame to disappear after account selection
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (gsxWindow.isDestroyed()) return;
      if (state.complete) return;
      if (!findAuthFrame(gsxWindow)) {
        logger.info('[Auth GSX] Account selected, redirected to GSX', {
          event: 'auth:gsx-account-selected',
          environment,
          targetAccountId,
          feature: 'auto-login',
        });
        recordLoginAttempt(environment, true);
        await hideStatusOverlay(gsxWindow, true);
        state.complete = true;
        state.inProgress = false;
        return;
      }
      await sleep(300);
    }
    log.warn('app', 'Auth frame still present after account selection, may need manual action');
  } else {
    log.warn('app', 'Could not auto-select account, leaving picker visible for user');
  }

  await hideStatusOverlay(gsxWindow, false);
  state.inProgress = false;
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
  const { confirmAutoLogin } = require('./auto-login-prompt');

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

    // Check global + per-environment settings
    const settingsManager = global.settingsManager;
    const settings = settingsManager ? settingsManager.getAll() : {};
    const autoLoginSettings = settings.autoLoginSettings || {};

    if (autoLoginSettings.enabled === false) {
      logger.info('[Auth GSX] Auto-login disabled in settings', {
        event: 'auth:gsx-disabled',
        environment,
        feature: 'auto-login',
      });
      state.inProgress = false;
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
      const keychainError = credentialManager.getLastError();
      const message = keychainError
        ? `Keychain access failed: ${keychainError}`
        : 'No saved credentials -- configure in Settings';
      logger.warn('[Auth GSX] No credentials configured', {
        event: 'auth:gsx-no-credentials',
        environment,
        keychainError,
        feature: 'auto-login',
      });
      await updateStatusOverlay(gsxWindow, message, 'error', {
        showManual: true,
      });
      state.inProgress = false;
      return;
    }

    // Prompt user for confirmation (respects session memory + per-environment flags)
    const confirmResult = await confirmAutoLogin(gsxWindow, credentials.email, autoLoginSettings, environment);
    if (!confirmResult.allowed) {
      logger.info('[Auth GSX] Auto-login not proceeding', {
        event: 'auth:gsx-blocked',
        reason: confirmResult.reason,
        environment,
        feature: 'auto-login',
      });
      if (confirmResult.reason === 'environment') {
        await updateStatusOverlay(
          gsxWindow,
          `Auto-login is disabled for ${environment} -- enable it in Settings > OneReach Login`,
          'error',
          { showManual: true }
        );
      } else if (confirmResult.reason === 'disabled') {
        await updateStatusOverlay(gsxWindow, 'Auto-login is disabled -- enable it in Settings', 'error', { showManual: true });
      } else {
        await hideStatusOverlay(gsxWindow);
      }
      state.inProgress = false;
      return;
    }

    // Update status
    await updateStatusOverlay(gsxWindow, 'Signing in...', 'loading');

    // Check if window is still valid
    if (gsxWindow.isDestroyed()) {
      throw new WindowDestroyedError();
    }

    // Wait for auth frame to appear in the frame tree
    const authFrame = await waitForAuthFrame(gsxWindow);
    if (!authFrame) {
      log.info('app', 'No auth frame found');
      state.inProgress = false;
      await hideStatusOverlay(gsxWindow);
      return;
    }

    log.info('app', 'Found auth frame', { url: authFrame.url });

    // Wait for form elements to render (MutationObserver-based, no blind sleeping)
    const pageType = await waitForAuthForm(gsxWindow, authFrame);

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
      const fillScript = authScripts.buildFillLoginScript(credentials.email, credentials.password, { autoSubmit: false });
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
        authScripts.buildSubmitButtonScript()
      ).catch((err) => log.info('app', 'Submit click error (may be expected)', { error: err.message }));

      // Wait for page transition after submit (2FA page, account select, error, or redirect)
      if (!gsxWindow.isDestroyed()) {
        const postSubmit = await waitForPostSubmitTransition(gsxWindow, authFrame, 8000, () => state.complete);
        if (postSubmit.hasError) {
          logger.warn('[Auth GSX] Login error detected after submit', {
            event: 'auth:gsx-submit-error',
            environment,
            message: postSubmit.message,
            feature: 'auto-login',
          });
          recordLoginAttempt(environment, false);
          return 'no_form';
        }
        if (postSubmit.isAccountSelect && !gsxWindow.isDestroyed()) {
          await handleAccountSelection(gsxWindow, authFrame, state, environment);
        } else if (postSubmit.timeout && !gsxWindow.isDestroyed()) {
          // Timeout: do one final account-select probe before falling through to 2FA
          const finalCheck = await checkForAccountSelection(gsxWindow, authFrame);
          if (finalCheck && !gsxWindow.isDestroyed()) {
            await handleAccountSelection(gsxWindow, authFrame, state, environment);
          } else if (!gsxWindow.isDestroyed()) {
            await handleGSX2FA(gsxWindow, state, environment, 0);
          }
        } else if (!gsxWindow.isDestroyed()) {
          await handleGSX2FA(gsxWindow, state, environment, 0);
        }
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

      // Setup retry handler via IPC bridge
      try {
        await gsxWindow.webContents.executeJavaScript(`
          window.__gsxRetryLogin = function() {
            if (window.electronAPI && window.electronAPI.retryAutoLogin) {
              window.electronAPI.retryAutoLogin();
            }
          };
        `);
      } catch (_e) {
        // Window may be destroyed
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
    // Check window destruction or manual completion
    if (!gsxWindow || gsxWindow.isDestroyed()) {
      throw new WindowDestroyedError();
    }
    if (state.complete) return;

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
      authScripts.buildAuthStateCheckScript()
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
      log.info('app', 'No 2FA input found, observing for changes...');
      const observed = await waitForAuthForm(gsxWindow, authFrame, 3000).catch(() => null);
      if (observed?.is2FAPage && !gsxWindow.isDestroyed()) {
        await handleGSX2FA(gsxWindow, state, environment, attempt);
      } else if (!gsxWindow.isDestroyed()) {
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

    // TOTP TIMING CHECK - Wait for fresh code if near expiration.
    // Threshold of 8s accounts for fill + submit + network latency.
    const totpManager = new TOTPManager();
    let timeRemaining = totpManager.getTimeRemaining();

    if (timeRemaining < 8) {
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

    // Fill 2FA form with React-compatible approach (submit done separately below)
    const result = await safeFrameExecute(
      gsxWindow,
      authFrame,
      authScripts.buildFillTOTPScript(totpCode, { autoSubmit: false })
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
      authScripts.buildSubmitButtonScript(['verify', 'submit', 'continue', 'confirm'])
    ).catch((err) => log.info('app', '2FA submit error (may be expected)', { error: err.message }));

    // Wait for 2FA submission result (auth frame disappears, account select, or error)
    const postSubmit = await waitForPostSubmitTransition(gsxWindow, authFrame, 8000, () => state.complete);
    if (postSubmit.authFrameGone) {
      logger.info('[Auth GSX] 2FA completed, auth frame gone', {
        event: 'auth:gsx-2fa-redirect',
        environment,
        feature: 'auto-login',
      });
      recordLoginAttempt(environment, true);
      await hideStatusOverlay(gsxWindow, true);
      state.complete = true;
      state.inProgress = false;
      return;
    }

    // Account selection page after 2FA
    if (postSubmit.isAccountSelect && !gsxWindow.isDestroyed()) {
      await handleAccountSelection(gsxWindow, authFrame, state, environment);
      return;
    }

    // Timeout: final account-select probe before treating as auth failure
    if (postSubmit.timeout && !gsxWindow.isDestroyed()) {
      const finalCheck = await checkForAccountSelection(gsxWindow, authFrame);
      if (finalCheck) {
        await handleAccountSelection(gsxWindow, authFrame, state, environment);
        return;
      }
    }

    // Check if we're still on auth page (indicates failure)
    if (!gsxWindow.isDestroyed()) {
      const authState = await safeFrameExecute(
        gsxWindow,
        authFrame,
        authScripts.buildAuthStateCheckScript()
      ).catch(() => ({ has2FA: false, hasError: false }));
      const stillOnAuth = { stillOnPage: authState.has2FA, hasError: authState.hasError };

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

  // Extract accountId from the GSX URL for per-account session isolation.
  // Each account needs its own partition so auth sessions don't bleed across accounts.
  let urlAccountId = null;
  try {
    const accountIdMatch = url.match(/accountId=([a-f0-9-]+)/i);
    if (accountIdMatch) {
      urlAccountId = accountIdMatch[1];
    }
  } catch (err) {
    log.warn('app', 'Could not extract accountId from GSX URL', { error: err.message });
  }

  // Partition key includes both environment AND accountId so each account
  // gets its own cookie jar. Without this, opening Account B reuses Account A's session.
  const partitionKey = urlAccountId
    ? `gsx-${idwEnvironment}-${urlAccountId}`
    : (idwEnvironment ? `gsx-${idwEnvironment}` : `gsx-tool-${Date.now()}`);
  const fullPartition = `persist:${partitionKey}`;

  log.info('app', 'Using session partition for GSX window', { partition: partitionKey, accountId: urlAccountId });

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
      log.info('app', 'Token injection successful', {
        cookieCount: injectionResult.cookieCount,
        domains: injectionResult.domains.join(', '),
      });
    } else if (injectionResult.error) {
      log.warn('app', 'Token injection issue, user may need to login manually', {
        error: injectionResult.error,
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
      backgroundThrottling: false,
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
          toolbar.innerHTML = '<button id="gsx-back" title="Back">&#9664;</button><button id="gsx-forward" title="Forward">&#9654;</button><button id="gsx-refresh" title="Refresh">&#8635;</button><button id="gsx-devtools-toggle" title="Toggle Info Bar">&#9881;</button><span id="gsx-ctx-label"></span><button id="gsx-devtools-menu" title="Dev Tools Menu">&#9776;</button><button id="gsx-mission-control" title="Show All Windows">&#8862;</button><button id="gsx-close" title="Close Window">&times;</button>';
          
          const style = document.createElement('style');
          style.textContent = '#gsx-minimal-toolbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);padding:4px 8px;display:flex;gap:4px;border-radius:8px 8px 0 0;opacity:0.4;transition:opacity 0.3s,padding 0.2s}#gsx-minimal-toolbar:hover{opacity:1;padding:6px 10px}#gsx-minimal-toolbar button{background:transparent;border:none;color:rgba(255,255,255,0.7);width:28px;height:28px;border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all 0.2s}#gsx-minimal-toolbar button:hover{background:rgba(255,255,255,0.15);color:#fff;transform:scale(1.1)}#gsx-minimal-toolbar button:active{transform:scale(0.95)}#gsx-minimal-toolbar button:disabled{opacity:0.3;cursor:not-allowed}#gsx-minimal-toolbar button#gsx-devtools-toggle{color:rgba(147,197,253,0.8)}#gsx-minimal-toolbar button#gsx-devtools-toggle:hover{background:rgba(37,99,235,0.25);color:#93c5fd}#gsx-minimal-toolbar button#gsx-devtools-toggle.active{color:#60a5fa;background:rgba(37,99,235,0.2)}#gsx-minimal-toolbar button#gsx-devtools-menu{color:rgba(147,197,253,0.8)}#gsx-minimal-toolbar button#gsx-devtools-menu:hover{background:rgba(37,99,235,0.25);color:#93c5fd}#gsx-minimal-toolbar button#gsx-devtools-menu.active{color:#60a5fa;background:rgba(37,99,235,0.2)}#gsx-ctx-label{font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0;opacity:0;transition:max-width 0.3s,opacity 0.3s,padding 0.3s;font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:28px;padding:0}#gsx-ctx-label.has-context{max-width:300px;opacity:1;padding:0 4px}#gsx-ctx-label .ctx-flow{color:rgba(226,232,240,0.8);font-weight:500}#gsx-ctx-label .ctx-sep{color:rgba(100,116,139,0.5);margin:0 3px}#gsx-ctx-label .ctx-step{color:rgba(167,139,250,0.9);font-weight:500}#gsx-minimal-toolbar:hover #gsx-ctx-label{opacity:1}#gsx-minimal-toolbar button#gsx-close{margin-left:8px;border-left:1px solid rgba(255,255,255,0.1);padding-left:12px}#gsx-minimal-toolbar button#gsx-close:hover{background:rgba(255,59,48,0.2);color:#ff3b30}#gsx-devtools-dropdown{position:fixed;bottom:36px;left:50%;transform:translateX(-50%);z-index:999997;background:rgba(15,23,42,0.95);backdrop-filter:blur(12px);border:1px solid rgba(59,130,246,0.25);border-radius:8px;padding:4px 0;min-width:230px;max-height:70vh;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:none}#gsx-devtools-dropdown::-webkit-scrollbar{width:4px}#gsx-devtools-dropdown::-webkit-scrollbar-thumb{background:rgba(100,116,139,0.3);border-radius:2px}#gsx-devtools-dropdown.open{display:block}#gsx-devtools-dropdown .dt-group-hdr{display:flex;align-items:center;gap:6px;padding:6px 14px;font-size:10px;font-weight:600;color:rgba(148,163,184,0.7);text-transform:uppercase;letter-spacing:0.8px;cursor:pointer;user-select:none}#gsx-devtools-dropdown .dt-group-hdr:hover{color:rgba(148,163,184,1)}#gsx-devtools-dropdown .dt-group-hdr .dt-chevron{font-size:8px;transition:transform 0.15s;display:inline-block}#gsx-devtools-dropdown .dt-group-hdr.open .dt-chevron{transform:rotate(90deg)}#gsx-devtools-dropdown .dt-group-items{display:none;padding-bottom:2px}#gsx-devtools-dropdown .dt-group-items.open{display:block}#gsx-devtools-dropdown .dt-item{display:flex;align-items:center;gap:8px;padding:6px 14px 6px 24px;font-size:12px;color:rgba(255,255,255,0.35);cursor:default;white-space:nowrap}#gsx-devtools-dropdown .dt-item .dt-label{flex:1}#gsx-devtools-dropdown .dt-item .dt-badge{font-size:9px;color:rgba(100,116,139,0.6);border:1px solid rgba(100,116,139,0.25);padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px}#gsx-devtools-dropdown .dt-item.enabled{color:rgba(255,255,255,0.85);cursor:pointer}#gsx-devtools-dropdown .dt-item.enabled:hover{background:rgba(59,130,246,0.15)}#gsx-devtools-dropdown .dt-sep{height:1px;background:rgba(255,255,255,0.06);margin:2px 0}';
          document.head.appendChild(style);
          document.body.appendChild(toolbar);
          
          document.getElementById('gsx-back').onclick = () => history.back();
          document.getElementById('gsx-forward').onclick = () => history.forward();
          document.getElementById('gsx-refresh').onclick = () => {
            if (window.electronAPI?.clearCacheAndReload) {
              window.electronAPI.clearCacheAndReload();
            } else {
              location.reload();
            }
          };
          document.getElementById('gsx-mission-control').onclick = () => window.electronAPI?.triggerMissionControl?.();
          document.getElementById('gsx-close').onclick = () => window.close();

          document.getElementById('gsx-devtools-toggle').onclick = () => {
            const bar = document.getElementById('gsx-devtools-bar');
            const btn = document.getElementById('gsx-devtools-toggle');
            if (bar) {
              const hidden = bar.style.display === 'none';
              bar.style.display = hidden ? 'flex' : 'none';
              btn.classList.toggle('active', hidden);
            }
          };
          document.getElementById('gsx-devtools-menu').onclick = (e) => {
            e.stopPropagation();
            let dd = document.getElementById('gsx-devtools-dropdown');
            if (!dd) {
              dd = document.createElement('div');
              dd.id = 'gsx-devtools-dropdown';
              const groups = [
                { name: 'Flow', open: true, items: [
                  { label: 'Evaluate Flow', action: 'evaluate-flow' },
                  { label: 'Evaluate Flow Logs', action: 'evaluate-flow-logs' },
                  { label: 'Add Intelligent Error Handling' },
                  { label: 'Make Flow Self Learning' },
                ]},
                { name: 'Step', open: true, items: [
                  { id: 'gsx-dt-configure-step', label: 'Configure Step', action: 'configure-step', needsStep: true },
                  { id: 'gsx-dt-validate-step', label: 'Validate Step', action: 'validate-step', needsStep: true },
                  { label: 'Evaluate Step', needsStep: true },
                  { label: 'Add Functionality to Step', needsStep: true },
                  { label: 'Suggest Next Step', needsStep: true },
                ]},
                { name: 'Build', items: [
                  { label: 'Build a Step Template', action: 'build-step-template' },
                  { label: 'Build a Flow' },
                  { label: 'Create Mock Step' },
                  { label: 'Generate Step from Mock' },
                  { label: 'Create Subflow' },
                ]},
                { name: 'Reporting', items: [
                  { label: 'Add Reporting Tags' },
                  { label: 'Build Reporting Plan' },
                  { label: 'View Reporting Plan' },
                  { label: 'Generate Reporting Dashboard' },
                ]},
                { name: 'Monitoring', items: [
                  { label: 'Turn On Error Monitoring' },
                  { label: 'Create Monitoring Flow' },
                  { label: 'View Monitoring Plan' },
                  { label: 'Feedback Loop and Auto Tuning Settings' },
                ]},
                { name: 'Testing', items: [
                  { label: 'Smoke Test Flow' },
                  { label: 'Create Full Automated Test' },
                  { label: 'Generate Test Harness' },
                  { label: 'Run Fully Automated Test' },
                  { label: 'Show Test Results' },
                  { label: 'Agentic Testing Configuration' },
                ]},
                { name: 'Tickets', items: [
                  { label: 'Flow Tickets' },
                  { label: 'Space Tickets' },
                  { label: 'Account Tickets' },
                ]},
              ];
              function renderItem(item) {
                var idAttr = item.id ? ' id="' + item.id + '"' : '';
                if (item.action && !item.needsStep) {
                  return '<div class="dt-item enabled" data-action="' + item.action + '"' + idAttr + '><span class="dt-label">' + item.label + '</span></div>';
                }
                if (item.action && item.needsStep) {
                  return '<div class="dt-item" data-action="' + item.action + '"' + idAttr + '><span class="dt-label">' + item.label + '</span><span class="dt-badge">Select a step</span></div>';
                }
                var badge = item.needsStep ? 'Step Required' : 'Coming Soon';
                return '<div class="dt-item"><span class="dt-label">' + item.label + '</span><span class="dt-badge">' + badge + '</span></div>';
              }
              dd.innerHTML = groups.map(function(g, gi) {
                var openCls = g.open ? ' open' : '';
                var sep = gi > 0 ? '<div class="dt-sep"></div>' : '';
                return sep + '<div class="dt-group-hdr' + openCls + '" data-group="' + gi + '"><span class="dt-chevron">&#9654;</span>' + g.name + '</div>' +
                  '<div class="dt-group-items' + openCls + '" data-group="' + gi + '">' + g.items.map(renderItem).join('') + '</div>';
              }).join('');
              document.body.appendChild(dd);
              dd.addEventListener('click', (ev) => {
                var hdr = ev.target.closest('.dt-group-hdr');
                if (hdr) {
                  var gi = hdr.dataset.group;
                  var items = dd.querySelector('.dt-group-items[data-group="' + gi + '"]');
                  hdr.classList.toggle('open');
                  if (items) items.classList.toggle('open');
                  return;
                }
                const item = ev.target.closest('.dt-item.enabled');
                if (item) {
                  const action = item.dataset.action;
                  if (action && window.electronAPI?.send) {
                    var bar = document.getElementById('gsx-devtools-bar');
                    var payload = { action: action, stepId: bar ? bar.dataset.stepId || null : null };
                    window.electronAPI.send('dev-tools-action', payload);
                  }
                  dd.classList.remove('open');
                  document.getElementById('gsx-devtools-menu')?.classList.remove('active');
                }
              });
              document.addEventListener('click', (ev) => {
                if (!dd.contains(ev.target) && ev.target.id !== 'gsx-devtools-menu') {
                  dd.classList.remove('open');
                  document.getElementById('gsx-devtools-menu')?.classList.remove('active');
                }
              });
            }
            const isOpen = dd.classList.toggle('open');
            document.getElementById('gsx-devtools-menu').classList.toggle('active', isOpen);
            if (isOpen) {
              var bar = document.getElementById('gsx-devtools-bar');
              var stepEl = document.getElementById('gsx-dt-step');
              var stepName = stepEl ? stepEl.textContent.trim() : '';
              var barStepId = bar ? (bar.dataset.stepId || '') : '';
              var cached = window.__gsxCurrentStep || {};
              if (!barStepId && cached.stepId) {
                barStepId = cached.stepId;
                if (bar) bar.dataset.stepId = barStepId;
              }
              if (!stepName && cached.displayName) stepName = cached.displayName;
              var hasStep = barStepId.length > 0 || (stepName.length > 0 && stepEl && stepEl.style.display !== 'none') || cached.hasStepId;
              if (!stepName && barStepId) stepName = barStepId.substring(0, 8) + '...';
              [['gsx-dt-configure-step', 'Configure'], ['gsx-dt-validate-step', 'Validate']].forEach(function(pair) {
                var item = document.getElementById(pair[0]);
                if (!item) return;
                var lbl = item.querySelector('.dt-label');
                var badge = item.querySelector('.dt-badge');
                if (hasStep) {
                  item.classList.add('enabled');
                  if (lbl) lbl.textContent = pair[1] + ': ' + stepName;
                  if (badge) badge.style.display = 'none';
                } else {
                  item.classList.remove('enabled');
                  if (lbl) lbl.textContent = pair[1] + ' Step';
                  if (badge) { badge.textContent = 'Select a step'; badge.style.display = ''; }
                }
              });
            }
          };
        }
        
        // ===== DEV TOOLS INFO BAR =====
        if (!document.getElementById('gsx-devtools-bar')) {
          const bar = document.createElement('div');
          bar.id = 'gsx-devtools-bar';
          bar.innerHTML = '<span id="gsx-dt-icon">&#9672;</span><span id="gsx-dt-flow">Waiting for flow...</span><span id="gsx-dt-steps"></span><span id="gsx-dt-sep" style="display:none;color:rgba(100,116,139,0.4)">|</span><span id="gsx-dt-step" style="display:none"></span>';
          
          const dtStyle = document.createElement('style');
          dtStyle.textContent = '#gsx-devtools-bar{position:fixed;bottom:36px;left:50%;transform:translateX(-50%);z-index:999998;background:rgba(15,23,42,0.88);backdrop-filter:blur(12px);border:1px solid rgba(59,130,246,0.3);padding:5px 16px;display:none;gap:10px;align-items:center;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;color:rgba(255,255,255,0.5);transition:all 0.3s;box-shadow:0 2px 8px rgba(0,0,0,0.3)}#gsx-devtools-bar.active{border-color:rgba(59,130,246,0.5);color:rgba(255,255,255,0.9)}#gsx-devtools-bar:hover{border-color:rgba(59,130,246,0.6);box-shadow:0 2px 12px rgba(59,130,246,0.15)}#gsx-dt-icon{font-size:10px;color:rgba(100,116,139,0.8);transition:color 0.3s}#gsx-devtools-bar.active #gsx-dt-icon{color:#3b82f6}#gsx-dt-flow{font-weight:500;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#gsx-devtools-bar.active #gsx-dt-flow{color:#e2e8f0}#gsx-dt-steps{color:rgba(147,197,253,0.7);font-size:11px}#gsx-dt-step{color:#a78bfa;font-size:11px;font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
          document.head.appendChild(dtStyle);
          document.body.appendChild(bar);
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

    // Inject fetch hook for future SPA navigations (catches flow fetches after initial load)
    try {
      const flowContextModule = require('./gsx-flow-context');
      gsxWindow.webContents
        .executeJavaScript(flowContextModule.getFetchHookScript())
        .catch(() => {});
      gsxWindow.webContents
        .executeJavaScript(flowContextModule.getStepObserverScript())
        .catch(() => {});
    } catch (_) { /* intentionally empty */ }
  });

  // --- Flow context detection via Electron network-level interception ---
  // This catches ALL requests from the start (no timing issues with renderer injection)
  try {
    const flowContextModule = require('./gsx-flow-context');

    // Capture Authorization header from Edison API requests (own try-catch so it doesn't break flow detection)
    try {
      gsxWindow.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: ['*://*.onereach.ai/*'] },
        (details, callback) => {
          const authHeader = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
          if (authHeader) {
            flowContextModule.setAuthToken(authHeader);
          }
          callback({ requestHeaders: details.requestHeaders });
        }
      );
    } catch (headerErr) {
      log.warn('gsx-flow-context', 'Could not set up auth header capture', { error: headerErr.message });
    }

    // Strategy 1: Intercept completed network requests for flow and step data
    gsxWindow.webContents.session.webRequest.onCompleted(
      { urls: ['*://*/*flows*', '*://*/*step*'] },
      (details) => {
        if (gsxWindow.isDestroyed()) return;
        if (details.statusCode !== 200) return;

        const flowMatch = details.url.match(/\/flows\/([a-f0-9-]{36})/i);
        if (flowMatch && (details.method === 'GET' || details.method === 'PUT')) {
          const flowId = flowMatch[1];
          log.info('gsx-flow-context', 'Network request detected flow access', {
            flowId,
            method: details.method,
            url: details.url.substring(0, 120),
          });
          flowContextModule.update({
            flowId,
            windowId: gsxWindow.id,
          });
        }

        const stepMatch = details.url.match(/\/step-templates\/([a-f0-9-]{36})/i) ||
                           details.url.match(/\/steps\/([a-f0-9-]{36})/i);
        if (stepMatch && details.method === 'GET') {
          log.info('gsx-flow-context', 'Network request detected step access', {
            stepId: stepMatch[1],
            url: details.url.substring(0, 120),
          });
          flowContextModule.updateStep({
            stepId: stepMatch[1],
            windowId: gsxWindow.id,
            source: 'network',
          });
        }
      }
    );

    // Strategy 2: Parse flow IDs from SPA URL changes
    const extractFlowFromUrl = (navUrl) => {
      if (!navUrl) return;
      const flowMatch = navUrl.match(/\/flows\/([a-f0-9-]{36})/i);
      const botMatch = navUrl.match(/\/bots\/([a-f0-9-]{36})/i);
      if (flowMatch) {
        const flowId = flowMatch[1];
        const botId = botMatch ? botMatch[1] : null;
        // Skip if the "flowId" is actually the botId from the URL
        if (botId && flowId === botId) return;
        log.info('gsx-flow-context', 'URL navigation detected flow', { flowId, botId });
        flowContextModule.update({
          flowId,
          botId,
          windowId: gsxWindow.id,
        });
      } else if (botMatch) {
        // URL has a botId but no flowId -- register it so we don't later confuse it
        flowContextModule.update({
          flowId: null,
          botId: botMatch[1],
          windowId: gsxWindow.id,
        });
      }
    };

    gsxWindow.webContents.on('did-navigate', (_e, navUrl) => {
      extractFlowFromUrl(navUrl);
      gsxWindow.webContents.executeJavaScript(flowContextModule.getFetchHookScript()).catch(() => {});
      gsxWindow.webContents.executeJavaScript(flowContextModule.getStepObserverScript()).catch(() => {});
    });
    gsxWindow.webContents.on('did-navigate-in-page', (_e, navUrl) => {
      extractFlowFromUrl(navUrl);
      gsxWindow.webContents.executeJavaScript(flowContextModule.getStepObserverScript()).catch(() => {});
    });

    // Strategy 3: Extract context from window title changes
    gsxWindow.on('page-title-updated', (_e, title) => {
      if (!title || gsxWindow.isDestroyed()) return;
      const ctx = flowContextModule.get();
      if (ctx && ctx.windowId === gsxWindow.id) {
        const labelFromTitle = title.replace(/^Studio\s*>\s*/, '').trim();
        if (labelFromTitle && labelFromTitle !== ctx.label) {
          flowContextModule.update({
            ...ctx,
            label: labelFromTitle,
            windowId: gsxWindow.id,
          });
        }
      }
    });
  } catch (e) {
    log.warn('app', 'Could not set up flow context detection', { error: e.message });
  }

  // Forward renderer console errors/warnings to the log server
  gsxWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const lvl = level >= 3 ? 'error' : 'warn';
      log[lvl]('gsx-renderer', `[GSX Window] ${message}`, {
        line,
        source: sourceId,
        windowTitle: gsxWindow.isDestroyed() ? '?' : gsxWindow.getTitle(),
      });
    }
  });

  // Auto-login handling for GSX windows - ONLY when idwEnvironment is explicitly set
  // This prevents auto-login for non-GSX tools or when user wants manual login
  if (idwEnvironment) {
    const gsxAutoLoginState = { inProgress: false, complete: false, hasSeenAuthPage: false, targetAccountId: urlAccountId, originalUrl: url };

    // Cancellation: if the user navigates away from auth AFTER we've been
    // on an auth page, mark login complete so auto-login loops bail out.
    // Guard: don't cancel before the auth redirect arrives -- the initial
    // GSX page load (studio.*.onereach.ai) is not an auth page and would
    // prematurely kill auto-login before the redirect to auth.*.onereach.ai.
    gsxWindow.webContents.on('did-navigate', (_event, navUrl) => {
      if (gsxAutoLoginState.complete) return;
      if (!gsxAutoLoginState.hasSeenAuthPage) return;
      if (navUrl && !navUrl.includes('auth.') && !navUrl.includes('about:blank')) {
        gsxAutoLoginState.complete = true;
        gsxAutoLoginState.inProgress = false;
        log.info('app', 'Auto-login cancelled: navigated away from auth', { navUrl });
        hideStatusOverlay(gsxWindow, true).catch(() => {});
      }
    });

    // Handle retry requests from the overlay "Try Again" button
    gsxWindow.webContents.ipc.on('gsx:retry-auto-login', () => {
      if (gsxAutoLoginState.inProgress) return;
      gsxAutoLoginState.inProgress = false;
      gsxAutoLoginState.complete = false;
      log.info('app', 'Retry auto-login requested by user');

      const currentUrl = gsxWindow.webContents.getURL();
      if (currentUrl.includes('auth.') && currentUrl.includes('onereach.ai')) {
        gsxAutoLoginState.inProgress = true;
        (async () => {
          await sleep(300);
          if (gsxWindow.isDestroyed() || gsxAutoLoginState.complete) return;
          try {
            await attemptGSXAutoLogin(gsxWindow, currentUrl, gsxAutoLoginState, idwEnvironment);
          } catch (err) {
            if (!err.message?.includes('destroyed') && !err.message?.includes('Window was closed')) {
              log.error('app', 'Retry auto-login error', { error: err.message });
            }
            gsxAutoLoginState.inProgress = false;
          }
        })();
      }
    });

    // Handle full page navigation (for auth redirects from GSX apps)
    gsxWindow.webContents.on('did-navigate', async (event, navUrl) => {
      log.info('app', 'Full navigation', { navUrl: navUrl });

      // Auto-login for auth pages (when GSX redirects to auth.*.onereach.ai)
      if (navUrl && navUrl.includes('auth.') && navUrl.includes('onereach.ai')) {
        gsxAutoLoginState.hasSeenAuthPage = true;
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

        // Brief delay for the auth page to start loading, then let
        // MutationObserver-based waitForAuthForm handle the actual timing
        await sleep(300);
        if (gsxWindow.isDestroyed() || gsxAutoLoginState.complete) return;

        try {
          const result = await attemptGSXAutoLogin(gsxWindow, navUrl, gsxAutoLoginState, idwEnvironment);
          if (result === 'no_form' && !gsxAutoLoginState.complete) {
            log.info('app', 'Form not found after observer timeout, giving up');
            gsxAutoLoginState.inProgress = false;
          }
        } catch (err) {
          if (err.message && !err.message.includes('destroyed') && !err.message.includes('Window was closed')) {
            log.error('app', 'Auto-login error', { error: err.message });
          }
          gsxAutoLoginState.inProgress = false;
        }
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

    // Clean up cookie listener for this partition to prevent handler buildup
    try {
      const multiTenantStore = require('../multi-tenant-store');
      multiTenantStore.removeCookieListener(fullPartition, { force: true });
      multiTenantStore.unregisterPartition(idwEnvironment, fullPartition);
    } catch (_e) { /* cleanup is best-effort */ }

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
      backgroundThrottling: false,
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
