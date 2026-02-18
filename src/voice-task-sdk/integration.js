/**
 * Voice Task SDK - Electron Integration Module
 *
 * Full task queuing system with:
 * - Named queues with concurrency control
 * - Priority-based task ordering
 * - Agent registry for task execution
 * - Classifier for voice commands
 * - HUD integration for status display
 */

const { ipcMain, BrowserWindow } = require('electron');
const { createVoiceTaskSDK } = require('./sdk-runtime');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Context provider system (lazy loaded to avoid circular deps)
let contextRegistry = null;
let temporalProvider = null;
let activeAppProvider = null;
let customFactsProvider = null;

/**
 * Initialize context providers
 */
async function initializeContextProviders() {
  try {
    // Dynamic import to avoid circular dependencies
    const contextModule = await import('./context/index.js');
    const { createContextRegistry, createTemporalProvider, createActiveAppProvider, createCustomFactsProvider } =
      contextModule;

    // Create registry
    contextRegistry = createContextRegistry({
      autoEnableBuiltins: true,
    });

    // Register built-in providers
    temporalProvider = createTemporalProvider();
    contextRegistry.register(temporalProvider);
    contextRegistry.enable('temporal');

    activeAppProvider = createActiveAppProvider();
    contextRegistry.register(activeAppProvider);
    contextRegistry.enable('active-app');

    customFactsProvider = createCustomFactsProvider();
    contextRegistry.register(customFactsProvider);
    contextRegistry.enable('custom-facts');

    log.info('voice', '[VoiceTaskSDK] Context providers initialized');
  } catch (e) {
    log.warn('voice', '[VoiceTaskSDK] Could not initialize context providers', { data: e.message });
    // Context providers are optional - continue without them
  }
}

/**
 * Get aggregated context from all providers
 */
async function getAggregatedContext() {
  if (!contextRegistry) {
    return {};
  }

  try {
    const aggregated = await contextRegistry.aggregate();
    return aggregated.providers;
  } catch (e) {
    log.warn('voice', '[VoiceTaskSDK] Error aggregating context', { data: e });
    return {};
  }
}

// SDK State
let sdk = null;
let isInitialized = false;

// Conversation history for context
const MAX_HISTORY_LENGTH = 20;
let conversationHistory = [];

/**
 * Add user message to conversation history
 * @param {string} content - User's message/transcript
 */
function addUserMessage(content) {
  conversationHistory.push({
    role: 'user',
    content,
    timestamp: Date.now(),
  });

  // Trim to max length
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
  }

  // Save to settings for persistence
  saveHistoryToSettings();
}

/**
 * Add assistant message to conversation history
 * @param {string} content - Assistant's response
 */
function addAssistantMessage(content) {
  conversationHistory.push({
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });

  // Trim to max length
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
  }

  saveHistoryToSettings();
}

/**
 * Get conversation history
 * @returns {Array} Conversation history entries
 */
function getConversationHistory() {
  return [...conversationHistory];
}

/**
 * Clear conversation history
 */
function clearConversationHistory() {
  conversationHistory = [];
  saveHistoryToSettings();
}

/**
 * Save history to settings for persistence
 */
function saveHistoryToSettings() {
  try {
    if (global.settingsManager) {
      global.settingsManager.set('voiceConversationHistory', conversationHistory);
    }
  } catch (e) {
    log.warn('voice', '[VoiceTaskSDK] Could not save history', { data: e });
  }
}

/**
 * Load history from settings
 */
function loadHistoryFromSettings() {
  try {
    if (global.settingsManager) {
      const saved = global.settingsManager.get('voiceConversationHistory');
      if (Array.isArray(saved)) {
        conversationHistory = saved.slice(-MAX_HISTORY_LENGTH);
        log.info('voice', '[VoiceTaskSDK] Loaded', { arg0: conversationHistory.length, arg1: 'history entries' });
      }
    }
  } catch (e) {
    log.warn('voice', '[VoiceTaskSDK] Could not load history', { data: e });
  }
}

/**
 * Default configuration
 */
const defaultConfig = {
  defaultQueue: 'voice-commands',
  defaultConcurrency: 3,
  maxQueueSize: 50,
  overflow: 'error',
  pollIntervalMs: 100,
  defaultTimeoutMs: 30000,
  debug: false,
};

/**
 * Classify a transcript into an action
 * Uses conversation history for context
 */
