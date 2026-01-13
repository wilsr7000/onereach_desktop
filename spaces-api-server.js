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

const PORT = 47291;

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
    console.log('[SpacesAPI] Auth token loaded');

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleHTTPRequest(req, res));

    // Handle WebSocket upgrade
    this.server.on('upgrade', (req, socket, head) => this.handleWebSocketUpgrade(req, socket, head));

    // Start listening
    return new Promise((resolve, reject) => {
      this.server.listen(PORT, '127.0.0.1', () => {
        console.log(`[SpacesAPI] Server running on http://127.0.0.1:${PORT}`);
        resolve();
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[SpacesAPI] Port ${PORT} is already in use`);
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
      console.log('[SpacesAPI] Server stopped');
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
      console.error('[SpacesAPI] Error loading token:', error);
    }

    // Generate new token
    const token = crypto.randomBytes(32).toString('hex');
    
    try {
      fs.writeFileSync(tokenPath, JSON.stringify({ 
        token, 
        createdAt: new Date().toISOString() 
      }), 'utf8');
    } catch (error) {
      console.error('[SpacesAPI] Error saving token:', error);
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

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;
    const method = req.method;
    
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
    
    // Dynamic routes - parse path segments
    const pathParts = pathname.split('/').filter(Boolean);
    
    // /api/smart-folders/:folderId
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'smart-folders') {
      const folderId = pathParts[2];
      if (method === 'GET') return this.handleGetSmartFolder(req, res, folderId);
      if (method === 'PUT') return this.handleUpdateSmartFolder(req, res, folderId);
      if (method === 'DELETE') return this.handleDeleteSmartFolder(req, res, folderId);
    }
    
    // /api/smart-folders/:folderId/items
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'smart-folders' && pathParts[3] === 'items') {
      const folderId = pathParts[2];
      if (method === 'GET') return this.handleGetSmartFolderItems(req, res, folderId, url);
    }
    
    // /api/spaces/:spaceId
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'spaces') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleGetSpace(req, res, spaceId);
      if (method === 'PUT') return this.handleUpdateSpace(req, res, spaceId);
      if (method === 'DELETE') return this.handleDeleteSpace(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleListItems(req, res, spaceId, url);
    }
    
    // /api/spaces/:spaceId/tags
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleListSpaceTags(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/items/:itemId
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (method === 'GET') return this.handleGetItem(req, res, spaceId, itemId);
      if (method === 'PUT') return this.handleUpdateItem(req, res, spaceId, itemId);
      if (method === 'DELETE') return this.handleDeleteItem(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/tags
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (method === 'GET') return this.handleGetItemTags(req, res, spaceId, itemId);
      if (method === 'PUT') return this.handleSetItemTags(req, res, spaceId, itemId);
      if (method === 'POST') return this.handleAddItemTag(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/tags/:tagName
    if (pathParts.length === 7 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'tags') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      const tagName = decodeURIComponent(pathParts[6]);
      if (method === 'DELETE') return this.handleRemoveItemTag(req, res, spaceId, itemId, tagName);
    }
    
    // /api/spaces/:spaceId/items/:itemId/move
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'move') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (method === 'POST') return this.handleMoveItem(req, res, spaceId, itemId);
    }
    
    // /api/spaces/:spaceId/items/:itemId/pin
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'items' && pathParts[5] === 'pin') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemId = decodeURIComponent(pathParts[4]);
      if (method === 'POST') return this.handleTogglePin(req, res, spaceId, itemId);
    }
    
    // ============================================
    // METADATA ROUTES
    // ============================================
    
    // /api/spaces/:spaceId/metadata
    if (pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleGetSpaceMetadata(req, res, spaceId);
      if (method === 'PUT') return this.handleUpdateSpaceMetadata(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/metadata/files/:filePath (filePath can contain slashes, so handle specially)
    if (pathParts.length >= 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'files') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const filePath = pathParts.slice(5).map(decodeURIComponent).join('/');
      if (method === 'GET') return this.handleGetFileMetadata(req, res, spaceId, filePath);
      if (method === 'PUT') return this.handleSetFileMetadata(req, res, spaceId, filePath);
    }
    
    // /api/spaces/:spaceId/metadata/assets/:assetType
    if (pathParts.length === 6 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'assets') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const assetType = decodeURIComponent(pathParts[5]);
      if (method === 'GET') return this.handleGetAssetMetadata(req, res, spaceId, assetType);
      if (method === 'PUT') return this.handleSetAssetMetadata(req, res, spaceId, assetType);
    }
    
    // /api/spaces/:spaceId/metadata/approvals/:itemType/:itemId
    if (pathParts.length === 7 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'approvals') {
      const spaceId = decodeURIComponent(pathParts[2]);
      const itemType = decodeURIComponent(pathParts[5]);
      const itemId = decodeURIComponent(pathParts[6]);
      if (method === 'PUT') return this.handleSetApproval(req, res, spaceId, itemType, itemId);
    }
    
    // /api/spaces/:spaceId/metadata/versions
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'versions') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (method === 'POST') return this.handleAddVersion(req, res, spaceId);
      if (method === 'GET') return this.handleGetVersions(req, res, spaceId);
    }
    
    // /api/spaces/:spaceId/metadata/project-config
    if (pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'spaces' && pathParts[3] === 'metadata' && pathParts[4] === 'project-config') {
      const spaceId = decodeURIComponent(pathParts[2]);
      if (method === 'GET') return this.handleGetProjectConfig(req, res, spaceId);
      if (method === 'PUT') return this.handleUpdateProjectConfig(req, res, spaceId);
    }
    
    // Debug logging for unmatched routes
    console.log('[SpacesAPI] Unmatched route:', {
      pathname,
      method,
      pathParts,
      pathPartsLength: pathParts.length
    });
    
    // 404 - Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
  }

  /**
   * GET /api/status - Health check and extension status
   */
  handleStatus(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: app.getVersion(),
      extensionConnected: this.isExtensionConnected(),
      port: PORT
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
      console.error('[SpacesAPIServer] Reload error:', error);
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
      console.error('[SpacesAPIServer] Database status error:', error);
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
      console.error('[SpacesAPIServer] Database rebuild error:', error);
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
      console.error('[SpacesAPI] Error getting spaces:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get spaces' }));
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
    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { spaceId, content, type, title, sourceUrl, tags, metadata } = data;

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'spaces-api-server.js:handleSendToSpace:entry',message:'Request received',data:{spaceId,type,hasTags:!!tags,tagsValue:tags,hasMetadataTags:!!metadata?.tags,metadataTagsValue:metadata?.tags},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
        // #endregion

        if (!spaceId || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing spaceId or content' }));
          return;
        }

        // Validate content is not empty
        if (typeof content === 'string' && content.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Content cannot be empty' }));
          return;
        }

        // Extract tags from either root level or metadata.tags
        const itemTags = tags || metadata?.tags || [];

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'spaces-api-server.js:handleSendToSpace:tagsExtracted',message:'Tags extracted',data:{itemTags,tagsLength:itemTags.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
        // #endregion

        // Route through clipboardManager for proper sync
        if (global.clipboardManager) {
          const item = {
            type: type || 'text',
            content: content,
            preview: title || (type === 'image' ? 'Image from browser' : content.substring(0, 50)),
            source: sourceUrl ? `browser:${sourceUrl}` : 'browser-extension',
            metadata: {
              ...(metadata || {}),
              sourceUrl: sourceUrl || metadata?.sourceUrl,
              title: title || metadata?.title
            },
            tags: itemTags,
            spaceId: spaceId,
            timestamp: Date.now()
          };

          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'spaces-api-server.js:handleSendToSpace:itemCreated',message:'Item object created before addToHistory',data:{itemTags:item.tags,itemType:item.type,itemSpaceId:item.spaceId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion

          // Use addToHistory for proper in-memory sync and space metadata updates
          await global.clipboardManager.addToHistory(item);
          
          // Get the newly added item's ID
          const addedItem = global.clipboardManager.history?.[0];
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, itemId: addedItem?.id || 'unknown' }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Clipboard manager not available' }));
        }
      } catch (error) {
        console.error('[SpacesAPI] Error sending to space:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to send to space' }));
      }
    });
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
      console.error('[SpacesAPI] Error getting tabs:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
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

    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { tabId } = JSON.parse(body);

        if (!tabId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing tabId' }));
          return;
        }

        const capture = await this.requestFromExtension('capture-tab', { tabId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(capture));
      } catch (error) {
        console.error('[SpacesAPI] Error capturing tab:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
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
      res.end(JSON.stringify(space));
    } catch (error) {
      console.error('[SpacesAPI] Error getting space:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get space', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces - Create new space
   */
  async handleCreateSpace(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error creating space:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create space', code: 'SERVER_ERROR' }));
      }
    });
  }

  /**
   * PUT /api/spaces/:spaceId - Update space
   */
  async handleUpdateSpace(req, res, spaceId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const success = await api.update(spaceId, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (error) {
        console.error('[SpacesAPI] Error updating space:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to update space', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error deleting space:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete space', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // ITEMS CRUD HANDLERS
  // ============================================

  /**
   * GET /api/spaces/:spaceId/items - List items
   */
  async handleListItems(req, res, spaceId, url) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      
      const options = {
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')) : undefined,
        type: url.searchParams.get('type') || undefined,
        pinned: url.searchParams.has('pinned') ? url.searchParams.get('pinned') === 'true' : undefined,
        tags: url.searchParams.get('tags') ? url.searchParams.get('tags').split(',') : undefined,
        includeContent: url.searchParams.get('includeContent') === 'true'
      };
      
      // Remove undefined values
      Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);
      
      const items = await api.items.list(spaceId, options);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
    } catch (error) {
      console.error('[SpacesAPI] Error listing items:', error);
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
      console.error('[SpacesAPI] Error getting item:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/items/:itemId - Update item
   */
  async handleUpdateItem(req, res, spaceId, itemId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const success = await api.items.update(spaceId, itemId, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (error) {
        console.error('[SpacesAPI] Error updating item:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to update item', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error deleting item:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete item', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/move - Move item
   */
  async handleMoveItem(req, res, spaceId, itemId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error moving item:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to move item', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error toggling pin:', error);
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
      console.error('[SpacesAPI] Error getting space metadata:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get space metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata - Update space metadata
   */
  async handleUpdateSpaceMetadata(req, res, spaceId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error updating space metadata:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to update space metadata', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error getting file metadata:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get file metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/files/:filePath - Set file metadata
   */
  async handleSetFileMetadata(req, res, spaceId, filePath) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const result = await api.metadata.setFile(spaceId, filePath, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, metadata: result }));
      } catch (error) {
        console.error('[SpacesAPI] Error setting file metadata:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to set file metadata', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error getting asset metadata:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get asset metadata', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/assets/:assetType - Set asset metadata
   */
  async handleSetAssetMetadata(req, res, spaceId, assetType) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const result = await api.metadata.setAsset(spaceId, assetType, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, metadata: result }));
      } catch (error) {
        console.error('[SpacesAPI] Error setting asset metadata:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to set asset metadata', code: 'SERVER_ERROR' }));
      }
    });
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/approvals/:itemType/:itemId - Set approval status
   */
  async handleSetApproval(req, res, spaceId, itemType, itemId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error setting approval:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to set approval', code: 'SERVER_ERROR' }));
      }
    });
  }

  /**
   * GET /api/spaces/:spaceId/metadata/versions - Get version history
   */
  async handleGetVersions(req, res, spaceId) {
    try {
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const spaceMetadata = await api.metadata.getSpace(spaceId);
      const versions = spaceMetadata?.versions || [];
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ versions }));
    } catch (error) {
      console.error('[SpacesAPI] Error getting versions:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get versions', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/spaces/:spaceId/metadata/versions - Add a version
   */
  async handleAddVersion(req, res, spaceId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const versionData = JSON.parse(body);
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const result = await api.metadata.addVersion(spaceId, versionData);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, metadata: result }));
      } catch (error) {
        console.error('[SpacesAPI] Error adding version:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to add version', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error getting project config:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get project config', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/metadata/project-config - Update project configuration
   */
  async handleUpdateProjectConfig(req, res, spaceId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const config = JSON.parse(body);
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const result = await api.metadata.updateProjectConfig(spaceId, config);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, metadata: result }));
      } catch (error) {
        console.error('[SpacesAPI] Error updating project config:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to update project config', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error getting tags:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get tags', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/spaces/:spaceId/items/:itemId/tags - Set item tags
   */
  async handleSetItemTags(req, res, spaceId, itemId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { tags } = data;
        
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const success = await api.items.setTags(spaceId, itemId, tags || []);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (error) {
        console.error('[SpacesAPI] Error setting tags:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to set tags', code: 'SERVER_ERROR' }));
      }
    });
  }

  /**
   * POST /api/spaces/:spaceId/items/:itemId/tags - Add tag to item
   */
  async handleAddItemTag(req, res, spaceId, itemId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error adding tag:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to add tag', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error removing tag:', error);
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
      console.error('[SpacesAPI] Error listing space tags:', error);
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
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')) : undefined;
      
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
      console.error('[SpacesAPI] Error searching by tags:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to search by tags', code: 'SERVER_ERROR' }));
    }
  }

  // ============================================
  // SEARCH HANDLER
  // ============================================

  /**
   * GET /api/search - Search across spaces
   */
  async handleSearch(req, res, url) {
    try {
      const query = url.searchParams.get('q');
      
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing q parameter', code: 'MISSING_REQUIRED_FIELD' }));
        return;
      }
      
      const options = {
        spaceId: url.searchParams.get('spaceId') || undefined,
        type: url.searchParams.get('type') || undefined,
        searchTags: url.searchParams.get('searchTags') !== 'false',
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')) : undefined
      };
      
      // Remove undefined values
      Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);
      
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const results = await api.search(query, options);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, total: results.length }));
    } catch (error) {
      console.error('[SpacesAPI] Error searching:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to search', code: 'SERVER_ERROR' }));
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
      console.error('[SpacesAPI] Error listing smart folders:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list smart folders', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * POST /api/smart-folders - Create smart folder
   */
  async handleCreateSmartFolder(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error creating smart folder:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create smart folder', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error getting smart folder:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get smart folder', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * PUT /api/smart-folders/:folderId - Update smart folder
   */
  async handleUpdateSmartFolder(req, res, folderId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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
        console.error('[SpacesAPI] Error updating smart folder:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to update smart folder', code: 'SERVER_ERROR' }));
      }
    });
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
      console.error('[SpacesAPI] Error deleting smart folder:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete smart folder', code: 'SERVER_ERROR' }));
    }
  }

  /**
   * GET /api/smart-folders/:folderId/items - Get smart folder items
   */
  async handleGetSmartFolderItems(req, res, folderId, url) {
    try {
      const options = {
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')) : undefined,
        includeContent: url.searchParams.get('includeContent') === 'true'
      };
      
      Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);
      
      const { getSpacesAPI } = require('./spaces-api');
      const api = getSpacesAPI();
      const items = await api.smartFolders.getItems(folderId, options);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
    } catch (error) {
      console.error('[SpacesAPI] Error getting smart folder items:', error);
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
    console.log('[SpacesAPI] WebSocket upgrade request');

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
      console.error('[SpacesAPI] WebSocket error:', error);
      this.handleWebSocketClose(ws);
    });

    console.log('[SpacesAPI] WebSocket connection established');
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleWebSocketMessage(ws, data) {
    try {
      const message = JSON.parse(data);
      console.log('[SpacesAPI] WebSocket message:', message.type);

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
          console.log('[SpacesAPI] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[SpacesAPI] Error parsing WebSocket message:', error);
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
      console.log('[SpacesAPI] Extension authenticated successfully');
    } else {
      ws.send(JSON.stringify({ type: 'auth-failed', error: 'Invalid token' }));
      console.log('[SpacesAPI] Extension authentication failed');
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
      console.log('[SpacesAPI] Extension disconnected');
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


