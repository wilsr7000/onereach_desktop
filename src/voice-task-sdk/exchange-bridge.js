/**
 * Exchange Bridge - Connects Voice Task SDK to the Auction Exchange
 * 
 * This module bridges the existing voice SDK IPC interface to the new
 * auction-based task exchange system.
 * 
 * Phase 1: Integrated with Concierge Router for:
 * - Critical command handling (cancel, repeat, undo)
 * - Conversation state management
 * - Pronoun resolution for followups
 * - Late-cancel suppression
 */

const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Phase 1: Import Router and state management
const { Router, createRouter } = require('./routing/Router');
const conversationState = require('./state/conversationState');
const responseMemory = require('./memory/responseMemory');
const { getLogger } = require('./logging/Logger');

// Phase 2: Notification manager for proactive notifications
const notificationManager = require('./notifications/notificationManager');

// Phase 1: Import built-in agents
const timeAgent = require('../../packages/agents/time-agent');
const weatherAgent = require('../../packages/agents/weather-agent');
const mediaAgent = require('../../packages/agents/media-agent');
const helpAgent = require('../../packages/agents/help-agent');
const searchAgent = require('../../packages/agents/search-agent');
const smalltalkAgent = require('../../packages/agents/smalltalk-agent');

// Task Queue Manager (LLM-based decomposition, bidding, execution)
const { processPhrase } = require('../../packages/agents/task-queue-manager');

// Router instance (initialized after exchange is ready)
let routerInstance = null;

// Phase 1: Built-in agents for local execution (keyed by ID for classifier lookup)
const allBuiltInAgents = [timeAgent, weatherAgent, mediaAgent, helpAgent, searchAgent, smalltalkAgent];
const allBuiltInAgentMap = {
  'time-agent': timeAgent,
  'weather-agent': weatherAgent,
  'media-agent': mediaAgent,
  'help-agent': helpAgent,
  'search-agent': searchAgent,
  'smalltalk-agent': smalltalkAgent
};

/**
 * Get enabled builtin agents based on user settings
 * @returns {Array} Array of enabled agents
 */
function getEnabledBuiltInAgents() {
  let states = {};
  if (global.settingsManager) {
    states = global.settingsManager.get('builtinAgentStates') || {};
  }
  
  // Filter agents based on enabled state (default to enabled)
  return allBuiltInAgents.filter(agent => {
    const isEnabled = states[agent.id] !== false;
    return isEnabled;
  });
}

/**
 * Get enabled builtin agent map
 * @returns {Object} Map of agentId -> agent for enabled agents only
 */
function getEnabledBuiltInAgentMap() {
  let states = {};
  if (global.settingsManager) {
    states = global.settingsManager.get('builtinAgentStates') || {};
  }
  
  const enabledMap = {};
  for (const [id, agent] of Object.entries(allBuiltInAgentMap)) {
    if (states[id] !== false) {
      enabledMap[id] = agent;
    }
  }
  return enabledMap;
}

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
 * Check if a transcription looks garbled/misheard
 * Returns true if the transcription seems suspicious
 */