function classifyTranscript(transcript) {
  const text = transcript.toLowerCase();
  let action = null;
  let params = {};
  let confidence = 0.6;

  // Check conversation history for context
  const recentHistory = conversationHistory.slice(-5);
  const _historyContext = recentHistory.map((h) => h.content.toLowerCase()).join(' ');

  // Keyword-based classification
  if (text.includes('search') || text.includes('find') || text.includes('look for')) {
    action = 'search';
    const match = text.match(/(?:search|find|look for)\s+(?:for\s+)?(.+)/i);
    if (match) params.query = match[1].trim();
    confidence = 0.75;
  } else if (text.includes('open') || text.includes('launch') || text.includes('start')) {
    const match = text.match(/(?:open|launch|start)\s+(?:the\s+)?(.+)/i);
    const target = match ? match[1].trim().toLowerCase() : '';

    // Check for specific window targets
    if (target.includes('agent composer') || target.includes('composer') || target.includes('gsx create')) {
      action = 'open-agent-composer';
      params.target = 'agent-composer';
      confidence = 0.9;
    } else if (target.includes('agent manager') || target === 'agents' || target === 'agent manager') {
      action = 'open-agent-manager';
      params.target = 'agent-manager';
      confidence = 0.9;
    } else {
      action = 'open';
      params.target = target;
      confidence = 0.75;
    }
  } else if (text.includes('create') || text.includes('make') || text.includes('new')) {
    // Check specifically for "create agent" voice command
    if (text.includes('agent') || text.includes('assistant') || text.includes('bot')) {
      action = 'create-agent';
      const match = text.match(
        /(?:create|make|new)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:agent|assistant|bot)\s*(?:that\s+|to\s+|for\s+)?(.+)?/i
      );
      if (match && match[1]) {
        params.description = match[1].trim();
      }
      confidence = 0.9;
    } else {
      action = 'create';
      const match = text.match(/(?:create|make|new)\s+(?:a\s+)?(.+)/i);
      if (match) params.item = match[1].trim();
      confidence = 0.7;
    }
  } else if (text.includes('send') || text.includes('email') || text.includes('message')) {
    action = 'send';
    confidence = 0.7;
  } else if (text.includes('save') || text.includes('store')) {
    action = 'save';
    confidence = 0.7;
  } else if (text.includes('delete') || text.includes('remove')) {
    action = 'delete';
    confidence = 0.7;
  } else if (text.includes('copy') || text.includes('clipboard')) {
    action = 'copy';
    confidence = 0.7;
  } else if (text.includes('play')) {
    action = 'play';
    confidence = 0.8;
  } else if (text.includes('pause')) {
    action = 'pause';
    confidence = 0.8;
  } else if (text.includes('stop')) {
    action = 'stop';
    confidence = 0.8;
  } else if (text.includes('help') || text.includes('assist')) {
    action = 'help';
    confidence = 0.8;
  } else if (text.includes('setting') || text.includes('preference') || text.includes('config')) {
    action = 'settings';
    confidence = 0.75;
  } else if (text.includes('undo')) {
    action = 'undo';
    confidence = 0.9;
  } else if (text.includes('redo')) {
    action = 'redo';
    confidence = 0.9;
  }

  return {
    transcript,
    action,
    params,
    confidence,
    classified: !!action,
    message: action ? `Classified as: ${action}` : 'No specific action recognized',
  };
}

/**
 * Create default agent that handles all voice commands
 */
function createDefaultAgent() {
  return {
    name: 'voice-command-agent',
    queues: ['voice-commands'],
    priority: 0,
    resolve: async (task, _ctx) => {
      log.info('voice', '[VoiceAgent] Executing task:', { v0: task.action, arg0: task.params });

      // Simulate execution time
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      // Broadcast task progress
      broadcastToWindows('voice-task:progress', {
        taskId: task.id,
        action: task.action,
        status: 'executing',
      });

      // Execute based on action type
      switch (task.action) {
        case 'search':
          return { success: true, data: { message: `Searching for: ${task.params.query}` } };
        case 'open':
          return { success: true, data: { message: `Opening: ${task.params.target}` } };
        case 'create':
          return { success: true, data: { message: `Creating: ${task.params.item}` } };
        case 'save':
          return { success: true, data: { message: 'Saved successfully' } };
        case 'delete':
          return { success: true, data: { message: 'Deleted successfully' } };
        case 'copy':
          return { success: true, data: { message: 'Copied to clipboard' } };
        case 'play':
        case 'pause':
        case 'stop':
          return { success: true, data: { message: `Media ${task.action} executed` } };
        case 'help':
          return { success: true, data: { message: 'Help information displayed' } };
        case 'settings':
          return { success: true, data: { message: 'Settings opened' } };
        case 'create-agent':
          return { success: true, data: { message: 'Opening agent creator...' } };
        case 'undo':
        case 'redo':
          return { success: true, data: { message: `${task.action} executed` } };
        default:
          return { success: true, data: { message: `Action ${task.action} completed` } };
      }
    },
  };
}

