/**
 * Voice Task SDK - Main Entry Point
 * 
 * This module provides both the legacy VoiceTaskSDK class for backward compatibility
 * and exports from the new modular SDK architecture.
 * 
 * LEGACY USAGE (backward compatible):
 * ```javascript
 * const { VoiceTaskSDK } = require('./src/voice-task-sdk')
 * const sdk = new VoiceTaskSDK({ apiKey: 'sk-...' })
 * await sdk.startListening()
 * ```
 * 
 * NEW USAGE (recommended):
 * ```javascript
 * const { createVoiceTaskSDK } = require('./src/voice-task-sdk')
 * const sdk = createVoiceTaskSDK({ 
 *   openaiKey: 'sk-...',
 *   classifier: { type: 'ai' }
 * })
 * await sdk.submit('send an email to John')
 * ```
 */

// =============================================================================
// LEGACY API (backward compatibility)
// =============================================================================

const { createSpeechManager } = require('./services/speechManager')
const TaskManager = require('./services/taskManager')

class VoiceTaskSDK {
  constructor(options = {}) {
    this.config = {
      // Voice settings
      apiKey: options.apiKey || (typeof localStorage !== 'undefined' ? localStorage.getItem('onereach-api-key') : null),
      language: options.language || 'en',
      silenceTimeout: options.silenceTimeout || 1500,
      preferredBackend: options.preferredBackend || 'realtime',
      
      // Task settings
      enableTaskCommands: options.enableTaskCommands !== false,
      taskStorageKey: options.taskStorageKey || 'onereach-tasks',
      syncWithSpaces: options.syncWithSpaces || false,
      spacesService: options.spacesService || null,
      
      // Callbacks
      onVoiceInput: options.onVoiceInput || (() => {}),
      onTaskCreated: options.onTaskCreated || (() => {}),
      onTaskUpdated: options.onTaskUpdated || (() => {}),
      onTaskDeleted: options.onTaskDeleted || (() => {}),
      onError: options.onError || ((err) => console.error('[SDK]', err)),
      
      ...options
    }

    // Initialize Task Manager
    this.tasks = new TaskManager({
      storageKey: this.config.taskStorageKey,
      syncWithSpaces: this.config.syncWithSpaces,
      spacesService: this.config.spacesService,
      onTaskChange: this._handleTaskChange.bind(this)
    })

    // Voice state
    this.voice = {
      isListening: false,
      currentBackend: 'none',
      speechManager: null
    }

    // Internal state
    this.state = {
      isInitialized: false,
      lastVoiceInput: null,
      lastTask: null
    }

    console.log('[VoiceTaskSDK] Initialized (legacy mode)')
  }

  async initializeVoice() {
    if (!this.config.apiKey) {
      throw new Error('API key is required for voice input')
    }

    this.voice.speechManager = createSpeechManager({
      onEvent: this._handleSpeechEvent.bind(this),
      language: this.config.language,
      preferredBackend: this.config.preferredBackend
    })

    this.voice.speechManager.initialize(this.config.apiKey)
    this.state.isInitialized = true
    
    console.log('[VoiceTaskSDK] Voice initialized')
  }

  async startListening() {
    if (!this.state.isInitialized) {
      await this.initializeVoice()
    }

    const success = await this.voice.speechManager.startListening()
    if (success) {
      this.voice.isListening = true
      console.log('[VoiceTaskSDK] Listening started')
    }
    
    return success
  }

  stopListening() {
    if (this.voice.speechManager) {
      this.voice.speechManager.stopListening()
      this.voice.isListening = false
      console.log('[VoiceTaskSDK] Listening stopped')
    }
  }

  _handleSpeechEvent(event) {
    switch (event.type) {
      case 'connected':
        this.voice.currentBackend = event.backend
        console.log('[VoiceTaskSDK] Connected:', event.backend)
        break

      case 'transcript_final':
        if (event.transcript) {
          this._processVoiceInput(event.transcript)
        }
        break

      case 'backend_changed':
        this.voice.currentBackend = event.backend
        break

      case 'error':
        this.config.onError({ type: 'voice_error', message: event.error })
        break
    }
  }

  _processVoiceInput(text) {
    console.log('[VoiceTaskSDK] Voice input:', text)
    
    this.state.lastVoiceInput = text
    this.config.onVoiceInput(text)

    if (this.config.enableTaskCommands) {
      this._handleTaskCommand(text)
    }
  }

