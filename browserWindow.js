const { BrowserWindow, shell, app, dialog, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const getLogger = require('./event-logger');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();
let logger;

// Main browser window reference - kept global to prevent garbage collection
let mainWindow = null;

// Graceful shutdown state (module-level for IPC handler access)
let isShuttingDown = false;
let shutdownTimeout = null;
let shutdownHandlersRegistered = false;

// Add at the top with other global variables
let authWindow = null;
let authTokens = new Map();

// Credential manager and TOTP manager for auto-login
let credentialManager = null;
let totpManager = null;

// Track auto-login state per GSX window to prevent duplicate attempts
const gsxAutoLoginState = new Map();

/**
 * Safe helper: send IPC message to a window only if it exists and isn't destroyed.
 * Returns true if the message was sent, false otherwise.
 */
function safeSend(win, channel, ...args) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
      return true;
    }
  } catch (e) {
    log.warn('window', 'Failed to send \'...\'', { channel })
  }
  return false;
}

/**
 * Attach structured log forwarding to a BrowserWindow.
 * Captures renderer console.log/warn/error/debug and renderer crashes,
 * routing them through the central LogEventQueue so they appear in the
 * log server, file logger, and ring buffer.
 *
 * @param {BrowserWindow} win - The Electron BrowserWindow to attach to
 * @param {string} [category='window'] - Log category (e.g. 'clipboard', 'video')
 */
function attachLogForwarder(win, category = 'window') {
  if (!win || !win.webContents) return;
  const levelFn = { 0: 'debug', 1: 'info', 2: 'warn', 3: 'error' };

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const fn = levelFn[level] || 'info';
    const short = (sourceId || '').split('/').pop();
    log[fn](category, `[renderer:${short}:${line}] ${message.substring(0, 500)}`, { source: 'renderer' });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(category, 'Renderer process crashed', { reason: details.reason, exitCode: details.exitCode });
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode !== -3) { // -3 is ERR_ABORTED (navigation cancelled), not a real error
      log.error(category, 'Page failed to load', { errorCode, errorDescription, url: validatedURL });
    }
  });

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(category, 'Preload script failed', { preloadPath, error: error.message || String(error) });
  });
}

/**
 * Safe helper: execute JavaScript in a window only if it exists and isn't destroyed.
 * Returns the result, or undefined if the window is unavailable.
 */
async function safeExecuteJS(win, script) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      return await win.webContents.executeJavaScript(script);
    }
  } catch (e) {
    log.warn('window', `[safeExecuteJS] Failed:`)
  }
  return undefined;
}

/**
 * Clean up auto-login state for a closed GSX window.
 */
function cleanupGSXAutoLoginState(windowId) {
  if (gsxAutoLoginState.has(windowId)) {
    log.info('window', 'Cleaning up state for window ...', { windowId })
    gsxAutoLoginState.delete(windowId);
  }
}

/**
 * Check if auto-login should be attempted for a GSX window
 */
function shouldAttemptGSXAutoLogin(windowId) {
  const state = gsxAutoLoginState.get(windowId);
  if (!state) return true;
  
  // Don't attempt if login completed successfully
  if (state.loginComplete) {
    log.info('window', 'Skipping window ... - login already complete', { windowId })
    return false;
  }
  
  // Don't attempt if already in progress (within 5 seconds)
  if (state.inProgress && Date.now() - state.lastAttempt < 5000) {
    log.info('window', 'Skipping window ... - login in progress', { windowId })
    return false;
  }
  
  return true;
}

/**
 * Attempt auto-login for GSX windows with retry mechanism
 * @param {BrowserWindow} gsxWindow - The GSX window
 * @param {string} url - Current URL  
 * @param {number} attempt - Current attempt number
 */
async function attemptGSXAutoLoginWithRetry(gsxWindow, url, attempt = 0) {
  const maxAttempts = 5;
  const retryDelay = 1000;
  
  // Guard: bail if window was destroyed since this was scheduled
  if (gsxWindow.isDestroyed()) {
    log.info('window', `[GSX AutoLogin] Window destroyed, aborting retry`)
    return;
  }
  
  const windowId = gsxWindow.id;
  
  // Check if we should attempt login
  if (attempt === 0 && !shouldAttemptGSXAutoLogin(windowId)) {
    return;
  }
  
  // Mark as in progress on first attempt
  if (attempt === 0) {
    gsxAutoLoginState.set(windowId, {
      ...(gsxAutoLoginState.get(windowId) || {}),
      inProgress: true,
      lastAttempt: Date.now()
    });
  }
  
  log.info('window', 'Attempt .../... for window ...', { detail: attempt + 1, maxAttempts, windowId })
  
  try {
    // Check if form fields exist yet (including cross-origin detection)
    const formInfo = await safeExecuteJS(gsxWindow, `
      (function() {
        const hasPasswordInMain = !!document.querySelector('input[type="password"]');
        if (hasPasswordInMain) {
          log.info('window', 'Form found in main document')
          return { location: 'main', crossOrigin: false };
        }
        
        // Check iframes
        const iframes = document.querySelectorAll('iframe');
        log.info('window', 'Found \' + iframes.length + \' iframes')
        
        let hasCrossOriginAuthIframe = false;
        
        for (let i = 0; i < iframes.length; i++) {
          const iframe = iframes[i];
          const src = iframe.src || '';
          
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            if (doc && doc.querySelector('input[type="password"]')) {
              log.info('window', 'Form found in same-origin iframe \' +')
              return { location: 'iframe', crossOrigin: false };
            }
          } catch (e) {
            // Cross-origin iframe
            log.info('window', 'Cross-origin iframe detected: \' + sr')
            if (src.includes('auth.') && src.includes('onereach.ai')) {
              hasCrossOriginAuthIframe = true;
            }
          }
        }
        
        if (hasCrossOriginAuthIframe) {
          return { location: 'cross-origin', crossOrigin: true };
        }
        
        return { location: 'none', crossOrigin: false };
      })()
    `);
    
    // If safeExecuteJS returned undefined, the window was destroyed
    if (!formInfo) return;
    
    log.info('window', 'Form info for window ...', { windowId })
    
    if (formInfo.location === 'main' || formInfo.location === 'iframe') {
      await attemptGSXAutoLogin(gsxWindow, url);
      // Mark as complete after successful login attempt
      gsxAutoLoginState.set(windowId, {
        ...(gsxAutoLoginState.get(windowId) || {}),
        inProgress: false,
        loginComplete: true
      });
    } else if (formInfo.crossOrigin) {
      // Cross-origin iframe - use webFrameMain to access it
      log.info('window', `[GSX AutoLogin] Cross-origin auth iframe detected, accessing via frames...`)
      await attemptGSXCrossOriginLogin(gsxWindow, windowId);
    } else if (formInfo.location === 'none' && attempt < maxAttempts - 1) {
      log.info('window', 'No form found, retrying', { retryDelay })
      setTimeout(() => {
        attemptGSXAutoLoginWithRetry(gsxWindow, url, attempt + 1);
      }, retryDelay);
    } else {
      log.info('window', 'No form found after ... attempts', { detail: attempt + 1 })
    }
  } catch (error) {
    log.error('window', 'Retry error', { error: error.message || error })
  }
}

/**
 * Attempt cross-origin login for GSX windows using webFrameMain
 */
async function attemptGSXCrossOriginLogin(gsxWindow, windowId) {
  try {
    // Guard: bail if window was destroyed
    if (gsxWindow.isDestroyed()) {
      log.info('window', 'Window ... destroyed, aborting', { windowId })
      return;
    }
    
    // Lazy load credential manager
    if (!credentialManager) {
      credentialManager = require('./credential-manager');
    }
    
    const credentials = await credentialManager.getOneReachCredentials();
    if (!credentials || !credentials.email || !credentials.password) {
      log.info('window', 'No credentials configured')
      return;
    }
    
    // Get all frames
    const mainFrame = gsxWindow.webContents.mainFrame;
    const allFrames = [mainFrame, ...mainFrame.framesInSubtree];
    
    log.info('window', 'Found ... frames total', { allFramesCount: allFrames.length })
    
    // Find the auth frame
    let authFrame = null;
    for (const frame of allFrames) {
      const frameUrl = frame.url;
      log.info('window', 'Frame: ...', { frameUrl })
      if (frameUrl && frameUrl.includes('auth.') && frameUrl.includes('onereach.ai')) {
        authFrame = frame;
        log.info('window', 'Found auth frame: ...', { frameUrl })
        break;
      }
    }
    
    if (!authFrame) {
      log.info('window', 'No auth frame found')
      return;
    }
    
    // Build and execute login script
    const loginScript = `
      (function() {
        const email = ${JSON.stringify(credentials.email)};
        const password = ${JSON.stringify(credentials.password)};
        
        log.info('window', 'Running in auth frame')
        log.info('window', 'URL', { href: window.location.href })
        
        function fillInput(input, value) {
          if (!input) return false;
          input.focus();
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(input, value);
          } else {
            input.value = value;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          log.info('window', 'Filled', { detail: input.name || input.type })
          return true;
        }
        
        // Find email field
        const emailField = document.querySelector(
          'input[type="email"], input[type="text"][name*="email" i], ' +
          'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
          'input[placeholder*="email" i], input[type="text"]:not([name*="search"])'
        );
        
        // Find password field
        const passwordField = document.querySelector('input[type="password"]');
        
        if (!passwordField) {
          log.info('window', 'No password field found')
          return { success: false, reason: 'no_password_field' };
        }
        
        if (emailField) fillInput(emailField, email);
        fillInput(passwordField, password);
        
        // Click submit
        setTimeout(() => {
          const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]') ||
                           document.querySelector('form button:not([type="button"])');
          if (submitBtn) {
            log.info('window', 'Clicking submit', { textContent: submitBtn.textContent })
            submitBtn.click();
          } else {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              const text = (btn.textContent || '').toLowerCase();
              if (text.includes('sign in') || text.includes('log in') || text.includes('login') || text.includes('continue')) {
                log.info('window', 'Clicking button by text', { textContent: btn.textContent })
                btn.click();
                break;
              }
            }
          }
        }, 500);
        
        return { success: true };
      })()
    `;
    
    const result = await authFrame.executeJavaScript(loginScript);
    log.info('window', 'Login result', { result })
    
    if (result && result.success) {
      log.info('window', 'Successfully filled login form, setting up 2FA monitoring...')
      
      // Mark login as in progress (not complete until 2FA done)
      gsxAutoLoginState.set(windowId, { ...gsxAutoLoginState.get(windowId || { }),
        loginFilled: true
      });
      
      // Monitor for 2FA
      setTimeout(() => {
        attemptGSXCrossOrigin2FA(gsxWindow, windowId, 0);
      }, 2000);
    }
    
  } catch (error) {
    log.error('window', 'Login error', { error: error.message || error })
  }
}

