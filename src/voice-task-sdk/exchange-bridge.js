/**
 * Exchange Bridge - Connects Voice Task SDK to the Auction Exchange
 * 
 * This module bridges the existing voice SDK IPC interface to the new
 * auction-based task exchange system.
 */

const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Exchange and agent imports (compiled from TypeScript)
let Exchange = null;
let WebSocketTransport = null;
let MemoryStorage = null;
let exchangeInstance = null;
let transportInstance = null;
let isExchangeRunning = false;
let localAgentConnections = new Map(); // agentId -> WebSocket

/**
 * Default exchange configuration
 */
const DEFAULT_EXCHANGE_CONFIG = {
  port: 3456, // Different from default 3000 to avoid conflicts
  transport: 'websocket',
  storage: 'memory',
  
  categories: [
    { name: 'spelling', keywords: ['spell', 'spelling', 'spelled', 'spelt', 'letters'] },
    { name: 'search', keywords: ['search', 'find', 'look', 'where', 'locate'] },
    { name: 'file', keywords: ['open', 'save', 'create', 'delete', 'file', 'folder'] },
    { name: 'media', keywords: ['play', 'pause', 'stop', 'volume', 'video', 'audio'] },
    { name: 'system', keywords: ['time', 'date', 'weather', 'battery', 'settings'] },
    { name: 'math', keywords: ['calculate', 'math', 'add', 'subtract', 'multiply', 'divide', 'plus', 'minus'] },
  ],
  
  auction: {
    defaultWindowMs: 500,    // Fast for voice
    minWindowMs: 100,
    maxWindowMs: 2000,
    instantWinThreshold: 0.9,
    dominanceMargin: 0.3,
    maxAuctionAttempts: 2,   // Quick retry
    executionTimeoutMs: 10000, // 10s for voice tasks
  },
  
  marketMaker: {
    enabled: true,
    agentId: 'fallback-agent',
    confidence: 0.1,
  },
  
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 60000,
};

/**
 * Connect local agents from agent-store to the exchange
 */
