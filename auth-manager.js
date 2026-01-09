/**
 * Authentication Manager for IDW and other services
 * Provides persistent authentication, credential capture, and auto-fill
 */

const { session, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const credentialManager = require('./credential-manager');

class AuthManager {
  constructor(app) {
    this.app = app;
    this.authDataPath = path.join(app.getPath('userData'), 'auth-sessions.json');
    this.sessions = new Map();
    
    // Track webviews with pending credential captures
    // Key: webContentsId, Value: { url, loginPageUrl, hasLoginForm }
    this.loginTracking = new Map();
    
    this.loadSessions();
    this.setupCredentialIPC();
    
    console.log('[AuthManager] Initialized with credential support');
  }

  /**
   * Setup IPC handlers for credential operations
   */
  setupCredentialIPC() {
    // Handle credentials captured from webview form submission
    ipcMain.on('credentials-captured', async (event, data) => {
      console.log('[AuthManager] Credentials captured for:', data.url);
      
      // Store temporarily until we confirm login success
      const key = credentialManager.storePendingCredentials(
        data.url,
        data.username,
        data.password,
        data.idwName || null
      );
      
      // Track this webContents for navigation monitoring
      const webContentsId = event.sender.id;
      this.loginTracking.set(webContentsId, {
        credentialKey: key,
        loginPageUrl: data.url,
        capturedAt: Date.now()
      });
    });

    // Handle request to save pending credentials (user confirmed)
    ipcMain.handle('credentials-save-pending', async (event, { url }) => {
      const pending = credentialManager.getPendingCredentials(url);
      if (pending) {
        const saved = await credentialManager.saveCredential(
          pending.url,
          pending.username,
          pending.password,
          pending.idwName
        );
        return { success: saved };
      }
      return { success: false, error: 'No pending credentials found' };
    });

    // Handle request to dismiss save prompt
    ipcMain.on('credentials-dismiss-save', (event, { url }) => {
      const pending = credentialManager.getPendingCredentials(url);
      if (pending) {
        credentialManager.clearPendingCredentials(pending.key);
      }
    });

    // Handle request to get credential for autofill
    ipcMain.handle('credentials-get', async (event, { url }) => {
      const credential = await credentialManager.getCredential(url);
      if (credential) {
        return {
          success: true,
          username: credential.username,
          password: credential.password,
          idwName: credential.idwName
        };
      }
      return { success: false };
    });

    // Handle request to check if credentials exist
    ipcMain.handle('credentials-check', async (event, { url }) => {
      const hasCredential = await credentialManager.hasCredential(url);
      return { hasCredential };
    });

    // Handle request to list all saved credentials (for settings)
    ipcMain.handle('credentials-list', async () => {
      const credentials = await credentialManager.listCredentials();
      return { credentials };
    });

    // Handle request to delete a credential
    ipcMain.handle('credentials-delete', async (event, { accountKey }) => {
      const deleted = await credentialManager.deleteCredential(accountKey);
      return { success: deleted };
    });

    // Handle request to delete all credentials
    ipcMain.handle('credentials-delete-all', async () => {
      const count = await credentialManager.deleteAllCredentials();
      return { deleted: count };
    });

    // Handle manual credential save (from IDW menu)
    ipcMain.handle('credentials-save-manual', async (event, { url, username, password, idwName }) => {
      const saved = await credentialManager.saveCredential(url, username, password, idwName);
      return { success: saved };
    });

    // Handle login form detected notification
    ipcMain.on('login-form-detected', async (event, { url, hasCredential }) => {
      console.log('[AuthManager] Login form detected at:', url, 'Has saved credential:', hasCredential);
      
      const webContentsId = event.sender.id;
      this.loginTracking.set(webContentsId, {
        ...this.loginTracking.get(webContentsId),
        hasLoginForm: true,
        loginPageUrl: url
      });
    });

    console.log('[AuthManager] Credential IPC handlers registered');
  }

  async loadSessions() {
    try {
      const data = await fs.readFile(this.authDataPath, 'utf8');
      const sessions = JSON.parse(data);
      Object.entries(sessions).forEach(([domain, cookies]) => {
        this.sessions.set(domain, cookies);
      });
      console.log('Loaded auth sessions for domains:', Array.from(this.sessions.keys()));
    } catch (error) {
      console.log('No existing auth sessions found');
    }
  }

  async saveSessions() {
    try {
      const data = {};
      this.sessions.forEach((cookies, domain) => {
        data[domain] = cookies;
      });
      await fs.writeFile(this.authDataPath, JSON.stringify(data, null, 2));
      console.log('Saved auth sessions');
    } catch (error) {
      console.error('Error saving auth sessions:', error);
    }
  }

  /**
   * Setup authentication persistence for a window
   */
  setupAuthPersistence(window) {
    const ses = window.webContents.session;

    // Listen for cookie changes on auth domains
    ses.cookies.on('changed', async (event, cookie, cause, removed) => {
      if (!cookie.domain) return;

      const authDomains = [
        'google.com',
        'accounts.google.com',
        'onereach.ai',
        'edison.onereach.ai',
        'microsoft.com',
        'login.microsoftonline.com',
        'adobe.com',
        'auth.services.adobe.com'
      ];

      const isAuthDomain = authDomains.some(domain => 
        cookie.domain.includes(domain)
      );

      if (isAuthDomain && !removed) {
        console.log(`Storing auth cookie: ${cookie.name} for ${cookie.domain}`);
        
        // Get all cookies for this domain
        const cookies = await ses.cookies.get({ domain: cookie.domain });
        
        // Filter for important auth cookies
        const authCookies = cookies.filter(c => 
          c.name.includes('auth') ||
          c.name.includes('session') ||
          c.name.includes('token') ||
          c.name.includes('SID') ||
          c.name.includes('SSID') ||
          c.name.includes('HSID') ||
          c.name.includes('APISID') ||
          c.name.includes('SAPISID') ||
          c.name.includes('__Secure') ||
          c.name === 'user'
        );

        if (authCookies.length > 0) {
          this.sessions.set(cookie.domain, authCookies);
          await this.saveSessions();
        }
      }
    });

    // Restore saved sessions when window loads
    window.webContents.on('did-start-loading', async () => {
      const url = window.webContents.getURL();
      
      for (const [domain, cookies] of this.sessions) {
        if (url.includes(domain)) {
          console.log(`Restoring ${cookies.length} auth cookies for ${domain}`);
          
          for (const cookie of cookies) {
            try {
              await ses.cookies.set({
                url: `https://${cookie.domain}`,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                secure: cookie.secure !== false,
                httpOnly: cookie.httpOnly !== false,
                expirationDate: cookie.expirationDate || (Date.now() / 1000) + 86400 * 30 // 30 days
              });
            } catch (error) {
              console.error(`Error restoring cookie ${cookie.name}:`, error);
            }
          }
        }
      }
    });

    // Inject helper for auto-fill and credential capture
    window.webContents.on('did-finish-load', () => {
      this.injectAuthHelper(window);
    });
    
    // Monitor navigation for login success detection
    window.webContents.on('did-navigate', (event, url) => {
      this.handleNavigation(window.webContents.id, url);
    });
    
    window.webContents.on('did-navigate-in-page', (event, url) => {
      this.handleNavigation(window.webContents.id, url);
    });
  }

  /**
   * Setup credential capture for a webview (called from browser-renderer)
   * @param {WebContents} webContents - The webview's webContents
   */
  setupWebviewCredentialCapture(webContents) {
    // Inject credential helper when webview loads
    webContents.on('did-finish-load', () => {
      this.injectCredentialHelper(webContents);
    });
    
    // Monitor navigation for login success
    webContents.on('did-navigate', (event, url) => {
      this.handleNavigation(webContents.id, url);
    });
    
    webContents.on('did-navigate-in-page', (event, url) => {
      this.handleNavigation(webContents.id, url);
    });
  }

  /**
   * Handle navigation events for login success detection
   */
  async handleNavigation(webContentsId, newUrl) {
    const tracking = this.loginTracking.get(webContentsId);
    if (!tracking || !tracking.credentialKey) return;
    
    // Check if we navigated away from the login page
    const loginPageDomain = new URL(tracking.loginPageUrl).hostname;
    let navigatedAway = false;
    
    try {
      const newDomain = new URL(newUrl).hostname;
      // Consider login successful if:
      // 1. Domain changed, OR
      // 2. URL no longer contains login-related paths
      const loginPaths = ['login', 'signin', 'auth', 'authenticate', 'sso'];
      const wasOnLoginPath = loginPaths.some(p => tracking.loginPageUrl.toLowerCase().includes(p));
      const stillOnLoginPath = loginPaths.some(p => newUrl.toLowerCase().includes(p));
      
      navigatedAway = (newDomain !== loginPageDomain) || (wasOnLoginPath && !stillOnLoginPath);
    } catch (e) {
      // Invalid URL, ignore
      return;
    }
    
    if (navigatedAway) {
      console.log('[AuthManager] Login appears successful, prompting to save credentials');
      
      // Get pending credentials
      const pending = credentialManager.getPendingCredentials(tracking.loginPageUrl);
      if (pending) {
        // Send message to show save prompt in the webview/window
        try {
          const { webContents } = require('electron');
          const wc = webContents.fromId(webContentsId);
          if (wc && !wc.isDestroyed()) {
            wc.send('show-save-credential-prompt', {
              domain: pending.domain,
              username: pending.username,
              idwName: pending.idwName
            });
          }
        } catch (e) {
          console.error('[AuthManager] Error sending save prompt:', e);
        }
      }
      
      // Clear tracking for this webContents
      this.loginTracking.delete(webContentsId);
    }
  }

  /**
   * Inject credential capture and autofill helper into webview
   */
  injectCredentialHelper(webContents) {
    const script = `
      (function() {
        if (window.__credentialHelperInjected) return;
        window.__credentialHelperInjected = true;
        
        console.log('[CredentialHelper] Initializing...');
        
        // Detect login form fields with various selectors
        function findLoginFields() {
          // Password field - most reliable indicator
          const passwordFields = document.querySelectorAll(
            'input[type="password"]:not([autocomplete="new-password"])'
          );
          
          if (passwordFields.length === 0) return null;
          
          // Find username/email field - look for common patterns
          const usernameSelectors = [
            'input[type="email"]',
            'input[name*="email" i]',
            'input[id*="email" i]',
            'input[name*="user" i]',
            'input[id*="user" i]',
            'input[name*="login" i]',
            'input[id*="login" i]',
            'input[autocomplete="username"]',
            'input[autocomplete="email"]'
          ];
          
          let usernameField = null;
          for (const selector of usernameSelectors) {
            const fields = document.querySelectorAll(selector);
            for (const field of fields) {
              // Make sure it's visible and not a password field
              if (field.type !== 'password' && field.offsetParent !== null) {
                usernameField = field;
                break;
              }
            }
            if (usernameField) break;
          }
          
          // If no username field found, look for text input near password
          if (!usernameField) {
            const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
            for (const input of allInputs) {
              if (input.offsetParent !== null) {
                usernameField = input;
                break;
              }
            }
          }
          
          return {
            passwordField: passwordFields[0],
            usernameField: usernameField,
            hasLoginForm: true
          };
        }
        
        // Check for login form and notify main process
        async function checkForLoginForm() {
          const fields = findLoginFields();
          if (!fields) return;
          
          const url = window.location.href;
          
          // Check if we have saved credentials for this domain
          let hasCredential = false;
          if (window.api && window.api.invoke) {
            try {
              const result = await window.api.invoke('credentials-check', { url });
              hasCredential = result.hasCredential;
            } catch (e) {
              console.log('[CredentialHelper] Could not check for credentials:', e);
            }
          }
          
          // Notify main process
          if (window.api && window.api.send) {
            window.api.send('login-form-detected', { url, hasCredential });
          }
          
          // If we have saved credentials, show autofill prompt
          if (hasCredential) {
            showAutofillPrompt(fields);
          }
          
          // Setup form submission capture
          setupFormCapture(fields);
        }
        
        // Show autofill prompt
        function showAutofillPrompt(fields) {
          // Remove existing prompt if any
          const existing = document.getElementById('onereach-autofill-prompt');
          if (existing) existing.remove();
          
          const prompt = document.createElement('div');
          prompt.id = 'onereach-autofill-prompt';
          prompt.innerHTML = \`
            <div style="
              position: fixed;
              bottom: 20px;
              right: 20px;
              z-index: 999999;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 12px 20px;
              border-radius: 12px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              font-size: 14px;
              box-shadow: 0 4px 20px rgba(102, 126, 234, 0.4);
              display: flex;
              align-items: center;
              gap: 12px;
              cursor: pointer;
              transition: transform 0.2s, box-shadow 0.2s;
            " onmouseover="this.style.transform='scale(1.02)'; this.style.boxShadow='0 6px 25px rgba(102, 126, 234, 0.5)';"
               onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='0 4px 20px rgba(102, 126, 234, 0.4)';">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <circle cx="12" cy="16" r="1"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <span>Fill saved login</span>
              <span style="opacity: 0.7; font-size: 12px;">(⌘⇧L)</span>
            </div>
          \`;
          
          prompt.querySelector('div').onclick = () => performAutofill(fields);
          document.body.appendChild(prompt);
          
          // Auto-hide after 10 seconds
          setTimeout(() => {
            if (prompt.parentNode) {
              prompt.style.opacity = '0';
              prompt.style.transition = 'opacity 0.3s';
              setTimeout(() => prompt.remove(), 300);
            }
          }, 10000);
        }
        
        // Perform autofill
        async function performAutofill(fields) {
          if (!window.api || !window.api.invoke) {
            console.log('[CredentialHelper] API not available for autofill');
            return;
          }
          
          try {
            const result = await window.api.invoke('credentials-get', { url: window.location.href });
            if (result.success) {
              // Fill username
              if (fields.usernameField) {
                fields.usernameField.value = result.username;
                fields.usernameField.dispatchEvent(new Event('input', { bubbles: true }));
                fields.usernameField.dispatchEvent(new Event('change', { bubbles: true }));
              }
              
              // Fill password
              if (fields.passwordField) {
                fields.passwordField.value = result.password;
                fields.passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                fields.passwordField.dispatchEvent(new Event('change', { bubbles: true }));
              }
              
              console.log('[CredentialHelper] Autofill completed for:', result.idwName);
              
              // Remove the prompt
              const prompt = document.getElementById('onereach-autofill-prompt');
              if (prompt) prompt.remove();
            }
          } catch (e) {
            console.error('[CredentialHelper] Autofill failed:', e);
          }
        }
        
        // Setup form submission capture
        function setupFormCapture(fields) {
          if (!fields.passwordField) return;
          
          // Find the form containing the password field
          const form = fields.passwordField.closest('form');
          
          // Capture credentials on form submit
          const captureCredentials = () => {
            const username = fields.usernameField ? fields.usernameField.value : '';
            const password = fields.passwordField ? fields.passwordField.value : '';
            
            if (username && password) {
              console.log('[CredentialHelper] Capturing credentials for:', window.location.hostname);
              
              if (window.api && window.api.send) {
                window.api.send('credentials-captured', {
                  url: window.location.href,
                  username: username,
                  password: password,
                  idwName: document.title || window.location.hostname
                });
              }
            }
          };
          
          if (form) {
            // Hook form submit
            form.addEventListener('submit', captureCredentials, true);
          }
          
          // Also capture on Enter key in password field
          fields.passwordField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              captureCredentials();
            }
          });
          
          // Capture on click of submit-like buttons
          const submitButtons = document.querySelectorAll(
            'button[type="submit"], input[type="submit"], button:not([type])'
          );
          submitButtons.forEach(btn => {
            btn.addEventListener('click', captureCredentials, true);
          });
        }
        
        // Keyboard shortcut for autofill (Cmd+Shift+L)
        document.addEventListener('keydown', async (e) => {
          if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            const fields = findLoginFields();
            if (fields) {
              performAutofill(fields);
            }
          }
        });
        
        // Listen for save credential prompt from main process
        if (window.api && window.api.receive) {
          window.api.receive('show-save-credential-prompt', (data) => {
            showSavePrompt(data);
          });
        }
        
        // Show save credential prompt after successful login
        function showSavePrompt(data) {
          // Remove existing prompt if any
          const existing = document.getElementById('onereach-save-prompt');
          if (existing) existing.remove();
          
          const prompt = document.createElement('div');
          prompt.id = 'onereach-save-prompt';
          prompt.innerHTML = \`
            <div style="
              position: fixed;
              top: 20px;
              right: 20px;
              z-index: 999999;
              background: white;
              border-radius: 12px;
              padding: 16px 20px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              box-shadow: 0 4px 20px rgba(0,0,0,0.15);
              max-width: 320px;
            ">
              <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#667eea" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <circle cx="12" cy="16" r="1"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                <div>
                  <div style="font-weight: 600; color: #333;">Save login?</div>
                  <div style="font-size: 13px; color: #666;">\${data.username} for \${data.idwName}</div>
                </div>
              </div>
              <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button id="onereach-save-dismiss" style="
                  padding: 8px 16px;
                  border: 1px solid #ddd;
                  background: white;
                  border-radius: 8px;
                  cursor: pointer;
                  font-size: 13px;
                ">Not now</button>
                <button id="onereach-save-confirm" style="
                  padding: 8px 16px;
                  border: none;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  border-radius: 8px;
                  cursor: pointer;
                  font-size: 13px;
                ">Save</button>
              </div>
            </div>
          \`;
          
          document.body.appendChild(prompt);
          
          document.getElementById('onereach-save-confirm').onclick = async () => {
            if (window.api && window.api.invoke) {
              await window.api.invoke('credentials-save-pending', { url: window.location.href });
            }
            prompt.remove();
          };
          
          document.getElementById('onereach-save-dismiss').onclick = () => {
            if (window.api && window.api.send) {
              window.api.send('credentials-dismiss-save', { url: window.location.href });
            }
            prompt.remove();
          };
          
          // Auto-dismiss after 30 seconds
          setTimeout(() => {
            if (prompt.parentNode) prompt.remove();
          }, 30000);
        }
        
        // Initialize on page load
        setTimeout(checkForLoginForm, 500);
        
        // Re-check on dynamic content changes
        const observer = new MutationObserver(() => {
          if (!document.getElementById('onereach-autofill-prompt')) {
            checkForLoginForm();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        
        console.log('[CredentialHelper] Initialized');
      })();
    `;
    
    webContents.executeJavaScript(script).catch(err => {
      console.error('[AuthManager] Failed to inject credential helper:', err);
    });
  }

  /**
   * Inject authentication helper scripts (legacy - for BrowserWindow)
   */
  injectAuthHelper(window) {
    // Use the new credential helper
    this.injectCredentialHelper(window.webContents);
    
    // Also inject Google compatibility fixes
    window.webContents.executeJavaScript(`
      (function() {
        // Make Google login less aggressive
        if (window.location.hostname.includes('google.com')) {
          // Override some detection methods
          try {
            Object.defineProperty(navigator.connection, 'rtt', {
              get: () => 50
            });
            
            Object.defineProperty(navigator.connection, 'downlink', {
              get: () => 10
            });
          } catch (e) {}
          
          window.ontouchstart = null;
          
          if (navigator.permissions) {
            const originalQuery = navigator.permissions.query;
            navigator.permissions.query = function(desc) {
              if (desc.name === 'notifications' || desc.name === 'geolocation') {
                return Promise.resolve({ state: 'prompt' });
              }
              return originalQuery.apply(this, arguments);
            };
          }
        }
      })();
    `).catch(err => console.error('Failed to inject Google compat:', err));
  }

  /**
   * Clear all saved sessions
   */
  async clearSessions() {
    this.sessions.clear();
    try {
      await fs.unlink(this.authDataPath);
      console.log('Cleared all saved auth sessions');
    } catch (error) {
      // File might not exist
    }
  }

  /**
   * Get saved sessions info
   */
  getSavedSessions() {
    const info = [];
    this.sessions.forEach((cookies, domain) => {
      info.push({
        domain,
        cookieCount: cookies.length,
        hasAuthCookies: cookies.some(c => 
          c.name.includes('auth') || 
          c.name.includes('session') || 
          c.name.includes('token')
        )
      });
    });
    return info;
  }
}

module.exports = AuthManager;
