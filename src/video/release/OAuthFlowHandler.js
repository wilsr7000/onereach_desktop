/**
 * OAuthFlowHandler - Manages OAuth authentication flows for YouTube and Vimeo
 * 
 * Features:
 * - Opens OAuth window
 * - Handles callback
 * - Stores tokens securely
 * - Refreshes expired tokens
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
export class OAuthFlowHandler {
  constructor(options = {}) {
    this.options = options;
    
    // OAuth configuration
    this.config = {
      youtube: {
        clientId: options.youtubeClientId || '',
        clientSecret: options.youtubeClientSecret || '',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: [
          'https://www.googleapis.com/auth/youtube.upload',
          'https://www.googleapis.com/auth/youtube.readonly'
        ],
        redirectUri: 'http://localhost:8080/oauth/youtube/callback'
      },
      vimeo: {
        clientId: options.vimeoClientId || '',
        clientSecret: options.vimeoClientSecret || '',
        authUrl: 'https://api.vimeo.com/oauth/authorize',
        tokenUrl: 'https://api.vimeo.com/oauth/access_token',
        scopes: ['upload', 'public', 'private', 'video_files'],
        redirectUri: 'http://localhost:8080/oauth/vimeo/callback'
      }
    };
    
    // Token storage (should be encrypted in production)
    this.tokens = {
      youtube: null,
      vimeo: null
    };
    
    // State for CSRF protection
    this.pendingStates = new Map();
  }

  /**
   * Initialize OAuth handler - load saved tokens
   */
  async init() {
    try {
      // Load tokens from secure storage
      if (typeof window !== 'undefined' && window.videoEditor?.getOAuthTokens) {
        this.tokens = await window.videoEditor.getOAuthTokens();
      }
      
      log.info('video', '[OAuth] Initialized', { arg0: {
        youtubeConnected: !!this.tokens.youtube, arg1: vimeoConnected: !!this.tokens.vimeo
      } });
    } catch (error) {
      log.error('video', '[OAuth] Init error', { error: error });
    }
  }

  /**
   * Check if a service is connected
   */
  isConnected(service) {
    const token = this.tokens[service];
    return !!token && !!token.access_token;
  }

  /**
   * Get connection status for all services
   */
  getConnectionStatus() {
    return {
      youtube: {
        connected: this.isConnected('youtube'),
        email: this.tokens.youtube?.email || null,
        expiresAt: this.tokens.youtube?.expires_at || null
      },
      vimeo: {
        connected: this.isConnected('vimeo'),
        name: this.tokens.vimeo?.user?.name || null,
        expiresAt: this.tokens.vimeo?.expires_at || null
      }
    };
  }

  /**
   * Start OAuth flow for a service
   * @param {string} service - 'youtube' or 'vimeo'
   */
  async startAuth(service) {
    const config = this.config[service];
    if (!config) {
      throw new Error(`Unknown service: ${service}`);
    }

    if (!config.clientId) {
      throw new Error(`${service} client ID not configured. Please add it in Settings.`);
    }

    // Generate state for CSRF protection
    const state = this._generateState();
    this.pendingStates.set(state, { service, timestamp: Date.now() });

    // Build auth URL
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state,
      access_type: 'offline', // For refresh tokens (Google-specific)
      prompt: 'consent' // Force consent screen to get refresh token
    });

    const authUrl = `${config.authUrl}?${params.toString()}`;

    log.info('video', '[OAuth] Starting auth flow for', { arg0: service });

    // Open OAuth window
    return this._openAuthWindow(authUrl, service);
  }

  /**
   * Open OAuth authentication window
   */
  _openAuthWindow(url, service) {
    return new Promise((resolve, reject) => {
      // In Electron context, use BrowserWindow
      if (typeof window !== 'undefined' && window.videoEditor?.openOAuthWindow) {
        window.videoEditor.openOAuthWindow(url)
          .then(result => {
            if (result.success) {
              this._handleCallback(result.code, result.state, service)
                .then(resolve)
                .catch(reject);
            } else {
              reject(new Error(result.error || 'Auth cancelled'));
            }
          })
          .catch(reject);
      } else {
        // Fallback to popup window
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.innerWidth - width) / 2;
        const top = window.screenY + (window.innerHeight - height) / 2;

        const popup = window.open(
          url,
          `${service}OAuth`,
          `width=${width},height=${height},left=${left},top=${top}`
        );

        if (!popup) {
          reject(new Error('Popup blocked. Please allow popups for this site.'));
          return;
        }

        // Listen for callback message
        const messageHandler = (event) => {
          if (event.data?.type === 'oauth_callback' && event.data?.service === service) {
            window.removeEventListener('message', messageHandler);
            
            if (event.data.error) {
              reject(new Error(event.data.error));
            } else {
              this._handleCallback(event.data.code, event.data.state, service)
                .then(resolve)
                .catch(reject);
            }
          }
        };

        window.addEventListener('message', messageHandler);

        // Check if popup was closed
        const checkClosed = setInterval(() => {
          if (popup.closed) {
            clearInterval(checkClosed);
            window.removeEventListener('message', messageHandler);
            reject(new Error('Auth window was closed'));
          }
        }, 1000);
      }
    });
  }

  /**
   * Handle OAuth callback
   */
  async _handleCallback(code, state, service) {
    // Verify state
    const pendingState = this.pendingStates.get(state);
    if (!pendingState || pendingState.service !== service) {
      throw new Error('Invalid state parameter - possible CSRF attack');
    }
    this.pendingStates.delete(state);

    // Exchange code for tokens
    const tokens = await this._exchangeCodeForTokens(code, service);
    
    // Store tokens
    this.tokens[service] = {
      ...tokens,
      obtained_at: Date.now(),
      expires_at: Date.now() + (tokens.expires_in * 1000)
    };

    // Save to secure storage
    if (typeof window !== 'undefined' && window.videoEditor?.saveOAuthTokens) {
      await window.videoEditor.saveOAuthTokens(this.tokens);
    }

    log.info('video', '[OAuth] Successfully authenticated with', { arg0: service });
    
    return {
      success: true,
      service,
      email: tokens.email || null
    };
  }

  /**
   * Exchange authorization code for tokens
   */
  async _exchangeCodeForTokens(code, service) {
    const config = this.config[service];

    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code'
    });

    // Use IPC if available (Electron)
    if (typeof window !== 'undefined' && window.videoEditor?.exchangeOAuthCode) {
      return await window.videoEditor.exchangeOAuthCode(service, {
        code,
        redirectUri: config.redirectUri
      });
    }

    // Fallback to direct fetch
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error_description || 'Token exchange failed');
    }

    return await response.json();
  }

  /**
   * Refresh access token
   */
  async refreshToken(service) {
    const token = this.tokens[service];
    if (!token?.refresh_token) {
      throw new Error('No refresh token available');
    }

    const config = this.config[service];

    // Use IPC if available
    if (typeof window !== 'undefined' && window.videoEditor?.refreshOAuthToken) {
      const newTokens = await window.videoEditor.refreshOAuthToken(service, token.refresh_token);
      
      this.tokens[service] = {
        ...this.tokens[service],
        access_token: newTokens.access_token,
        expires_at: Date.now() + (newTokens.expires_in * 1000)
      };

      await window.videoEditor?.saveOAuthTokens?.(this.tokens);
      return this.tokens[service];
    }

    // Fallback to direct fetch
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token'
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!response.ok) {
      throw new Error('Token refresh failed');
    }

    const newTokens = await response.json();
    
    this.tokens[service] = {
      ...this.tokens[service],
      access_token: newTokens.access_token,
      expires_at: Date.now() + (newTokens.expires_in * 1000)
    };

    return this.tokens[service];
  }

  /**
   * Get access token (refreshing if needed)
   */
  async getAccessToken(service) {
    const token = this.tokens[service];
    if (!token?.access_token) {
      throw new Error(`Not connected to ${service}`);
    }

    // Check if token is expired or about to expire (5 min buffer)
    if (token.expires_at && Date.now() > token.expires_at - 300000) {
      log.info('video', '[OAuth] Token expired, refreshing...');
      const refreshed = await this.refreshToken(service);
      return refreshed.access_token;
    }

    return token.access_token;
  }

  /**
   * Disconnect from a service
   */
  async disconnect(service) {
    // Revoke token if possible
    const token = this.tokens[service];
    if (token?.access_token) {
      try {
        if (service === 'youtube') {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${token.access_token}`, {
            method: 'POST'
          });
        }
        // Vimeo doesn't have a revoke endpoint
      } catch (error) {
        log.warn('video', '[OAuth] Token revocation failed', { data: error });
      }
    }

    // Clear stored token
    this.tokens[service] = null;
    
    if (typeof window !== 'undefined' && window.videoEditor?.saveOAuthTokens) {
      await window.videoEditor.saveOAuthTokens(this.tokens);
    }

    log.info('video', '[OAuth] Disconnected from', { arg0: service });
  }

  /**
   * Generate random state for CSRF protection
   */
  _generateState() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Render settings UI HTML
   */
  renderSettingsUI() {
    const status = this.getConnectionStatus();

    return `
      <div class="oauth-settings-section">
        <h3 class="oauth-settings-title">Video Platform Connections</h3>
        
        <!-- YouTube Connection -->
        <div class="oauth-service-card" data-service="youtube">
          <div class="oauth-service-header">
            <div class="oauth-service-icon">📺</div>
            <div class="oauth-service-info">
              <div class="oauth-service-name">YouTube</div>
              <div class="oauth-service-status ${status.youtube.connected ? 'connected' : ''}">
                ${status.youtube.connected ? `Connected${status.youtube.email ? ` as ${status.youtube.email}` : ''}` : 'Not connected'}
              </div>
            </div>
          </div>
          <div class="oauth-service-actions">
            ${status.youtube.connected ? `
              <button class="oauth-btn oauth-btn-disconnect" data-service="youtube" data-action="disconnect">
                Disconnect
              </button>
            ` : `
              <button class="oauth-btn oauth-btn-connect" data-service="youtube" data-action="connect">
                Connect YouTube
              </button>
            `}
          </div>
        </div>
        
        <!-- Vimeo Connection -->
        <div class="oauth-service-card" data-service="vimeo">
          <div class="oauth-service-header">
            <div class="oauth-service-icon">🎬</div>
            <div class="oauth-service-info">
              <div class="oauth-service-name">Vimeo</div>
              <div class="oauth-service-status ${status.vimeo.connected ? 'connected' : ''}">
                ${status.vimeo.connected ? `Connected${status.vimeo.name ? ` as ${status.vimeo.name}` : ''}` : 'Not connected'}
              </div>
            </div>
          </div>
          <div class="oauth-service-actions">
            ${status.vimeo.connected ? `
              <button class="oauth-btn oauth-btn-disconnect" data-service="vimeo" data-action="disconnect">
                Disconnect
              </button>
            ` : `
              <button class="oauth-btn oauth-btn-connect" data-service="vimeo" data-action="connect">
                Connect Vimeo
              </button>
            `}
          </div>
        </div>
        
        <!-- API Keys Configuration (for developers) -->
        <div class="oauth-config-section">
          <button class="oauth-config-toggle" onclick="this.parentElement.classList.toggle('expanded')">
            ⚙️ API Configuration (Advanced)
          </button>
          <div class="oauth-config-fields">
            <div class="oauth-config-field">
              <label>YouTube Client ID</label>
              <input type="text" id="youtubeClientId" placeholder="Your YouTube Client ID" 
                     value="${this.config.youtube.clientId}">
            </div>
            <div class="oauth-config-field">
              <label>Vimeo Client ID</label>
              <input type="text" id="vimeoClientId" placeholder="Your Vimeo Client ID"
                     value="${this.config.vimeo.clientId}">
            </div>
            <button class="oauth-btn oauth-btn-save" onclick="app.oauthHandler?.saveConfig()">
              Save Configuration
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Save OAuth configuration
   */
  async saveConfig() {
    const youtubeClientId = document.getElementById('youtubeClientId')?.value;
    const vimeoClientId = document.getElementById('vimeoClientId')?.value;

    if (youtubeClientId) this.config.youtube.clientId = youtubeClientId;
    if (vimeoClientId) this.config.vimeo.clientId = vimeoClientId;

    // Save to settings
    if (typeof window !== 'undefined' && window.videoEditor?.saveOAuthConfig) {
      await window.videoEditor.saveOAuthConfig({
        youtubeClientId: this.config.youtube.clientId,
        vimeoClientId: this.config.vimeo.clientId
      });
    }

    log.info('video', '[OAuth] Configuration saved');
  }

  /**
   * Get CSS styles for settings UI
   */
  static getStyles() {
    return `
      .oauth-settings-section {
        padding: 16px;
      }

      .oauth-settings-title {
        margin: 0 0 16px 0;
        font-size: 16px;
        color: var(--text-primary, #fff);
      }

      .oauth-service-card {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .oauth-service-header {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .oauth-service-icon {
        font-size: 24px;
      }

      .oauth-service-name {
        font-weight: 600;
        color: var(--text-primary, #fff);
      }

      .oauth-service-status {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }

      .oauth-service-status.connected {
        color: #10b981;
      }

      .oauth-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s, opacity 0.2s;
      }

      .oauth-btn-connect {
        background: var(--accent-color, #4a9eff);
        border: none;
        color: white;
      }

      .oauth-btn-connect:hover {
        background: #3a8eef;
      }

      .oauth-btn-disconnect {
        background: transparent;
        border: 1px solid var(--border-color, #333);
        color: var(--text-secondary, #888);
      }

      .oauth-btn-disconnect:hover {
        border-color: #ef4444;
        color: #ef4444;
      }

      .oauth-config-section {
        margin-top: 16px;
        border-top: 1px solid var(--border-color, #333);
        padding-top: 16px;
      }

      .oauth-config-toggle {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        cursor: pointer;
        font-size: 13px;
        padding: 0;
      }

      .oauth-config-toggle:hover {
        color: var(--text-primary, #fff);
      }

      .oauth-config-fields {
        display: none;
        margin-top: 12px;
      }

      .oauth-config-section.expanded .oauth-config-fields {
        display: block;
      }

      .oauth-config-field {
        margin-bottom: 12px;
      }

      .oauth-config-field label {
        display: block;
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 4px;
      }

      .oauth-config-field input {
        width: 100%;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid var(--border-color, #333);
        background: var(--bg-primary, #1a1a2e);
        color: var(--text-primary, #fff);
        font-size: 13px;
      }

      .oauth-btn-save {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        color: var(--text-primary, #fff);
        width: 100%;
      }

      .oauth-btn-save:hover {
        background: var(--bg-hover, #333);
      }
    `;
  }
}

export default OAuthFlowHandler;











