/**
 * Spaces API Server
 * 
 * Local HTTP + WebSocket server for browser extension communication.
 * Enables Chrome/Safari extensions to:
 * - List open browser tabs
 * - Capture screenshots and text from tabs
 * - Send content to Spaces
 * 
 * Port: 47291 (chosen to avoid conflicts)
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

const PORT = 47291;

/** Max request body size for JSON (10 MB) */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** Max WebSocket frame payload size (1 MB) */
const MAX_WS_PAYLOAD = 1024 * 1024;

/** Max limit for list/search query params */
const MAX_QUERY_LIMIT = 1000;

/**
 * Parse and clamp limit/offset from URL search params. Returns { limit, offset } with defaults and max applied.
 */
function parseLimitOffset(url, defaults = {}) {
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  let limit = limitRaw !== null && limitRaw !== '' ? parseInt(limitRaw, 10) : (defaults.limit ?? undefined);
  let offset = offsetRaw !== null && offsetRaw !== '' ? parseInt(offsetRaw, 10) : (defaults.offset ?? 0);
  if (Number.isNaN(limit)) limit = defaults.limit;
  if (Number.isNaN(offset)) offset = 0;
  if (limit !== undefined && (limit < 0 || limit > MAX_QUERY_LIMIT)) limit = MAX_QUERY_LIMIT;
  if (offset < 0) offset = 0;
  return { limit, offset };
}

/** Safe characters for space/item/folder IDs (alphanumeric, hyphen, underscore) */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Check that a relative filePath does not escape (no '..' or absolute segments).
 * @param {string} filePath - Relative path segment(s)
 * @returns {boolean} true if safe
 */
function isSafeRelativePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = path.normalize(filePath);
  return normalized !== '..' && !normalized.startsWith('..' + path.sep) && !path.isAbsolute(normalized);
}

/**
 * Send 400 for invalid ID/path and return true; otherwise return false.
 */