function isLikelyGarbledTranscription(content) {
  if (!content || typeof content !== 'string') return true;
  
  const text = content.trim().toLowerCase();
  
  // Too short (single word that's not a command)
  if (text.length < 3) return true;
  
  // Single word that's not a known command
  const knownSingleWords = ['play', 'pause', 'stop', 'skip', 'next', 'mute', 'unmute', 'help', 'cancel', 'yes', 'no'];
  if (!text.includes(' ') && !knownSingleWords.includes(text)) {
    // Single unknown word - might be garbled
    return true;
  }
  
  // Contains unusual character patterns (allow international characters)
  // Support common accented letters: àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ
  if (/[^a-z0-9\s\-'.,!?àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ]/.test(text)) return true;
  
  // Very high ratio of consonants (common in misheard speech)
  const consonants = text.replace(/[aeiou\s]/gi, '').length;
  const vowels = text.replace(/[^aeiou]/gi, '').length;
  if (vowels > 0 && consonants / vowels > 4) return true;
  
  // Looks like a made-up word (no common English patterns)
  const uncommonPatterns = /[^aeiou]{5,}|^[^aeiou]+$/i;
  const words = text.split(/\s+/);
  const garbledWords = words.filter(w => w.length > 3 && uncommonPatterns.test(w));
  if (garbledWords.length > words.length / 2) return true;
  
  return false;
}

/**
 * Get suggestions for what the user might have meant
 */
function getSuggestionsForTask(content) {
  if (!content) return [];
  
  const text = content.toLowerCase();
  const suggestions = [];
  
  // Check for partial matches with known commands
  const knownCommands = [
    { keywords: ['play', 'music', 'song'], suggestion: 'play music' },
    { keywords: ['spell', 'letter', 'word'], suggestion: 'spell a word' },
    { keywords: ['open', 'launch', 'start'], suggestion: 'open an app' },
    { keywords: ['search', 'find', 'look'], suggestion: 'search for something' },
    { keywords: ['volume', 'loud', 'quiet'], suggestion: 'adjust volume' },
    { keywords: ['create', 'make', 'new', 'agent'], suggestion: 'create an agent' },
    { keywords: ['time', 'date', 'day'], suggestion: 'what time is it' },
    { keywords: ['weather', 'temperature'], suggestion: 'check the weather' },
  ];
  
  for (const cmd of knownCommands) {
    // Check if any keyword partially matches the content
    const hasPartialMatch = cmd.keywords.some(kw => {
      // Fuzzy match - at least 60% of characters match
      if (text.includes(kw) || kw.includes(text)) return true;
      
      // Levenshtein-like check for short words
      for (const word of text.split(/\s+/)) {
        if (word.length >= 3 && kw.length >= 3) {
          const common = [...word].filter(c => kw.includes(c)).length;
          if (common >= Math.min(word.length, kw.length) * 0.6) return true;
        }
      }
      return false;
    });
    
    if (hasPartialMatch) {
      suggestions.push(cmd.suggestion);
    }
  }
  
  // Limit to top 3 suggestions
  return suggestions.slice(0, 3);
}

/**
 * Handle media playback commands via AppleScript
 */
async function handleMediaCommand(text, transcript) {
  // Determine the media app - default to Music (Apple Music)
  let app = 'Music';
  if (text.includes('spotify')) {
    app = 'Spotify';
  } else if (text.includes('youtube')) {
    // YouTube requires browser control, skip for now
    return null;
  }
  
  let script = null;
  let action = null;
  let message = null;
  
  // Play command
  if (text.includes('play')) {
    // Check if it's "play music" or similar general play command
    if (text.includes('music') || text.includes('song') || text.includes('something') || 
        text.match(/^play\s*$/) || text.match(/play\s+(now|please|it)/)) {
      script = `tell application "${app}" to play`;
      action = 'play';
      message = `Playing music in ${app}`;
    }
    // Specific song/artist/playlist
    else {
      const queryMatch = text.match(/play\s+(.+?)(?:\s+on\s+\w+)?$/i);
      const query = queryMatch ? queryMatch[1].trim() : null;
      
      if (query && !query.match(/^(music|song|something|now|please|it)$/i)) {
        // Search and play
        if (app === 'Spotify') {
          script = `
            tell application "Spotify"
              activate
              delay 0.5
            end tell
            tell application "System Events"
              keystroke "l" using command down
              delay 0.2
              keystroke "${query.replace(/"/g, '\\"')}"
              delay 1
              keystroke return
            end tell
          `;
        } else {
          // Apple Music search
          script = `
            tell application "Music"
              set searchResults to search playlist "Library" for "${query.replace(/"/g, '\\"')}"
              if length of searchResults > 0 then
                play item 1 of searchResults
              else
                play
              end if
            end tell
          `;
        }
        action = 'play-search';
        message = `Playing "${query}" in ${app}`;
      } else {
        script = `tell application "${app}" to play`;
        action = 'play';
        message = `Playing music in ${app}`;
      }
    }
  }
  // Pause command
  else if (text.includes('pause') || text.includes('stop')) {
    script = `tell application "${app}" to pause`;
    action = 'pause';
    message = 'Music paused';
  }
  // Skip/Next command
  else if (text.includes('skip') || text.includes('next')) {
    script = `tell application "${app}" to next track`;
    action = 'next';
    message = 'Skipping to next track';
  }
  // Previous command
  else if (text.includes('previous') || text.includes('back')) {
    script = `tell application "${app}" to previous track`;
    action = 'previous';
    message = 'Going back to previous track';
  }
  // Volume commands
  else if (text.includes('volume')) {
    if (text.includes('up') || text.includes('louder') || text.includes('increase')) {
      script = `set volume output volume ((output volume of (get volume settings)) + 10)`;
      action = 'volume-up';
      message = 'Volume increased';
    } else if (text.includes('down') || text.includes('quieter') || text.includes('decrease') || text.includes('lower')) {
      script = `set volume output volume ((output volume of (get volume settings)) - 10)`;
      action = 'volume-down';
      message = 'Volume decreased';
    } else if (text.includes('mute')) {
      script = `set volume with output muted`;
      action = 'mute';
      message = 'Volume muted';
    } else if (text.includes('unmute')) {
      script = `set volume without output muted`;
      action = 'unmute';
      message = 'Volume unmuted';
    } else {
      // Set specific volume
      const volumeMatch = text.match(/volume\s+(?:to\s+)?(\d+)/);
      if (volumeMatch) {
        const level = Math.min(100, Math.max(0, parseInt(volumeMatch[1])));
        script = `set volume output volume ${level}`;
        action = 'volume-set';
        message = `Volume set to ${level}%`;
      }
    }
  }
  
  if (!script) {
    return null; // Not a media command we can handle
  }
  
  // Execute the AppleScript
  try {
    const escapedScript = script.replace(/'/g, "'\"'\"'");
    await execAsync(`osascript -e '${escapedScript}'`, { timeout: 5000 });
    
    console.log('[ExchangeBridge] Media command executed:', action);
    
    // NOTE: Don't call speakFeedback - message returned via respondToFunctionCall
    
    return {
      transcript,
      queued: false,
      handled: true,
      classified: true,
      action: `media-${action}`,
      message,
      suppressAIResponse: true,
    };
  } catch (error) {
    console.error('[ExchangeBridge] Media command error:', error.message);
    
    // Try to open the app and then play
    if (action === 'play' && error.message.includes('not running')) {
      try {
        await execAsync(`open -a "${app}"`, { timeout: 3000 });
        await new Promise(r => setTimeout(r, 2000)); // Wait for app to launch
        await execAsync(`osascript -e 'tell application "${app}" to play'`, { timeout: 3000 });
        
        // NOTE: Don't call speakFeedback - message returned via respondToFunctionCall
        
        return {
          transcript,
          queued: false,
          handled: true,
          classified: true,
          action: 'media-play-launch',
          message: `Opened ${app} and started playback`,
          suppressAIResponse: true,
        };
      } catch (launchError) {
        console.error('[ExchangeBridge] Failed to launch and play:', launchError.message);
      }
    }
    
    return null; // Let it fall through to the exchange
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
 * Setup notification manager listener to speak notifications
 */
function setupNotificationListener() {
  notificationManager.on('notify', (event) => {
    console.log(`[ExchangeBridge] Notification: ${event.message}`);
    
    // Speak the notification
    if (global.speakFeedback) {
      global.speakFeedback(event.message);
    }
    
    // Also broadcast to windows
    broadcastToWindows('voice-task:notification', event);
  });
  
  console.log('[ExchangeBridge] Notification listener setup');
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
    
    // Setup notification manager
    setupNotificationListener();
    
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
  
  // Task queued - show HUD and acknowledge
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
    
    // NOTE: With function calling, frontend handles all TTS via respondToFunctionCall()
    // Don't call speakFeedback directly here - it conflicts with function call responses
    
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
  
  // No bids received - task halted - try disambiguation
  exchangeInstance.on('exchange:halt', ({ task, reason }) => {
    console.warn('[ExchangeBridge] Exchange halted:', reason);
    
    const content = task?.content || '';
    
    // Check if this looks like a garbled transcription
    const isGarbled = isLikelyGarbledTranscription(content);
    
    if (isGarbled) {
      // Ask for clarification - transcription seems wrong
      console.log('[ExchangeBridge] Transcription appears garbled, asking for clarification');
      
      const clarificationMessage = "I didn't quite catch that. Could you say that again?";
      
      // NOTE: With function calling, frontend handles TTS - don't call speakFeedback
      
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: false,
          needsClarification: true,
          message: clarificationMessage,
        });
      }
    } else {
      // Task was clear but no agent can handle it - offer suggestions
      console.log('[ExchangeBridge] No agents for task, offering disambiguation');
      
      const suggestions = getSuggestionsForTask(content);
      
      let clarificationMessage;
      if (suggestions.length > 0) {
        clarificationMessage = `I'm not sure what you meant by "${content}". Did you mean: ${suggestions.join(', or ')}?`;
      } else {
        clarificationMessage = `I don't have an agent that can handle "${content}". Try saying something like: play music, spell a word, or create an agent.`;
      }
      
      // NOTE: With function calling, frontend handles TTS - don't call speakFeedback
      
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: false,
          needsClarification: true,
          suggestions,
          message: clarificationMessage,
        });
      }
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
    
    // Note: Don't speak here - we already said "Got it" on task:queued
    // The next feedback will be the result or an error
    
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
    
    // Phase 1: Check if this task was cancelled (late result suppression)
    if (routerInstance?.cancelledTaskIds?.has(task.id)) {
      console.log('[ExchangeBridge] Suppressing late result for cancelled task:', task.id);
      routerInstance.cancelledTaskIds.delete(task.id);
      return;
    }
    
    const message = result.data?.message || (result.success ? 'All done' : null);
    
    // Phase 1: Store response for repeat
    if (message) {
      responseMemory.setLastResponse(message);
      
      // Store undo if available
      if (result.data?.undoFn && result.data?.undoDescription) {
        responseMemory.setUndoableAction(result.data.undoDescription, result.data.undoFn);
      }
    }
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: true,
        message: message || 'Task completed',
        data: result.data,
      });
    }
    
    // NOTE: Don't call speakFeedback here - the message is returned to the frontend
    // which calls respondToFunctionCall() to avoid "conversation_already_has_active_response"
    
    broadcastToWindows('voice-task:completed', {
      taskId: task.id,
      agentId,
      result,
    });
  });
  
  // Task executing - agent started working
  exchangeInstance.on('task:executing', ({ task, agentId }) => {
    console.log('[ExchangeBridge] Task executing by:', agentId);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing...',
        status: 'running',
      });
    }
    
    // Don't speak here - too granular, would interrupt flow
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
    
    // NOTE: Don't speak retry messages during function call processing
    // It would conflict with the response that's being built
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
    
    // NOTE: Don't call speakFeedback - error message returned via respondToFunctionCall
    
    broadcastToWindows('voice-task:failed', {
      taskId: task.id,
      reason,
    });
  });
  
  // Task cancelled
  exchangeInstance.on('task:cancelled', ({ task, reason }) => {
    console.log('[ExchangeBridge] Task cancelled:', task.id, reason);
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: false,
        cancelled: true,
        message: 'Cancelled',
      });
    }
    
    // NOTE: Don't call speakFeedback - "Cancelled" is returned via respondToFunctionCall
    
    broadcastToWindows('voice-task:cancelled', {
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
    const log = getLogger();
    
    // ==================== PHASE 1: ROUTER INTEGRATION ====================
    // Initialize router if needed
    if (!routerInstance && exchangeInstance) {
      routerInstance = createRouter(
        {
          submit: async (task) => {
            // Wrap exchange submit to return normalized results
            try {
              const { taskId } = await exchangeInstance.submit({
                content: task.content,
                priority: 2,
                metadata: { source: 'voice', timestamp: Date.now() }
              });
              // Wait for result via events (handled elsewhere)
              // For now, return that we're processing
              return { success: true, queued: true, taskId };
            } catch (error) {
              return { success: false, message: error.message };
            }
          },
          cancel: (taskId) => {
            // Exchange cancel if available
            if (exchangeInstance?.cancelTask) {
              exchangeInstance.cancelTask(taskId);
            }
          }
        },
        (message) => {
          // NOTE: Progress messages during function call processing would conflict
          // with respondToFunctionCall. Just log them for now.
          // Future: Could aggregate progress messages into final response
          console.log('[Router] Progress:', message);
        }
      );
      log.info('ExchangeBridge', 'Router initialized');
    }
    
    // Use Router for critical commands (cancel, repeat, undo)
    if (routerInstance) {
      const text = transcript?.toLowerCase()?.trim() || '';
      
      // Check for critical commands that Router handles directly
      if (['cancel', 'stop', 'nevermind', 'never mind', 'repeat', 'say that again', 
           'undo', 'undo that', 'take that back'].some(cmd => text === cmd || text.startsWith(cmd + ' '))) {
        log.info('ExchangeBridge', 'Routing to Router for critical command');
        const result = await routerInstance.handle(transcript);
        
        if (result.handled) {
          // NOTE: Don't call speakFeedback here!
          // The message is returned to the frontend which calls respondToFunctionCall()
          // Calling speakFeedback would create a SECOND response, causing:
          // "conversation_already_has_active_response" error
          return {
            transcript,
            queued: false,
            handled: true,
            classified: true,
            action: result.type || 'router-handled',
            message: result.speak,
            suppressAIResponse: false,  // Let respondToFunctionCall speak this
          };
        }
      }
      
      // Check for pending state (question or confirmation)
      const routingContext = conversationState.getRoutingContext();
      if (routingContext.hasPendingQuestion || routingContext.hasPendingConfirmation) {
        log.info('ExchangeBridge', 'Routing to Router for pending state resolution');
        const result = await routerInstance.handle(transcript);
        
        if (result.handled) {
          // NOTE: Don't call speakFeedback - let respondToFunctionCall handle it
          return {
            transcript,
            queued: false,
            handled: true,
            classified: true,
            action: result.type || 'state-resolved',
            message: result.speak,
            suppressAIResponse: false,  // Let respondToFunctionCall speak this
          };
        }
      }
    }
    // ==================== END PHASE 1: ROUTER INTEGRATION ====================
    
    // ==================== PHASE 1: BUILT-IN AGENT HANDLING ====================
    // Try built-in agents before sending to exchange
    const task = { id: `task_${Date.now()}`, content: transcript };
    console.log('[ExchangeBridge] Phase 1: Checking built-in agents for:', transcript);
    
    // STEP 1: Add task to HUD (visual feedback)
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing',
        status: 'queued',
      });
    }
    broadcastToWindows('voice-task:queued', {
      taskId: task.id,
      content: task.content,
      timestamp: Date.now(),
    });
    
    // ==================== LLM-BASED TASK QUEUE PROCESSING ====================
    // Full pipeline: Decompose → Bid → Execute → Report
    const queueResult = await processPhrase(transcript, [], {
      onTaskQueued: (queuedTask) => {
        console.log(`[ExchangeBridge] Task queued: ${queuedTask.type}`);
        if (global.showCommandHUD) {
          global.showCommandHUD({
            id: queuedTask.id,
            transcript: queuedTask.content,
            action: 'Processing',
            status: 'queued',
          });
        }
        broadcastToWindows('voice-task:queued', {
          taskId: queuedTask.id,
          content: queuedTask.content,
          type: queuedTask.type,
          timestamp: Date.now(),
        });
      },
      onTaskAssigned: (assignedTask, winner) => {
        console.log(`[ExchangeBridge] Task assigned: ${assignedTask.type} → ${winner.agentId}`);
        if (global.showCommandHUD) {
          global.showCommandHUD({
            id: assignedTask.id,
            transcript: assignedTask.content,
            action: `${winner.agentId} executing`,
            status: 'running',
          });
        }
        broadcastToWindows('voice-task:assigned', {
          taskId: assignedTask.id,
          agentId: winner.agentId,
          confidence: winner.confidence,
          timestamp: Date.now(),
        });
      },
      onTaskCompleted: (completedTask, winner, result) => {
        console.log(`[ExchangeBridge] Task completed: ${completedTask.type} → ${result.message || 'OK'}`);
        if (global.sendCommandHUDResult) {
          global.sendCommandHUDResult({
            success: result.success,
            message: result.message,
            agentId: winner.agentId,
          });
        }
        broadcastToWindows('voice-task:completed', {
          taskId: completedTask.id,
          agentId: winner.agentId,
          result: result.message,
          timestamp: Date.now(),
        });
        
        // Store for repeat
        if (result.message) {
          responseMemory.setLastResponse(result.message);
        }
        
        // Store undo if available
        if (result.undoFn && result.undoDescription) {
          responseMemory.setUndoableAction(result.undoDescription, result.undoFn);
        }
      },
      onNeedsClarification: (unclearTasks, message) => {
        console.log(`[ExchangeBridge] Needs clarification:`, message);
        
        // Send result to HUD (direct channel) - this should update HUD to show result
        if (global.sendCommandHUDResult) {
          console.log('[ExchangeBridge] Sending HUD result:', message);
          global.sendCommandHUDResult({
            success: false,
            needsClarification: true,
            message: message,
          });
        }
        
        // Also broadcast lifecycle event to voice-task:lifecycle channel (HUD listens here)
        broadcastToWindows('voice-task:lifecycle', {
          type: 'failed',
          task: { id: task.id, content: task.content },
          error: message,
          needsClarification: true,
          timestamp: Date.now(),
        });
      },
      onProgress: (progressTask, winner, status) => {
        // Update HUD with agent's progress status
        console.log(`[ExchangeBridge] Progress: ${winner.agentId} - ${status}`);
        if (global.showCommandHUD) {
          global.showCommandHUD({
            id: progressTask.id,
            transcript: progressTask.content,
            action: status,  // e.g., "Searching the web...", "Analyzing results..."
            status: 'running',
          });
        }
        broadcastToWindows('voice-task:progress', {
          taskId: progressTask.id,
          agentId: winner.agentId,
          status: status,
          timestamp: Date.now(),
        });
      }
    });
    
    // Handle successful execution (agents completed tasks)
    if (queueResult.success) {
      return {
        transcript,
        queued: false,
        handled: true,
        classified: true,
        action: queueResult.results?.[0]?.winner?.agentId || 'task-queue',
        message: queueResult.message,
        suppressAIResponse: true, // Message already spoken via callbacks
      };
    }
    
    // Handle clarification needed (no agent could handle the request)
    if (queueResult.needsClarification) {
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false, // Not classified to a known agent
        action: 'clarification-needed',
        message: queueResult.message,
        suppressAIResponse: false, // Let the clarification message be spoken!
        needsClarification: true,
      };
    }
    
    // If task queue failed (e.g., API key missing), return the error message
    if (queueResult.error) {
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false,
        message: queueResult.message,
        suppressAIResponse: false, // Let the error message be spoken
      };
    }
    
    // Handle case where task queue returned nothing actionable (no tasks decomposed)
    if (!queueResult.success && queueResult.message) {
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false,
        action: 'unknown',
        message: queueResult.message,
        suppressAIResponse: false, // Let the message be spoken
      };
    }
    // ==================== END LLM-BASED TASK QUEUE PROCESSING ====================
    
    // ==================== EARLY GARBLED DETECTION ====================
    // Check if transcription looks garbled before processing
    if (isLikelyGarbledTranscription(transcript)) {
      console.log('[ExchangeBridge] Transcript appears garbled, asking for clarification');
      
      const clarificationMessage = "Sorry, I didn't catch that. Could you repeat that?";
      
      // NOTE: With function calling, frontend handles TTS via respondToFunctionCall()
      // Don't call speakFeedback directly - return the message for frontend to handle
      
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false,
        needsClarification: true,
        message: clarificationMessage,
        suppressAIResponse: false, // Let function call response speak the clarification
      };
    }
    // ==================== END EARLY GARBLED DETECTION ====================
    
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
    
    // ==================== MEDIA PLAYBACK COMMANDS ====================
    // Handle media control commands directly (play music, pause, stop, volume)
    if (text.includes('play') || text.includes('pause') || text.includes('stop') || 
        text.includes('volume') || text.includes('skip') || text.includes('next') || text.includes('previous')) {
      
      const mediaResult = await handleMediaCommand(text, transcript);
      if (mediaResult) {
        console.log('[ExchangeBridge] Media command handled:', mediaResult.action);
        return mediaResult;
      }
    }
    // ==================== END MEDIA COMMANDS ====================
    
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
