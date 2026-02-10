/**
 * GSX MCS Client
 * 
 * Connects to GSX/MCS servers for remote agent integration.
 * Uses WebSocket for real-time communication and HTTP for configuration.
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const EventEmitter = require('events');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

/**
 * MCS Client for connecting to remote GSX servers
 */
class GSXMCSClient extends EventEmitter {
  constructor(config) {
    super();
    
    this.id = config.id;
    this.name = config.name;
    this.wsUrl = config.url;
    this.httpUrl = config.configUrl || this.deriveHttpUrl(config.url);
    this.apiKey = config.apiKey;
    
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectIntervalMs = 3000;
    this.heartbeatInterval = null;
    
    this.agents = [];
  }
  
  /**
   * Derive HTTP URL from WebSocket URL
   */
  deriveHttpUrl(wsUrl) {
    try {
      const url = new URL(wsUrl);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '/api';
      return url.toString();
    } catch (e) {
      return null;
    }
  }
  
  /**
   * Connect to the MCS server
   */
  async connect() {
    if (this.connected || this.reconnecting) return;
    
    log.info('voice', '[MCSClient:${this.name}] Connecting to ...', { v0: this.wsUrl });
    
    try {
      this.ws = new WebSocket(this.wsUrl, {
        headers: this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {},
      });
      
      this.ws.on('open', () => {
        log.info('voice', '[MCSClient:${this.name}] Connected');
        this.connected = true;
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        
        // Start heartbeat
        this.startHeartbeat();
        
        // Register with server
        this.send({
          type: 'register',
          clientType: 'desktop-app',
          version: '1.0.0',
        });
        
        this.emit('connected');
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (e) {
          log.error('voice', '[MCSClient:${this.name}] Invalid message:', { arg0: e });
        }
      });
      
      this.ws.on('close', (code, reason) => {
        log.info('voice', '[MCSClient] Disconnected', { name: this.name, code, reason: reason?.toString() });
        this.connected = false;
        this.stopHeartbeat();
        this.emit('disconnected', { code, reason: reason?.toString() });
        
        // Attempt reconnection
        this.scheduleReconnect();
      });
      
      this.ws.on('error', (error) => {
        log.error('voice', '[MCSClient:${this.name}] WebSocket error:', { arg0: error.message });
        this.emit('error', error);
      });
      
    } catch (error) {
      log.error('voice', '[MCSClient:${this.name}] Connection failed:', { arg0: error });
      this.emit('error', error);
      this.scheduleReconnect();
    }
  }
  