/**
 * Attempt 2FA in cross-origin GSX window
 */
async function attemptGSXCrossOrigin2FA(gsxWindow, windowId, attempt) {
  const maxAttempts = 5;
  const retryDelay = 1500;
  
  // Guard: bail if window was destroyed since this was scheduled
  if (gsxWindow.isDestroyed()) {
    log.info('window', 'Window ... destroyed, aborting 2FA', { windowId })
    cleanupGSXAutoLoginState(windowId);
    return;
  }
  
  // Check if already complete
  const state = gsxAutoLoginState.get(windowId);
  if (state && state.twoFAComplete) {
    log.info('window', 'Skipping window ... - 2FA already complete', { windowId })
    return;
  }
  
  try {
    log.info('window', 'Attempt .../... for window ...', { detail: attempt + 1, maxAttempts, windowId })
    
    // Get auth frame
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
      log.info('window', 'No auth frame found')
      if (attempt < maxAttempts - 1 && !gsxWindow.isDestroyed()) {
        setTimeout(() => attemptGSXCrossOrigin2FA(gsxWindow, windowId, attempt + 1), retryDelay);
      }
      return;
    }
    
    // Check if on 2FA page
    const detection = await authFrame.executeJavaScript(`
      (function() {
        const passwordField = document.querySelector('input[type="password"]');
        const totpInput = document.querySelector(
          'input[name="totp"], input[name="code"], input[name="otp"], ' +
          'input[autocomplete="one-time-code"], input[maxlength="6"]:not([type="password"])'
        );
        
        if (totpInput) return { is2FAPage: true };
        if (passwordField) return { is2FAPage: false, reason: 'still_login' };
        return { is2FAPage: false, reason: 'unknown' };
      })()
    `);
    
    log.info('window', 'Detection', { detection })
    
    if (!detection.is2FAPage) {
      if (attempt < maxAttempts - 1 && !gsxWindow.isDestroyed()) {
        log.info('window', 'Not on 2FA page yet, retrying in ...ms...', { retryDelay })
        setTimeout(() => attemptGSXCrossOrigin2FA(gsxWindow, windowId, attempt + 1), retryDelay);
      } else {
        log.info('window', 'Not on 2FA page after max attempts (may have succeeded without 2FA)')
        gsxAutoLoginState.set(windowId, { ...gsxAutoLoginState.get(windowId || { }),
          loginComplete: true
        });
      }
      return;
    }
    
    // Get TOTP code
    if (!totpManager) {
      const { getTOTPManager } = require('./lib/totp-manager');
      totpManager = getTOTPManager();
    }
    
    if (!credentialManager) {
      credentialManager = require('./credential-manager');
    }
    
    const totpSecret = await credentialManager.getTOTPSecret();
    if (!totpSecret) {
      log.info('window', 'No TOTP secret configured')
      return;
    }
    
    const code = totpManager.generateCode(totpSecret);
    log.info('window', 'Generated TOTP code, filling form...')
    
    // Fill 2FA code
    const fillResult = await authFrame.executeJavaScript(`
      (function() {
        const code = ${JSON.stringify(code)};
        
        function fillInput(input, value) {
          if (!input) return false;
          input.focus();
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(input, value);
          } else {
            input.value = value;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        
        const totpInput = document.querySelector(
          'input[name="totp"], input[name="code"], input[name="otp"], ' +
          'input[autocomplete="one-time-code"], input[maxlength="6"]:not([type="password"])'
        ) || document.querySelector('input[type="text"]:not([name*="email"]):not([name*="user"])');
        
        if (totpInput) {
          fillInput(totpInput, code);
          
          setTimeout(() => {
            const submitBtn = document.querySelector('button[type="submit"]') ||
                             document.querySelector('form button');
            if (submitBtn) {
              console.log('[GSX Auth] Clicking submit');
              submitBtn.click();
            }
          }, 500);
          
          return { success: true };
        }
        
        return { success: false };
      })()
    `);
    
    log.info('window', 'Fill result', { fillResult })
    
    if (fillResult && fillResult.success) {
      log.info('window', 'Successfully filled 2FA code!')
      gsxAutoLoginState.set(windowId, { ...gsxAutoLoginState.get(windowId || { }),
        twoFAComplete: true,
        loginComplete: true
      });
    }
    
  } catch (error) {
    log.error('window', 'Error', { error: error.message || error })
  }
}

/**
 * Attempt auto-login for GSX windows
 * @param {BrowserWindow} gsxWindow - The GSX window
 * @param {string} url - Current URL
 */
async function attemptGSXAutoLogin(gsxWindow, url) {
  try {
    // Lazy load credential manager
    if (!credentialManager) {
      credentialManager = require('./credential-manager');
    }
    
    // Check if we have credentials
    const credentials = await credentialManager.getOneReachCredentials();
    if (!credentials || !credentials.email || !credentials.password) {
      log.info('window', 'No credentials configured')
      return;
    }
    
    // Get settings to check if auto-login is enabled
    const settingsManager = global.settingsManager;
    const settings = settingsManager ? settingsManager.getAll() : {};
    const autoLoginSettings = settings.autoLoginSettings || {};
    
    if (autoLoginSettings.enabled === false) {
      log.info('window', 'Auto-login disabled')
      return;
    }
    
    // Detect page type with detailed logging
    const pageType = await gsxWindow.webContents.executeJavaScript(`
      (function() {
        // Log all inputs for debugging
        const allInputs = document.querySelectorAll('input');
        console.log('[GSX Auth] Found ' + allInputs.length + ' input fields on page');
        allInputs.forEach((inp, i) => {
          if (inp.type !== 'hidden') {
            console.log('[GSX Auth] Input ' + i + ': type=' + inp.type + ', name=' + inp.name + ', placeholder=' + inp.placeholder);
          }
        });
        
        const pageContent = document.body ? document.body.innerText.toLowerCase() : '';
        
        // Check for 2FA page indicators
        const has2FAField = document.querySelector(
          'input[name="code"], input[name="otp"], input[name="totp"], ' +
          'input[placeholder*="code" i], input[placeholder*="2fa" i], ' +
          'input[placeholder*="authenticator" i], input[maxlength="6"][inputmode="numeric"]'
        );
        const has2FAText = pageContent.includes('two-factor') || pageContent.includes('2fa') || 
                          pageContent.includes('verification code') || pageContent.includes('authenticator') ||
                          pageContent.includes('enter the code') || pageContent.includes('6-digit');
        
        if (has2FAField || (has2FAText && !document.querySelector('input[type="password"]'))) {
          console.log('[GSX Auth] 2FA page detected');
          return '2fa';
        }
        
        // Check for login page indicators (broader search)
        const hasEmailField = document.querySelector(
          'input[type="email"], input[type="text"][name*="email" i], ' +
          'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
          'input[autocomplete="email"], input[autocomplete="username"], ' +
          'input[placeholder*="email" i], input[placeholder*="user" i]'
        );
        const hasPasswordField = document.querySelector('input[type="password"]');
        
        console.log('[GSX Auth] Email field:', !!hasEmailField, 'Password field:', !!hasPasswordField);
        
        if (hasEmailField && hasPasswordField) {
          console.log('[GSX Auth] Login form detected');
          return 'login';
        }
        
        if (hasPasswordField) {
          console.log('[GSX Auth] Password-only page');
          return 'password-only';
        }
        
        return 'other';
      })()
    `);
    
    log.info('window', 'Page type', { pageType })
    
    if (pageType === 'other') {
      return; // Not a login page
    }
    
    if (pageType === 'login' || pageType === 'password-only') {
      log.info('window', 'Filling', { pageType, arg2: 'form for', email: credentials.email })
      
      await gsxWindow.webContents.executeJavaScript(`
        (function() {
          const email = ${JSON.stringify(credentials.email)};
          const password = ${JSON.stringify(credentials.password)};
          
          function fillInput(input, value) {
            if (!input) return false;
            input.focus();
            
            // React compatibility - set native value
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(input, value);
            
            // Dispatch events
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            console.log('[GSX Auth] Filled field:', input.name || input.type);
            return true;
          }
          
          // Find and fill email field (broader search)
          const emailField = document.querySelector(
            'input[type="email"], input[type="text"][name*="email" i], ' +
            'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
            'input[autocomplete="email"], input[autocomplete="username"], ' +
            'input[placeholder*="email" i], input[placeholder*="user" i]'
          );
          if (emailField) {
            fillInput(emailField, email);
          }
          
          // Find and fill password field
          const passwordField = document.querySelector('input[type="password"]');
          if (passwordField) {
            fillInput(passwordField, password);
          }
          
          // Find and click submit button after a short delay
          setTimeout(() => {
            const submitBtn = document.querySelector(
              'button[type="submit"], input[type="submit"], button.submit, button.login'
            ) || document.querySelector('form button:not([type="button"])');
            
            if (submitBtn) {
              console.log('[GSX Auth] Clicking submit:', submitBtn.textContent || submitBtn.type);
              submitBtn.click();
            } else {
              // Try finding by text content
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                const text = (btn.textContent || '').toLowerCase();
                if (text.includes('sign in') || text.includes('log in') || text.includes('login') || text.includes('submit') || text.includes('continue')) {
                  console.log('[GSX Auth] Clicking button by text:', btn.textContent);
                  btn.click();
                  break;
                }
              }
            }
          }, 500);
          
          return true;
        })()
      `);
      
    } else if (pageType === '2fa') {
      if (!credentials.totpSecret) {
        log.info('window', 'No TOTP secret configured')
        return;
      }
      
      // Lazy load TOTP manager
      if (!totpManager) {
        const { getTOTPManager } = require('./lib/totp-manager');
        totpManager = getTOTPManager();
      }
      
      // Generate TOTP code
      const code = totpManager.generateCode(credentials.totpSecret);
      log.info('window', 'Filling 2FA code')
      
      await gsxWindow.webContents.executeJavaScript(`
        (function() {
          const code = ${JSON.stringify(code)};
          
          // Find 2FA input field
          const codeField = document.querySelector('input[name="code"], input[name="otp"], input[name="totp"], input[placeholder*="code" i], input[placeholder*="2fa" i], input[maxlength="6"]');
          if (codeField) {
            codeField.value = code;
            codeField.dispatchEvent(new Event('input', { bubbles: true }));
            codeField.dispatchEvent(new Event('change', { bubbles: true }));
            
            // Auto-submit after a short delay
            setTimeout(() => {
              const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
              if (submitBtn) {
                submitBtn.click();
              } else {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                  const text = btn.textContent.toLowerCase();
                  if (text.includes('verify') || text.includes('submit') || text.includes('continue') || text.includes('confirm')) {
                    btn.click();
                    break;
                  }
                }
              }
            }, 500);
          }
          
          return true;
        })()
      `);
    }
    
  } catch (error) {
    log.error('window', 'Error', { error: error.message })
  }
}