/**
 * Broadcast message to all windows
 */
function broadcastToWindows(channel, data) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}

/**
 * Initialize the Voice Task SDK
 */
function initializeVoiceTaskSDK(config = {}) {
  const mergedConfig = { ...defaultConfig, ...config };

  log.info('voice', '[VoiceTaskSDK] Initializing with config', {
    arg0: mergedConfig.defaultQueue,
    arg1: mergedConfig.defaultConcurrency,
    arg2: mergedConfig.maxQueueSize,
  });

  // Load conversation history from settings
  loadHistoryFromSettings();

  // Initialize context providers (non-blocking)
  initializeContextProviders().catch((e) => {
    log.warn('voice', '[VoiceTaskSDK] Context provider init failed', { data: e });
  });

  // Create SDK instance
  sdk = createVoiceTaskSDK(mergedConfig);

  // Register default agent
  const defaultAgent = createDefaultAgent();
  sdk.agents.create(defaultAgent);
  log.info('voice', '[VoiceTaskSDK] Default agent registered');

  // Wire up events to broadcast to windows and HUD
  sdk.on('queued', (task) => {
    log.info('voice', '[VoiceTaskSDK] Task queued', { arg0: task.id, arg1: task.action });
    broadcastToWindows('voice-task:queued', task);

    // Show HUD if available
    if (global.showCommandHUD) {
      global.showCommandHUD({
        ...task,
        transcript: task.content,
      });
    }
  });

  sdk.on('started', (task) => {
    log.info('voice', '[VoiceTaskSDK] Task started', { data: task.id });
    broadcastToWindows('voice-task:started', task);

    // Update HUD
    if (global.showCommandHUD) {
      global.showCommandHUD({
        ...task,
        status: 'running',
        transcript: task.content,
      });
    }
  });

  sdk.on('completed', ({ task, result }) => {
    log.info('voice', '[VoiceTaskSDK] Task completed', { data: task.id });
    broadcastToWindows('voice-task:completed', { task, result });

    // Update HUD with result
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: result?.success !== false,
        message: result?.data?.message || 'Task completed',
      });
    }
  });

  sdk.on('failed', ({ task, error }) => {
    log.info('voice', '[VoiceTaskSDK] Task failed', { arg0: task.id, arg1: error });
    broadcastToWindows('voice-task:failed', { task, error: String(error) });

    // Update HUD with error
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: false,
        error: String(error),
        message: 'Task failed',
      });
    }
  });

  sdk.on('retry', ({ task, attempt }) => {
    log.info('voice', '[VoiceTaskSDK] Task retry', { arg0: task.id, arg1: 'attempt', arg2: attempt });
    broadcastToWindows('voice-task:retry', { task, attempt });
  });

  sdk.on('deadletter', ({ task, reason }) => {
    log.info('voice', '[VoiceTaskSDK] Task deadletter', { arg0: task.id, arg1: reason });
    broadcastToWindows('voice-task:deadletter', { task, reason });
  });

  sdk.on('cancelled', (task) => {
    log.info('voice', '[VoiceTaskSDK] Task cancelled', { data: task.id });
    broadcastToWindows('voice-task:cancelled', task);
  });

  // Start the dispatcher
  sdk.start();
  log.info('voice', '[VoiceTaskSDK] Dispatcher started');

  // Setup IPC handlers
  setupSDKIPC();

  isInitialized = true;
  log.info('voice', '[VoiceTaskSDK] Initialization complete');
}

/**
 * Setup SDK IPC handlers
 */
