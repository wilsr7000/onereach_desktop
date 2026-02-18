/**
 * Auto-Login Manager for OneReach
 * Automatically handles login forms and 2FA code entry
 *
 * Flow:
 * 1. Detect login page → fill email/password → submit
 * 2. Detect 2FA page → generate TOTP code → fill → submit
 * 3. Capture session token for future use
 */

const { getTOTPManager } = require('./totp-manager');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

class AutoLoginManager {
  constructor(credentialManager) {
    this.credentialManager = credentialManager;
    this.totpManager = getTOTPManager();
    this.pendingLogins = new Map(); // Track in-progress logins by webContentsId
    this.enabled = true; // Can be toggled in settings

    log.info('app', 'Manager initialized');
  }

  /**
   * Enable or disable auto-login
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    log.info('app', '', { enabledEnabledDisabled: enabled ? 'Enabled' : 'Disabled' });
  }

  /**
   * Check if URL is a OneReach domain
   */
  isOneReachDomain(url) {
    if (!url) return false;
    try {
      const hostname = new URL(url).hostname;
      return hostname.includes('onereach.ai');
    } catch {
      return false;
    }
  }

  /**
   * Handle page navigation - detect and act on login/2FA pages
   * Call this from webview 'did-finish-load' or 'dom-ready' event
   */
  async handleNavigation(webContents, url) {
    if (!this.enabled || !this.isOneReachDomain(url)) {
      return { handled: false, reason: 'not applicable' };
    }

    try {
      const pageType = await this.detectPageType(webContents);
      log.info('app', 'Page type detected: for', { pageType: pageType, url: url });

      switch (pageType) {
        case 'login':
          return await this.handleLoginPage(webContents, url);
        case '2fa':
          return await this.handle2FAPage(webContents, url);
        case 'authenticated':
          return { handled: true, reason: 'already authenticated' };
        default:
          return { handled: false, reason: 'unknown page type' };
      }
    } catch (error) {
      log.error('app', 'Navigation handling error', { error: error.message });
      return { handled: false, reason: error.message };
    }
  }

  /**
   * Detect what type of page we're on
   */
  async detectPageType(webContents) {
    try {
      return await webContents.executeJavaScript(`
        (function() {
          // Check for 2FA input first (more specific)
          const totpInputs = document.querySelectorAll(
            'input[name="totp"], input[name="code"], input[name="otp"], ' +
            'input[autocomplete="one-time-code"], ' +
            'input[inputmode="numeric"][maxlength="6"], ' +
            'input[placeholder*="code" i], input[placeholder*="2fa" i]'
          );
          
          // Filter to visible inputs
          const visible2FA = Array.from(totpInputs).find(input => {
            const rect = input.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          
          if (visible2FA) return '2fa';
          
          // Check for login form (password + email/username)
          const passwordInput = document.querySelector('input[type="password"]:not([style*="display: none"])');
          const emailInput = document.querySelector(
            'input[type="email"], input[name="email"], input[name="username"], ' +
            'input[autocomplete="email"], input[autocomplete="username"]'
          );
          
          if (passwordInput && emailInput) return 'login';
          
          // Check if we're already authenticated (look for common indicators)
          const authIndicators = document.querySelectorAll(
            '[href*="logout"], [data-action="logout"], ' +
            '.user-menu, .user-avatar, .account-menu, ' +
            '[class*="dashboard"], [class*="workspace"]'
          );
          
          if (authIndicators.length > 0) return 'authenticated';
          
          return 'unknown';
        })()
      `);
    } catch (error) {
      log.error('app', 'Page detection error', { error: error.message });
      return 'error';
    }
  }

