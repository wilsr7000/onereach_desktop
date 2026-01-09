/**
 * VimeoUploader - Vimeo API integration
 * OAuth 2.0 flow and tus-based video upload
 * @module src/video/release/VimeoUploader
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, shell } = require('electron');

/**
 * Vimeo privacy settings
 */
export const VIMEO_PRIVACY = {
  ANYBODY: 'anybody',
  ONLY_ME: 'nobody',
  PASSWORD: 'password',
  UNLISTED: 'unlisted',
  DISABLE: 'disable'
};

/**
 * Service for uploading videos to Vimeo
 */
export class VimeoUploader {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'vimeo-auth.json');
    this.credentials = this.loadCredentials();
    
    // OAuth endpoints
    this.authEndpoint = 'https://api.vimeo.com/oauth/authorize';
    this.tokenEndpoint = 'https://api.vimeo.com/oauth/access_token';
    this.apiEndpoint = 'https://api.vimeo.com';
    
    // Required scopes
    this.scopes = ['public', 'private', 'upload', 'edit'];
  }

  /**
   * Load stored credentials
   */
  loadCredentials() {
    if (fs.existsSync(this.settingsPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      } catch (e) {
        console.warn('[VimeoUploader] Failed to load credentials:', e);
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
   * Check if we're authenticated
   * @returns {Promise<boolean>} Whether we have valid authentication
   */
  async isAuthenticated() {
    if (!this.credentials.accessToken) return false;
    
    // Verify token is still valid
    try {
      await this.getUserInfo();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Start OAuth flow
   * @returns {Promise<Object>} Auth result
   */
  async authenticate() {
    if (!this.hasClientCredentials()) {
      throw new Error('Vimeo client credentials not configured. Please set them in Settings.');
    }

    // Generate state for CSRF protection
    const state = Math.random().toString(36).substring(2);
    
    // Build auth URL
    const redirectUri = 'http://localhost:8090/oauth/callback';
    const authUrl = new URL(this.authEndpoint);
    authUrl.searchParams.set('client_id', this.credentials.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', this.scopes.join(' '));
    authUrl.searchParams.set('state', state);

    return new Promise((resolve, reject) => {
      const http = require('http');
      let server;

      const timeout = setTimeout(() => {
        if (server) server.close();
        reject(new Error('Authentication timed out'));
      }, 120000);

      server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:8090`);
        
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
            res.end('<html><body><h1>Invalid state</h1></body></html>');
            clearTimeout(timeout);
            server.close();
            reject(new Error('Invalid state'));
            return;
          }

          try {
            await this.exchangeCodeForTokens(code, redirectUri);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Successful!</h1><p>You can close this window.</p><script>window.close()</script></body></html>');
            
            clearTimeout(timeout);
            server.close();
            
            const userInfo = await this.getUserInfo();
            resolve({ success: true, user: userInfo });
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
            clearTimeout(timeout);
            server.close();
            reject(e);
          }
        }
      });

      server.listen(8090, () => {
        console.log('[VimeoUploader] OAuth callback server listening on port 8090');
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
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    }).toString();

    const auth = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64');

    const response = await this._httpRequest({
      hostname: 'api.vimeo.com',
      path: '/oauth/access_token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/vnd.vimeo.*+json;version=3.4',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    const tokens = JSON.parse(response);
    
    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    this.credentials.accessToken = tokens.access_token;
    this.credentials.tokenType = tokens.token_type;
    this.credentials.scope = tokens.scope;
    this.saveCredentials();

    console.log('[VimeoUploader] Access token saved');
  }

  /**
   * Get authenticated user info
   * @returns {Promise<Object>} User info
   */
  async getUserInfo() {
    if (!this.credentials.accessToken) {
      throw new Error('Not authenticated');
    }

    const response = await this._httpRequest({
      hostname: 'api.vimeo.com',
      path: '/me',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.credentials.accessToken}`,
        'Accept': 'application/vnd.vimeo.*+json;version=3.4'
      }
    });

    const data = JSON.parse(response);
    
    return {
      uri: data.uri,
      name: data.name,
      link: data.link,
      picture: data.pictures?.sizes?.[0]?.link
    };
  }

  /**
   * Upload video to Vimeo
   * @param {string} videoPath - Path to video file
   * @param {Object} metadata - Video metadata
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Upload result
   */
  async upload(videoPath, metadata = {}, progressCallback = null) {
    if (!await this.isAuthenticated()) {
      throw new Error('Not authenticated. Please connect your Vimeo account first.');
    }

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    const {
      title = path.basename(videoPath, path.extname(videoPath)),
      description = '',
      privacy = VIMEO_PRIVACY.ANYBODY,
      password = null
    } = metadata;

    const fileSize = fs.statSync(videoPath).size;
    
    console.log(`[VimeoUploader] Starting upload: ${title} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    // Create video with tus upload
    const uploadData = await this._createVideo({
      name: title,
      description: description,
      privacy: {
        view: privacy,
        ...(privacy === 'password' ? { password: password } : {})
      },
      upload: {
        approach: 'tus',
        size: fileSize
      }
    });

    const uploadLink = uploadData.upload?.upload_link;
    if (!uploadLink) {
      throw new Error('Failed to get upload URL from Vimeo');
    }

    // Upload using tus protocol
    await this._tusUpload(uploadLink, videoPath, fileSize, progressCallback);

    console.log('[VimeoUploader] Upload complete');
    
    // Get video info
    const videoUri = uploadData.uri;
    const videoId = videoUri.split('/').pop();

    return {
      success: true,
      videoId: videoId,
      uri: videoUri,
      url: uploadData.link,
      title: title
    };
  }

  /**
   * Create video resource on Vimeo
   * @private
   */
  async _createVideo(videoData) {
    const postData = JSON.stringify(videoData);

    const response = await this._httpRequest({
      hostname: 'api.vimeo.com',
      path: '/me/videos',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.vimeo.*+json;version=3.4',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    const data = JSON.parse(response);
    
    if (data.error) {
      throw new Error(data.error || 'Failed to create video');
    }

    return data;
  }

  /**
   * Upload file using tus protocol
   * @private
   */
  async _tusUpload(uploadLink, videoPath, fileSize, progressCallback) {
    const url = new URL(uploadLink);
    const fileStream = fs.createReadStream(videoPath);
    
    let uploadedBytes = 0;
    const chunkSize = 128 * 1024 * 1024; // 128MB chunks
    
    return new Promise((resolve, reject) => {
      const chunks = [];
      let currentChunk = Buffer.alloc(0);
      
      fileStream.on('data', (data) => {
        currentChunk = Buffer.concat([currentChunk, data]);
        
        while (currentChunk.length >= chunkSize) {
          chunks.push(currentChunk.slice(0, chunkSize));
          currentChunk = currentChunk.slice(chunkSize);
        }
      });
      
      fileStream.on('end', async () => {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
        
        try {
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const offset = i * chunkSize;
            
            await this._uploadChunk(url, chunk, offset, fileSize);
            
            uploadedBytes += chunk.length;
            if (progressCallback) {
              const percent = Math.round((uploadedBytes / fileSize) * 100);
              progressCallback({ percent, uploadedBytes, totalBytes: fileSize });
            }
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      
      fileStream.on('error', reject);
    });
  }

  /**
   * Upload a single chunk via PATCH
   * @private
   */
  _uploadChunk(url, chunk, offset, totalSize) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.credentials.accessToken}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': offset.toString(),
          'Content-Type': 'application/offset+octet-stream',
          'Content-Length': chunk.length
        }
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Upload chunk failed: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(chunk);
      req.end();
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
   * Disconnect/logout
   */
  disconnect() {
    delete this.credentials.accessToken;
    delete this.credentials.tokenType;
    delete this.credentials.scope;
    this.saveCredentials();
    console.log('[VimeoUploader] Disconnected');
  }

  /**
   * Get connection status
   * @returns {Promise<Object>} Connection status
   */
  async getConnectionStatus() {
    const hasCredentials = this.hasClientCredentials();
    const isAuth = await this.isAuthenticated();
    
    let userInfo = null;
    if (isAuth) {
      try {
        userInfo = await this.getUserInfo();
      } catch (e) {
        console.warn('[VimeoUploader] Failed to get user info:', e);
      }
    }

    return {
      configured: hasCredentials,
      authenticated: isAuth,
      user: userInfo
    };
  }

  /**
   * Open browser upload page (fallback)
   * @param {string} videoPath - Path to video
   */
  async openBrowserUpload(videoPath) {
    const { clipboard } = require('electron');
    clipboard.writeText(videoPath);
    await shell.openExternal('https://vimeo.com/upload');
    
    return {
      method: 'browser',
      videoPath: videoPath,
      message: 'Video path copied to clipboard. Upload manually on Vimeo.'
    };
  }
}