/**
 * Creates the main application window
 * @param {Object} app - The Electron app instance
 * @returns {BrowserWindow} The created main window
 */
function createMainWindow(app) {
  // Initialize logger if not already
  if (!logger) {
    logger = getLogger();
  }
  
  // Reset shutdown state when creating a new main window
  // (handles the case where createMainWindow is called again after a close)
  isShuttingDown = false;
  if (shutdownTimeout) {
    clearTimeout(shutdownTimeout);
    shutdownTimeout = null;
  }
  
  // Use the PNG icon for all platforms for consistency
  const iconPath = path.join(__dirname, 'assets/tray-icon.png');
  
  logger.logWindowCreated('main-window', 'main', {
    action: 'creating',
    icon: iconPath
  });
  log.info('window', 'Using icon path for main window: ...', { iconPath })

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: true, // Explicitly show window
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      // Enable features needed for media/voice
      enableBlinkFeatures: 'MediaStreamAPI,WebRTC,AudioWorklet,WebAudio,MediaRecorder',
      experimentalFeatures: true
    },
    title: 'Onereach.ai',
    icon: iconPath
  });

  // Set Chrome-like user agent for the main window
  const chromeVersion = process.versions.chrome;
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  mainWindow.webContents.setUserAgent(userAgent);
  
  // Enhanced: Configure session for better authentication
  const session = mainWindow.webContents.session;
  
  // Set persistent cookies for auth domains
  session.cookies.on('changed', (event, cookie, cause, removed) => {
    if (cookie.domain && (
      cookie.domain.includes('google.com') ||
      cookie.domain.includes('onereach.ai') ||
      cookie.domain.includes('microsoft.com')
    )) {
      log.info('window', 'Auth cookie ...: ... for ...', { detail: removed ? 'removed' : 'changed', cookieName: cookie.name, domain: cookie.domain })
    }
  });
  
  // Enhanced browser fingerprinting to be more Chrome-like
  // PERFORMANCE: Only intercept requests to domains that need Chrome-like headers
  const headerFilterUrls = [
    '*://*.onereach.ai/*',
    '*://*.google.com/*',
    '*://*.googleapis.com/*',
    '*://*.gstatic.com/*',
    '*://*.microsoft.com/*',
    '*://*.openai.com/*',
    '*://*.chatgpt.com/*'
  ];
  
  session.webRequest.onBeforeSendHeaders({ urls: headerFilterUrls }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    
    // Set headers to match Chrome exactly
    headers['User-Agent'] = userAgent;
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['Accept-Encoding'] = 'gzip, deflate, br';
    headers['Sec-Ch-Ua'] = `"Chromium";v="${chromeVersion.split('.')[0]}", "Not(A:Brand";v="24"`;
    headers['Sec-Ch-Ua-Mobile'] = '?0';
    headers['Sec-Ch-Ua-Platform'] = '"macOS"';
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none';
    headers['Sec-Fetch-User'] = '?1';
    headers['Upgrade-Insecure-Requests'] = '1';
    
    // Remove Electron-specific headers
    delete headers['X-DevTools-Request-Id'];
    delete headers['X-Electron'];
    
    callback({ requestHeaders: headers });
  });
  
  // Set up permission handlers for the main window
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    log.info('window', 'Main window permission requested: ...', { permission })
    
    // Allow media and other necessary permissions
    if (permission === 'media' || 
        permission === 'audioCapture' || 
        permission === 'microphone' ||
        permission === 'camera' ||
        permission === 'notifications' ||
        permission === 'clipboard-read' ||
        permission === 'clipboard-write') {
      log.info('window', 'Main window allowing ... permission', { permission })
      callback(true);
    } else {
      log.info('window', 'Main window denying ... permission', { permission })
      callback(false);
    }
  });
  
  // Also set permission check handler
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    log.info('window', 'Main window permission check: ...', { permission })
    
    if (permission === 'media' || 
        permission === 'audioCapture' || 
        permission === 'microphone' ||
        permission === 'camera' ||
        permission === 'notifications' ||
        permission === 'clipboard-read' ||
        permission === 'clipboard-write') {
      return true;
    }
    
    return false;
  });
  
  // Special handler for new-window events in WebContents
  // This affects windows requested by the main HTML file, not webviews
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    log.info('window', 'Main window open handler, URL', { url })
    
    // For Google authentication, notify the renderer to handle in the current tab
    if (url.includes('accounts.google.com') || 
        url.includes('oauth2') || 
        url.includes('auth')) {
      log.info('window', 'Google auth URL detected, sending to renderer to handle in current tab', { url })
      
      // Send to renderer to handle in the current tab
      setTimeout(() => safeSend(mainWindow, 'handle-auth-url', url), 0);
      
      return { action: 'deny' };
    }
    
    // For chat URLs, notify the renderer to handle in the appropriate tab
    if (url.includes('/chat/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
      log.info('window', 'Main process: Chat URL detected in window open handler, sending to renderer')
      
      // Send to renderer to handle in the current tab
      setTimeout(() => safeSend(mainWindow, 'handle-chat-url', url), 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // For non-chat URLs, let the renderer handle it by opening in a new tab
    setTimeout(() => safeSend(mainWindow, 'open-in-new-tab', url), 0);
    
    // Prevent default window creation
    return { action: 'deny' };
  });

  // Add navigation handler for Google auth redirects
  mainWindow.webContents.on('will-navigate', (event, url) => {
    log.info('window', 'Main window navigation attempted to', { url })
    
    // Handle Google auth redirects
    if (url.includes('accounts.google.com') || 
        url.includes('oauth2') || 
        url.includes('auth')) {
      log.info('window', 'Auth navigation detected, allowing', { url })
      return;
    }
    
    // Allow navigation for onereach.ai domains
    if (url.includes('.onereach.ai/')) {
      log.info('window', 'Navigation to onereach.ai URL allowed', { url })
      return;
    }
    
    // Block navigation to other domains
    log.info('window', 'Blocking navigation to non-onereach.ai URL', { url })
    event.preventDefault();
    
    // Open external URLs in default browser
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        log.error('window', 'Failed to open external URL', { error: err.message || err })
      });
    }
  });

  // Set Content Security Policy
  // PERFORMANCE: Only apply CSP to onereach.ai domains (main app content)
  const cspFilterUrls = ['*://*.onereach.ai/*', 'file://*'];
  
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: cspFilterUrls }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://chatgpt.com https://*.chatgpt.com https://chat.openai.com https://*.openai.com https://cdn.jsdelivr.net; " +
          "style-src 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' https://*.onereach.ai https://*.api.onereach.ai https://*.openai.com https://*.chatgpt.com ws://localhost:3322 wss://*.onereach.ai http://127.0.0.1:47291 http://localhost:47291; " +
          "img-src 'self' data: spaces: https://*.onereach.ai https://*.googleapis.com https://*.gstatic.com https://www.google.com; " +
          "font-src 'self' data: https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' blob: https://*.onereach.ai https://*.chatgpt.com https://*.openai.com; " +
          "worker-src 'self' blob:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  // Attach structured log forwarding for the main window
  attachLogForwarder(mainWindow, 'app');

  // Load the tabbed browser HTML file instead of directly loading a URL
  mainWindow.loadFile('tabbed-browser.html');

  // Handle downloads in the main window
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Use the new handler with space option
    handleDownloadWithSpaceOption(item, 'Main Window');
  });

  // Add custom scrollbar styling to main window
  mainWindow.webContents.on('did-finish-load', () => {
    // Guard: bail if window was destroyed between event dispatch and handler
    if (!mainWindow || mainWindow.isDestroyed()) return;
    
    // Inject Chrome-like behavior and remove Electron fingerprints
    mainWindow.webContents.executeJavaScript(`
      (function() {
        console.log('[Window] Injecting Chrome-like behavior and removing Electron fingerprints');
        
        // Remove Electron fingerprints
        delete window.navigator.__proto__.webdriver;
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
        
        // Override user agent to match Chrome
        const chromeVersion = '${chromeVersion}';
        const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
        Object.defineProperty(navigator, 'userAgent', {
          get: () => userAgent
        });
        
        // Hide Electron-specific properties
        if (window.process && window.process.versions) {
          delete window.process.versions.electron;
        }
        
        // Override platform if needed
        Object.defineProperty(navigator, 'platform', {
          get: () => 'MacIntel'
        });
        
        // Add Chrome-specific properties
        Object.defineProperty(navigator, 'vendor', {
          get: () => 'Google Inc.'
        });
        
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8  // Common value for modern Macs
        });
        
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8  // 8GB RAM
        });
        
        // Mock Chrome app
        if (!window.chrome) {
          window.chrome = {};
        }
        
        // Add Chrome runtime API mock
        window.chrome.runtime = {
          id: undefined,
          connect: () => {},
          sendMessage: () => {},
          onMessage: { addListener: () => {} }
        };
        
        // Mock Web Audio API fingerprint to match Chrome
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const originalCreateOscillator = AudioContext.prototype.createOscillator;
          AudioContext.prototype.createOscillator = function() {
            const oscillator = originalCreateOscillator.apply(this, arguments);
            // Add slight noise to match Chrome's implementation
            const originalConnect = oscillator.connect;
            oscillator.connect = function() {
              return originalConnect.apply(this, arguments);
            };
            return oscillator;
          };
        }
        
        // Override WebGL fingerprinting
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
          }
          if (parameter === 37446) {
            return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          }
          return getParameter.apply(this, arguments);
        };
        
        // NOTE: Canvas toDataURL override removed - it was corrupting ALL canvas
        // exports (images, thumbnails, etc.) by adding random noise to every pixel.
        // The anti-fingerprinting benefit was minimal compared to the data corruption risk.
        
        console.log('[Window] Enhanced Chrome-like behavior applied');
      })();
    `).catch(err => log.warn('window', 'Chrome-like behavior injection skipped (page not ready)', { error: err.message || err }))
    
    mainWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => log.error('window', 'Failed to inject scrollbar CSS', { error: err.message || err }))

    // Check for Material Symbols font and preload if needed
    mainWindow.webContents.executeJavaScript(`
      (function() {
        // Check if page uses Material Symbols
        const hasSymbols = document.querySelector('.material-symbols-outlined, .material-icons');
        if (hasSymbols) {
          console.log('[Window] Material Symbols found on page, preloading font');
          
          // Add preload link for Material Icons font
          const preloadLink = document.createElement('link');
          preloadLink.rel = 'preload';
          preloadLink.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
          preloadLink.as = 'style';
          document.head.appendChild(preloadLink);
          
          return true;
        } else {
          console.log('[Window] No Material Symbols elements found on page, skipping preload');
          return false;
        }
      })();
    `).catch(err => log.warn('window', 'Material Symbols check skipped (page not ready)', { error: err.message || err }))
  });

  // Handle window close event - save state and close gracefully
  mainWindow.on('close', (event) => {
    log.info('window', 'Close event', { isShuttingDown, isQuitting: !!global.isQuitting })
    
    // If app.quit() was called or already shutting down, allow immediate close
    if (isShuttingDown || global.isQuitting) {
      log.info('window', 'Allowing close (shutdown/quit in progress)')
      return;
    }
    
    // Mark as shutting down immediately
    isShuttingDown = true;
    
    // Prevent the default close temporarily
    event.preventDefault();
    log.info('window', 'Close requested - giving renderer time to save state')
    
    // Send shutdown signal to renderer (it will save state via beforeunload anyway)
    safeSend(mainWindow, 'request-graceful-shutdown');
    
    // Short delay to let beforeunload complete, then force destroy
    // This is a simple, reliable approach
    shutdownTimeout = setTimeout(() => {
      log.info('window', 'Forcing window destroy')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
      shutdownTimeout = null;
    }, 500); // 500ms is enough for localStorage saves
  });
  
  // Register IPC handlers only once (for future extension if needed)
  if (!shutdownHandlersRegistered) {
    shutdownHandlersRegistered = true;
    
    // Optional: renderer can signal early if ready
    ipcMain.on('shutdown-ready', () => {
      log.info('window', 'Renderer signaled shutdown-ready (early)')
      // Window will be destroyed by the timeout anyway
    });
  }
  
  // Handle window closed event
  mainWindow.on('closed', () => { logWindowClosed: logger.logWindowClosed('main-window', 'main');
    mainWindow = null; });
  
  // Log window focus events
  mainWindow.on('focus', () => {
    logger.logWindowFocused('main-window', 'main');
  });

  // Add context menu handler for right-click with standard editing options and "Send to Space"
  mainWindow.webContents.on('context-menu', (event, params) => {
    // Guard: bail if mainWindow was destroyed (edge case during shutdown)
    if (!mainWindow || mainWindow.isDestroyed()) return;
    
    log.info('window', 'Context menu requested at', { x: params.x, y: params.y, arg3: 'selectionText:', selectionText: params.selectionText })
    
    // Allow native DevTools context menu to work (only when right-clicking IN DevTools)
    const url = mainWindow.webContents.getURL();
    if (url.startsWith('devtools://') || url.startsWith('chrome-devtools://')) {
      log.info('window', 'DevTools panel detected, allowing native context menu')
      return; // Don't prevent default, let DevTools handle it
    }
    
    event.preventDefault();
    
    const { Menu, MenuItem, clipboard } = require('electron');
    const contextMenu = new Menu();
    
    // Add Cut option if text is selected and editable
    if (params.editFlags.canCut) {
      contextMenu.append(new MenuItem({
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        click: () => {
          mainWindow.webContents.cut();
        }
      }));
    }
    
    // Add Copy option if text is selected
    if (params.editFlags.canCopy) {
      contextMenu.append(new MenuItem({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        click: () => {
          mainWindow.webContents.copy();
        }
      }));
    }
    
    // Add Paste option if paste is available
    if (params.editFlags.canPaste) {
      contextMenu.append(new MenuItem({
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        click: () => {
          mainWindow.webContents.paste();
        }
      }));
    }
    
    // Add Select All option
    if (params.editFlags.canSelectAll) {
      contextMenu.append(new MenuItem({
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        click: () => {
          mainWindow.webContents.selectAll();
        }
      }));
    }
    
    // Add separator if we have any standard options
    if (params.editFlags.canCut || params.editFlags.canCopy || params.editFlags.canPaste || params.editFlags.canSelectAll) {
      contextMenu.append(new MenuItem({ type: 'separator' }));
    }
    
    // Add "Send to Space" option if text is selected
    if (params.selectionText && params.selectionText.trim().length > 0) {
      contextMenu.append(new MenuItem({
        label: 'Send to Space',
        click: () => {
          log.info('window', 'Send to Space clicked with selection', { detail: params.selectionText.substring(0, 50) })
          
          if (global.clipboardManager) {
            const selectionData = {
              hasText: true,
              hasHtml: false,
              hasImage: false,
              text: params.selectionText,
              html: null
            };
            
            log.info('window', 'Selection data ready', { detail: { textLength: params.selectionText.length } })
            
            // Position the window
            const bounds = mainWindow.getBounds();
            const position = {
              x: bounds.x + bounds.width - 100,
              y: bounds.y + 100
            };
            
            // Create window with selection data - will show modal directly
            global.clipboardManager.createBlackHoleWindow(position, true, selectionData);
          }
        }
      }));
    }
    
    // Add "Send Image to Space" option if right-clicking on an image
    if (params.mediaType === 'image' && params.srcURL) {
      contextMenu.append(new MenuItem({
        label: 'Send Image to Space',
        click: async () => {
          log.info('window', 'Send Image to Space clicked', { srcURL: params.srcURL })
          
          if (global.clipboardManager) {
            try {
              const { net } = require('electron');
              
              // Download the image
              const imageData = await new Promise((resolve, reject) => {
                const request = net.request(params.srcURL);
                const chunks = [];
                
                request.on('response', (response) => {
                  const contentType = response.headers['content-type'] || 'image/png';
                  
                  response.on('data', (chunk) => {
                    chunks.push(chunk);
                  });
                  
                  response.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    const mimeType = Array.isArray(contentType) ? contentType[0] : contentType;
                    resolve(`data:${mimeType};base64,${base64}`);
                  });
                  
                  response.on('error', reject);
                });
                
                request.on('error', reject);
                request.end();
              });
              
              const imageDataObj = {
                hasText: false,
                hasHtml: false,
                hasImage: true,
                text: null,
                html: null,
                imageDataUrl: imageData,
                sourceUrl: params.srcURL
              };
              
              log.info('window', 'Image data ready from', { srcURL: params.srcURL })
              
              // Position the window
              const bounds = mainWindow.getBounds();
              const position = {
                x: bounds.x + bounds.width - 100,
                y: bounds.y + 100
              };
              
              // Create window with image data - will show modal directly
              global.clipboardManager.createBlackHoleWindow(position, true, imageDataObj);
            } catch (error) {
              log.error('window', 'Error downloading image', { error: error.message || error })
              // Fallback: just send the URL as text
              const fallbackData = {
                hasText: true,
                hasHtml: false,
                hasImage: false,
                text: params.srcURL,
                html: null
              };
              
              const bounds = mainWindow.getBounds();
              const position = {
                x: bounds.x + bounds.width - 100,
                y: bounds.y + 100
              };
              
              global.clipboardManager.createBlackHoleWindow(position, true, fallbackData);
            }
          }
        }
      }));
      
      // Also add "Copy Image" option for convenience
      contextMenu.append(new MenuItem({
        label: 'Copy Image',
        click: () => {
          mainWindow.webContents.copyImageAt(params.x, params.y);
        }
      }));
    }
    
    // Add "Paste to Space" option (for clipboard content)
    contextMenu.append(new MenuItem({
      label: 'Paste to Space',
      click: () => {
        log.info('window', 'Paste to Space clicked')
        
        // Get clipboard manager from global
        if (global.clipboardManager) {
          // Read clipboard data FIRST
          const text = clipboard.readText();
          const html = clipboard.readHTML();
          const image = clipboard.readImage();
          
          // Check if HTML is really meaningful
          let isRealHtml = false;
          if (html && text) {
            const hasBlocks = /<(div|p|br|table|ul|ol|li|h[1-6])\b/i.test(html);
            const hasLinks = /<a\s+[^>]*href\s*=/i.test(html);
            const hasImages = /<img\s+[^>]*src\s*=/i.test(html);
            const hasFormatting = /<(strong|em|b|i|u)\b/i.test(html);
            isRealHtml = hasBlocks || hasLinks || hasImages || hasFormatting;
          }
          
          const clipboardData = {
            hasText: !!text,
            hasHtml: isRealHtml,
            hasImage: !image.isEmpty(),
            text: text,
            html: isRealHtml ? html : null
          };
          
          if (!image.isEmpty()) {
            clipboardData.imageDataUrl = image.toDataURL();
          }
          
          log.info('window', 'Clipboard data ready', { detail: { hasText: !!text, hasHtml: isRealHtml, hasImage: !image.isEmpty() } })
          
          // Position the window
          const bounds = mainWindow.getBounds();
          const position = {
            x: bounds.x + bounds.width - 100,
            y: bounds.y + 100
          };
          
          // Create window with clipboard data - will show modal directly
          global.clipboardManager.createBlackHoleWindow(position, true, clipboardData);
        }
      }
    }));
    
    // Use setImmediate to ensure the menu shows after all other handlers
    setImmediate(() => {
      contextMenu.popup({
        window: mainWindow,
        x: params.x,
        y: params.y
      });
    });
  });

  return mainWindow;
}