function sendBadRequestIfInvalid(res, opts) {
  const { spaceId, itemId, folderId, filePath, tagName } = opts || {};
  if (spaceId !== undefined && !SAFE_ID_PATTERN.test(spaceId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid spaceId', code: 'INVALID_ID' }));
    return true;
  }
  if (itemId !== undefined && !SAFE_ID_PATTERN.test(itemId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid itemId', code: 'INVALID_ID' }));
    return true;
  }
  if (folderId !== undefined && !SAFE_ID_PATTERN.test(folderId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid folderId', code: 'INVALID_ID' }));
    return true;
  }
  if (filePath !== undefined && !isSafeRelativePath(filePath)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file path', code: 'INVALID_PATH' }));
    return true;
  }
  if (tagName !== undefined && (typeof tagName !== 'string' || tagName.includes('..') || tagName.includes('/') || tagName.includes('\\'))) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid tag name', code: 'INVALID_PATH' }));
    return true;
  }
  return false;
}

class SpacesAPIServer {
  constructor() {
    this.server = null;
    this.wsConnections = new Set();
    this.authToken = null;
    this.extensionConnection = null;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.requestCounter = 0;
    this.onTabsReceived = null;
    this.onCaptureReceived = null;
  }

  /**
   * Initialize and start the server
   */
  async start() {
    // Load or generate auth token
    this.authToken = await this.loadOrGenerateToken();
    log.info('spaces', 'Auth token loaded')

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleHTTPRequest(req, res));

    // Handle WebSocket upgrade
    this.server.on('upgrade', (req, socket, head) => this.handleWebSocketUpgrade(req, socket, head));

    // NOTE: Conversion API routes (lib/conversion-routes.js) require Express.
    // This server uses raw HTTP, so conversion routes are handled via
    // handleHTTPRequest routing below instead of Express mounting.
    log.debug('spaces', 'Conversion routes available via raw HTTP handler');

    // Start listening
    return new Promise((resolve, reject) => {
      this.server.listen(PORT, '127.0.0.1', () => {
        log.info('spaces', 'Server running on http://127.0.0.1:...', { PORT })
        resolve();
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          log.error('spaces', 'Port ... is already in use', { PORT })
        }
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   */
  stop() {
    if (this.server) {
      // Close all WebSocket connections
      for (const ws of this.wsConnections) {
        ws.close();
      }
      this.wsConnections.clear();
      
      this.server.close();
      this.server = null;
      log.info('spaces', 'Server stopped')
    }
  }

  /**
   * Load existing token or generate new one
   */
  async loadOrGenerateToken() {
    const tokenPath = path.join(app.getPath('userData'), 'extension-auth-token.json');
    
    try {
      if (fs.existsSync(tokenPath)) {
        const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        if (data.token) {
          return data.token;
        }
      }
    } catch (error) {
      log.error('spaces', 'Error loading token', { error: error.message || error })
    }

    // Generate new token
    const token = crypto.randomBytes(32).toString('hex');
    const payload = JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 0);

    const tryWrite = () => {
      try {
        fs.writeFileSync(tokenPath, payload, 'utf8');
        return true;
      } catch (error) {
        log.error('spaces', 'Error saving extension auth token', { error: error.message })
        return false;
      }
    };
    if (!tryWrite()) {
      tryWrite(); // Retry once
      if (!fs.existsSync(tokenPath) || !JSON.parse(fs.readFileSync(tokenPath, 'utf8')).token) {
        log.warn('spaces', 'Extension auth token was NOT persisted; extension may need to re-authenticate after restart.')
      }
    }
    return token;
  }

  /**
   * Get the auth token (for displaying in setup UI)
   */
  getAuthToken() {
    return this.authToken;
  }

  /**
   * Check if extension is connected
   */
  isExtensionConnected() {
    return this.extensionConnection !== null;
  }

  /**
   * Read request body with size limit and request error handling.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {number} maxSize - Max body size in bytes (default MAX_BODY_SIZE)
   * @returns {Promise<string|null>} Body string, or null if response already sent (error/overflow)
   */
  readRequestBody(req, res, maxSize = MAX_BODY_SIZE) {
    return new Promise((resolve) => {
      let settled = false;
      function done(value) {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        done('');
        return;
      }
      const contentLength = req.headers['content-length'];
      if (contentLength !== undefined) {
        const len = parseInt(contentLength, 10);
        if (Number.isNaN(len) || len < 0 || len > maxSize) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' }));
          done(null);
          return;
        }
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxSize) {
          req.destroy();
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' }));
          }
          done(null);
        }
      });
      req.on('end', () => done(body));
      req.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request error', code: 'SERVER_ERROR' }));
        }
        done(null);
      });
    });
  }

  /**
   * Handle HTTP requests
   */
  handleHTTPRequest(req, res) {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    let pathname;
    let method;
    try {
      url = new URL(req.url || '', `http://127.0.0.1:${PORT}`);
      pathname = url.pathname;
      method = req.method;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request URL', code: 'INVALID_REQUEST' }));
      return;
    }
    
    // Route handlers with dynamic path matching
    // Static routes first
    if (pathname === '/api/status' && method === 'GET') {
      return this.handleStatus(req, res);
    }
    if (pathname === '/api/reload' && method === 'POST') {
      return this.handleReload(req, res);
    }
    if (pathname === '/api/database/status' && method === 'GET') {
      return this.handleDatabaseStatus(req, res);
    }
    if (pathname === '/api/database/rebuild' && method === 'POST') {
      return this.handleDatabaseRebuild(req, res);
    }
    if (pathname === '/api/token' && method === 'GET') {
      return this.handleGetToken(req, res);
    }
    if (pathname === '/api/tabs' && method === 'GET') {
      return this.handleGetTabs(req, res);
    }
    if (pathname === '/api/capture-tab' && method === 'POST') {
      return this.handleCaptureTab(req, res);
    }
    if (pathname === '/api/send-to-space' && method === 'POST') {
      return this.handleSendToSpace(req, res);
    }
    // Search routes (order matters: longer paths first)
    if ((pathname === '/api/search/suggestions' || pathname === '/api/search/suggest') && method === 'GET') {
      return this.handleSearchSuggestions(req, res, url);
    }
    if (pathname === '/api/search/deep/filters' && method === 'GET') {
      return this.handleGetDeepSearchFilters(req, res);
    }
    if (pathname === '/api/search/deep' && method === 'POST') {
      return this.handleDeepSearch(req, res);
    }
    if (pathname === '/api/search' && method === 'GET') {
      return this.handleSearch(req, res, url);
    }
    
    // Spaces routes
    if (pathname === '/api/spaces') {
      if (method === 'GET') return this.handleGetSpaces(req, res);
      if (method === 'POST') return this.handleCreateSpace(req, res);
    }
    
    // Smart folders routes
    if (pathname === '/api/smart-folders') {
      if (method === 'GET') return this.handleListSmartFolders(req, res);
      if (method === 'POST') return this.handleCreateSmartFolder(req, res);
    }
    
    // Tags search
    if (pathname === '/api/tags/search' && method === 'GET') {
      return this.handleSearchByTags(req, res, url);
    }
    
    // Global tags list
    if (pathname === '/api/tags' && method === 'GET') {
      return this.handleListAllTags(req, res, url);
    }
    
    // Dynamic routes - parse path segments
    const pathParts = pathname.split('/').filter(Boolean);
    
    // /api/smart-folders/:folderId
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'smart-folders') {
      const folderId = pathParts[2];
      if (sendBadRequestIfInvalid(res, { folderId })) return;
      if (method === 'GET') return this.handleGetSmartFolder(req, res, folderId);
      if (method === 'PUT') return this.handleUpdateSmartFolder(req, res, folderId);
      if (method === 'DELETE') return this.handleDeleteSmartFolder(req, res, folderId);
    }
    
    // /api/smart-folders/:folderId/items
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'smart-folders' && pathParts[3] === 'items') {
      const folderId = pathParts[2];
      if (sendBadRequestIfInvalid(res, { folderId })) return;
      if (method === 'GET') return this.handleGetSmartFolderItems(req, res, folderId, url);
    }
    
    // /api/spaces/:spaceId
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'spaces') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGetSpace(req, res, spaceId);
      if (method === 'PUT') return this.handleUpdateSpace(req, res, spaceId);
      if (method === 'DELETE') return this.handleDeleteSpace(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleListItems(req, res, spaceId, url);
      if (method === 'POST') return this.handleAddItem(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/tags
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleListSpaceTags(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items/push (bulk push - must match before generic items/:itemId)
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[4] === 'push') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handlePushAssets(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items/upload (multipart file upload - must match before generic items/:itemId)
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[4] === 'upload') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handleFileUpload(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items/:itemId (generic catch-all for item CRUD)
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'GET') return this.handleGetItem(req, res, spaceId, itemId);
      if (method === 'PUT') return this.handleUpdateItem(req, res, spaceId, itemId);
      if (method === 'DELETE') return this.handleDeleteItem(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/tags
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'GET') return this.handleGetItemTags(req, res, spaceId, itemId);
      if (method === 'PUT') return this.handleSetItemTags(req, res, spaceId, itemId);
      if (method === 'POST') return this.handleAddItemTag(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/tags/:tagName
    if (pathParts.length === 7 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      const tagName = decodeURIComponent(pathParts[6]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId, tagName })) return;
      if (method === 'DELETE') return this.handleRemoveItemTag(req, res, spaceId, itemId, tagName);
    }
    
    // /api/spaces/:spaceId/items/:itemId/move
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'move') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'POST') return this.handleMoveItem(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/pin
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'pin') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'POST') return this.handleTogglePin(req, res, spaceId, itemId);
    }
    
    // ============================================
    // METADATA ROUTES
    // ============================================
    
    // /api/spaces/:spaceId/metadata
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGetSpaceMetadata(req, res, spaceId);
      if (method === 'PUT') return this.handleUpdateSpaceMetadata(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/metadata/files/:filePath (filePath can contain slashes, so handle specially)
    if (pathParts.length >= 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'files') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const filePath = pathParts.slice(5).map(decodeURIComponent).join('/');
      if (sendBadRequestIfInvalid(res, { spaceId, filePath })) return;
      if (method === 'GET') return this.handleGetFileMetadata(req, res, spaceId, filePath);
      if (method === 'PUT') return this.handleSetFileMetadata(req, res, spaceId, filePath);
    }
    
    // /api/spaces/:spaceId/metadata/assets/:assetType
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'assets') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const assetType = decodeURIComponent(pathParts[5]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGetAssetMetadata(req, res, spaceId, assetType);
      if (method === 'PUT') return this.handleSetAssetMetadata(req, res, spaceId, assetType);
    }
    
    // /api/spaces/:spaceId/metadata/approvals/:itemType/:itemId
    if (pathParts.length === 7 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'approvals') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemType = decodeURIComponent(pathParts[5]);
      const itemId = decodeURIComponent(pathParts[6]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'PUT') return this.handleSetApproval(req, res, spaceId, itemType, itemId);
    }
    
    // /api/spaces/:spaceId/metadata/versions
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'versions') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handleAddVersion(req, res, spaceId);
      if (method === 'GET') return this.handleGetVersions(req, res, spaceId);
    }
    
    // ============================================
    // SHARING ROUTES (v3 Space API)
    // ============================================
    
    // /api/shares - Get everything shared with the current user
    if (pathParts.length === 2 && pathParts[0] === 'api' && pathParts[1] === 'shares') {
      if (method === 'GET') return this.handleGetSharedWithMe(req, res);
    }
    
    // /api/spaces/:spaceId/items/:itemId/share - Share/list shares for an item
    // Must come BEFORE the generic /api/spaces/:spaceId/items/:itemId route
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'share') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'POST') return this.handleShareAsset(req, res, spaceId, itemId);
      if (method === 'GET') return this.handleGetAssetSharedWith(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/share/:email - Revoke item share
    if (pathParts.length === 7 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'share') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      const email = decodeURIComponent(pathParts[6]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'DELETE') return this.handleUnshareAsset(req, res, spaceId, itemId, email);
    }
    
    // /api/spaces/:spaceId/share - Share/list shares for a space
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'share') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handleShareSpace(req, res, spaceId);
      if (method === 'GET') return this.handleGetSpaceSharedWith(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/share/:email - Revoke space share
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'share') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const email = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'DELETE') return this.handleUnshareSpace(req, res, spaceId, email);
    }
    
    // ============================================
    // GSX GRAPH STATUS / SCHEMA / STATS ROUTES
    // ============================================
    
    // /api/gsx/status - Check OmniGraph connection and readiness
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'gsx' && pathParts[2] === 'status') {
      if (method === 'GET') return this.handleGsxStatus(req, res);
    }
    
    // /api/gsx/schemas - List all graph schemas
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'gsx' && pathParts[2] === 'schemas') {
      if (method === 'GET') return this.handleGsxListSchemas(req, res);
    }
    
    // /api/gsx/schema/:entity - Get schema for a specific entity type
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'gsx' && pathParts[2] === 'schema') {
      const entity = decodeURIComponent(pathParts[3]);
      if (method === 'GET') return this.handleGsxGetSchema(req, res, entity);
    }
    
    // /api/gsx/stats - Get graph statistics
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'gsx' && pathParts[2] === 'stats') {
      if (method === 'GET') return this.handleGsxStats(req, res);
    }
    
    // /api/gsx/test - Test graph connection
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'gsx' && pathParts[2] === 'test') {
      if (method === 'GET') return this.handleGsxTestConnection(req, res);
    }
    
    // /api/gsx/seed-permission-schema - Diagnostic: seed Permission schema
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'gsx' && pathParts[2] === 'seed-permission-schema') {
      if (method === 'POST') return this.handleSeedPermissionSchema(req, res);
    }
    
    // ============================================
    // GSX GRAPH PUSH ROUTES
    // ============================================
    
    // /api/spaces/:spaceId/items/:itemId/push
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'push') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'POST') return this.handlePushAsset(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/push
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'push') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handlePushSpace(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/unpush
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'unpush') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handleUnpushSpace(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/unpush
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'unpush') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'POST') return this.handleUnpushAsset(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/push-status
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'push-status') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'GET') return this.handleGetPushStatus(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/visibility
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'visibility') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'PUT') return this.handleChangeVisibility(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/links
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'links') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (sendBadRequestIfInvalid(res, { spaceId, itemId })) return;
      if (method === 'GET') return this.handleGetLinks(req, res, spaceId, itemId);
    }
    
    // ============================================
    // DATA SOURCE API ROUTES
    // ============================================
    
    // /api/data-sources - List all data sources across all spaces
    if (pathname === '/api/data-sources' && method === 'GET') {
      return this.handleListDataSources(req, res, url);
    }
    
    // /api/data-sources/:itemId - Get single data source
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'data-sources' && method === 'GET') {
      const itemId = decodeURIComponent(pathParts[2]);
      return this.handleGetDataSource(req, res, itemId);
    }
    
    // /api/data-sources/:itemId/document - Get/Update description document
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'data-sources' && pathParts[3] === 'document') {
      const itemId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleGetDataSourceDocument(req, res, itemId);
      if (method === 'PUT') return this.handleUpdateDataSourceDocument(req, res, itemId);
    }
    
    // /api/data-sources/:itemId/operations - Get CRUD operation definitions
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'data-sources' && pathParts[3] === 'operations') {
      const itemId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleGetDataSourceOperations(req, res, itemId);
    }
    
    // /api/data-sources/:itemId/test - Test connectivity
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'data-sources' && pathParts[3] === 'test') {
      const itemId = decodeURIComponent(pathParts[2]);
      if (method === 'POST') return this.handleTestDataSource(req, res, itemId);
    }
    
    // ============================================
    // SPACE FILES API ROUTES
    // ============================================
    
    // /api/spaces/:spaceId/files (list) or /api/spaces/:spaceId/files/* (read/write/delete)
    if (pathParts.length >= 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'files') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      
      if (pathParts.length === 4) {
        // /api/spaces/:spaceId/files - list files
        if (method === 'GET') return this.handleListFiles(req, res, spaceId);
      } else {
        // /api/spaces/:spaceId/files/*path
        const filePath = pathParts.slice(4).map(decodeURIComponent).join('/');
        if (method === 'GET') return this.handleReadFile(req, res, spaceId, filePath);
        if (method === 'PUT') return this.handleWriteFile(req, res, spaceId, filePath);
        if (method === 'DELETE') return this.handleDeleteFile(req, res, spaceId, filePath);
      }
    }
    
    // ── Git-backed Version Control Endpoints ──────────────────────────────
    
    // /api/spaces/:spaceId/git/versions (Git commit log)
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-versions') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGitLog(req, res, spaceId);
      if (method === 'POST') return this.handleGitCommit(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/git/diff
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-diff') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGitDiff(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/git/branches
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-branches') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGitListBranches(req, res);
      if (method === 'POST') return this.handleGitCreateBranch(req, res);
    }
    
    // /api/spaces/:spaceId/git/merge
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-merge') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handleGitMerge(req, res);
    }
    
    // /api/spaces/:spaceId/git/status
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-status') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGitStatus(req, res);
    }
    
    // /api/spaces/:spaceId/git/tags
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGitListTags(req, res);
      if (method === 'POST') return this.handleGitCreateTag(req, res);
    }
    
    // /api/spaces/:spaceId/git/revert
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'git-revert') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'POST') return this.handleGitRevert(req, res);
    }
    
    // /api/git/migration - Run v2 to v3 migration
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'git' && pathParts[2] === 'migration') {
      if (method === 'POST') return this.handleGitMigration(req, res);
      if (method === 'GET') return this.handleGitMigrationStatus(req, res);
    }

    // /api/spaces/:spaceId/metadata/project-config
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'project-config') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (sendBadRequestIfInvalid(res, { spaceId })) return;
      if (method === 'GET') return this.handleGetProjectConfig(req, res, spaceId);
      if (method === 'PUT') return this.handleUpdateProjectConfig(req, res, spaceId);
    }
    
    // Debug logging for unmatched routes
    log.info('spaces', 'Unmatched route', { detail: { pathname,
      method,
      pathParts,
      pathPartsLength: pathParts.length
    } })
    
    // 404 - Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
  }

  /**
   * GET /api/status - Health check and extension status
   */
  handleStatus(req, res) {
    let database = { ready: false, path: null, hasConnection: false };
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      database = api.getDatabaseStatus();
    } catch (e) {
      // Spaces API not yet initialized
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: app.getVersion(),
      extensionConnected: this.isExtensionConnected(),
      port: PORT,
      databaseReady: database.ready,
      database
    }));
  }

  /**
   * POST /api/reload - Force reload index from disk
   * Useful when external processes have modified the storage
   * and the in-memory index needs to be refreshed
   */
  handleReload(req, res) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      api.reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Index reloaded from disk'
      }));
    } catch (error) {
      log.error('spaces', 'Reload error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: 'RELOAD_ERROR' }));
    }
  }

  /**
   * GET /api/database/status - Get DuckDB status
   */
  handleDatabaseStatus(req, res) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const status = api.getDatabaseStatus();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        database: status
      }));
    } catch (error) {
      log.error('spaces', 'Database status error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: 'DATABASE_STATUS_ERROR' }));
    }
  }

  /**
   * POST /api/database/rebuild - Rebuild index from metadata files
   */
  async handleDatabaseRebuild(req, res) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      // Wait for database to be ready
      const ready = await api.waitForDatabase();
      if (!ready) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'DuckDB not available',
          code: 'DATABASE_NOT_AVAILABLE'
        }));
        return;
      }
      
      const count = await api.rebuildIndex();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Rebuilt ${count} items from metadata files`,
        itemsRebuilt: count
      }));
    } catch (error) {
      log.error('spaces', 'Database rebuild error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: 'DATABASE_REBUILD_ERROR' }));
    }
  }

  /**
   * GET /api/token - Get auth token (only from localhost)
   */
  handleGetToken(req, res) {
    // Only allow from localhost
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: this.authToken }));
  }

  /**
   * GET /api/spaces - List available spaces
   */
  async handleGetSpaces(req, res) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const spaces = await api.list();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ spaces }));
    } catch (error) {
      log.error('spaces', 'Error getting spaces', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get spaces', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/send-to-space - Send content to a space
   * 
   * Routes through clipboardManager.addToHistory() for proper:
   * - In-memory history sync
   * - Space metadata updates
   * - Context capture
   * 
   * Accepts tags either at root level or in metadata.tags
   */
  async handleSendToSpace(req, res) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { spaceId, content, type, title, sourceUrl, tags, metadata } = data;

      if (!spaceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing spaceId', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      // Allow filePath as alternative to content for local file references
      const filePath = data.filePath;
      const fileName = data.fileName;

      if (!filePath && (!content || (typeof content === 'string' && content.trim().length === 0))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing content or filePath', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      // Validate filePath exists if provided
      if (filePath && !fs.existsSync(filePath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found at provided filePath', code: 'NOT_FOUND' }));
        return;
      }

      const itemTags = tags || metadata?.tags || [];

      if (global.clipboardManager) {
        const item = {
          type: type || (filePath ? 'file' : 'text'),
          content: content || '',
          preview: title || (type === 'image' ? 'Image from browser' : (filePath ? path.basename(filePath) : content.substring(0, 50))),
          source: sourceUrl ? `browser:${sourceUrl}` : (filePath ? 'spaces-api-filepath' : 'browser-extension'),
          metadata: {
            ...(metadata || {}),
            sourceUrl: sourceUrl || metadata?.sourceUrl,
            title: title || metadata?.title
          },
          tags: itemTags,
          spaceId: spaceId,
          timestamp: Date.now()
        };

        // Attach file path for local file references
        if (filePath) {
          item.filePath = filePath;
          item.fileName = fileName || path.basename(filePath);
        }

        await global.clipboardManager.addToHistory(item);
        const addedItem = global.clipboardManager.history?.[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, itemId: addedItem?.id || 'unknown' }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Clipboard manager not available', code: 'SERVER_ERROR' }));
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error sending to space', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to send to space', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/tabs - Request tab list from extension
   */
  async handleGetTabs(req, res) {
    if (!this.isExtensionConnected()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Extension not connected', code: 'NO_EXTENSION' }));
      return;
    }

    try {
      const tabs = await this.requestFromExtension('get-tabs', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tabs }));
    } catch (error) {
      log.error('spaces', 'Error getting tabs', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/capture-tab - Request tab capture from extension
   */
  async handleCaptureTab(req, res) {
    if (!this.isExtensionConnected()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Extension not connected', code: 'NO_EXTENSION' }));
      return;
    }

    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { tabId } = JSON.parse(body);
      if (!tabId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing tabId', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const capture = await this.requestFromExtension('capture-tab', { tabId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(capture));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error capturing tab', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // SPACES CRUD HANDLERS
  // ============================================

  /**
   * GET /api/spaces/:spaceId - Get single space
   */
  async handleGetSpace(req, res, spaceId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const space = await api.get(spaceId);
      
      if (!space) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Space not found', code: 'NOT_FOUND' }));
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ space }));
    } catch (error) {
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error getting space', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get space', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces - Create new space
   */
  async handleCreateSpace(req, res) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { name, icon, color } = data;
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing name', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const space = await api.create(name, { icon, color });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, space }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error creating space', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create space', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId - Update space
   */
  async handleUpdateSpace(req, res, spaceId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.update(spaceId, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error updating space', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update space', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * DELETE /api/spaces/:spaceId - Delete space
   */
  async handleDeleteSpace(req, res, spaceId) {
    try {
      if (spaceId === 'unclassified') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot delete Unclassified space', code: 'INVALID_OPERATION' }));
        return;
      }
      
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.delete(spaceId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error deleting space', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete space', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // ITEMS CRUD HANDLERS
  // ============================================

  /**
   * POST /api/spaces/:spaceId/items - Add an item to a space
   * Body: { content, type?, title?, sourceUrl?, tags?, metadata? }
   */
  async handleAddItem(req, res, spaceId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { content, type, title, sourceUrl, tags, metadata } = data;

      if (!content && !data.filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing content', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();

      const newItem = await api.items.add(spaceId, {
        content,
        type: type || 'text',
        title,
        sourceUrl,
        tags: tags || metadata?.tags || [],
        metadata: metadata || {},
        source: 'rest-api',
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item: newItem }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      // Content validation errors (invalid type, missing content, etc.) are client errors
      const msg = error.message || '';
      if (msg.includes('Invalid content type') || msg.includes('Missing content') || msg.includes('Content is required')) {
        log.warn('spaces', 'Item validation failed', { error: msg });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'VALIDATION_ERROR' }));
        return;
      }
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error adding item', { error: msg });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to add item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/items - List items
   */
  async handleListItems(req, res, spaceId, url) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const { limit, offset } = parseLimitOffset(url);
      const options = {
        limit,
        offset,
        type: url.searchParams.get('type') || undefined,
        pinned: url.searchParams.has('pinned') ? url.searchParams.get('pinned') === 'true' : undefined,
        tags: url.searchParams.get('tags') ? url.searchParams.get('tags').split(',') : undefined,
        includeContent: url.searchParams.get('includeContent') === 'true'
      };
      Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);
      const items = await api.items.list(spaceId, options);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
    } catch (error) {
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error listing items', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list items', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/items/:itemId - Get single item
   */
  async handleGetItem(req, res, spaceId, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const item = await api.items.get(spaceId, itemId);
      
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Item not found', code: 'NOT_FOUND' }));
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
    } catch (error) {
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error getting item', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/items/:itemId - Update item
   */
  async handleUpdateItem(req, res, spaceId, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.items.update(spaceId, itemId, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error updating item', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * DELETE /api/spaces/:spaceId/items/:itemId - Delete item
   */
  async handleDeleteItem(req, res, spaceId, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.items.delete(spaceId, itemId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error deleting item', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/move - Move item
   */
  async handleMoveItem(req, res, spaceId, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { toSpaceId } = data;
      if (!toSpaceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing toSpaceId', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.items.move(itemId, spaceId, toSpaceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error moving item', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to move item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/pin - Toggle pin
   */
  async handleTogglePin(req, res, spaceId, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const pinned = await api.items.togglePin(spaceId, itemId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, pinned }));
    } catch (error) {
      log.error('spaces', 'Error toggling pin', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to toggle pin', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // METADATA HANDLERS
  // ============================================

  /**
   * GET /api/spaces/:spaceId/metadata - Get space metadata
   */
  async handleGetSpaceMetadata(req, res, spaceId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const metadata = await api.metadata.getSpace(spaceId);
      
      if (!metadata) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Space metadata not found', code: 'NOT_FOUND' }));
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metadata));
    } catch (error) {
      log.error('spaces', 'Error getting space metadata', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get space metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata - Update space metadata
   */
  async handleUpdateSpaceMetadata(req, res, spaceId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const updated = await api.metadata.updateSpace(spaceId, data);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Space not found', code: 'NOT_FOUND' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, metadata: updated }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error updating space metadata', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update space metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/metadata/files/:filePath - Get file metadata
   */
  async handleGetFileMetadata(req, res, spaceId, filePath) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const metadata = await api.metadata.getFile(spaceId, filePath);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metadata || {}));
    } catch (error) {
      log.error('spaces', 'Error getting file metadata', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get file metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/files/:filePath - Set file metadata
   */
  async handleSetFileMetadata(req, res, spaceId, filePath) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const result = await api.metadata.setFile(spaceId, filePath, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, metadata: result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error setting file metadata', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to set file metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/metadata/assets/:assetType - Get asset metadata
   */
  async handleGetAssetMetadata(req, res, spaceId, assetType) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const spaceMetadata = await api.metadata.getSpace(spaceId);
      const assetData = spaceMetadata?.assets?.[assetType] || null;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(assetData || {}));
    } catch (error) {
      log.error('spaces', 'Error getting asset metadata', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get asset metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/assets/:assetType - Set asset metadata
   */
  async handleSetAssetMetadata(req, res, spaceId, assetType) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const result = await api.metadata.setAsset(spaceId, assetType, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, metadata: result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error setting asset metadata', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to set asset metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/approvals/:itemType/:itemId - Set approval status
   */
  async handleSetApproval(req, res, spaceId, itemType, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { approved } = JSON.parse(body);
      if (typeof approved !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'approved must be a boolean', code: 'INVALID_INPUT' }));
        return;
      }
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const result = await api.metadata.setApproval(spaceId, itemType, itemId, approved);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, metadata: result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error setting approval', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to set approval', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/metadata/versions - Get version history (from Git)
   */
  async handleGetVersions(req, res, spaceId) {
    try {
      const { getSpacesGit } = require('./lib/spaces-git');
      const spacesGit = getSpacesGit();
      
      if (!spacesGit.isInitialized()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ versions: [] }));
        return;
      }

      // Get commit history filtered to this space's files
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const depth = parseInt(url.searchParams.get('depth') || '50', 10);
      
      const log = await spacesGit.log({ depth, filepath: `spaces/${spaceId}` });
      const versions = log.map((entry, i) => ({
        version: log.length - i,
        sha: entry.sha,
        message: entry.message,
        author: entry.author,
        timestamp: entry.timestamp,
        parentShas: entry.parentShas,
      }));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ versions }));
    } catch (error) {
      log.error('spaces', 'Error getting versions', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get versions', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/metadata/versions - Add a version
   */
  async handleAddVersion(req, res, spaceId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const versionData = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();

      // Respond immediately -- Git commit runs in background (can take 10+ seconds for large repos)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: 'pending', message: 'Version commit started' }));

      // Run git commit in background
      api.metadata.addVersion(spaceId, versionData).then(result => {
        log.info('spaces', 'Version committed', { spaceId, sha: result?.sha, filesChanged: result?.filesChanged });
      }).catch(error => {
        log.warn('spaces', 'Background version commit failed', { error: error.message || error });
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      const msg = error.message || String(error);
      if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, code: 'NOT_FOUND' }));
        return;
      }
      log.error('spaces', 'Error adding version', { error: msg })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to add version', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/metadata/project-config - Get project configuration
   */
  async handleGetProjectConfig(req, res, spaceId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const spaceMetadata = await api.metadata.getSpace(spaceId);
      const projectConfig = spaceMetadata?.projectConfig || {};
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projectConfig));
    } catch (error) {
      log.error('spaces', 'Error getting project config', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get project config', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/project-config - Update project configuration
   */
  async handleUpdateProjectConfig(req, res, spaceId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const config = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const result = await api.metadata.updateProjectConfig(spaceId, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, metadata: result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error updating project config', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update project config', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // GSX GRAPH PUSH HELPERS
  // ============================================

  /**
   * Helper: verify GSX push is initialized; auto-initializes from settings if needed.
   * Sends 503 + returns null if initialization fails.
   */
  _getGSX(res) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const client = api.gsx.getClient();
      if (!client) throw new Error('not initialized');
      
      // Auto-initialize OmniGraph endpoint from settings if not yet configured
      const { getOmniGraphClient } = require('./omnigraph-client');
      const omniClient = getOmniGraphClient();
      if (!omniClient.isReady()) {
        try {
          const { getSettingsManager } = require('./settings-manager');
          const settings = getSettingsManager();
          const refreshUrl = settings.get('gsxRefreshUrl');
          if (refreshUrl) {
            const endpoint = refreshUrl.replace('/refresh_token', '/omnigraph');
            api.gsx.initialize(endpoint, null, settings.get('userEmail') || 'system');
            log.info('spaces', 'Auto-initialized OmniGraph from settings', { endpoint })
          }
        } catch (initErr) {
          log.warn('spaces', 'Could not auto-initialize OmniGraph', { error: initErr.message })
        }
      }
      
      return api;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GSX not initialized. Configure GSX connection first.', code: 'GSX_NOT_INITIALIZED' }));
      return null;
    }
  }

  // ============================================
  // GSX GRAPH PUSH HANDLERS
  // ============================================

  /**
   * POST /api/spaces/:spaceId/items/:itemId/push - Push single asset to graph
   * Body: { isPublic? }
   */
  async handlePushAsset(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = body.trim() ? JSON.parse(body) : {};
      const result = await api.gsx.pushAsset(itemId, { isPublic: !!data.isPublic, force: !!data.force });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Push asset error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to push asset', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/push - Bulk push assets to graph
   * Body: { itemIds, isPublic? }
   */
  async handlePushAssets(req, res, spaceId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { itemIds, isPublic } = JSON.parse(body);
      if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or empty itemIds array', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const result = await api.gsx.pushAssets(itemIds, { isPublic: !!isPublic });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Bulk push error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to push assets', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/push - Push entire space to graph
   * Body: { isPublic?, includeAssets? }
   */
  async handlePushSpace(req, res, spaceId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = body.trim() ? JSON.parse(body) : {};
      const result = await api.gsx.pushSpace(spaceId, {
        isPublic: !!data.isPublic,
        includeAssets: !!data.includeAssets
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Push space error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to push space', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/unpush - Unpush asset from graph
   */
  async handleUnpushAsset(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const result = await api.gsx.unpushAsset(itemId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'Unpush asset error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to unpush asset', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/unpush - Unpush space from graph
   * Body: { includeAssets? }
   */
  async handleUnpushSpace(req, res, spaceId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = body.trim() ? JSON.parse(body) : {};
      const result = await api.gsx.unpushSpace(spaceId, { includeAssets: !!data.includeAssets });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Unpush space error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to unpush space', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/items/:itemId/push-status - Get push status
   */
  async handleGetPushStatus(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const status = await api.gsx.getPushStatus(itemId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (error) {
      log.error('spaces', 'Push status error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get push status', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/items/:itemId/visibility - Change visibility
   * Body: { isPublic }
   */
  async handleChangeVisibility(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { isPublic } = JSON.parse(body);
      if (typeof isPublic !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid "isPublic" boolean', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const result = await api.gsx.changeVisibility(itemId, isPublic);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Visibility error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to change visibility', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/items/:itemId/links - Get graph links
   */
  async handleGetLinks(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const links = await api.gsx.getLinks(itemId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(links));
    } catch (error) {
      log.error('spaces', 'Get links error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get links', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  // ============================================
  // SHARING HANDLERS (v3 Space API)
  // ============================================

  /**
   * POST /api/spaces/:spaceId/share - Share a space with a user
   * Body: { email, permission, expiresIn?, note? }
   */
  async handleShareSpace(req, res, spaceId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      if (!data.email) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: email', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      if (!data.permission || !['read', 'write', 'admin'].includes(data.permission)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Permission must be read, write, or admin', code: 'INVALID_INPUT' }));
        return;
      }
      const result = await Promise.race([
        api.sharing.shareSpace(spaceId, data.email, data.permission, {
          expiresIn: data.expiresIn || null,
          note: data.note || ''
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Share operation timed out (10s)')), 10000))
      ]);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Share space error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to share space', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/share - List who a space is shared with
   */
  async handleGetSpaceSharedWith(req, res, spaceId) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const result = await api.sharing.getSpaceSharedWith(spaceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'Get space shares error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get space shares', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * DELETE /api/spaces/:spaceId/share/:email - Revoke space share
   */
  async handleUnshareSpace(req, res, spaceId, email) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const result = await api.sharing.unshareSpace(spaceId, email);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'Unshare space error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to unshare space', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/share - Share an item with a user
   * Body: { email, permission, expiresIn?, note? }
   */
  async handleShareAsset(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      if (!data.email) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: email', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      if (!data.permission || !['read', 'write', 'admin'].includes(data.permission)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Permission must be read, write, or admin', code: 'INVALID_INPUT' }));
        return;
      }
      const result = await Promise.race([
        api.sharing.shareAsset(itemId, data.email, data.permission, {
          expiresIn: data.expiresIn || null,
          note: data.note || ''
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Share operation timed out (10s)')), 10000))
      ]);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Share asset error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to share asset', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/items/:itemId/share - List who an item is shared with
   */
  async handleGetAssetSharedWith(req, res, spaceId, itemId) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const result = await api.sharing.getAssetSharedWith(itemId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'Get asset shares error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get asset shares', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * DELETE /api/spaces/:spaceId/items/:itemId/share/:email - Revoke item share
   */
  async handleUnshareAsset(req, res, spaceId, itemId, email) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const result = await api.sharing.unshareAsset(itemId, email);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'Unshare asset error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to unshare asset', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/shares - Get all spaces/items shared with the current user
   */
  async handleGetSharedWithMe(req, res) {
    const api = this._getGSX(res);
    if (!api) return;
    try {
      const result = await api.sharing.getSharedWithMe();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'Get shared with me error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get shared items', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  // ============================================
  // GSX GRAPH STATUS / SCHEMA / STATS HANDLERS
  // ============================================

  /**
   * GET /api/gsx/status - Check OmniGraph connection readiness
   */
  async handleGsxStatus(req, res) {
    try {
      const { getOmniGraphClient } = require('./omnigraph-client');
      const client = getOmniGraphClient();
      
      // Try auto-init if not ready
      if (!client.isReady()) {
        try {
          const { getSettingsManager } = require('./settings-manager');
          const settings = getSettingsManager();
          const refreshUrl = settings.get('gsxRefreshUrl');
          if (refreshUrl) {
            const endpoint = refreshUrl.replace('/refresh_token', '/omnigraph');
            const { getSpacesAPI } = require('./spaces-api');
            const api = getSpacesAPI();
            api.gsx.initialize(endpoint, null, settings.get('userEmail') || 'system');
          }
        } catch (e) { /* ignore */ }
      }
      
      const ready = client.isReady();
      const result = {
        ready,
        endpoint: ready ? client.endpoint : null,
        graphName: client.graphName || 'idw',
        currentUser: client.currentUser || null
      };
      
      // If ready, try a connection test
      if (ready) {
        try {
          const testResult = await client.testConnection();
          result.connected = testResult.connected !== false;
          result.nodeCount = testResult.count || 0;
        } catch (e) {
          result.connected = false;
          result.connectionError = e.message;
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'GSX status error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get GSX status', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/gsx/schemas - List all entity schemas in the graph
   */
  async handleGsxListSchemas(req, res) {
    try {
      const { getOmniGraphClient } = require('./omnigraph-client');
      const client = getOmniGraphClient();
      if (!client.isReady()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OmniGraph not initialized', code: 'GSX_NOT_INITIALIZED' }));
        return;
      }
      const schemas = await client.listSchemas();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schemas: schemas || [] }));
    } catch (error) {
      log.error('spaces', 'GSX list schemas error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list schemas', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/gsx/schema/:entity - Get schema for a specific entity type
   */
  async handleGsxGetSchema(req, res, entity) {
    try {
      const { getOmniGraphClient } = require('./omnigraph-client');
      const client = getOmniGraphClient();
      if (!client.isReady()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OmniGraph not initialized', code: 'GSX_NOT_INITIALIZED' }));
        return;
      }
      const schema = await client.getSchema(entity);
      if (!schema) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Schema not found for entity: ${entity}`, code: 'NOT_FOUND' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(schema));
    } catch (error) {
      log.error('spaces', 'GSX get schema error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get schema', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/gsx/stats - Get graph statistics (space + asset counts)
   */
  async handleGsxStats(req, res) {
    try {
      const { getOmniGraphClient } = require('./omnigraph-client');
      const client = getOmniGraphClient();
      if (!client.isReady()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OmniGraph not initialized', code: 'GSX_NOT_INITIALIZED' }));
        return;
      }
      const stats = await client.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } catch (error) {
      log.error('spaces', 'GSX stats error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get graph stats', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * GET /api/gsx/test - Test graph connection
   */
  async handleGsxTestConnection(req, res) {
    try {
      const { getOmniGraphClient } = require('./omnigraph-client');
      const client = getOmniGraphClient();
      if (!client.isReady()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OmniGraph not initialized', code: 'GSX_NOT_INITIALIZED' }));
        return;
      }
      const result = await client.testConnection();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error('spaces', 'GSX test connection error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to test connection', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  /**
   * POST /api/gsx/seed-permission-schema - Diagnostic: force seed Permission schema
   */
  async handleSeedPermissionSchema(req, res) {
    try {
      const { getOmniGraphClient } = require('./omnigraph-client');
      const client = getOmniGraphClient();
      if (!client.isReady()) {
        // Try auto-init
        const api = this._getGSX(res);
        if (!api) return;
      }
      // Force re-seed by resetting the flag
      client._permissionSchemaEnsured = false;
      client._permissionSchemaError = null;
      await client.ensurePermissionSchema();
      
      const result = {
        success: !!client._permissionSchemaEnsured,
        error: client._permissionSchemaError || null,
        schemaEnsured: !!client._permissionSchemaEnsured
      };
      
      // Try to verify
      try {
        const schema = await client.getSchema('Permission');
        result.schemaFound = !!schema;
        result.schemaData = schema;
      } catch (e) {
        result.schemaFound = false;
        result.schemaLookupError = e.message;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, stack: error.stack }));
    }
  }

  // ============================================
  // DATA SOURCE HANDLERS
  // ============================================

  /**
   * GET /api/data-sources - Discovery endpoint: list all data sources across all spaces
   * Query params: ?sourceType=mcp|api|web-scraping&limit=50&offset=0
   */
  async handleListDataSources(req, res, url) {
    try {
      const params = url.searchParams;
      const sourceType = params.get('sourceType');
      const limit = Math.min(parseInt(params.get('limit')) || 100, 1000);
      const offset = Math.max(parseInt(params.get('offset')) || 0, 0);
      
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      // Get all items across all spaces, filter to data-source type
      let allItems = api.storage.index.items.filter(item => item.type === 'data-source');
      
      // Filter by sourceType if specified
      if (sourceType) {
        allItems = allItems.filter(item => {
          const ds = item.dataSource || {};
          return ds.sourceType === sourceType || item.sourceType === sourceType;
        });
      }
      
      const total = allItems.length;
      const items = allItems.slice(offset, offset + limit).map(item => {
        const ds = item.dataSource || {};
        return {
          id: item.id,
          name: item.name || '',
          spaceId: item.spaceId,
          sourceType: ds.sourceType || item.sourceType,
          connection: ds.connection || {},
          auth: {
            type: (ds.auth || {}).type || 'none',
            label: (ds.auth || {}).label || '',
            headerName: (ds.auth || {}).headerName || '',
            tokenUrl: (ds.auth || {}).tokenUrl || '',
            scopes: (ds.auth || {}).scopes || [],
            notes: (ds.auth || {}).notes || ''
            // No secrets
          },
          operations: ds.operations || {},
          status: ds.status || 'inactive',
          documentVisibility: (ds.document || {}).visibility || 'private',
          lastTestedAt: ds.lastTestedAt || null,
          timestamp: item.timestamp
        };
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total, limit, offset }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * GET /api/data-sources/:itemId - Get full data source config
   */
  async handleGetDataSource(req, res, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const item = api.storage.index.items.find(i => i.id === itemId);
      if (!item || item.type !== 'data-source') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data source not found' }));
        return;
      }
      
      const ds = item.dataSource || {};
      const result = {
        id: item.id,
        name: item.name || '',
        spaceId: item.spaceId,
        sourceType: ds.sourceType || item.sourceType,
        connection: ds.connection || {},
        auth: {
          type: (ds.auth || {}).type || 'none',
          label: (ds.auth || {}).label || '',
          headerName: (ds.auth || {}).headerName || '',
          tokenUrl: (ds.auth || {}).tokenUrl || '',
          scopes: (ds.auth || {}).scopes || [],
          notes: (ds.auth || {}).notes || ''
        },
        operations: ds.operations || {},
        mcp: ds.mcp || {},
        scraping: ds.scraping || {},
        document: {
          visibility: (ds.document || {}).visibility || 'private',
          lastUpdated: (ds.document || {}).lastUpdated
          // Content returned via /document endpoint
        },
        status: ds.status || 'inactive',
        lastTestedAt: ds.lastTestedAt || null,
        lastError: ds.lastError || null,
        timestamp: item.timestamp
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * GET /api/data-sources/:itemId/document - Get description document
   */
  async handleGetDataSourceDocument(req, res, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const item = api.storage.index.items.find(i => i.id === itemId);
      if (!item || item.type !== 'data-source') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data source not found' }));
        return;
      }
      
      const ds = item.dataSource || {};
      const doc = ds.document || {};
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: doc.content || '',
        visibility: doc.visibility || 'private',
        lastUpdated: doc.lastUpdated || null
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * PUT /api/data-sources/:itemId/document - Update description document
   */
  async handleUpdateDataSourceDocument(req, res, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const item = api.storage.index.items.find(i => i.id === itemId);
      if (!item || item.type !== 'data-source') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data source not found' }));
        return;
      }
      
      const ds = item.dataSource || {};
      ds.document = {
        content: body.content || '',
        visibility: body.visibility || ds.document?.visibility || 'private',
        lastUpdated: new Date().toISOString()
      };
      
      // Persist via items API
      await api.items.update(item.spaceId, itemId, { dataSource: ds, documentVisibility: ds.document.visibility });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * GET /api/data-sources/:itemId/operations - Get CRUD operation definitions
   */
  async handleGetDataSourceOperations(req, res, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const item = api.storage.index.items.find(i => i.id === itemId);
      if (!item || item.type !== 'data-source') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data source not found' }));
        return;
      }
      
      const ds = item.dataSource || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        baseUrl: (ds.connection || {}).url || '',
        operations: ds.operations || {},
        auth: {
          type: (ds.auth || {}).type || 'none',
          headerName: (ds.auth || {}).headerName || '',
          notes: (ds.auth || {}).notes || ''
        }
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * POST /api/data-sources/:itemId/test - Test connectivity (credentials in body, not stored)
   */
  async handleTestDataSource(req, res, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const item = api.storage.index.items.find(i => i.id === itemId);
      if (!item || item.type !== 'data-source') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data source not found' }));
        return;
      }
      
      const ds = item.dataSource || {};
      const conn = ds.connection || {};
      const targetUrl = conn.url;
      
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No URL configured for this data source' }));
        return;
      }
      
      // Build headers
      const headers = { ...(conn.headers || {}) };
      const credential = body.credential || '';
      if (credential && ds.auth) {
        if (ds.auth.type === 'bearer') headers['Authorization'] = `Bearer ${credential}`;
        else if (ds.auth.type === 'api-key' && ds.auth.headerName) headers[ds.auth.headerName] = credential;
        else if (ds.auth.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(credential).toString('base64')}`;
      }
      
      // Test connection
      const https = require('https');
      const http = require('http');
      const urlObj = new URL(targetUrl);
      const transport = urlObj.protocol === 'https:' ? https : http;
      const startTime = Date.now();
      
      const testResult = await new Promise((resolve) => {
        const testReq = transport.request(targetUrl, {
          method: conn.method || 'GET',
          headers,
          timeout: Math.min(conn.timeout || 10000, 15000)
        }, (testRes) => {
          resolve({ success: testRes.statusCode < 400, statusCode: testRes.statusCode, responseTime: Date.now() - startTime });
          testRes.destroy();
        });
        testReq.on('error', (err) => resolve({ success: false, error: err.message, responseTime: Date.now() - startTime }));
        testReq.on('timeout', () => { testReq.destroy(); resolve({ success: false, error: 'Timeout', responseTime: Date.now() - startTime }); });
        testReq.end();
      });
      
      // Update status in storage
      ds.status = testResult.success ? 'active' : 'error';
      ds.lastTestedAt = new Date().toISOString();
      ds.lastError = testResult.success ? null : (testResult.error || `HTTP ${testResult.statusCode}`);
      
      await api.items.update(item.spaceId, itemId, { 
        dataSource: ds, 
        dataSourceStatus: ds.status, 
        lastTestedAt: ds.lastTestedAt 
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(testResult));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  // ============================================
  // FILE UPLOAD HANDLER
  // ============================================

  /**
   * Parse multipart/form-data request body.
   * Returns { fields: {key: string}, file: { name, type, data: Buffer } | null }
   */
  _parseMultipart(req) {
    return new Promise((resolve, reject) => {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
      if (!boundaryMatch) {
        return reject(new Error('Missing multipart boundary'));
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const delimiter = Buffer.from(`--${boundary}`);
      const maxSize = 100 * 1024 * 1024; // 100 MB for file uploads
      const chunks = [];
      let totalSize = 0;

      req.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          req.destroy();
          return reject(new Error('FILE_TOO_LARGE'));
        }
        chunks.push(chunk);
      });

      req.on('error', reject);

      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const fields = {};
          let file = null;

          // Split by boundary
          let start = 0;
          while (true) {
            const idx = raw.indexOf(delimiter, start);
            if (idx === -1) break;

            if (start > 0) {
              // Extract part between previous boundary and this one
              // Skip the CRLF after the previous delimiter
              let partStart = start;
              // The part data is between the previous boundary end and this boundary start
              // Previous boundary end is at `start`, this boundary start is at `idx`
              const partData = raw.slice(partStart, idx);

              if (partData.length > 4) { // Skip empty parts
                // Find headers/body separator (double CRLF)
                const headerEnd = partData.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                  const headerStr = partData.slice(0, headerEnd).toString('utf8');
                  // Body is after \r\n\r\n and before trailing \r\n
                  const bodyData = partData.slice(headerEnd + 4, partData.length - 2); // trim trailing \r\n

                  const nameMatch = headerStr.match(/name="([^"]+)"/);
                  const filenameMatch = headerStr.match(/filename="([^"]+)"/);
                  const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

                  if (nameMatch) {
                    if (filenameMatch) {
                      // File field
                      file = {
                        fieldName: nameMatch[1],
                        name: filenameMatch[1],
                        type: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
                        data: bodyData
                      };
                    } else {
                      // Text field
                      fields[nameMatch[1]] = bodyData.toString('utf8');
                    }
                  }
                }
              }
            }

            // Move past delimiter + CRLF (or -- for closing)
            start = idx + delimiter.length + 2; // +2 for \r\n
          }

          resolve({ fields, file });
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * POST /api/spaces/:spaceId/items/upload - Multipart file upload
   * Fields: type, title, tags (JSON string), sourceUrl, metadata (JSON string)
   * File: the binary content
   */
  async handleFileUpload(req, res, spaceId) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data', code: 'INVALID_CONTENT_TYPE' }));
      return;
    }

    try {
      const { fields, file } = await this._parseMultipart(req);

      if (!file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file provided in form data', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      // Write file to temp location
      const tmpDir = path.join(app.getPath('temp'), 'spaces-upload');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `${Date.now()}-${file.name}`);
      fs.writeFileSync(tmpPath, file.data);

      // Parse optional fields
      let parsedTags = [];
      let parsedMetadata = {};
      try { parsedTags = fields.tags ? JSON.parse(fields.tags) : []; } catch { /* ignore */ }
      try { parsedMetadata = fields.metadata ? JSON.parse(fields.metadata) : {}; } catch { /* ignore */ }

      if (global.clipboardManager) {
        const item = {
          type: fields.type || 'file',
          content: '',
          filePath: tmpPath,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.data.length,
          preview: fields.title || file.name,
          source: fields.sourceUrl ? `api:${fields.sourceUrl}` : 'spaces-api-upload',
          metadata: {
            ...parsedMetadata,
            sourceUrl: fields.sourceUrl || parsedMetadata.sourceUrl,
            title: fields.title || parsedMetadata.title
          },
          tags: parsedTags,
          spaceId: spaceId,
          timestamp: Date.now()
        };

        await global.clipboardManager.addToHistory(item);
        const addedItem = global.clipboardManager.history?.[0];

        // Clean up temp file
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, itemId: addedItem?.id || 'unknown', fileName: file.name, fileSize: file.data.length }));
      } else {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Clipboard manager not available', code: 'SERVER_ERROR' }));
      }
    } catch (error) {
      if (error.message === 'FILE_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File exceeds 100 MB limit', code: 'FILE_TOO_LARGE' }));
        return;
      }
      log.error('spaces', 'File upload error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to upload file', code: 'SERVER_ERROR', details: error.message }));
    }
  }

  // ============================================
  // SPACE FILES API HANDLERS
  // ============================================

  /** MIME type lookup from extension */
  _getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.json': 'application/json', '.js': 'text/javascript', '.ts': 'text/typescript',
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
      '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
      '.xml': 'text/xml', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.pdf': 'application/pdf', '.zip': 'application/zip',
      '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * GET /api/spaces/:spaceId/files - List files in space directory
   * Query params: subPath (optional subdirectory)
   */
  async handleListFiles(req, res, spaceId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const subPath = url.searchParams.get('subPath') || '';

      const files = await api.files.list(spaceId, subPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files, total: files.length }));
    } catch (error) {
      if (error.message === 'Path escapes space directory') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path traversal not allowed', code: 'PATH_TRAVERSAL' }));
        return;
      }
      log.error('spaces', 'List files error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list files', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/files/*path - Read a file from space
   */
  async handleReadFile(req, res, spaceId, filePath) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const spacePath = await api.files.getSpacePath(spaceId);
      const fullPath = path.join(spacePath, filePath);

      // Security: ensure resolved path is within space directory
      const resolvedPath = path.resolve(fullPath);
      const resolvedSpacePath = path.resolve(spacePath);
      if (!resolvedPath.startsWith(resolvedSpacePath + path.sep) && resolvedPath !== resolvedSpacePath) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path traversal not allowed', code: 'PATH_TRAVERSAL' }));
        return;
      }

      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found', code: 'NOT_FOUND' }));
        return;
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        // Return directory listing
        const files = await api.files.list(spaceId, filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files, total: files.length }));
        return;
      }

      const mimeType = this._getMimeType(fullPath);
      const isText = mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'image/svg+xml';

      if (isText) {
        const content = fs.readFileSync(fullPath, 'utf8');
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(content);
      } else {
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': content.length
        });
        res.end(content);
      }
    } catch (error) {
      if (error.message === 'Path escapes space directory') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path traversal not allowed', code: 'PATH_TRAVERSAL' }));
        return;
      }
      log.error('spaces', 'Read file error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/files/*path - Write a file to space
   * Accepts JSON body { content } or raw text/plain body
   */
  async handleWriteFile(req, res, spaceId, filePath) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const contentType = req.headers['content-type'] || '';
      let content;

      if (contentType.includes('application/json')) {
        const body = await this.readRequestBody(req, res);
        if (body === null) return;
        const data = JSON.parse(body);
        content = data.content;
        if (content === undefined || content === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "content" field in JSON body', code: 'MISSING_REQUIRED_FIELD' }));
          return;
        }
      } else {
        // Accept raw body as content
        const body = await this.readRequestBody(req, res);
        if (body === null) return;
        content = body;
      }

      const success = await api.files.write(spaceId, filePath, content);

      if (success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filePath }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to write file', code: 'SERVER_ERROR' }));
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      if (error.message === 'Path escapes space directory') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path traversal not allowed', code: 'PATH_TRAVERSAL' }));
        return;
      }
      log.error('spaces', 'Write file error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to write file', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * DELETE /api/spaces/:spaceId/files/*path - Delete a file from space
   */
  async handleDeleteFile(req, res, spaceId, filePath) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.files.delete(spaceId, filePath);

      if (success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filePath }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found or could not be deleted', code: 'NOT_FOUND' }));
      }
    } catch (error) {
      if (error.message === 'Path escapes space directory') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path traversal not allowed', code: 'PATH_TRAVERSAL' }));
        return;
      }
      log.error('spaces', 'Delete file error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete file', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // GIT VERSION CONTROL HANDLERS
  // ============================================

  /**
   * Helper: get SpacesGit instance, return null + 503 if not initialized.
   */
  _getGit(res) {
    const { getSpacesGit } = require('./lib/spaces-git');
    const spacesGit = getSpacesGit();
    if (!spacesGit.isInitialized()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Git not initialized. Run migration first.', code: 'GIT_NOT_INITIALIZED' }));
      return null;
    }
    return spacesGit;
  }

  /**
   * GET /api/spaces/:spaceId/git-versions - Get Git commit log
   * Query params: depth (default 50), filepath (optional)
   */
  async handleGitLog(req, res, spaceId) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const depth = Math.min(parseInt(url.searchParams.get('depth') || '50', 10), MAX_QUERY_LIMIT);
      const filepath = url.searchParams.get('filepath') || `spaces/${spaceId}`;
      
      const log = await spacesGit.log({ depth, filepath });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ versions: log, total: log.length }));
    } catch (error) {
      log.error('spaces', 'Git log error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get version history', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/git-versions - Create a new commit
   * Body: { message, authorName?, authorEmail?, filepaths? }
   */
  async handleGitCommit(req, res, spaceId) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { message, authorName, authorEmail, filepaths } = JSON.parse(body);
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing commit message', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      let result;
      if (filepaths && Array.isArray(filepaths)) {
        result = await spacesGit.commit({ filepaths, message, authorName, authorEmail });
      } else {
        result = await spacesGit.commitAll({ message, authorName, authorEmail });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Git commit error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create version', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/git-diff - Diff between two commits
   * Query params: from (SHA or ref), to (SHA or ref)
   */
  async handleGitDiff(req, res, spaceId) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to') || 'HEAD';
      
      if (!from) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "from" parameter (commit SHA or ref)', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      const changes = await spacesGit.diff(from, to);
      
      // Filter to this space's files if requested
      const spaceChanges = changes.filter(c => c.filepath.startsWith(`spaces/${spaceId}/`) || c.filepath.startsWith('items/'));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ changes: spaceChanges, total: spaceChanges.length }));
    } catch (error) {
      log.error('spaces', 'Git diff error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to compute diff', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/git-branches - List all branches
   */
  async handleGitListBranches(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    try {
      const branches = await spacesGit.listBranches();
      const current = await spacesGit.currentBranch();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ branches, current }));
    } catch (error) {
      log.error('spaces', 'Git branches error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list branches', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/git-branches - Create and optionally checkout a branch
   * Body: { name, startPoint?, checkout? }
   */
  async handleGitCreateBranch(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { name, startPoint, checkout } = JSON.parse(body);
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing branch name', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      await spacesGit.createBranch(name, startPoint);
      if (checkout) {
        await spacesGit.checkout(name);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, branch: name, checkedOut: !!checkout }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Git create branch error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create branch', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/git-merge - Merge a branch into current
   * Body: { theirs, authorName?, message? }
   */
  async handleGitMerge(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { theirs, authorName, authorEmail, message } = JSON.parse(body);
      if (!theirs) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "theirs" branch name', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      const result = await spacesGit.merge({ theirs, authorName, authorEmail, message });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      // Check for merge conflict
      if (error.code === 'MergeConflictError' || error.code === 'MergeNotSupportedError') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Merge conflict', code: 'MERGE_CONFLICT', details: error.message }));
        return;
      }
      log.error('spaces', 'Git merge error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to merge', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/git-status - Working tree status
   */
  async handleGitStatus(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    try {
      const status = await spacesGit.status();
      const currentBranch = await spacesGit.currentBranch();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ branch: currentBranch, ...status }));
    } catch (error) {
      log.error('spaces', 'Git status error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get status', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/git-tags - List all tags
   */
  async handleGitListTags(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    try {
      const tags = await spacesGit.listTags();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tags }));
    } catch (error) {
      log.error('spaces', 'Git tags error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list tags', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/git-tags - Create an annotated tag
   * Body: { name, message?, ref? }
   */
  async handleGitCreateTag(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { name, message, ref, authorName } = JSON.parse(body);
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing tag name', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      await spacesGit.createTag({ name, message, ref, authorName });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tag: name }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Git create tag error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create tag', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/git-revert - Revert a commit
   * Body: { sha, authorName? }
   */
  async handleGitRevert(req, res) {
    const spacesGit = this._getGit(res);
    if (!spacesGit) return;
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const { sha, authorName } = JSON.parse(body);
      if (!sha) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing commit SHA to revert', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }

      const result = await spacesGit.revert(sha, authorName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Git revert error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to revert', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/git/migration - Trigger v2 to v3 migration
   */
  async handleGitMigration(req, res) {
    try {
      const { getSpacesGit } = require('./lib/spaces-git');
      const spacesGit = getSpacesGit();
      
      if (spacesGit.isV3()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, alreadyMigrated: true }));
        return;
      }

      const { migrateToV3 } = require('./lib/spaces-migration');
      const progressEvents = [];
      
      const result = await migrateToV3({
        onProgress: (step, detail, percent) => {
          progressEvents.push({ step, detail, percent, timestamp: new Date().toISOString() });
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result, progressEvents }));
    } catch (error) {
      log.error('spaces', 'Migration error', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Migration failed', 
        code: 'MIGRATION_ERROR', 
        details: error.message,
        backupPath: error.backupPath || null 
      }));
    }
  }

  /**
   * GET /api/git/migration - Check migration status
   */
  async handleGitMigrationStatus(req, res) {
    try {
      const { getSpacesGit } = require('./lib/spaces-git');
      const spacesGit = getSpacesGit();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        isV3: spacesGit.isV3(), 
        isGitInitialized: spacesGit.isInitialized() 
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check migration status', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // TAGS HANDLERS
  // ============================================

  /**
   * GET /api/spaces/:spaceId/items/:itemId/tags - Get item tags
   */
  async handleGetItemTags(req, res, spaceId, itemId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const tags = await api.items.getTags(spaceId, itemId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tags }));
    } catch (error) {
      log.error('spaces', 'Error getting tags', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get tags', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/items/:itemId/tags - Set item tags
   */
  async handleSetItemTags(req, res, spaceId, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { tags } = data;
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.items.setTags(spaceId, itemId, tags || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error setting tags', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to set tags', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/tags - Add tag to item
   */
  async handleAddItemTag(req, res, spaceId, itemId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { tag } = data;
      if (!tag) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing tag', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const tags = await api.items.addTag(spaceId, itemId, tag);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tags }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error adding tag', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to add tag', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * DELETE /api/spaces/:spaceId/items/:itemId/tags/:tagName - Remove tag
   */
  async handleRemoveItemTag(req, res, spaceId, itemId, tagName) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const tags = await api.items.removeTag(spaceId, itemId, tagName);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tags }));
    } catch (error) {
      log.error('spaces', 'Error removing tag', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to remove tag', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/spaces/:spaceId/tags - List all tags in space
   */
  async handleListSpaceTags(req, res, spaceId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const tags = await api.tags.list(spaceId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tags }));
    } catch (error) {
      log.error('spaces', 'Error listing space tags', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list tags', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/tags - List all tags across all spaces
   */
  async handleListAllTags(req, res, url) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const tags = await api.tags.listAll();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tags, total: tags.length }));
    } catch (error) {
      log.error('spaces', 'Error listing all tags', { error: error.message || error });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list tags', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/tags/search - Search items by tags
   */
  async handleSearchByTags(req, res, url) {
    try {
      const tags = url.searchParams.get('tags')?.split(',') || [];
      const matchAll = url.searchParams.get('matchAll') === 'true';
      const spaceId = url.searchParams.get('spaceId') || undefined;
      const { limit } = parseLimitOffset(url);
      if (tags.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing tags parameter', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const items = await api.tags.findItems(tags, { spaceId, matchAll, limit });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
    } catch (error) {
      log.error('spaces', 'Error searching by tags', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to search by tags', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // SEARCH HANDLERS
  // ============================================

  /**
   * GET /api/search - Quick Search (keyword-based)
   * 
   * Fast keyword search across spaces. Use `depth` to control thoroughness:
   *   - quick:    index only, no metadata files (fastest, good for typeahead)
   *   - standard: index + metadata (default)
   *   - thorough: index + metadata + full content from disk (slowest, most complete)
   */
  async handleSearch(req, res, url) {
    try {
      const query = url.searchParams.get('q');
      
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing q parameter', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      
      const { limit, offset } = parseLimitOffset(url);
      const depth = url.searchParams.get('depth') || 'standard';

      const options = {
        spaceId: url.searchParams.get('spaceId') || undefined,
        type: url.searchParams.get('type') || undefined,
        searchTags: url.searchParams.get('searchTags') !== 'false',
        searchMetadata: url.searchParams.get('searchMetadata') !== 'false',
        searchContent: url.searchParams.get('searchContent') === 'true',
        fuzzy: url.searchParams.get('fuzzy') !== 'false',
        fuzzyThreshold: url.searchParams.get('fuzzyThreshold') ? parseFloat(url.searchParams.get('fuzzyThreshold')) : undefined,
        includeHighlights: url.searchParams.get('includeHighlights') !== 'false',
        limit,
        offset
      };
      // Remove undefined keys so the API uses its defaults
      Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);

      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();

      let results;
      if (depth === 'quick') {
        results = await api.quickSearch(query, options);
      } else if (depth === 'thorough') {
        results = await api.deepSearch(query, options);
      } else {
        results = await api.search(query, options);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, total: results.length }));
    } catch (error) {
      log.error('spaces', 'Error in quick search', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to search', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/search/suggestions - Search suggestions / autocomplete
   */
  async handleSearchSuggestions(req, res, url) {
    try {
      const prefix = url.searchParams.get('prefix') || url.searchParams.get('q') || '';
      
      if (!prefix) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing prefix or q parameter', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      
      const { limit } = parseLimitOffset(url, { limit: 10 });
      
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const suggestions = await api.getSearchSuggestions(prefix, limit);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestions }));
    } catch (error) {
      log.error('spaces', 'Error getting search suggestions', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get suggestions', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/search/deep - Deep Search (LLM-powered semantic search)
   * 
   * Uses the GenerativeFilterEngine to evaluate items against semantic filters.
   * Items are scored by an LLM (GPT-5.2) and ranked by composite score.
   * 
   * Request body:
   * {
   *   "filters": [{ "id": "useful_for", "input": "Q1 presentation", "weight": 1.0, "threshold": 30 }],
   *   "spaceId": "work-project",     // optional: limit to one space
   *   "mode": "quick",               // "quick" | "balanced" | "thorough"
   *   "userQuery": "quarterly review", // optional natural-language context
   *   "limit": 20                     // optional max results
   * }
   */
  async handleDeepSearch(req, res) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    
    try {
      const data = JSON.parse(body);
      const { filters, spaceId, mode, userQuery, context, limit } = data;
      
      if (!filters || !Array.isArray(filters) || filters.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Missing or empty filters array. Use GET /api/search/deep/filters to discover available filters.',
          code: 'MISSING_REQUIRED_FIELD'
        }));
        return;
      }
      
      // Resolve API key from settings (same as internal IPC path)
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('openaiApiKey');
      
      if (!apiKey) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'OpenAI API key not configured. Add it in app Settings to enable Deep Search.',
          code: 'SERVICE_UNAVAILABLE'
        }));
        return;
      }
      
      // Get or create the engine (reuse singleton pattern from main.js)
      const { getSpacesAPI } = require('./spaces-api');
      const spacesAPI = getSpacesAPI();
      const { getGenerativeFilterEngine } = require('./lib/generative-search');
      const engine = getGenerativeFilterEngine(spacesAPI, {
        concurrency: 5,
        batchSize: 8
      });
      
      if (!engine) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Deep Search engine not available', code: 'SERVICE_UNAVAILABLE' }));
        return;
      }
      
      const searchOptions = { filters, apiKey };
      if (spaceId) searchOptions.spaceId = spaceId;
      if (mode) searchOptions.mode = mode;
      if (userQuery) searchOptions.userQuery = userQuery;
      if (context) searchOptions.context = context;
      if (limit) searchOptions.limit = limit;
      
      const results = await engine.search(searchOptions);
      
      const cost = engine.lastSearchCost || 0;
      const stats = engine.batchProcessor ? engine.batchProcessor.getStats() : {};
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        results: Array.isArray(results) ? results : (results.results || []),
        total: Array.isArray(results) ? results.length : (results.results || []).length,
        cost,
        stats
      }));
    } catch (error) {
      log.error('spaces', 'Error in deep search', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Deep Search failed: ' + error.message, code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/search/deep/filters - List available Deep Search filter types
   * 
   * Returns all filter types grouped by category so external tools can
   * discover what's available and build valid Deep Search requests.
   */
  async handleGetDeepSearchFilters(req, res) {
    try {
      const { FILTER_TYPES, FILTER_CATEGORIES } = require('./lib/generative-search');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        filterTypes: FILTER_TYPES,
        categories: FILTER_CATEGORIES
      }));
    } catch (error) {
      log.error('spaces', 'Error getting deep search filters', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get filter types', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // SMART FOLDERS HANDLERS
  // ============================================

  /**
   * GET /api/smart-folders - List smart folders
   */
  async handleListSmartFolders(req, res) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const folders = await api.smartFolders.list();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ folders }));
    } catch (error) {
      log.error('spaces', 'Error listing smart folders', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list smart folders', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/smart-folders - Create smart folder
   */
  async handleCreateSmartFolder(req, res) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      const { name, criteria, icon, color } = data;
      if (!name || !criteria) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing name or criteria', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const folder = await api.smartFolders.create(name, criteria, { icon, color });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, folder }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error creating smart folder', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create smart folder', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/smart-folders/:folderId - Get smart folder
   */
  async handleGetSmartFolder(req, res, folderId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const folder = await api.smartFolders.get(folderId);
      
      if (!folder) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Smart folder not found', code: 'NOT_FOUND' }));
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(folder));
    } catch (error) {
      log.error('spaces', 'Error getting smart folder', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get smart folder', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/smart-folders/:folderId - Update smart folder
   */
  async handleUpdateSmartFolder(req, res, folderId) {
    const body = await this.readRequestBody(req, res);
    if (body === null) return;
    try {
      const updates = JSON.parse(body);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const folder = await api.smartFolders.update(folderId, updates);
      if (!folder) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Smart folder not found', code: 'NOT_FOUND' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, folder }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }));
        return;
      }
      log.error('spaces', 'Error updating smart folder', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update smart folder', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * DELETE /api/smart-folders/:folderId - Delete smart folder
   */
  async handleDeleteSmartFolder(req, res, folderId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const success = await api.smartFolders.delete(folderId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    } catch (error) {
      log.error('spaces', 'Error deleting smart folder', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete smart folder', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/smart-folders/:folderId/items - Get smart folder items
   */
  async handleGetSmartFolderItems(req, res, folderId, url) {
    try {
      const { limit, offset } = parseLimitOffset(url);
      const options = { limit, offset, includeContent: url.searchParams.get('includeContent') === 'true' };
      Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const items = await api.smartFolders.getItems(folderId, options);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
    } catch (error) {
      log.error('spaces', 'Error getting smart folder items', { error: error.message || error })
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get smart folder items', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // WEBSOCKET HANDLERS
  // ============================================

  /**
   * Handle WebSocket upgrade requests
   */
  handleWebSocketUpgrade(req, socket, head) {
    log.info('spaces', 'WebSocket upgrade request')

    // Parse the WebSocket handshake
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    // Calculate accept key
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    // Send handshake response
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      ''
    ].join('\r\n');

    socket.write(responseHeaders);

    // Create WebSocket wrapper
    const ws = new WebSocketConnection(socket);
    this.wsConnections.add(ws);

    ws.on('message', (data) => this.handleWebSocketMessage(ws, data));
    ws.on('close', () => this.handleWebSocketClose(ws));
    ws.on('error', (error) => {
      log.error('spaces', 'WebSocket error', { error: error.message || error })
      this.handleWebSocketClose(ws);
    });

    log.info('spaces', 'WebSocket connection established')
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleWebSocketMessage(ws, data) {
    try {
      const message = JSON.parse(data);
      log.info('spaces', 'WebSocket message', { type: message.type })

      switch (message.type) {
        case 'auth':
          this.handleAuthMessage(ws, message);
          break;
        case 'tabs':
        case 'capture-result':
          this.handleExtensionResponse(message);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        default:
          log.info('spaces', 'Unknown message type', { type: message.type })
      }
    } catch (error) {
      log.error('spaces', 'Error parsing WebSocket message', { error: error.message || error })
    }
  }

  /**
   * Handle auth message from extension
   */
  handleAuthMessage(ws, message) {
    if (message.token === this.authToken) {
      ws.authenticated = true;
      this.extensionConnection = ws;
      ws.send(JSON.stringify({ type: 'auth-success' }));
      log.info('spaces', 'Extension authenticated successfully')
    } else { stringify: ws.send(JSON.stringify({ type: 'auth-failed', error: 'Invalid token' }));
      log.info('spaces', 'Extension authentication failed')
      ws.close();
    }
  }

  /**
   * Handle response from extension (tabs list, capture result)
   */
  handleExtensionResponse(message) {
    const { requestId } = message;
    
    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId);
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);

      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.data);
      }
    }
  }

  /**
   * Handle WebSocket close
   */
  handleWebSocketClose(ws) {
    this.wsConnections.delete(ws);
    
    if (this.extensionConnection === ws) {
      this.extensionConnection = null;
      log.info('spaces', 'Extension disconnected')
    }
  }

  /**
   * Send a request to the extension and wait for response
   */
  requestFromExtension(type, data, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.extensionConnection || !this.extensionConnection.authenticated) {
        reject(new Error('Extension not connected'));
        return;
      }

      const requestId = ++this.requestCounter;
      
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timeout: timeoutId });

      this.extensionConnection.send(JSON.stringify({
        type,
        requestId,
        ...data
      }));
    });
  }

  /**
   * Request tabs from extension (for use by Electron app)
   */
  async getTabs() {
    if (!this.isExtensionConnected()) {
      throw new Error('Extension not connected');
    }
    return this.requestFromExtension('get-tabs', {});
  }

  /**
   * Request tab capture from extension (for use by Electron app)
   */
  async captureTab(tabId) {
    if (!this.isExtensionConnected()) {
      throw new Error('Extension not connected');
    }
    return this.requestFromExtension('capture-tab', { tabId });
  }
}

/**
 * Simple WebSocket connection wrapper (no external dependencies)
 */
class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.authenticated = false;
    this.handlers = {};
    this.buffer = Buffer.alloc(0);

    socket.on('data', (data) => this.handleData(data));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (error) => this.emit('error', error));
  }

  on(event, handler) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(handler);
  }

  emit(event, data) {
    if (this.handlers[event]) {
      for (const handler of this.handlers[event]) {
        handler(data);
      }
    }
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      
      const opcode = firstByte & 0x0F;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7F;
      
      let offset = 2;
      
      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLength > MAX_WS_PAYLOAD) {
        this.buffer = Buffer.alloc(0);
        this.close();
        return;
      }

      const maskLength = isMasked ? 4 : 0;
      const totalLength = offset + maskLength + payloadLength;
      if (this.buffer.length < totalLength) return;
      
      let mask = null;
      if (isMasked) {
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      
      let payload = this.buffer.slice(offset, offset + payloadLength);
      
      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }
      
      this.buffer = this.buffer.slice(totalLength);
      
      // Handle different opcodes
      if (opcode === 0x01) { // Text frame
        this.emit('message', payload.toString('utf8'));
      } else if (opcode === 0x08) { // Close frame
        this.close();
        this.emit('close');
      } else if (opcode === 0x09) { // Ping
        this.sendPong(payload);
      }
    }
  }

  send(data) {
    if (this.socket.destroyed) return;
    
    const payload = Buffer.from(data, 'utf8');
    const frame = this.createFrame(payload, 0x01);
    this.socket.write(frame);
  }

  sendPong(payload) {
    const frame = this.createFrame(payload, 0x0A);
    this.socket.write(frame);
  }

  createFrame(payload, opcode) {
    const length = payload.length;
    let header;
    
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    
    return Buffer.concat([header, payload]);
  }

  close() {
    if (!this.socket.destroyed) {
      const closeFrame = this.createFrame(Buffer.alloc(0), 0x08);
      this.socket.write(closeFrame);
      this.socket.end();
    }
  }
}

// Export singleton instance
let serverInstance = null;

function getSpacesAPIServer() {
  if (!serverInstance) {
    serverInstance = new SpacesAPIServer();
  }
  return serverInstance;
}

module.exports = { SpacesAPIServer, getSpacesAPIServer };


