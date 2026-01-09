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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    
    // Route handlers
    switch (url.pathname) {
      case '/api/status':
        this.handleStatus(req, res);
        break;
      case '/api/spaces':
        this.handleGetSpaces(req, res);
        break;
      case '/api/send-to-space':
        this.handleSendToSpace(req, res);
        break;
      case '/api/tabs':
        this.handleGetTabs(req, res);
        break;
      case '/api/capture-tab':
        this.handleCaptureTab(req, res);
        break;
      case '/api/token':
        this.handleGetToken(req, res);
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
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
      // Get spaces from clipboard manager
      if (global.clipboardManager && global.clipboardManager.storage) {
        const spaces = await global.clipboardManager.storage.getSpaces();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ spaces }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ spaces: [] }));
      }
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
   */
  async handleSendToSpace(req, res) {
    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { spaceId, content, type, title, sourceUrl } = data;

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

        // Route through clipboardManager for proper sync
        if (global.clipboardManager) {
          const item = {
            type: type || 'text',
            content: content,
            preview: title || (type === 'image' ? 'Image from browser' : content.substring(0, 50)),
            source: sourceUrl ? `browser:${sourceUrl}` : 'browser-extension',
            metadata: sourceUrl ? { sourceUrl } : undefined,
            spaceId: spaceId,
            timestamp: Date.now()
          };

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