/**
 * Creates a secure window for external content with proper security
 * @param {BrowserWindow} parentWindow - The parent window
 * @returns {BrowserWindow} The secure content window
 */
function createSecureContentWindow(parentWindow) {
  // Create a window with more restrictive security settings for external content
  const contentWindow = new BrowserWindow({
    width: parentWindow.getSize()[0],
    height: parentWindow.getSize()[1],
    parent: parentWindow,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true,
      enableRemoteModule: false, // Disable remote module
      preload: path.join(__dirname, 'preload-minimal.js') // Use a minimal preload script
    }
  });

  // Set Content Security Policy for the content window
  // PERFORMANCE: Only apply CSP to onereach.ai domains
  contentWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*.onereach.ai/*', 'file://*'] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "style-src 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322 http://127.0.0.1:47291 http://localhost:47291; " +
          "img-src 'self' data: spaces: https://*.onereach.ai https://*.googleapis.com https://*.gstatic.com https://www.google.com; " +
          "font-src 'self' data: https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' blob: https://*.onereach.ai; " +
          "worker-src 'self' blob:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  // Attach structured log forwarding
  attachLogForwarder(contentWindow, 'external');

  // Setup security monitoring for external content
  contentWindow.webContents.on('will-navigate', (event, url) => {
    // Log navigation attempts
    log.info('window', 'Content window navigation attempted to', { url })
    
    // Allow navigation within the same window for IDW and chat URLs
    if (url.startsWith('https://idw.edison.onereach.ai/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/') || 
        url.includes('/chat/')) {
      log.info('window', 'Navigation to IDW/chat URL allowed in same window', { url })
      return;
    }
    
    // Allow navigation for GSX domains
    if (url.includes('.onereach.ai/') &&
        (url.includes('actiondesk.') || 
         url.includes('studio.') || 
         url.includes('hitl.') || 
         url.includes('tickets.') || 
         url.includes('calendar.') || 
         url.includes('docs.'))) {
      log.info('window', 'Navigation to GSX URL allowed in same window', { url })
      return;
    }
    
    // Block navigation to unexpected URLs
    log.info('window', 'Blocking navigation to non-IDW/GSX URL', { url })
    event.preventDefault();
    
    // Open external URLs in default browser instead
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        log.error('window', 'Failed to open external URL', { error: err.message || err })
      });
    }
  });

  // Handle redirect events
  contentWindow.webContents.on('will-redirect', (event, url) => {
    log.info('window', 'Content window redirect attempted to', { url })
    
    // Allow redirects to IDW and chat URLs in the same window
    if (url.startsWith('https://idw.edison.onereach.ai/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/') || 
        url.includes('/chat/')) {
      log.info('window', 'Redirect to IDW/chat URL allowed in same window', { url })
      return;
    }
    
    // Allow redirects for GSX domains
    if (url.includes('.onereach.ai/') &&
        (url.includes('actiondesk.') || 
         url.includes('studio.') || 
         url.includes('hitl.') || 
         url.includes('tickets.') || 
         url.includes('calendar.') || 
         url.includes('docs.'))) {
      log.info('window', 'Redirect to GSX URL allowed in same window', { url })
      return;
    }
    
    // Block redirects to unexpected URLs
    log.info('window', 'Blocking redirect to non-IDW/GSX URL', { url })
    event.preventDefault();
    
    // Open external URLs in default browser instead
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        log.error('window', 'Failed to open external URL on redirect', { error: err.message || err })
      });
    }
  });

  // Add scripts and styling on page load
  contentWindow.webContents.on('did-finish-load', () => {
    // Check for Material Symbols font and preload if needed
    contentWindow.webContents.executeJavaScript(`
      (function() {
        // Check if page uses Material Symbols
        const hasSymbols = document.querySelector('.material-symbols-outlined, .material-icons');
        if (hasSymbols) {
          console.log('[Window] Material Symbols found on page, preloading font');
          
          // Add preload link for Material Icons font
          const preloadLink = document.createElement('link');
          preloadLink.rel = 'preload';
          preloadLink.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
          preloadLink.as = 'style';
          document.head.appendChild(preloadLink);
          
          return true;
        } else {
          console.log('[Window] No Material Symbols elements found on page, skipping preload');
          return false;
        }
      })();
    `).catch(err => log.warn('window', 'Material Symbols check skipped (page not ready)', { error: err.message || err }))
    
    // Inject script to intercept link clicks
    contentWindow.webContents.executeJavaScript(`
      (function() {
        // If we've already installed the interceptor, don't do it again
        if (window.__linkInterceptorInstalled) return false;
        
        // Mark as installed
        window.__linkInterceptorInstalled = true;
        
        // Add click event listener to the document
        document.addEventListener('click', (event) => {
          // Check if the clicked element is a link
          let target = event.target;
          while (target && target.tagName !== 'A') {
            target = target.parentElement;
          }
          
          // If we found a link
          if (target && target.tagName === 'A') {
            const url = target.href;
            
            // Log chat URLs (will be handled by will-navigate)
            if (url && (url.includes('/chat/') || 
                         url.startsWith('https://flow-desc.chat.edison.onereach.ai/'))) {
              console.log('[Window] Chat link clicked:', url);
              // We don't need to do anything here - just log
            }
          }
        }, true);
        
        console.log('[Window] Link click interceptor installed');
        return true;
      })();
    `).catch(err => log.error('window', 'Failed to inject link handler script', { error: err.message || err }))
    
    // Add custom scrollbar styling
    contentWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => log.error('window', 'Failed to inject scrollbar CSS', { error: err.message || err }))
  });

  // Handle downloads in secure content windows
  contentWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Use the new handler with space option
    handleDownloadWithSpaceOption(item, 'Secure Window');
  });

  // Monitor for unexpected new windows
  contentWindow.webContents.setWindowOpenHandler(({ url }) => {
    log.info('window', 'External content attempted to open new window', { url })
    
    // For chat URLs, navigate the current window instead of opening a new one
    if (url.includes('/chat/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
      log.info('window', 'Chat URL detected, navigating current window to', { url })
      
      // Handle this URL manually by loading it in the current window
      setTimeout(() => {
        contentWindow.loadURL(url).catch(err => {
          log.error('window', 'Failed to load chat URL in current window', { error: err.message || err })
        });
      }, 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // For GSX URLs, navigate the current window
    if (url.includes('.onereach.ai/') &&
        (url.includes('actiondesk.') || 
         url.includes('studio.') || 
         url.includes('hitl.') || 
         url.includes('tickets.') || 
         url.includes('calendar.') || 
         url.includes('docs.'))) {
      log.info('window', 'GSX URL detected, navigating current window to', { url })
      
      // Handle this URL manually by loading it in the current window
      setTimeout(() => {
        contentWindow.loadURL(url).catch(err => {
          log.error('window', 'Failed to load GSX URL in current window', { error: err.message || err })
        });
      }, 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // Only allow URLs that match our expected domains for external browser
    if (url.startsWith('https://idw.edison.onereach.ai/')) {
      // Open non-chat IDW URLs in the default browser
      shell.openExternal(url).catch(err => {
        log.error('window', 'Failed to open external URL', { error: err.message || err })
      });
    }
    
    // Prevent the app from opening the window directly
    return { action: 'deny' };
  });

  return contentWindow;
}

/**
 * Opens a URL in a secure content window
 * @param {string} url - The URL to open
 */
