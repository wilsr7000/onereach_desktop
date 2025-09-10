/**
 * Authentication Manager for IDW and other services
 * Provides persistent authentication and easier login experience
 */

const { session, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs').promises;

class AuthManager {
  constructor(app) {
    this.app = app;
    this.authDataPath = path.join(app.getPath('userData'), 'auth-sessions.json');
    this.sessions = new Map();
    this.loadSessions();
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

    // Inject helper for auto-fill
    window.webContents.on('did-finish-load', () => {
      this.injectAuthHelper(window);
    });
  }

  /**
   * Inject authentication helper scripts
   */
  injectAuthHelper(window) {
    window.webContents.executeJavaScript(`
      (function() {
        // Helper to detect login forms
        function detectLoginForm() {
          const passwordFields = document.querySelectorAll('input[type="password"]');
          const emailFields = document.querySelectorAll('input[type="email"], input[name*="email"], input[id*="email"], input[placeholder*="email"]');
          const usernameFields = document.querySelectorAll('input[name*="username"], input[id*="username"], input[placeholder*="username"]');
          
          return {
            hasLoginForm: passwordFields.length > 0,
            passwordField: passwordFields[0],
            emailField: emailFields[0],
            usernameField: usernameFields[0]
          };
        }

        // Check if we're on a login page
        const loginInfo = detectLoginForm();
        if (loginInfo.hasLoginForm) {
          console.log('Login form detected on page');
          
          // Add a helper button for quick login (optional)
          const helperDiv = document.createElement('div');
          helperDiv.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; background: #4285f4; color: white; padding: 10px 20px; border-radius: 20px; cursor: pointer; font-family: Arial, sans-serif; font-size: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.2);';
          helperDiv.textContent = 'Use saved login';
          helperDiv.onclick = function() {
            if (window.electron && window.electron.requestSavedCredentials) {
              window.electron.requestSavedCredentials();
            }
          };
          
          // Only show if we're on a known auth domain
          const url = window.location.href;
          if (url.includes('accounts.google.com') || 
              url.includes('login.microsoftonline.com') || 
              url.includes('auth.') || 
              url.includes('signin')) {
            document.body.appendChild(helperDiv);
            
            // Auto-hide after 10 seconds
            setTimeout(() => {
              helperDiv.style.display = 'none';
            }, 10000);
          }
        }

        // Make Google login less aggressive
        if (window.location.hostname.includes('google.com')) {
          // Override some detection methods
          Object.defineProperty(navigator.connection, 'rtt', {
            get: () => 50 // Typical Chrome value
          });
          
          Object.defineProperty(navigator.connection, 'downlink', {
            get: () => 10 // Typical Chrome value
          });
          
          // Add touch support (Chrome on Mac has this)
          window.ontouchstart = null;
          
          // Mock permissions API
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
        
        console.log('Auth helper injected');
      })();
    `).catch(err => console.error('Failed to inject auth helper:', err));
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