  /**
   * Handle login page - fill credentials and submit
   */
  async handleLoginPage(webContents, _url) {
    const credentials = await this.credentialManager.getOneReachCredentials();

    if (!credentials || !credentials.email || !credentials.password) {
      log.info('app', 'No credentials configured, skipping auto-login');
      return { handled: false, reason: 'no credentials configured' };
    }

    log.info('app', 'Filling login form for', { credentials: credentials.email });

    try {
      const result = await webContents.executeJavaScript(`
        (function() {
          const email = ${JSON.stringify(credentials.email)};
          const password = ${JSON.stringify(credentials.password)};
          
          // Find inputs
          const emailInput = document.querySelector(
            'input[type="email"], input[name="email"], input[name="username"], ' +
            'input[autocomplete="email"], input[autocomplete="username"]'
          );
          const passwordInput = document.querySelector('input[type="password"]');
          
          if (!emailInput || !passwordInput) {
            return { success: false, error: 'Could not find login form fields' };
          }
          
          // Fill function that works with React/Vue/Angular forms
          function fillInput(input, value) {
            // Focus the input
            input.focus();
            
            // Clear existing value
            input.value = '';
            
            // Set the value
            input.value = value;
            
            // Dispatch events that frameworks listen to
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            // For React specifically
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          
          // Fill the form
          fillInput(emailInput, email);
          fillInput(passwordInput, password);
          
          // Find submit button
          const submitBtn = document.querySelector(
            'button[type="submit"], input[type="submit"], ' +
            'button:contains("Sign in"), button:contains("Log in"), button:contains("Login"), ' +
            'button[class*="login"], button[class*="submit"]'
          ) || document.querySelector('form button');
          
          if (submitBtn) {
            // Small delay before clicking to ensure form validation passes
            setTimeout(() => {
              submitBtn.click();
            }, 300);
            return { success: true, submitted: true };
          }
          
          return { success: true, submitted: false, message: 'Form filled but no submit button found' };
        })()
      `);

      log.info('app', 'Login form result', { result: result });
      return { handled: true, ...result };
    } catch (error) {
      log.error('app', 'Login form fill error', { error: error.message });
      return { handled: false, reason: error.message };
    }
  }

  /**
   * Handle 2FA page - generate code and submit
   */
  async handle2FAPage(webContents, _url) {
    const credentials = await this.credentialManager.getOneReachCredentials();

    if (!credentials || !credentials.totpSecret) {
      log.info('app', 'No TOTP secret configured, skipping 2FA auto-fill');
      return { handled: false, reason: 'no TOTP secret configured' };
    }

    try {
      // Generate fresh TOTP code
      const code = this.totpManager.generateCode(credentials.totpSecret);
      log.info('app', 'Generated 2FA code: ****', { code: code.slice(0, 2) });

      const result = await webContents.executeJavaScript(`
        (function() {
          const code = ${JSON.stringify(code)};
          
          // Find 2FA input
          const totpInput = document.querySelector(
            'input[name="totp"], input[name="code"], input[name="otp"], ' +
            'input[autocomplete="one-time-code"], ' +
            'input[inputmode="numeric"][maxlength="6"], ' +
            'input[placeholder*="code" i], input[placeholder*="2fa" i], ' +
            'input[type="text"][maxlength="6"], input[type="number"][maxlength="6"]'
          );
          
          if (!totpInput) {
            // Try finding any visible numeric input
            const allInputs = document.querySelectorAll('input[type="text"], input[type="number"]');
            for (const input of allInputs) {
              const rect = input.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                const placeholder = (input.placeholder || '').toLowerCase();
                const label = input.labels?.[0]?.textContent?.toLowerCase() || '';
                if (placeholder.includes('code') || label.includes('code') || 
                    placeholder.includes('2fa') || label.includes('2fa') ||
                    placeholder.includes('authenticator') || label.includes('authenticator')) {
                  totpInput = input;
                  break;
                }
              }
            }
          }
          
          if (!totpInput) {
            return { success: false, error: 'Could not find 2FA input field' };
          }
          
          // Fill the code
          totpInput.focus();
          totpInput.value = code;
          totpInput.dispatchEvent(new Event('input', { bubbles: true }));
          totpInput.dispatchEvent(new Event('change', { bubbles: true }));
          
          // For React
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(totpInput, code);
          totpInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          // Find and click submit button
          const submitBtn = document.querySelector(
            'button[type="submit"], input[type="submit"], ' +
            'button:contains("Verify"), button:contains("Submit"), button:contains("Continue")'
          ) || document.querySelector('form button');
          
          if (submitBtn) {
            setTimeout(() => {
              submitBtn.click();
            }, 300);
            return { success: true, submitted: true };
          }
          
          return { success: true, submitted: false, message: '2FA filled but no submit button found' };
        })()
      `);

      log.info('app', '2FA form result', { result: result });
      return { handled: true, ...result };
    } catch (error) {
      log.error('app', '2FA form fill error', { error: error.message });
      return { handled: false, reason: error.message };
    }
  }

  /**
   * Manually trigger auto-login attempt
   * Useful for retry or when automatic detection fails
   */
  async attemptLogin(webContents) {
    const url = webContents.getURL();
    return await this.handleNavigation(webContents, url);
  }
}

// Singleton instance
let autoLoginManager = null;

function getAutoLoginManager(credentialManager) {
  if (!autoLoginManager && credentialManager) {
    autoLoginManager = new AutoLoginManager(credentialManager);
  }
  return autoLoginManager;
}

module.exports = { AutoLoginManager, getAutoLoginManager };