function openURLInMainWindow(url) {
  log.info('window', 'Opening URL in main window', { url })
  
  if (!mainWindow) {
    log.error('window', 'Main window not available')
    return;
  }
  
  // Make sure the URL is valid
  try {
    const urlObj = new URL(url);
    
    // Make sure it's using http or https protocol
    if (!urlObj.protocol.match(/^https?:$/)) {
      log.error('window', 'Invalid URL protocol', { protocol: urlObj.protocol })
      throw new Error(`Invalid URL protocol: ${urlObj.protocol}`);
    }
    
    log.info('window', 'Loading URL in main window', { href: urlObj.href })
    
    // Create a secure window for external content to avoid security issues
    // with Node.js integration in the main window
    const contentWindow = createSecureContentWindow(mainWindow);
    
    // Show loading indicator in the main window before loading URL
    mainWindow.webContents.executeJavaScript(`
      document.body.innerHTML += '<div id="loading-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; z-index: 9999;"><div style="color: white; font-size: 20px;">Loading IDW environment...</div></div>';
    `).catch(err => log.error('window', 'Error showing loading indicator', { error: err.message || err }))

    // Close the main window when loading is complete
    contentWindow.webContents.on('did-finish-load', () => {
      mainWindow.hide(); // Hide instead of close to keep the app running
      contentWindow.show();
    });
    
    // When content window is closed, show main window again
    contentWindow.on('closed', () => {
      mainWindow.show();
      mainWindow.focus();
    });

    // Load the URL in the content window
    contentWindow.loadURL(urlObj.href).catch(error => {
      log.error('window', 'Error loading URL', { error: error.message || error })
      contentWindow.close(); // Close the content window on error
      
      // Show error notification
      mainWindow.webContents.send('show-notification', {
        title: 'Error',
        body: `Failed to load IDW environment: ${error.message}`
      });
    });
  } catch (error) {
    log.error('window', 'Error parsing URL', { error: error.message || error })
    
    // Show error notification
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('show-notification', {
        title: 'Error',
        body: `Invalid URL format: ${error.message}`
      });
    }
  }
}

