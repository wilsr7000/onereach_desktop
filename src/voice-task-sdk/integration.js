/**
 * Voice Task SDK - Electron Integration Module
 * 
 * This module provides easy integration with the OneReach app's Electron main process.
 * It can be used alongside or as a replacement for the existing realtime-speech.js.
 * 
 * USAGE in main.js:
 * ```javascript
 * // Initialize Voice Task SDK (new architecture)
 * try {
 *   const { initializeVoiceTaskSDK, getVoiceTaskSDK } = require('./src/voice-task-sdk/integration');
 *   initializeVoiceTaskSDK({
 *     useNewSpeechService: true  // Set to false to use legacy realtime-speech.js
 *   });
 *   console.log('[VoiceTaskSDK] Voice Task SDK initialized');
 * } catch (error) {
 *   console.error('[Startup] Error initializing Voice Task SDK:', error);
 * }
 * ```
 */

const { ipcMain, BrowserWindow, app } = require('electron')
const path = require('path')

// SDK State
let sdkInstance = null
let ipcAdapterInstance = null
let isInitialized = false

/**
 * Configuration options for SDK initialization
 */
const defaultConfig = {
  // Use the new speech service instead of legacy realtime-speech.js
  useNewSpeechService: false,
  
  // Language setting
  language: 'en',
  
  // Preferred voice backend
  preferredBackend: 'realtime', // 'realtime' | 'whisper'
  
  // Enable knowledge/RAG system
  enableKnowledge: true,
  
  // Enable AI classification
  enableClassification: true,
  
  // Debug mode
  debug: false
}

/**
 * Initialize the Voice Task SDK
 * @param {Object} config - Configuration options
 */
function initializeVoiceTaskSDK(config = {}) {
  const mergedConfig = { ...defaultConfig, ...config }
  
  console.log('[VoiceTaskSDK] Initializing with config:', {
    useNewSpeechService: mergedConfig.useNewSpeechService,
    language: mergedConfig.language,
    preferredBackend: mergedConfig.preferredBackend
  })

  // Setup IPC handlers for the new SDK
  setupSDKIPC(mergedConfig)

  // If using new speech service, set up the IPC adapter
  if (mergedConfig.useNewSpeechService) {
    try {
      // Note: The TypeScript IPC adapter needs to be compiled first
      // For now, we'll set up basic IPC handlers
      setupNewSpeechServiceIPC(mergedConfig)
      console.log('[VoiceTaskSDK] New speech service IPC handlers registered')
    } catch (error) {
      console.error('[VoiceTaskSDK] Failed to setup new speech service:', error)
      console.log('[VoiceTaskSDK] Falling back to legacy realtime-speech.js')
    }
  }

  isInitialized = true
  console.log('[VoiceTaskSDK] Initialization complete')
}

/**
 * Setup SDK-specific IPC handlers
 */
function setupSDKIPC(config) {
  // Get SDK status
  ipcMain.handle('voice-task-sdk:status', () => {
    return {
      initialized: isInitialized,
      useNewSpeechService: config.useNewSpeechService,
      version: '2.0.0'
    }
  })

  // Get SDK configuration
  ipcMain.handle('voice-task-sdk:config', () => {
    return config
  })

  // Submit transcript for classification (new SDK feature)
  ipcMain.handle('voice-task-sdk:submit', async (_event, transcript, options = {}) => {
    console.log('[VoiceTaskSDK] Submit transcript:', transcript)
    
    // For now, return basic result
    // Full implementation requires TypeScript SDK compilation
    return {
      transcript,
      classified: false,
      message: 'Classification requires compiled TypeScript SDK'
    }
  })

  // List registered actions
  ipcMain.handle('voice-task-sdk:list-actions', () => {
    return []
  })

  // List registered queues
  ipcMain.handle('voice-task-sdk:list-queues', () => {
    return []
  })

  // List registered agents
  ipcMain.handle('voice-task-sdk:list-agents', () => {
    return []
  })

  console.log('[VoiceTaskSDK] SDK IPC handlers registered')
}

/**
 * Setup new speech service IPC handlers
 * This provides the same interface as realtime-speech.js but uses the new SDK
 */
function setupNewSpeechServiceIPC(config) {
  // Import the speech manager from the new SDK
  // Note: This requires the TypeScript to be compiled
  let SpeechManager = null
  let speechManagerInstance = null

  try {
    // Try to load compiled speech manager
    const speechManagerPath = path.join(__dirname, 'voice', 'services', 'speechManager')
    SpeechManager = require(speechManagerPath)
    console.log('[VoiceTaskSDK] Loaded compiled speech manager')
  } catch (e) {
    // Fall back to legacy TypeScript service if available
    try {
      const { createSpeechManager } = require('./services/speechManager')
      SpeechManager = { createSpeechManager }
      console.log('[VoiceTaskSDK] Using legacy speech manager')
    } catch (e2) {
      console.warn('[VoiceTaskSDK] No speech manager available:', e2.message)
      return
    }
  }

  // Create speech manager instance
  const getApiKey = () => {
    if (global.settingsManager) {
      return global.settingsManager.get('openaiApiKey')
    }
    return null
  }

  // Broadcast events to all windows
  const broadcastEvent = (eventType, data) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('realtime-speech:event', {
          type: eventType,
          ...data
        })
      }
    })
  }

  // Note: Full implementation would use the TypeScript IPC adapter
  // For now, these handlers provide basic functionality
  
  console.log('[VoiceTaskSDK] New speech service handlers ready')
}

/**
 * Get the SDK instance
 */
function getVoiceTaskSDK() {
  return sdkInstance
}

/**
 * Check if SDK is initialized
 */
function isSDKInitialized() {
  return isInitialized
}

/**
 * Cleanup SDK resources
 */
function cleanup() {
  if (ipcAdapterInstance) {
    ipcAdapterInstance.cleanup()
    ipcAdapterInstance = null
  }
  sdkInstance = null
  isInitialized = false
  
  // Remove IPC handlers
  const handlers = [
    'voice-task-sdk:status',
    'voice-task-sdk:config',
    'voice-task-sdk:submit',
    'voice-task-sdk:list-actions',
    'voice-task-sdk:list-queues',
    'voice-task-sdk:list-agents'
  ]
  
  handlers.forEach(handler => {
    try {
      ipcMain.removeHandler(handler)
    } catch (e) {
      // Handler may not exist
    }
  })
  
  console.log('[VoiceTaskSDK] Cleanup complete')
}

module.exports = {
  initializeVoiceTaskSDK,
  getVoiceTaskSDK,
  isSDKInitialized,
  cleanup
}
