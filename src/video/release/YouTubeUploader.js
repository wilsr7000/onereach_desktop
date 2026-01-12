/**
 * YouTubeUploader - YouTube Data API v3 integration
 * OAuth 2.0 flow and resumable video upload
 * @module src/video/release/YouTubeUploader
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, shell, BrowserWindow } = require('electron');

/**
 * YouTube privacy status options
 */
export const YOUTUBE_PRIVACY = {
  PUBLIC: 'public',
  UNLISTED: 'unlisted',
  PRIVATE: 'private'
};

/**
 * YouTube category IDs
 */
export const YOUTUBE_CATEGORIES = {
  FILM_ANIMATION: '1',
  AUTOS_VEHICLES: '2',
  MUSIC: '10',
  PETS_ANIMALS: '15',
  SPORTS: '17',
  TRAVEL_EVENTS: '19',
  GAMING: '20',
  PEOPLE_BLOGS: '22',
  COMEDY: '23',
  ENTERTAINMENT: '24',
  NEWS_POLITICS: '25',
  HOWTO_STYLE: '26',
  EDUCATION: '27',
  SCIENCE_TECH: '28',
  NONPROFITS: '29'
};

/**
 * Service for uploading videos to YouTube
 */
export class YouTubeUploader {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'youtube-auth.json');
    this.credentials = this.loadCredentials();
    
    // OAuth endpoints
    this.authEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenEndpoint = 'https://oauth2.googleapis.com/token';
    this.uploadEndpoint = 'https://www.googleapis.com/upload/youtube/v3/videos';
    this.apiEndpoint = 'https://www.googleapis.com/youtube/v3';
    
    // Required scopes
    this.scopes = [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly'
    ];
  }

  /**
   * Load stored credentials
   */
  loadCredentials() {
    if (fs.existsSync(this.settingsPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      } catch (e) {
        console.warn('[YouTubeUploader] Failed to load credentials:', e);
      }
    }
    return {};
  }

  /**
   * Save credentials to disk
   */
  saveCredentials() {
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.credentials, null, 2));
  }

  /**
   * Set OAuth client credentials
   * @param {string} clientId - OAuth client ID
   * @param {string} clientSecret - OAuth client secret
   */
  setClientCredentials(clientId, clientSecret) {
    this.credentials.clientId = clientId;
    this.credentials.clientSecret = clientSecret;
    this.saveCredentials();
  }

  /**
   * Check if we have valid credentials
   * @returns {boolean} Whether client credentials are configured
   */
  hasClientCredentials() {
    return !!(this.credentials.clientId && this.credentials.clientSecret);
  }

  /**
   * Check if we're authenticated (have valid access token)
   * @returns {Promise<boolean>} Whether we have valid authentication
   */
  async isAuthenticated() {
    if (!this.credentials.accessToken) return false;
    
    // Check if token is expired
    if (this.credentials.expiresAt && Date.now() >= this.credentials.expiresAt) {
      // Try to refresh
      if (this.credentials.refreshToken) {
        try {
          await this.refreshAccessToken();
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    }
    
    return true;
  }

  /**
   * Start OAuth flow - opens browser for user authentication
   * @returns {Promise<Object>} Auth result
   */
  async authenticate() {
    if (!this.hasClientCredentials()) {
      throw new Error('YouTube client credentials not configured. Please set them in Settings.');
    }

    // Generate state for CSRF protection
    const state = Math.random().toString(36).substring(2);
    
    // Build auth URL
    const redirectUri = 'http://localhost:8089/oauth/callback';
    const authUrl = new URL(this.authEndpoint);
    authUrl.searchParams.set('client_id', this.credentials.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', this.scopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    return new Promise((resolve, reject) => {
      // Create local server to receive callback
      const http = require('http');
      let server;

      const timeout = setTimeout(() => {
        if (server) server.close();
        reject(new Error('Authentication timed out'));
      }, 120000); // 2 minute timeout

      server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:8089`);
        
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Failed</h1><p>You can close this window.</p></body></html>');
            clearTimeout(timeout);
            server.close();
            reject(new Error(`Authentication failed: ${error}`));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Failed</h1><p>Invalid state. You can close this window.</p></body></html>');
            clearTimeout(timeout);
            server.close();
            reject(new Error('Invalid state - possible CSRF attack'));
            return;
          }

          try {
            // Exchange code for tokens
            await this.exchangeCodeForTokens(code, redirectUri);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to the app.</p><script>window.close()</script></body></html>');
            
            clearTimeout(timeout);
            server.close();
            
            // Get channel info
            const channelInfo = await this.getChannelInfo();
            resolve({ success: true, channel: channelInfo });
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
            clearTimeout(timeout);
            server.close();
            reject(e);
          }
        }
      });

      server.listen(8089, () => {
        console.log('[YouTubeUploader] OAuth callback server listening on port 8089');
        // Open browser
        shell.openExternal(authUrl.toString());
      });

      server.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start OAuth server: ${err.message}`));
      });
    });
  }

  /**
   * Exchange authorization code for tokens
   * @private
   */
  async exchangeCodeForTokens(code, redirectUri) {
    const postData = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString();

    const response = await this._httpRequest({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    const tokens = JSON.parse(response);
    
    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    this.credentials.accessToken = tokens.access_token;
    this.credentials.refreshToken = tokens.refresh_token || this.credentials.refreshToken;
    this.credentials.expiresAt = Date.now() + (tokens.expires_in * 1000);
    this.saveCredentials();

    console.log('[YouTubeUploader] Tokens saved');
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken() {
    if (!this.credentials.refreshToken) {
      throw new Error('No refresh token available');
    }

    const postData = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const response = await this._httpRequest({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    const tokens = JSON.parse(response);
    
    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    this.credentials.accessToken = tokens.access_token;
    this.credentials.expiresAt = Date.now() + (tokens.expires_in * 1000);
    this.saveCredentials();

    console.log('[YouTubeUploader] Access token refreshed');
  }

  /**
   * Get authenticated channel info
   * @returns {Promise<Object>} Channel info
   */
  async getChannelInfo() {
    if (!await this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    const response = await this._httpRequest({
      hostname: 'www.googleapis.com',
      path: '/youtube/v3/channels?part=snippet&mine=true',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.credentials.accessToken}`
      }
    });

    const data = JSON.parse(response);
    
    if (data.items && data.items.length > 0) {
      const channel = data.items[0];
      return {
        id: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        thumbnail: channel.snippet.thumbnails?.default?.url
      };
    }

    return null;
  }

  /**
   * Upload video to YouTube
   * @param {string} videoPath - Path to video file
   * @param {Object} metadata - Video metadata
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Upload result
   */
  async upload(videoPath, metadata = {}, progressCallback = null) {
    if (!await this.isAuthenticated()) {
      throw new Error('Not authenticated. Please connect your YouTube account first.');
    }

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    const {
      title = path.basename(videoPath, path.extname(videoPath)),
      description = '',
      tags = [],
      categoryId = YOUTUBE_CATEGORIES.ENTERTAINMENT,
      privacyStatus = YOUTUBE_PRIVACY.PRIVATE,
      madeForKids = false
    } = metadata;

    const fileSize = fs.statSync(videoPath).size;
    
    console.log(`[YouTubeUploader] Starting upload: ${title} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    // Build video resource
    const videoResource = {
      snippet: {
        title: title,
        description: description,
        tags: tags,
        categoryId: categoryId
      },
      status: {
        privacyStatus: privacyStatus,
        selfDeclaredMadeForKids: madeForKids
      }
    };

    // Start resumable upload
    const uploadUrl = await this._initResumableUpload(videoResource, fileSize);
    
    // Upload the file
    const result = await this._uploadFile(uploadUrl, videoPath, fileSize, progressCallback);
    
    console.log('[YouTubeUploader] Upload complete:', result.id);
    
    return {
      success: true,
      videoId: result.id,
      url: `https://youtube.com/watch?v=${result.id}`,
      title: result.snippet?.title,
      status: result.status?.uploadStatus
    };
  }

  /**
   * Initialize resumable upload
   * @private
   */
  async _initResumableUpload(videoResource, fileSize) {
    const metadataJson = JSON.stringify(videoResource);
    
    const response = await this._httpRequestRaw({
      hostname: 'www.googleapis.com',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(metadataJson),
        'X-Upload-Content-Length': fileSize,
        'X-Upload-Content-Type': 'video/*'
      }
    }, metadataJson);

    if (response.statusCode !== 200) {
      throw new Error(`Failed to initialize upload: ${response.statusCode}`);
    }

    const uploadUrl = response.headers.location;
    if (!uploadUrl) {
      throw new Error('No upload URL received');
    }

    return uploadUrl;
  }

  /**
   * Upload file to resumable upload URL
   * @private
   */
  async _uploadFile(uploadUrl, videoPath, fileSize, progressCallback) {
    return new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const fileStream = fs.createReadStream(videoPath);
      
      let uploadedBytes = 0;

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.credentials.accessToken}`,
          'Content-Length': fileSize,
          'Content-Type': 'video/*'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve({ id: 'unknown', status: { uploadStatus: 'complete' } });
            }
          } else {
            reject(new Error(`Upload failed: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);

      fileStream.on('data', (chunk) => {
        uploadedBytes += chunk.length;
        if (progressCallback) {
          const percent = Math.round((uploadedBytes / fileSize) * 100);
          progressCallback({ percent, uploadedBytes, totalBytes: fileSize });
        }
      });

      fileStream.pipe(req);
    });
  }

  /**
   * Make HTTP request
   * @private
   */
  _httpRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      
      req.on('error', reject);
      
      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * Make HTTP request and return raw response with headers
   * @private
   */
  _httpRequestRaw(options, postData = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });
      
      req.on('error', reject);
      
      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * Disconnect/logout
   */
  disconnect() {
    delete this.credentials.accessToken;
    delete this.credentials.refreshToken;
    delete this.credentials.expiresAt;
    this.saveCredentials();
    console.log('[YouTubeUploader] Disconnected');
  }

  /**
   * Get connection status
   * @returns {Promise<Object>} Connection status
   */
  async getConnectionStatus() {
    const hasCredentials = this.hasClientCredentials();
    const isAuth = await this.isAuthenticated();
    
    let channelInfo = null;
    if (isAuth) {
      try {
        channelInfo = await this.getChannelInfo();
      } catch (e) {
        console.warn('[YouTubeUploader] Failed to get channel info:', e);
      }
    }

    return {
      configured: hasCredentials,
      authenticated: isAuth,
      channel: channelInfo
    };
  }

  /**
   * Open browser upload page (fallback)
   * @param {string} videoPath - Path to video
   */
  async openBrowserUpload(videoPath) {
    const { clipboard } = require('electron');
    clipboard.writeText(videoPath);
    await shell.openExternal('https://studio.youtube.com/channel/UC/videos/upload');
    
    return {
      method: 'browser',
      videoPath: videoPath,
      message: 'Video path copied to clipboard. Upload manually in YouTube Studio.'
    };
  }
}