async function connectLocalAgents(port) {
  try {
    // Load agents from agent-store
    const { getAgentStore } = require('./agent-store');
    const agentStore = getAgentStore();
    
    if (!agentStore || !agentStore.initialized) {
      console.log('[ExchangeBridge] Agent store not ready, skipping local agents');
      return;
    }
    
    const agents = agentStore.getAll();
    console.log(`[ExchangeBridge] Found ${agents.length} local agents to connect`);
    
    for (const agent of agents) {
      if (!agent.enabled) continue;
      
      try {
        await connectLocalAgent(agent, port);
      } catch (error) {
        console.error(`[ExchangeBridge] Failed to connect agent ${agent.name}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[ExchangeBridge] Failed to load local agents:', error.message);
  }
}

/**
 * Connect a single local agent to the exchange
 */
async function connectLocalAgent(agent, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('open', () => {
      console.log(`[ExchangeBridge] Local agent connecting: ${agent.name}`);
      
      // Register with exchange
      ws.send(JSON.stringify({
        type: 'register',
        agentId: agent.id,
        agentVersion: agent.version || '1.0.0',
        categories: agent.categories || ['general'],
        capabilities: {
          keywords: agent.keywords || [],
          executionType: agent.executionType || 'llm',
        },
      }));
      
      localAgentConnections.set(agent.id, { ws, agent });
      console.log(`[ExchangeBridge] Local agent registered: ${agent.name}`);
      resolve();
    });
    
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'task:request') {
          // Exchange is asking us to bid
          const confidence = calculateConfidence(agent, msg.task);
          if (confidence > 0.1) {
            ws.send(JSON.stringify({
              type: 'bid',
              taskId: msg.task.id,
              confidence: confidence,
              estimatedDurationMs: 5000,
            }));
            console.log(`[ExchangeBridge] Agent ${agent.name} bid ${confidence.toFixed(2)} on task`);
          }
        } else if (msg.type === 'task:assigned') {
          // We won! Execute the task
          console.log(`[ExchangeBridge] Agent ${agent.name} executing task: ${msg.task.content}`);
          const result = await executeLocalAgent(agent, msg.task);
          ws.send(JSON.stringify({
            type: 'task:result',
            taskId: msg.task.id,
            ...result,
          }));
        }
      } catch (error) {
        console.error(`[ExchangeBridge] Local agent message error:`, error.message);
      }
    });
    
    ws.on('error', (error) => {
      console.error(`[ExchangeBridge] Local agent WebSocket error:`, error.message);
      reject(error);
    });
    
    ws.on('close', () => {
      console.log(`[ExchangeBridge] Local agent disconnected: ${agent.name}`);
      localAgentConnections.delete(agent.id);
    });
    
    // Timeout for connection
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Connection timeout'));
      }
    }, 5000);
  });
}

/**
 * Calculate confidence that an agent can handle a task
 */
function calculateConfidence(agent, task) {
  const content = (task.content || '').toLowerCase();
  const keywords = agent.keywords || [];
  
  let matches = 0;
  for (const keyword of keywords) {
    if (content.includes(keyword.toLowerCase())) {
      matches++;
    }
  }
  
  if (matches === 0) return 0;
  
  // Base confidence from keyword matches
  const confidence = Math.min(0.9, 0.5 + (matches * 0.15));
  return confidence;
}

/**
 * Execute a local agent's task
 */
async function executeLocalAgent(agent, task) {
  const executionType = agent.executionType || 'llm';
  const content = task.content || '';
  
  try {
    if (executionType === 'applescript') {
      // Use Claude to generate AppleScript based on agent prompt and task
      const claudeCode = require('../../lib/claude-code-runner');
      const prompt = `${agent.prompt}\n\nUser command: "${content}"\n\nGenerate and return ONLY the AppleScript code to execute. No explanation.`;
      
      const response = await claudeCode.complete(prompt);
      
      // Extract AppleScript from response
      let script = response;
      const codeMatch = response.match(/```(?:applescript)?\n?([\s\S]*?)```/);
      if (codeMatch) {
        script = codeMatch[1].trim();
      }
      
      // Execute the AppleScript
      const escapedScript = script.replace(/'/g, "'\"'\"'");
      const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 10000 });
      
      return {
        success: true,
        result: stdout || 'Command executed',
      };
    } else if (executionType === 'shell') {
      // Generate and execute shell command
      const claudeCode = require('../../lib/claude-code-runner');
      const prompt = `${agent.prompt}\n\nUser command: "${content}"\n\nGenerate and return ONLY the shell command to execute. No explanation.`;
      
      const response = await claudeCode.complete(prompt);
      let command = response;
      const codeMatch = response.match(/```(?:bash|sh)?\n?([\s\S]*?)```/);
      if (codeMatch) {
        command = codeMatch[1].trim();
      }
      
      const { stdout } = await execAsync(command, { timeout: 10000 });
      return {
        success: true,
        result: stdout || 'Command executed',
      };
    } else {
      // LLM/conversational - just use Claude to respond
      const claudeCode = require('../../lib/claude-code-runner');
      const prompt = `${agent.prompt}\n\nUser: ${content}`;
      const response = await claudeCode.complete(prompt);
      
      return {
        success: true,
        result: response,
      };
    }
  } catch (error) {
    console.error(`[ExchangeBridge] Agent execution error:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Broadcast message to all windows
 */
function broadcastToWindows(channel, data) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}

/**
 * Initialize the exchange bridge
 */
async function initializeExchangeBridge(config = {}) {
  console.log('[ExchangeBridge] Initializing...');
  
  // Try to load the compiled exchange package
  try {
    const exchangePkg = require('../../packages/task-exchange/dist/index.js');
    Exchange = exchangePkg.Exchange;
    WebSocketTransport = exchangePkg.WebSocketTransport;
    MemoryStorage = exchangePkg.MemoryStorage;
    console.log('[ExchangeBridge] Loaded task-exchange package');
  } catch (error) {
    console.error('[ExchangeBridge] Failed to load task-exchange:', error.message);
    console.log('[ExchangeBridge] Make sure to run: cd packages/task-exchange && npm run build');
    return false;
  }
  
  const mergedConfig = { ...DEFAULT_EXCHANGE_CONFIG, ...config };
  
  try {
    // Create storage
    const storage = new MemoryStorage();
    
    // Create exchange
    exchangeInstance = new Exchange(mergedConfig, storage);
    
    // Create transport
    transportInstance = new WebSocketTransport(exchangeInstance, {
      port: mergedConfig.port,
      heartbeatIntervalMs: mergedConfig.heartbeatIntervalMs,
      heartbeatTimeoutMs: mergedConfig.heartbeatTimeoutMs,
    });
    
    // Wire up exchange events to HUD
    setupExchangeEvents();
    
    // Start transport and exchange
    await transportInstance.start();
    await exchangeInstance.start();
    
    isExchangeRunning = true;
    console.log(`[ExchangeBridge] Exchange running on port ${mergedConfig.port}`);
    
    // Register IPC handlers
    setupExchangeIPC();
    
    // Connect local agents from agent-store
    await connectLocalAgents(mergedConfig.port);
    
    return true;
  } catch (error) {
    console.error('[ExchangeBridge] Failed to start exchange:', error);
    return false;
  }
}

/**
 * Setup exchange event listeners
 */
function setupExchangeEvents() {
  if (!exchangeInstance) return;
  
  // Task queued - show HUD
  exchangeInstance.on('task:queued', ({ task }) => {
    console.log('[ExchangeBridge] Task queued:', task.id);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing',
        status: 'queued',
        confidence: 0,
      });
    }
    
    broadcastToWindows('voice-task:queued', {
      taskId: task.id,
      content: task.content,
      status: 'queued',
    });
  });
  
  // Auction started
  exchangeInstance.on('auction:started', ({ task, auctionId }) => {
    console.log('[ExchangeBridge] Auction started:', auctionId);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Finding agent...',
        status: 'running',
      });
    }
  });
  
  // No bids received - task halted
  exchangeInstance.on('exchange:halt', ({ task, reason }) => {
    console.warn('[ExchangeBridge] Exchange halted:', reason);
    
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: false,
        error: 'No agents available to handle this request',
        message: 'No matching agents found. Try a different command.',
      });
    }
  });
  
  // Task assigned to winner
  exchangeInstance.on('task:assigned', ({ task, winner, backups }) => {
    console.log('[ExchangeBridge] Task assigned to:', winner.agentId);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: `${winner.agentId} executing`,
        status: 'running',
        confidence: winner.confidence,
      });
    }
    
    // Speak immediate confirmation
    if (global.speakFeedback) {
      global.speakFeedback('On it');
    }
    
    broadcastToWindows('voice-task:assigned', {
      taskId: task.id,
      agentId: winner.agentId,
      confidence: winner.confidence,
      backupCount: backups.length,
    });
  });
  
  // Task completed successfully
  exchangeInstance.on('task:settled', ({ task, result, agentId }) => {
    console.log('[ExchangeBridge] Task settled by:', agentId);
    
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: true,
        message: result.data?.message || 'Task completed',
        data: result.data,
      });
    }
    
    // Speak the result if it has a message (with slight delay to avoid cutting off confirmation)
    if (result.data?.message && global.speakFeedback) {
      // Wait a moment for "On it" to finish before speaking the result
      setTimeout(() => {
        global.speakFeedback(result.data.message);
      }, 1500);
    } else if (result.success && global.speakFeedback) {
      // For actions without a specific message, confirm completion
      setTimeout(() => {
        global.speakFeedback('Done');
      }, 1500);
    }
    
    broadcastToWindows('voice-task:completed', {
      taskId: task.id,
      agentId,
      result,
    });
  });
  
  // Task failed, trying backup
  exchangeInstance.on('task:busted', ({ task, agentId, error, backupsRemaining }) => {
    console.log('[ExchangeBridge] Task busted, backups remaining:', backupsRemaining);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: backupsRemaining > 0 ? 'Trying backup agent...' : 'All agents failed',
        status: 'running',
      });
    }
  });
  
  // Task dead-lettered (all retries exhausted)
  exchangeInstance.on('task:dead_letter', ({ task, reason }) => {
    console.error('[ExchangeBridge] Task dead-lettered:', reason);
    
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: false,
        error: reason,
        message: 'Could not complete request',
      });
    }
    
    broadcastToWindows('voice-task:failed', {
      taskId: task.id,
      reason,
    });
  });
  
  // Agent connected
  exchangeInstance.on('agent:connected', ({ agent }) => {
    console.log('[ExchangeBridge] Agent connected:', agent.id);
    broadcastToWindows('voice-task:agent-connected', { agent });
  });
  
  // Agent disconnected
  exchangeInstance.on('agent:disconnected', ({ agentId, reason }) => {
    console.log('[ExchangeBridge] Agent disconnected:', agentId, reason);
    broadcastToWindows('voice-task:agent-disconnected', { agentId, reason });
  });
  
  // Agent flagged for review
  exchangeInstance.on('agent:flagged', ({ agentId, reputation }) => {
    console.warn('[ExchangeBridge] Agent flagged:', agentId, reputation.score);
  });
}