function setupSDKIPC() {
  // Get SDK status
  ipcMain.handle('voice-task-sdk:status', () => {
    return {
      initialized: isInitialized,
      running: sdk?.isRunning() || false,
      version: '2.0.0',
    };
  });

  // Submit transcript for classification and queuing
  ipcMain.handle('voice-task-sdk:submit', async (_event, transcript, options = {}) => {
    if (!sdk) {
      throw new Error('SDK not initialized');
    }

    log.info('voice', '[VoiceTaskSDK] Submit transcript', { data: transcript });

    // Add to conversation history
    addUserMessage(transcript);

    // Get context from providers
    const providerContext = await getAggregatedContext();

    // Update context with providers
    if (sdk && Object.keys(providerContext).length > 0) {
      sdk.updateContext({
        metadata: {
          providers: providerContext,
        },
      });
    }

    // Classify the transcript (uses history for context)
    const classification = classifyTranscript(transcript);

    if (!classification.classified) {
      // Add assistant response to history
      addAssistantMessage('I did not understand that command.');

      return {
        ...classification,
        queued: false,
        message: 'Could not classify command',
      };
    }

    // Handle special actions that open windows directly
    if (classification.action === 'create-agent' || classification.action === 'open-agent-composer') {
      log.info('voice', '[VoiceTaskSDK] Opening Agent Composer');

      // Extract description from params if this is a create-agent request
      const description = classification.params?.description || '';

      // Open the Claude Code window (GSX Agent Composer) with the description
      try {
        const main = require('../../main');
        if (main.createClaudeCodeWindow) {
          main.createClaudeCodeWindow({ initialDescription: description });
        }
      } catch (e) {
        log.error('voice', '[VoiceTaskSDK] Could not open Agent Composer window', { error: e });
      }

      // Set global flag that we're in agent creation mode (for voice relay)
      global.agentCreationMode = true;

      if (description) {
        addAssistantMessage(`Opening the Agent Composer to create an agent for: "${description}"`);
      } else {
        addAssistantMessage('Opening the Agent Composer.');
      }

      return {
        ...classification,
        queued: false,
        handled: true,
        message: description ? `Opening Agent Composer with: ${description}` : 'Opening Agent Composer window',
      };
    }

    if (classification.action === 'open-agent-manager') {
      log.info('voice', '[VoiceTaskSDK] Opening Agent Manager');

      // Open the Agent Manager window
      try {
        const main = require('../../main');
        if (main.createAgentManagerWindow) {
          main.createAgentManagerWindow();
        }
      } catch (e) {
        log.error('voice', '[VoiceTaskSDK] Could not open Agent Manager window', { error: e });
      }

      addAssistantMessage('Opening the Agent Manager.');

      return {
        ...classification,
        queued: false,
        handled: true,
        message: 'Opening Agent Manager window',
      };
    }

    // Create classified task object
    const classifiedTask = {
      action: classification.action,
      content: transcript,
      params: classification.params,
      priority: options.priority || 2, // 1=high, 2=normal, 3=low
    };

    // Submit to queue
    const task = await sdk.submit(classifiedTask);

    // Add assistant response to history
    addAssistantMessage(`Executing ${classification.action} action.`);

    return {
      ...classification,
      queued: true,
      taskId: task?.id,
      task,
    };
  });

  // Submit a specific action directly (used after disambiguation)
  ipcMain.handle('voice-task-sdk:submit-action', async (_event, actionData) => {
    if (!sdk) {
      throw new Error('SDK not initialized');
    }

    const { action, params, originalTranscript, clarification } = actionData;

    log.info('voice', '[VoiceTaskSDK] Submit action directly', { data: action });

    // Add clarification to history if provided
    if (clarification) {
      addUserMessage(clarification);
      addAssistantMessage(`Got it, executing ${action}.`);
    }

    // Handle special actions that open windows directly
    if (action === 'create-agent' || action === 'open-agent-composer') {
      log.info('voice', '[VoiceTaskSDK] Opening Agent Composer');

      // Extract description from params if available
      const description = params?.description || '';

      try {
        const main = require('../../main');
        if (main.createClaudeCodeWindow) {
          main.createClaudeCodeWindow({ initialDescription: description });
        }
      } catch (e) {
        log.error('voice', '[VoiceTaskSDK] Could not open Agent Composer window', { error: e });
      }

      // Set global flag that we're in agent creation mode (for voice relay)
      global.agentCreationMode = true;

      if (description) {
        addAssistantMessage(`Opening the Agent Composer to create an agent for: "${description}"`);
      } else {
        addAssistantMessage('Opening the Agent Composer.');
      }

      return {
        action,
        queued: false,
        handled: true,
        message: description ? `Opening Agent Composer with: ${description}` : 'Opening Agent Composer window',
      };
    }

    if (action === 'open-agent-manager') {
      log.info('voice', '[VoiceTaskSDK] Opening Agent Manager');

      try {
        const main = require('../../main');
        if (main.createAgentManagerWindow) {
          main.createAgentManagerWindow();
        }
      } catch (e) {
        log.error('voice', '[VoiceTaskSDK] Could not open Agent Manager window', { error: e });
      }

      addAssistantMessage('Opening the Agent Manager.');

      return {
        action,
        queued: false,
        handled: true,
        message: 'Opening Agent Manager window',
      };
    }

    // Create classified task object
    const classifiedTask = {
      action,
      content: originalTranscript || action,
      params: params || {},
      priority: 2,
    };

    // Submit to queue
    const task = await sdk.submit(classifiedTask);

    return {
      action,
      queued: true,
      taskId: task?.id,
      task,
    };
  });

  // Get queue stats
  ipcMain.handle('voice-task-sdk:queue-stats', (_event, queueName) => {
    if (!sdk) return null;
    return sdk.queues.getStats(queueName || 'voice-commands');
  });

  // List all queues
  ipcMain.handle('voice-task-sdk:list-queues', () => {
    if (!sdk) return [];
    return sdk.queues.list().map((q) => ({
      ...q,
      stats: sdk.queues.getStats(q.name),
    }));
  });

  // Get pending tasks
  ipcMain.handle('voice-task-sdk:pending-tasks', (_event, queueName) => {
    if (!sdk) return [];
    return sdk.queues.getTasks(queueName || 'voice-commands');
  });

  // List all tasks
  ipcMain.handle('voice-task-sdk:list-tasks', (_event, filter) => {
    if (!sdk) return [];
    return sdk.tasks.list(filter);
  });

  // Cancel a task
  ipcMain.handle('voice-task-sdk:cancel-task', (_event, taskId) => {
    if (!sdk) return false;
    return sdk.cancelTask(taskId);
  });

  // List agents
  ipcMain.handle('voice-task-sdk:list-agents', () => {
    if (!sdk) return [];
    return sdk.agents.list().map((a) => ({
      id: a.id,
      name: a.name,
      queues: a.queues,
      actions: a.actions,
      priority: a.priority,
      enabled: a.enabled,
    }));
  });

  // Pause queue
  ipcMain.handle('voice-task-sdk:pause-queue', (_event, queueName) => {
    if (!sdk) return false;
    sdk.queues.pause(queueName);
    return true;
  });

  // Resume queue
  ipcMain.handle('voice-task-sdk:resume-queue', (_event, queueName) => {
    if (!sdk) return false;
    sdk.queues.resume(queueName);
    return true;
  });

  // Clear completed tasks
  ipcMain.handle('voice-task-sdk:clear-completed', () => {
    if (!sdk) return 0;
    return sdk.tasks.clearCompleted();
  });

  // Create custom queue
  ipcMain.handle('voice-task-sdk:create-queue', (_event, input) => {
    if (!sdk) throw new Error('SDK not initialized');
    return sdk.queues.create(input);
  });

  // Register custom agent
  ipcMain.handle('voice-task-sdk:register-agent', (_event, input) => {
    if (!sdk) throw new Error('SDK not initialized');

    // Note: For security, we only allow registering agents with predefined resolvers
    // Custom resolve functions would need a more secure mechanism
    const agent = sdk.agents.create({
      ...input,
      resolve: async (task, _ctx) => {
        // Default implementation - broadcast for renderer to handle
        broadcastToWindows('voice-task:execute', { task });
        return { success: true, data: { message: 'Executed via broadcast' } };
      },
    });

    return {
      id: agent.id,
      name: agent.name,
      queues: agent.queues,
      actions: agent.actions,
    };
  });

  // ==================== CONVERSATION HISTORY ====================

  // Get conversation history
  ipcMain.handle('voice-task-sdk:get-history', () => {
    return getConversationHistory();
  });

  // Clear conversation history
  ipcMain.handle('voice-task-sdk:clear-history', () => {
    clearConversationHistory();
    return { success: true };
  });

  // Add custom message to history (for external integrations)
  ipcMain.handle('voice-task-sdk:add-history', (_event, role, content) => {
    if (role === 'user') {
      addUserMessage(content);
    } else {
      addAssistantMessage(content);
    }
    return { success: true };
  });

  // ==================== CONTEXT PROVIDERS ====================

  // List context providers
  ipcMain.handle('voice-task-sdk:list-providers', () => {
    if (!contextRegistry) return [];
    return contextRegistry.list();
  });

  // Enable a context provider
  ipcMain.handle('voice-task-sdk:enable-provider', (_event, providerId) => {
    if (!contextRegistry) return false;
    return contextRegistry.enable(providerId);
  });

  // Disable a context provider
  ipcMain.handle('voice-task-sdk:disable-provider', (_event, providerId) => {
    if (!contextRegistry) return false;
    return contextRegistry.disable(providerId);
  });

  // Configure a provider
  ipcMain.handle('voice-task-sdk:configure-provider', (_event, providerId, settings) => {
    if (!contextRegistry) return false;
    return contextRegistry.configure(providerId, settings);
  });

  // Get current context
  ipcMain.handle('voice-task-sdk:get-context', async () => {
    return await getAggregatedContext();
  });

  // Add custom fact
  ipcMain.handle('voice-task-sdk:add-fact', (_event, key, value, category) => {
    if (customFactsProvider && customFactsProvider.addFact) {
      customFactsProvider.addFact({ key, value, category });
      return true;
    }
    return false;
  });

  // Remove custom fact
  ipcMain.handle('voice-task-sdk:remove-fact', (_event, key) => {
    if (customFactsProvider && customFactsProvider.removeFact) {
      return customFactsProvider.removeFact(key);
    }
    return false;
  });

  // Get custom facts
  ipcMain.handle('voice-task-sdk:get-facts', () => {
    if (customFactsProvider && customFactsProvider.getFacts) {
      return customFactsProvider.getFacts();
    }
    return [];
  });

  log.info('voice', '[VoiceTaskSDK] IPC handlers registered');
}