  _handleTaskCommand(text) {
    const normalized = text.toLowerCase().trim()

    // Add task commands
    if (normalized.startsWith('add task') || normalized.startsWith('create task') || normalized.startsWith('new task')) {
      const title = text.replace(/^(add|create|new) task /i, '').trim()
      if (title) {
        const task = this.tasks.add({ title, status: 'pending', priority: 'medium' })
        this.config.onTaskCreated(task)
        console.log('[VoiceTaskSDK] Task created from voice:', task.title)
      }
      return
    }

    // List tasks commands
    if (normalized.includes('show tasks') || normalized.includes('list tasks') || normalized.includes('my tasks')) {
      const tasks = this.tasks.getAll()
      console.log('[VoiceTaskSDK] Tasks requested:', tasks.length)
      if (this.config.onTasksRequested) {
        this.config.onTasksRequested(tasks)
      }
      return
    }

    // Complete task commands
    const completeMatch = normalized.match(/^(complete|finish|done) (?:task )?(.+)$/i)
    if (completeMatch) {
      const taskTitle = completeMatch[2]
      const task = this.tasks.getAll().find(t => 
        t.title.toLowerCase().includes(taskTitle) && t.status !== 'completed'
      )
      if (task) {
        this.tasks.update(task.id, { status: 'completed' })
        console.log('[VoiceTaskSDK] Task completed:', task.title)
      }
      return
    }

    // Delete task commands
    const deleteMatch = normalized.match(/^(delete|remove) (?:task )?(.+)$/i)
    if (deleteMatch) {
      const taskTitle = deleteMatch[2]
      const task = this.tasks.getAll().find(t => 
        t.title.toLowerCase().includes(taskTitle)
      )
      if (task) {
        this.tasks.delete(task.id)
        this.config.onTaskDeleted(task)
        console.log('[VoiceTaskSDK] Task deleted:', task.title)
      }
      return
    }

    // High priority tasks
    if (normalized.includes('high priority') || normalized.includes('urgent tasks')) {
      const tasks = this.tasks.getHighPriority()
      console.log('[VoiceTaskSDK] High priority tasks:', tasks.length)
      if (this.config.onTasksRequested) {
        this.config.onTasksRequested(tasks)
      }
      return
    }

    // Overdue tasks
    if (normalized.includes('overdue')) {
      const tasks = this.tasks.getOverdue()
      console.log('[VoiceTaskSDK] Overdue tasks:', tasks.length)
      if (this.config.onTasksRequested) {
        this.config.onTasksRequested(tasks)
      }
      return
    }
  }

  _handleTaskChange(tasks) {
    this.state.lastTask = tasks[tasks.length - 1]
  }

  getStatus() {
    return {
      voice: {
        isInitialized: this.state.isInitialized,
        isListening: this.voice.isListening,
        currentBackend: this.voice.currentBackend
      },
      tasks: {
        total: this.tasks.getAll().length,
        ...this.tasks.getStats()
      }
    }
  }

  exportData() {
    return {
      tasks: JSON.parse(this.tasks.export()),
      exportedAt: new Date().toISOString()
    }
  }

  importData(data) {
    if (data.tasks) {
      this.tasks.import(JSON.stringify(data.tasks))
    }
  }

  destroy() {
    this.stopListening()
    this.voice.speechManager = null
    this.state.isInitialized = false
    console.log('[VoiceTaskSDK] Destroyed')
  }
}

// =============================================================================
// NEW MODULAR SDK EXPORTS
// =============================================================================

// The new SDK is written in TypeScript - these will be available after compilation
// For now, we expose paths for direct TypeScript imports

const SDK_VERSION = '2.0.0'

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
  // Legacy API (backward compatible)
  VoiceTaskSDK,
  default: VoiceTaskSDK,
  
  // Version info
  SDK_VERSION,
  
  // New SDK paths (for TypeScript/ESM imports)
  // Usage: const { createVoiceTaskSDK } = require('./src/voice-task-sdk/createSDK')
  paths: {
    createSDK: './createSDK',
    core: './core',
    classifier: './classifier',
    voice: './voice',
    knowledge: './knowledge',
    ui: './ui/react',
    electron: './electron'
  }
}

// ES6 export for modern usage
if (typeof window !== 'undefined') {
  window.VoiceTaskSDK = VoiceTaskSDK
}