/**
 * Setup IPC handlers for the exchange
 */
function setupExchangeIPC() {
  // Remove existing handlers that we're going to override
  const handlersToOverride = [
    'voice-task-sdk:submit',
    'voice-task-sdk:exchange-status',
    'voice-task-sdk:list-agents',
    'voice-task-sdk:reputation-summary',
  ];
  
  for (const handler of handlersToOverride) {
    try {
      ipcMain.removeHandler(handler);
    } catch (e) {
      // Handler may not exist, that's fine
    }
  }
  
  ipcMain.handle('voice-task-sdk:submit', async (_event, transcript, options = {}) => {
    console.log('[ExchangeBridge] Submit transcript:', transcript);
    
    // ==================== SPECIAL COMMAND HANDLING ====================
    // Handle commands that open windows directly (don't need the exchange)
    const text = transcript?.toLowerCase() || '';
    
    // Check for "open/launch agent composer" commands
    if (text.includes('open') || text.includes('launch') || text.includes('start')) {
      const match = text.match(/(?:open|launch|start)\s+(?:the\s+)?(.+)/i);
      const target = match ? match[1].trim().toLowerCase() : '';
      
      if (target.includes('agent composer') || target.includes('composer') || target.includes('gsx create')) {
        console.log('[ExchangeBridge] Opening Agent Composer window');
        
        // Cancel any AI response
        try {
          const { getRealtimeSpeech } = require('../../realtime-speech');
          getRealtimeSpeech().cancelResponse();
        } catch (e) {}
        
        try {
          const main = require('../../main');
          if (main.createClaudeCodeWindow) {
            main.createClaudeCodeWindow();
          }
        } catch (e) {
          console.error('[ExchangeBridge] Could not open Agent Composer:', e);
        }
        
        return {
          transcript,
          queued: false,
          handled: true,
          classified: true,
          action: 'open-agent-composer',
          message: 'Opening Agent Composer window',
          suppressAIResponse: true,
        };
      }
      
      if (target.includes('agent manager') || target === 'agents') {
        console.log('[ExchangeBridge] Opening Agent Manager window');
        try {
          const main = require('../../main');
          if (main.createAgentManagerWindow) {
            main.createAgentManagerWindow();
          }
        } catch (e) {
          console.error('[ExchangeBridge] Could not open Agent Manager:', e);
        }
        
        return {
          transcript,
          queued: false,
          handled: true,
          classified: true,
          action: 'open-agent-manager',
          message: 'Opening Agent Manager window',
        };
      }
    }
    
    // Check for "create agent" commands  
    if ((text.includes('create') || text.includes('make') || text.includes('new')) &&
        (text.includes('agent') || text.includes('assistant') || text.includes('bot'))) {
      
      // Extract the description - what comes after "agent/assistant/bot" or "to/that/for"
      const descMatch = transcript.match(/(?:agent|assistant|bot)\s*(?:that\s+|to\s+|for\s+|which\s+)?(.+)/i);
      const description = descMatch ? descMatch[1].trim() : '';
      
      console.log('[ExchangeBridge] Opening Agent Composer for new agent, description:', description);
      
      // Cancel any AI response since we're handling this locally
      const { getRealtimeSpeech } = require('../../realtime-speech');
      const realtimeSpeech = getRealtimeSpeech();
      
      try {
        realtimeSpeech.cancelResponse();
      } catch (e) {
        console.warn('[ExchangeBridge] Could not cancel AI response:', e);
      }
      
      // IMMEDIATE ACKNOWLEDGMENT - speak before opening window
      try {
        const ack = description 
          ? `Got it, I'll help you build an agent for ${description}. Let me think about the best approach.`
          : `Got it, let me help you create a new agent.`;
        realtimeSpeech.speak(ack);
        console.log('[ExchangeBridge] Spoke acknowledgment:', ack);
      } catch (e) {
        console.warn('[ExchangeBridge] Could not speak acknowledgment:', e);
      }
      
      try {
        const main = require('../../main');
        if (main.createClaudeCodeWindow) {
          // Pass the description so Composer can auto-plan
          main.createClaudeCodeWindow({ initialDescription: description || transcript });
        }
      } catch (e) {
        console.error('[ExchangeBridge] Could not open Agent Composer:', e);
      }
      
      // Set global flag for voice relay
      global.agentCreationMode = true;
      
      return {
        transcript,
        queued: false,
        handled: true,
        classified: true,
        action: 'create-agent',
        params: { description },
        message: description 
          ? `Opening Agent Composer to create: ${description}` 
          : 'Opening Agent Composer window',
        // Signal to not let AI respond
        suppressAIResponse: true,
      };
    }
    // ==================== END SPECIAL COMMAND HANDLING ====================
    
    if (!exchangeInstance || !isExchangeRunning) {
      return {
        transcript,
        queued: false,
        error: 'Exchange not running',
      };
    }
    
    try {
      const { taskId, task } = await exchangeInstance.submit({
        content: transcript,
        priority: options.priority || 2,
        metadata: {
          source: 'voice',
          timestamp: Date.now(),
          ...options.metadata,
        },
      });
      
      return {
        transcript,
        queued: true,
        taskId,
        task,
        classified: true,
        action: 'auction',
        message: 'Task submitted to exchange',
      };
    } catch (error) {
      console.error('[ExchangeBridge] Submit error:', error);
      return {
        transcript,
        queued: false,
        error: error.message,
      };
    }
  });
  
  // Get exchange status
  ipcMain.handle('voice-task-sdk:exchange-status', () => {
    const status = {
      running: isExchangeRunning,
      port: DEFAULT_EXCHANGE_CONFIG.port,
      agentCount: exchangeInstance?.agents?.getCount() || 0,
      queueDepth: exchangeInstance?.getQueueStats()?.depth?.total || 0,
      agents: [],
    };
    
    // List connected agents
    if (exchangeInstance?.agents) {
      status.agents = exchangeInstance.agents.getAll().map(a => ({
        id: a.id,
        name: a.name,
        healthy: a.healthy,
      }));
    }
    
    console.log('[ExchangeBridge] Status check:', status);
    return status;
  });
  
  // List connected agents
  ipcMain.handle('voice-task-sdk:list-agents', () => {
    if (!exchangeInstance) return [];
    return exchangeInstance.agents.getAll().map(a => ({
      id: a.id,
      name: a.name,
      version: a.version,
      categories: a.categories,
      healthy: a.healthy,
      currentTasks: a.currentTasks,
    }));
  });
  
  // Get reputation summary
  ipcMain.handle('voice-task-sdk:reputation-summary', async () => {
    if (!exchangeInstance) return {};
    const summary = await exchangeInstance.reputation.getSummary();
    return Object.fromEntries(summary);
  });
  
  console.log('[ExchangeBridge] IPC handlers registered');
}