/**
 * Get the SDK instance
 */
function getVoiceTaskSDK() {
  return sdk;
}

/**
 * Check if SDK is initialized
 */
function isSDKInitialized() {
  return isInitialized;
}

/**
 * Cleanup SDK resources
 */
function cleanup() {
  if (sdk) {
    sdk.stop();
    sdk = null;
  }
  isInitialized = false;

  // Clear conversation history on cleanup
  conversationHistory = [];

  // Dispose context registry
  if (contextRegistry) {
    contextRegistry.dispose();
    contextRegistry = null;
    temporalProvider = null;
    activeAppProvider = null;
    customFactsProvider = null;
  }

  // Remove IPC handlers
  const handlers = [
    'voice-task-sdk:status',
    'voice-task-sdk:submit',
    'voice-task-sdk:submit-action',
    'voice-task-sdk:queue-stats',
    'voice-task-sdk:list-queues',
    'voice-task-sdk:pending-tasks',
    'voice-task-sdk:list-tasks',
    'voice-task-sdk:cancel-task',
    'voice-task-sdk:list-agents',
    'voice-task-sdk:pause-queue',
    'voice-task-sdk:resume-queue',
    'voice-task-sdk:clear-completed',
    'voice-task-sdk:create-queue',
    'voice-task-sdk:register-agent',
    'voice-task-sdk:get-history',
    'voice-task-sdk:clear-history',
    'voice-task-sdk:add-history',
    'voice-task-sdk:list-providers',
    'voice-task-sdk:enable-provider',
    'voice-task-sdk:disable-provider',
    'voice-task-sdk:configure-provider',
    'voice-task-sdk:get-context',
    'voice-task-sdk:add-fact',
    'voice-task-sdk:remove-fact',
    'voice-task-sdk:get-facts',
  ];

  handlers.forEach((handler) => {
    try {
      ipcMain.removeHandler(handler);
    } catch (_e) {
      // Handler may not exist
    }
  });

  log.info('voice', '[VoiceTaskSDK] Cleanup complete');
}

module.exports = {
  initializeVoiceTaskSDK,
  getVoiceTaskSDK,
  isSDKInitialized,
  cleanup,
  classifyTranscript,
  // Conversation history exports
  addUserMessage,
  addAssistantMessage,
  getConversationHistory,
  clearConversationHistory,
};