/**
 * Creates a setup wizard window
 * @param {Object} options - Options for the wizard window
 * @returns {BrowserWindow} The wizard window
 */
function createSetupWizardWindow(options = {}) {
  const wizardWindow = new BrowserWindow({
    width: 900,
    height: 650,
    parent: mainWindow, // Make it a child of the main window
    modal: true, // Make it a modal
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#141414', // Match setup-wizard.html body background
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false // Disable sandbox to allow IPC access
    },
    ...options
  });

  // Attach structured log forwarding
  attachLogForwarder(wizardWindow, 'settings');

  // Set CSP for wizard window
  // PERFORMANCE: Only apply CSP to onereach.ai domains
  wizardWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*.onereach.ai/*', 'file://*'] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "style-src 'self' 'unsafe-inline' https://*.onereach.ai; " +
          "style-src-elem 'self' 'unsafe-inline' https://*.onereach.ai; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322 http://127.0.0.1:47291 http://localhost:47291; " +
          "img-src 'self' data: spaces: https://*.onereach.ai; " +
          "font-src 'self' data: https://*.onereach.ai; " +
          "media-src 'self' https://*.onereach.ai; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  return wizardWindow;
}

/**
 * Creates a test window for development
 * @returns {BrowserWindow} The test window
 */
function createTestWindow() {
  const testWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true
    }
  });

  // Attach structured log forwarding
  attachLogForwarder(testWindow, 'test');

  // Set CSP for test window
  // PERFORMANCE: Only apply CSP to onereach.ai domains
  testWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*.onereach.ai/*', 'file://*'] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "style-src 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322 http://127.0.0.1:47291 http://localhost:47291; " +
          "img-src 'self' data: spaces: https://*.onereach.ai https://*.googleapis.com https://*.gstatic.com https://www.google.com; " +
          "font-src 'self' data: https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' https://*.onereach.ai; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  return testWindow;
}

/**
 * Gets the main window reference
 * @returns {BrowserWindow|null} The main window or null if not created
 */
function getMainWindow() {
  return mainWindow;
}

/**
 * Creates a window specifically for GSX content
 * @param {string} url - The GSX URL to open
 * @param {string} title - Title for the window
 * @param {string} idwEnvironment - Optional environment name to create environment-specific sessions
 * @returns {BrowserWindow} The created GSX window
 */