/**
 * Get the exchange instance
 */
function getExchange() {
  return exchangeInstance;
}

/**
 * Check if exchange is running
 */
function isRunning() {
  return isExchangeRunning;
}

/**
 * Get exchange connection URL for agents
 */
function getExchangeUrl() {
  return `ws://localhost:${DEFAULT_EXCHANGE_CONFIG.port}`;
}

/**
 * Shutdown the exchange
 */
async function shutdown() {
  console.log('[ExchangeBridge] Shutting down...');
  
  if (exchangeInstance) {
    await exchangeInstance.shutdown(5000);
    exchangeInstance = null;
  }
  
  if (transportInstance) {
    await transportInstance.stop();
    transportInstance = null;
  }
  
  isExchangeRunning = false;
  
  // Remove IPC handlers
  const handlers = [
    'voice-task-sdk:submit',
    'voice-task-sdk:exchange-status',
    'voice-task-sdk:list-agents',
    'voice-task-sdk:reputation-summary',
  ];
  
  handlers.forEach(handler => {
    try {
      ipcMain.removeHandler(handler);
    } catch (e) {
      // Handler may not exist
    }
  });
  
  console.log('[ExchangeBridge] Shutdown complete');
}

module.exports = {
  initializeExchangeBridge,
  getExchange,
  isRunning,
  getExchangeUrl,
  shutdown,
  DEFAULT_EXCHANGE_CONFIG,
};