  /**
   * Disconnect from the MCS server
   */
  disconnect() {
    this.reconnecting = false;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    this.connected = false;
    log.info('voice', '[MCSClient:${this.name}] Disconnected');
  }
  
  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        log.error('voice', '[MCSClient:${this.name}] Max reconnect attempts reached');
        this.emit('reconnect_failed');
      }
      return;
    }
    
    this.reconnecting = true;
    this.reconnectAttempts++;
    
    log.info('voice', '[MCSClient:${this.name}] Reconnecting in ms (attempt )', { v0: this.reconnectIntervalMs, v1: this.reconnectAttempts });
    
    setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, this.reconnectIntervalMs);
  }
  
  /**
   * Start heartbeat
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.connected) {
        this.send({ type: 'ping', timestamp: Date.now() });
      }
    }, 30000);
  }
  
  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * Send a message to the server
   */
  send(message) {
    if (!this.ws || !this.connected) {
      log.warn('voice', '[MCSClient:${this.name}] Not connected, cannot send');
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.error('voice', '[MCSClient:${this.name}] Send error:', { arg0: error });
      return false;
    }
  }
  
  /**
   * Handle incoming message
   */
  handleMessage(message) {
    switch (message.type) {
      case 'pong':
        // Heartbeat response
        break;
        
      case 'agents':
        // List of available agents
        this.agents = message.agents || [];
        log.info('voice', '[MCSClient:${this.name}] Received agents', { v0: this.agents.length });
        this.emit('agents', this.agents);
        break;
        
      case 'task_result':
        // Result from a task execution
        this.emit('task_result', message);
        break;
        
      case 'error':
        log.error('voice', '[MCSClient:${this.name}] Server error:', { arg0: message.error });
        this.emit('server_error', message);
        break;
        
      default:
        this.emit('message', message);
    }
  }
  
  /**
   * Fetch available agents via HTTP
   */
  async fetchAgents() {
    if (!this.httpUrl) {
      throw new Error('No HTTP URL configured');
    }
    
    log.info('voice', '[MCSClient:${this.name}] Fetching agents from /agents', { v0: this.httpUrl });
    
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.httpUrl}/agents`);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
        },
      };
      
      const req = lib.request(options, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            
            const json = JSON.parse(data);
            this.agents = json.agents || json || [];
            log.info('voice', '[MCSClient:${this.name}] Fetched agents', { v0: this.agents.length });
            resolve(this.agents);
          } catch (e) {
            reject(new Error('Failed to parse response'));
          }
        });
      });
      
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }
  
  /**
   * Send a task to a specific agent
   */
  async sendTask(agentId, task) {
    if (!this.connected) {
      throw new Error('Not connected to MCS server');
    }
    
    const taskMessage = {
      type: 'task',
      agentId,
      task: {
        id: task.id || `task-${Date.now()}`,
        content: task.content,
        metadata: task.metadata || {},
      },
    };
    
    log.info('voice', '[MCSClient:${this.name}] Sending task to agent', { v0: agentId });
    this.send(taskMessage);
    
    // Return a promise that resolves when we get the result
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('task_result', handler);
        reject(new Error('Task timeout'));
      }, 60000); // 60 second timeout
      
      const handler = (result) => {
        if (result.taskId === taskMessage.task.id) {
          clearTimeout(timeout);
          this.removeListener('task_result', handler);
          resolve(result);
        }
      };
      
      this.on('task_result', handler);
    });
  }
  
  /**
   * Get connection status
   */
  getStatus() {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      agents: this.agents,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

/**
 * MCS Client Manager
 * Manages multiple MCS connections
 */
class MCSClientManager {
  constructor() {
    this.clients = new Map();
  }
  
  /**
   * Add a client
   */
  addClient(config) {
    if (this.clients.has(config.id)) {
      log.warn('voice', '[MCSManager] Client already exists', { v0: config.id });
      return this.clients.get(config.id);
    }
    
    const client = new GSXMCSClient(config);
    this.clients.set(config.id, client);
    
    log.info('voice', '[MCSManager] Added client:', { v0: config.name });
    return client;
  }
  
  /**
   * Remove a client
   */
  removeClient(id) {
    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      this.clients.delete(id);
      log.info('voice', '[MCSManager] Removed client:', { v0: id });
    }
  }
  
  /**
   * Get a client
   */
  getClient(id) {
    return this.clients.get(id);
  }
  
  /**
   * Get all clients
   */
  getAllClients() {
    return Array.from(this.clients.values());
  }
  
  /**
   * Connect all enabled clients
   */
  async connectAll() {
    const promises = [];
    for (const client of this.clients.values()) {
      promises.push(client.connect());
    }
    await Promise.allSettled(promises);
  }
  
  /**
   * Disconnect all clients
   */
  disconnectAll() {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
  }
  
  /**
   * Get all agents from all connected clients
   */
  getAllAgents() {
    const agents = [];
    for (const client of this.clients.values()) {
      if (client.connected) {
        for (const agent of client.agents) {
          agents.push({
            ...agent,
            connectionId: client.id,
            connectionName: client.name,
          });
        }
      }
    }
    return agents;
  }
}

// Singleton instance
let managerInstance = null;

function getMCSManager() {
  if (!managerInstance) {
    managerInstance = new MCSClientManager();
  }
  return managerInstance;
}

module.exports = {
  GSXMCSClient,
  MCSClientManager,
  getMCSManager,
};