async function openGSXWindow(url, title, idwEnvironment) {
  log.info('window', 'Opening GSX window for ...: ...', { title, url })
  
  if (!logger) {
    logger = getLogger();
  }
  
  logger.logWindowCreated('gsx-window', title, {
    url,
    environment: idwEnvironment
  });
  
  // Multi-tenant token injection - inject BEFORE creating window
  // This ensures the token is available when the window first loads
  const multiTenantStore = require('./multi-tenant-store');
  
  // Extract environment from URL if not provided
  // Use the multi-tenant-store's extraction logic for consistency
  if (!idwEnvironment) {
    try {
      idwEnvironment = multiTenantStore.extractEnvironmentFromUrl(url);
      log.info('window', 'Extracted environment \'...\' from URL: ...', { idwEnvironment, url })
    } catch (err) {
      log.error('window', 'Error parsing GSX URL to extract environment', { error: err.message || err })
      idwEnvironment = 'production'; // Default to production
    }
  }
  
  // Create session partition name based ONLY on the IDW environment
  // This allows all GSX windows in the same IDW group to share cookies
  // while keeping different IDW groups sandboxed from each other
  const partitionName = `gsx-${idwEnvironment}`;
  const fullPartition = `persist:${partitionName}`;
  
  log.info('window', 'Using shared session partition for IDW group: ...', { partitionName })
  
  // Use centralized hardened injection with retry logic and verification
  const injectionResult = await multiTenantStore.injectAndRegister(
    idwEnvironment, 
    fullPartition, 
    { source: 'browserWindow.openGSXWindow' }
  );
  
  // Store injection status for later display
  const authStatus = {
    hasToken: injectionResult.success,
    cookieCount: injectionResult.cookieCount,
    domains: injectionResult.domains,
    error: injectionResult.error,
    environment: idwEnvironment
  };
  
  if (injectionResult.success) {
    log.info('window', 'Token injection successful: ... cookies on ...', { cookieCount: injectionResult.cookieCount, domains: injectionResult.domains.join(', ') })
  } else if (injectionResult.error) {
    log.warn('window', 'Token injection issue: ... - user may need to login manually', { error: injectionResult.error })
  }
  
  // Create a window with proper security settings for GSX content
  const gsxWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `GSX - ${title} (${idwEnvironment})`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: true,
      // Screen-sharing removed – use standard preload
      preload: path.join(__dirname, 'preload.js'),
      // Use a persistent partition specific to this GSX service and environment
      partition: fullPartition,
      // Enable media access for screen sharing
      enableRemoteModule: false,
      allowRunningInsecureContent: false
    }
  });
  
  // Attach structured log forwarding
  attachLogForwarder(gsxWindow, 'window');

  // Set Content Security Policy for the GSX window
  // PERFORMANCE: Only apply CSP to onereach.ai domains
  gsxWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*.onereach.ai/*', 'file://*'] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "style-src 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322 wss://*.onereach.ai http://127.0.0.1:47291 http://localhost:47291; " +
          "img-src 'self' data: spaces: https://*.onereach.ai https://*.googleapis.com https://*.gstatic.com https://www.google.com; " +
          "font-src 'self' data: https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' blob: https://*.onereach.ai; " +
          "worker-src 'self' blob:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });
  
  // Enable screen capture permissions
  gsxWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    log.info('window', 'GSX Window - Permission requested: ...', { permission })
    
    // Allow screen capture and media permissions
    if (permission === 'media' || permission === 'display-capture' || permission === 'screen') {
      log.info('window', 'GSX Window - Granting ... permission', { permission })
      callback(true);
    } else {
      log.info('window', 'GSX Window - Denying ... permission', { permission })
      callback(false);
    }
  });

  // Handle media access requests
  gsxWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    log.info('window', 'GSX Window - Permission check: ... from ...', { permission, requestingOrigin })
    
    // Allow media permissions for onereach.ai domains
    if ((permission === 'media' || permission === 'display-capture' || permission === 'screen') && 
        requestingOrigin.includes('onereach.ai')) {
      log.info('window', 'GSX Window - Allowing ... for ...', { permission, requestingOrigin })
      return true;
    }
    
    return false;
  });

  // Add debugging for window events
  gsxWindow.on('close', () => {
    log.info('window', 'GSX Window closing: ...', { title })
  });
  
  gsxWindow.on('closed', () => {
    log.info('window', 'GSX Window closed: ...', { title })
    // Clean up auto-login state to prevent memory leak
    cleanupGSXAutoLoginState(gsxWindow.id);
  });
  
  gsxWindow.on('hide', () => {
    log.info('window', 'GSX Window hidden: ...', { title })
  });
  
  gsxWindow.webContents.on('crashed', () => {
    log.error('window', 'GSX Window crashed: ...', { title })
  });
  
  gsxWindow.webContents.on('unresponsive', () => {
    log.error('window', 'GSX Window unresponsive: ...', { title })
  });
  
  gsxWindow.webContents.on('responsive', () => {
    log.info('window', 'GSX Window responsive again: ...', { title })
  });

  // Load the URL
  log.info('window', 'Loading GSX URL: ...', { url })
  gsxWindow.loadURL(url);
  
  // Show auth status notification when page loads
  gsxWindow.webContents.on('did-finish-load', () => {
    // Use JSON.stringify to safely inject values (prevents injection via quotes in env names)
    const statusColor = authStatus.hasToken ? '#22c55e' : '#f59e0b';
    const statusText = authStatus.hasToken 
      ? `Authenticated (${authStatus.environment})` 
      : `No token for ${authStatus.environment} - login required`;
    const tooltipText = `Click to dismiss. Cookies: ${authStatus.cookieCount || 0}, Domains: ${(authStatus.domains || []).join(', ') || 'none'}`;
    
    safeExecuteJS(gsxWindow, `
      (function() {
        var statusColor = ${JSON.stringify(statusColor)};
        var statusText = ${JSON.stringify(statusText)};
        var tooltipText = ${JSON.stringify(tooltipText)};
        
        // Remove existing status if any
        var existing = document.getElementById('gsx-auth-status');
        if (existing) existing.remove();
        
        // Create status indicator
        var status = document.createElement('div');
        status.id = 'gsx-auth-status';
        status.style.cssText = 'position:fixed;bottom:10px;right:10px;padding:8px 16px;background:' + statusColor + ';color:white;border-radius:6px;font-family:system-ui;font-size:12px;z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,0.2);cursor:pointer;transition:opacity 0.3s;';
        status.textContent = statusText;
        status.title = tooltipText;
        status.onclick = function() { this.style.opacity = '0'; setTimeout(function() { status.remove(); }, 300); };
        document.body.appendChild(status);
        
        // Auto-hide after 8 seconds
        setTimeout(function() {
          if (status.parentNode) {
            status.style.opacity = '0';
            setTimeout(function() { status.remove(); }, 300);
          }
        }, 8000);
        
        log.info('window', 'Status: \' + statusTex')
      })();
    `);
  });
  
  // Handle downloads in GSX windows
  gsxWindow.webContents.session.on('will-download', (event, item, webContents) => { detail: // Use the new handler with space option
    handleDownloadWithSpaceOption(item, 'GSX Window'); });
  
  // Add event handlers for will-navigate and will-redirect
  gsxWindow.webContents.on('will-navigate', (event, navUrl) => {
    log.info('window', 'GSX window navigation attempted to', { navUrl })
    
    // Allow navigation for GSX and IDW domains
    if (navUrl.includes('.onereach.ai/')) {
      log.info('window', 'Navigation to onereach.ai URL allowed in GSX window', { navUrl })
      return;
    }
    
    // Block navigation to other domains
    log.info('window', 'Blocking navigation to non-onereach.ai URL in GSX window', { navUrl })
    event.preventDefault();
    
    // Open external URLs in default browser
    shell.openExternal(navUrl).catch(err => {
      log.error('window', 'Failed to open external URL from GSX window', { error: err.message || err })
    });
  });
  
  // Handle window open events (like authentication popups)
  gsxWindow.webContents.setWindowOpenHandler(({ url }) => {
    log.info('window', 'GSX window attempted to open URL', { url })
    
    // For authentication URLs, use the centralized auth window
    if (url.includes('auth.edison.onereach.ai') || 
        url.includes('sso.global.api.onereach.ai') ||
        url.includes('accounts.google.com')) {
      
      // Determine the service type
      let service = 'onereach';
      if (url.includes('accounts.google.com')) {
        service = 'google';
      }
      
      // Handle auth request
      handleAuthRequest(url, service)
        .then(token => {
          safeSend(gsxWindow, 'auth-token', { service, token });
        })
        .catch(error => {
          log.error('window', 'Authentication failed', { error: error.message || error })
          safeSend(gsxWindow, 'auth-error', { service, error: error.message });
        });
      
      return { action: 'deny' };
    }
    
    // For onereach.ai URLs, allow to open in the same window
    if (url.includes('.onereach.ai/')) {
      return { action: 'allow' };
    }
    
    // Deny other URLs and open in default browser
    shell.openExternal(url).catch(err => {
      log.error('window', 'Failed to open external URL', { error: err.message || err })
    });
    
    return { action: 'deny' };
  });
  
  // Add custom scrollbar CSS when content loads
  gsxWindow.webContents.on('did-finish-load', async () => {
    const currentUrl = gsxWindow.webContents.getURL();
    log.info('window', 'Loaded: ...', { currentUrl })
    
    // Inject scrollbar CSS
    gsxWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => log.error('window', 'Failed to inject scrollbar CSS in GSX window', { error: err.message || err }))
    
    // Auto-login for OneReach pages (with retry for async-loaded forms)
    if (currentUrl && currentUrl.includes('onereach.ai')) {
      // Check state before attempting
      if (!shouldAttemptGSXAutoLogin(gsxWindow.id)) {
        log.info('window', 'Skipping - already in progress or complete')
      } else {
        log.info('window', 'OneReach page detected, starting auto-login...')
        setTimeout(() => {
          attemptGSXAutoLoginWithRetry(gsxWindow, currentUrl, 0);
        }, 1000);
      }
    }
  });
  
  // Handle full page navigation (for auth redirects)
  gsxWindow.webContents.on('did-navigate', async (event, url) => {
    log.info('window', 'Full navigation: ...', { url })
    
    // Auto-login for auth pages (when GSX redirects to auth.*.onereach.ai)
    if (url && url.includes('auth.') && url.includes('onereach.ai')) {
      // Check state before attempting
      if (!shouldAttemptGSXAutoLogin(gsxWindow.id)) {
        log.info('window', 'Skipping - already in progress or complete')
        return;
      }
      log.info('window', 'Auth page detected via redirect, starting auto-login...')
      // Wait for form to render
      setTimeout(() => {
        attemptGSXAutoLoginWithRetry(gsxWindow, url, 0);
      }, 1500);
    }
  });
  
  // Handle SPA navigation (for auth page internal navigation)
  gsxWindow.webContents.on('did-navigate-in-page', async (event, url) => {
    log.info('window', 'In-page navigation: ...', { url })
    
    // Auto-login for auth pages
    if (url && url.includes('onereach.ai') && url.includes('/login')) {
      // Check state before attempting
      if (!shouldAttemptGSXAutoLogin(gsxWindow.id)) {
        return;
      }
      log.info('window', 'Auth login page detected via SPA navigation')
      // Wait for form to render then retry
      setTimeout(() => {
        attemptGSXAutoLoginWithRetry(gsxWindow, url, 0);
      }, 1000);
    }
  });
  
  return gsxWindow;
}

/**
 * Creates or returns the centralized authentication window
 * @returns {BrowserWindow} The authentication window
 */
function getAuthWindow() {
  if (authWindow) {
    return authWindow;
  }

  // Create a new authentication window
  authWindow = new BrowserWindow({
    width: 800,
    height: 700,
    show: false, // Hide by default
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
      // Use a dedicated partition for auth
      partition: 'persist:auth'
    }
  });

  // Attach structured log forwarding
  attachLogForwarder(authWindow, 'window');

  // Handle auth window events
  authWindow.on('closed', () => {
    authWindow = null;
  });

  // Set up token sharing via IPC
  authWindow.webContents.on('did-finish-load', () => {
    // Listen for successful authentication
    authWindow.webContents.on('ipc-message', (event, channel, ...args) => {
      if (channel === 'auth-success') {
        const [token, service] = args;
        authTokens.set(service, token);
        
        // Broadcast token to all windows (with destroyed-window guard)
        BrowserWindow.getAllWindows().forEach(win => {
          if (win !== authWindow) {
            safeSend(win, 'auth-token-update', { service, token });
          }
        });
      }
    });
  });

  return authWindow;
}

