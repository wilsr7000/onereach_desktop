/**
 * IPC Adapter - Bridges the new Voice SDK with existing Electron IPC interface
 * 
 * Maintains backward compatibility with the existing realtime-speech.js IPC interface
 * while using the new SDK's speech services internally.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { createSpeechManager, type SpeechManager } from '../voice/services/speechManager'
import type { VoiceState } from '../voice/types'

export interface IPCAdapterConfig {
  apiKey?: string
  getApiKey?: () => string | null
  language?: string
  preferredBackend?: 'realtime' | 'whisper'
}

export interface IPCAdapter {
  setup: () => void
  cleanup: () => void
  getSpeechManager: () => SpeechManager | null
  isConnected: () => boolean
}

export function createIPCAdapter(config: IPCAdapterConfig = {}): IPCAdapter {
  let speechManager: SpeechManager | null = null
  let isActive = false

  // Get API key from config or external source
  function getApiKey(): string | null {
    if (config.apiKey) return config.apiKey
    if (config.getApiKey) return config.getApiKey()
    // Try global settings manager (OneReach app pattern)
    if (typeof global !== 'undefined' && (global as any).settingsManager) {
      return (global as any).settingsManager.get('openaiApiKey')
    }
    return null
  }

  // Broadcast event to all renderer windows
  function broadcastEvent(eventType: string, data: any): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('realtime-speech:event', {
          type: eventType,
          ...data
        })
      }
    })
  }

  // Map SDK state changes to legacy event format
  function handleStateChange(state: Partial<VoiceState>): void {
    if (state.status === 'listening') {
      broadcastEvent('speech_started', {})
    } else if (state.status === 'idle' && isActive) {
      broadcastEvent('speech_stopped', {})
    } else if (state.status === 'error') {
      broadcastEvent('error', { error: state.error || 'Unknown error' })
    }

    if (state.connectionState === 'connected') {
      broadcastEvent('connected', { backend: state.backend || 'realtime' })
    } else if (state.connectionState === 'disconnected') {
      broadcastEvent('disconnected', {})
    }
  }

  // Handle transcript events
  function handleTranscript(transcript: string, isFinal: boolean): void {
    if (isFinal) {
      broadcastEvent('transcript', { text: transcript, isFinal: true })
    } else {
      broadcastEvent('transcript_delta', { text: transcript, isFinal: false })
    }
  }

  // Handle errors
  function handleError(error: Error): void {
    console.error('[IPCAdapter] Speech error:', error.message)
    broadcastEvent('error', { error: error.message })
  }

  // Handle volume changes
  function handleVolumeChange(volume: number): void {
    broadcastEvent('volume', { level: volume })
  }

  // Initialize speech manager
  function initializeSpeechManager(): boolean {
    const apiKey = getApiKey()
    if (!apiKey) {
      console.warn('[IPCAdapter] No API key available')
      return false
    }

    if (speechManager) {
      speechManager.destroy()
    }

    speechManager = createSpeechManager({
      apiKey,
      preferredBackend: config.preferredBackend || 'realtime',
      language: config.language || 'en',
      fallbackEnabled: true,
      onTranscript: handleTranscript,
      onError: handleError,
      onStateChange: handleStateChange,
      onVolumeChange: handleVolumeChange,
    })

    console.log('[IPCAdapter] Speech manager initialized')
    return true
  }

  // Setup IPC handlers
  function setup(): void {
    // Connect to speech service
    ipcMain.handle('realtime-speech:connect', async () => {
      try {
        if (!speechManager) {
          if (!initializeSpeechManager()) {
            throw new Error('Failed to initialize speech manager - no API key')
          }
        }

        await speechManager!.start()
        isActive = true
        console.log('[IPCAdapter] Connected')
        return true
      } catch (error) {
        console.error('[IPCAdapter] Connect error:', error)
        return false
      }
    })

    // Disconnect from speech service
    ipcMain.handle('realtime-speech:disconnect', () => {
      if (speechManager) {
        speechManager.stop()
        isActive = false
        console.log('[IPCAdapter] Disconnected')
      }
      return true
    })

    // Check connection status
    ipcMain.handle('realtime-speech:is-connected', () => {
      return speechManager?.isActive() || false
    })

    // Send audio chunk (for Whisper mode or manual audio streaming)
    ipcMain.handle('realtime-speech:send-audio', (_event, base64Audio: string) => {
      // The new SDK handles audio internally via getUserMedia
      // This is kept for compatibility but may not be needed
      console.log('[IPCAdapter] send-audio called (handled internally by SDK)')
      return true
    })

    // Commit audio buffer
    ipcMain.handle('realtime-speech:commit', () => {
      // In the new SDK, this is handled automatically by VAD
      console.log('[IPCAdapter] commit called (handled by VAD)')
      return true
    })

    // Clear audio buffer
    ipcMain.handle('realtime-speech:clear', () => {
      // Clear is handled internally
      console.log('[IPCAdapter] clear called')
      return true
    })

    // Get current backend
    ipcMain.handle('realtime-speech:get-backend', () => {
      return speechManager?.getBackend() || 'none'
    })

    // Set preferred backend
    ipcMain.handle('realtime-speech:set-backend', (_event, backend: 'realtime' | 'whisper') => {
      if (speechManager) {
        speechManager.setBackend(backend)
        return true
      }
      return false
    })

    // Get speech state
    ipcMain.handle('realtime-speech:get-state', () => {
      if (speechManager) {
        return speechManager.getState()
      }
      return {
        status: 'idle',
        isListening: false,
        isSpeaking: false,
        transcript: '',
        interimTranscript: '',
        error: null,
        volume: 0,
        backend: 'none',
        connectionState: 'disconnected',
      }
    })

    console.log('[IPCAdapter] IPC handlers registered')
  }

  // Cleanup
  function cleanup(): void {
    if (speechManager) {
      speechManager.destroy()
      speechManager = null
    }
    isActive = false

    // Remove IPC handlers
    ipcMain.removeHandler('realtime-speech:connect')
    ipcMain.removeHandler('realtime-speech:disconnect')
    ipcMain.removeHandler('realtime-speech:is-connected')
    ipcMain.removeHandler('realtime-speech:send-audio')
    ipcMain.removeHandler('realtime-speech:commit')
    ipcMain.removeHandler('realtime-speech:clear')
    ipcMain.removeHandler('realtime-speech:get-backend')
    ipcMain.removeHandler('realtime-speech:set-backend')
    ipcMain.removeHandler('realtime-speech:get-state')

    console.log('[IPCAdapter] Cleaned up')
  }

  return {
    setup,
    cleanup,
    getSpeechManager: () => speechManager,
    isConnected: () => isActive,
  }
}

// Singleton instance for easy access
let adapterInstance: IPCAdapter | null = null

export function getIPCAdapter(config?: IPCAdapterConfig): IPCAdapter {
  if (!adapterInstance && config) {
    adapterInstance = createIPCAdapter(config)
  }
  if (!adapterInstance) {
    throw new Error('IPC Adapter not initialized')
  }
  return adapterInstance
}

export function setupIPCAdapter(config?: IPCAdapterConfig): IPCAdapter {
  adapterInstance = createIPCAdapter(config)
  adapterInstance.setup()
  return adapterInstance
}