/**
 * Handles authentication requests from any window
 * @param {string} url - The authentication URL
 * @param {string} service - The service requesting auth (e.g., 'google', 'onereach')
 * @returns {Promise<string>} The authentication token
 */
async function handleAuthRequest(url, service) {
  const window = getAuthWindow();
  
  // Check if we already have a valid token
  if (authTokens.has(service)) {
    return authTokens.get(service);
  }

  // Show the auth window
  window.show();
  
  // Load the auth URL
  await window.loadURL(url);

  // Return a promise that resolves when auth is complete
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Authentication timeout'));
    }, 300000); // 5 minute timeout

    // Listen for auth success
    const handler = (event, data) => {
      if (data.service === service) {
        clearTimeout(timeout);
        window.webContents.removeListener('ipc-message', handler);
        window.hide();
        resolve(data.token);
      }
    };

    window.webContents.on('ipc-message', handler);
  });
}

/**
 * Send a downloaded file to the black hole widget (Space picker).
 * Extracted to eliminate code duplication - previously duplicated ~80 lines.
 * Also fixes: ipcMain listener leak by adding a timeout cleanup.
 */
function sendFileToBlackHoleWidget(clipboardManager, filePayload, tempFilePath) {
  const bhWindow = clipboardManager.blackHoleWindow;
  if (!bhWindow || bhWindow.isDestroyed()) {
    log.error('window', `[DOWNLOAD] Black hole window unavailable`)
    return;
  }
  
  // Set up one-time listener for widget ready signal with a timeout to prevent listener leak
  const WIDGET_READY_TIMEOUT = 10000; // 10 seconds
  let listenerFired = false;
  
  const onWidgetReady = () => {
    if (listenerFired) return;
    listenerFired = true;
    log.info('window', `[DOWNLOAD] Black hole widget reported ready, sending file...`)
    
    setTimeout(() => {
      if (clipboardManager.blackHoleWindow && !clipboardManager.blackHoleWindow.isDestroyed()) {
        if (!clipboardManager.blackHoleWindow.isVisible()) {
          clipboardManager.blackHoleWindow.show();
        }
        safeSend(clipboardManager.blackHoleWindow, 'external-file-drop', filePayload);
        log.info('window', `[DOWNLOAD] external-file-drop event sent`)
      } else {
        log.error('window', `[DOWNLOAD] Black hole window destroyed before file send`)
      }
    }, 200);
  };
  
  ipcMain.once('black-hole:widget-ready', onWidgetReady);
  
  // Timeout cleanup: remove the listener if widget never signals ready
  setTimeout(() => {
    if (!listenerFired) {
      ipcMain.removeListener('black-hole:widget-ready', onWidgetReady);
      log.warn('window', 'Widget ready listener timed out after ...ms', { WIDGET_READY_TIMEOUT })
    }
  }, WIDGET_READY_TIMEOUT);
  
  // Handle DOM readiness
  const handleDomReady = () => {
    log.info('window', `[DOWNLOAD] Black hole window DOM ready, sending prepare event`)
    safeSend(clipboardManager.blackHoleWindow, 'prepare-for-download', {
      fileName: filePayload.fileName
    });
    setTimeout(() => {
      safeSend(clipboardManager.blackHoleWindow, 'check-widget-ready');
    }, 100);
  };
  
  if (bhWindow.webContents.getURL() && !bhWindow.webContents.isLoading()) {
    handleDomReady();
  } else {
    bhWindow.webContents.once('dom-ready', handleDomReady);
  }
  
  // Clean up temp file after a delay
  if (tempFilePath) {
    setTimeout(() => {
      fs.unlink(tempFilePath, (err) => {
        if (err && err.code !== 'ENOENT') log.error('window', 'Error deleting temp file', { error: err.message || err })
        else log.info('window', 'Temp file cleaned up: ...', { tempFilePath })
      });
    }, 5000);
  }
}

// Function to handle downloads with space option
function handleDownloadWithSpaceOption(item, windowName = 'Main Window') {
  const fileName = item.getFilename();
  
  log.info('window', 'Download detected in ...: ...', { windowName, fileName })
  log.info('window', 'URL: ...', { detail: item.getURL() })
  log.info('window', 'Size: ... bytes', { detail: item.getTotalBytes() })
  
  // Create dialog options
  const options = {
    type: 'question',
    buttons: ['Save to Downloads', 'Save to Space', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Save Download',
    message: `How would you like to save "${fileName}"?`,
    detail: 'You can save it to your Downloads folder or add it to a Space in your clipboard manager.',
    icon: path.join(__dirname, 'assets/tray-icon.png')
  };
  
  // Show dialog
  dialog.showMessageBox(options).then(async (result) => {
    log.info('window', 'User selected option: ... (0=Downloads, 1=Space, 2=Cancel)', { response: result.response })
    
    if (result.response === 0) {
      // Save to Downloads - normal behavior
      const downloadsPath = app.getPath('downloads');
      const filePath = path.join(downloadsPath, fileName);
      item.setSavePath(filePath);
      
      log.info('window', '... - Download started (Downloads): ...', { windowName, fileName })
      item.resume();
      
      // Set up download progress tracking
      item.on('updated', (event, state) => {
        if (state === 'interrupted') {
          log.info('window', '... - Download interrupted but can be resumed', { windowName })
        } else if (state === 'progressing') {
          if (item.isPaused()) {
            log.info('window', '... - Download is paused', { windowName })
          } else {
            const total = item.getTotalBytes();
            if (total > 0) {
              const progress = item.getReceivedBytes() / total;
              log.info('window', '... - Download progress: ...%', { windowName, detail: Math.round(progress * 100) })
            }
          }
        }
      });
      
      item.once('done', (event, state) => {
        if (state === 'completed') {
          log.info('window', '... - Download completed: ...', { windowName, fileName })
          
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: 'Download Complete',
              body: `${fileName} has been downloaded successfully`,
              icon: path.join(__dirname, 'assets/tray-icon.png')
            });
            notification.on('click', () => shell.showItemInFolder(filePath));
            notification.show();
          }
        } else {
          log.info('window', '... - Download failed: ...', { windowName, state })
        }
      });
    } else if (result.response === 1) {
      // Save to Space
      log.info('window', `[DOWNLOAD] User chose to save to Space`)
      
      const tempPath = app.getPath('temp');
      const tempFilePath = path.join(tempPath, fileName);
      item.setSavePath(tempFilePath);
      
      log.info('window', '... - Download started (Space): ...', { windowName, fileName })
      item.resume();
      
      item.once('done', async (event, state) => {
        if (state === 'completed') {
          log.info('window', '... - Download completed for Space: ...', { windowName, fileName })
          
          try {
            const fileData = fs.readFileSync(tempFilePath);
            const base64Data = fileData.toString('base64');
            log.info('window', 'File read successfully, size: ... bytes', { fileDataCount: fileData.length })
            
            const clipboardManager = global.clipboardManager;
            if (!clipboardManager) {
              log.error('window', `[DOWNLOAD] Clipboard manager not available`)
              return;
            }
            
            const filePayload = {
              fileName: fileName,
              fileData: base64Data,
              fileSize: fileData.length,
              mimeType: item.getMimeType() || 'application/octet-stream'
            };
            
            if (clipboardManager.blackHoleWindow && !clipboardManager.blackHoleWindow.isDestroyed()) {
              // Black hole window already exists - send file directly
              safeSend(clipboardManager.blackHoleWindow, 'prepare-for-download', { fileName });
              sendFileToBlackHoleWidget(clipboardManager, filePayload, tempFilePath);
            } else {
              // Create black hole window first, then send
              log.info('window', `[DOWNLOAD] Creating black hole window...`)
              clipboardManager.createBlackHoleWindow(null, true);
              
              // Wait for creation then send
              setTimeout(() => {
                if (clipboardManager.blackHoleWindow && !clipboardManager.blackHoleWindow.isDestroyed()) {
                  sendFileToBlackHoleWidget(clipboardManager, filePayload, tempFilePath);
                } else {
                  log.error('window', `[DOWNLOAD] Black hole window creation failed`)
                }
              }, 1500);
            }
          } catch (error) {
            log.error('window', 'Error processing file for space', { error: error.message || error })
          }
        } else {
          log.info('window', '... - Download failed: ...', { windowName, state })
        }
      });
    } else {
      // Cancel
      item.cancel();
      log.info('window', '... - Download cancelled by user', { windowName })
    }
  }).catch(err => {
    log.error('window', 'Error showing download dialog', { error: err.message || err })
    // Fallback to normal download
    const downloadsPath = app.getPath('downloads');
    const filePath = path.join(downloadsPath, fileName);
    item.setSavePath(filePath);
    item.resume();
  });
}

module.exports = {
  createMainWindow,
  createSecureContentWindow,
  openURLInMainWindow,
  createSetupWizardWindow,
  createTestWindow,
  getMainWindow,
  openGSXWindow,
  getAuthWindow,
  handleAuthRequest,
  handleDownloadWithSpaceOption,
  attachLogForwarder
}; 