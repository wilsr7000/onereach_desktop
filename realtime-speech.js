/**
 * Realtime Speech - Backward Compatibility Wrapper
 * 
 * This file maintains backward compatibility with existing code.
 * Actual functionality is delegated to:
 * - voice-listener.js: Speech-to-text transcription
 * - voice-speaker.js: Text-to-speech
 * 
 * New code should import from voice-listener.js or voice-speaker.js directly.
 */

const { ipcMain } = require('electron');
const { getVoiceListener } = require('./voice-listener');
const { getVoiceSpeaker, PRIORITY } = require('./voice-speaker');

class RealtimeSpeech {
  constructor() {
    // Delegate to specialized modules
    this.listener = getVoiceListener();
    this.speaker = getVoiceSpeaker();
    
    console.log('[RealtimeSpeech] Initialized (compatibility wrapper)');
  }

  // ==================== LISTENER DELEGATION ====================
  
  get isConnected() {
    return this.listener.isConnected;
  }
  
  get sessionId() {
    return this.listener.sessionId;
  }
  
  get subscribers() {
    return this.listener.subscribers;
  }
  
  get hasActiveResponse() {
    return this.listener.hasActiveResponse;
  }

  getApiKey() {
    return this.listener.getApiKey();
  }

  clearApiKey() {
    this.listener.clearApiKey();
    this.speaker.clearApiKey();
  }

  async connect() {
    return this.listener.connect();
  }

  sendEvent(event) {
    return this.listener.sendEvent(event);
  }

  sendAudio(base64Audio) {
    return this.listener.sendAudio(base64Audio);
  }

  commitAudio() {
    return this.listener.commitAudio();
  }

  clearAudio() {
    return this.listener.clearAudio();
  }

  subscribe(webContentsId, callback) {
    return this.listener.subscribe(webContentsId, callback);
  }

  unsubscribe(webContentsId) {
    return this.listener.unsubscribe(webContentsId);
  }

  broadcast(event) {
    // Broadcast to both listener and speaker subscribers
    this.listener.broadcast(event);
    this.speaker.broadcast(event);
  }

  disconnect() {
    return this.listener.disconnect();
  }

  cancelResponse(cancelQueue = false) {
    if (cancelQueue) {
      this.speaker.cancel();
    }
    return this.listener.cancelResponse();
  }

  respondToFunctionCall(callId, result, options = {}) {
    // Acknowledge the function call
    this.listener.respondToFunctionCall(callId, '');
    
    // Speak the result via voice-speaker
    if (result && result.trim()) {
      this.speaker.speak(result, { voice: options.voice });
    }
    
    return true;
  }

  // ==================== SPEAKER DELEGATION ====================

  get speechQueue() {
    return this.speaker.speechQueue;
  }
  
  get isTTSSpeaking() {
    return this.speaker.isSpeaking;
  }

  async speak(text, options = {}) {
    return this.speaker.speak(text, options);
  }

  // ==================== IPC HANDLERS ====================
  
  setupIPC() {
    // Set up listener IPC
    this.listener.setupIPC();
    
    // Legacy IPC handlers that delegate to new modules
    // These maintain backward compatibility with existing preload scripts
    
    ipcMain.handle('realtime-speech:connect', async (event) => {
      try {
        await this.connect();
        
        const webContentsId = event.sender.id;
        this.subscribe(webContentsId, (speechEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('realtime-speech:event', speechEvent);
          }
        });
        
        return { success: true, sessionId: this.sessionId };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('realtime-speech:send-audio', async (event, base64Audio) => {
      return this.sendAudio(base64Audio);
    });

    ipcMain.handle('realtime-speech:commit', async () => {
      return this.commitAudio();
    });

    ipcMain.handle('realtime-speech:clear', async () => {
      return this.clearAudio();
    });

    ipcMain.handle('realtime-speech:disconnect', async (event) => {
      const webContentsId = event.sender.id;
      this.unsubscribe(webContentsId);
      return { success: true };
    });

    ipcMain.handle('realtime-speech:is-connected', async () => {
      return {
        connected: this.isConnected,
        sessionId: this.sessionId,
        hasApiKey: !!this.getApiKey()
      };
    });

    ipcMain.handle('realtime-speech:speak', async (event, text, options = {}) => {
      try {
        const webContentsId = event.sender.id;
        if (!this.subscribers.has(webContentsId)) {
          this.subscribe(webContentsId, (speechEvent) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('realtime-speech:event', speechEvent);
            }
          });
        }
        
        const result = await this.speak(text, options);
        return { success: result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('realtime-speech:cancel-response', async (event, cancelQueue = false) => {
      return { success: this.cancelResponse(cancelQueue) };
    });
    
    ipcMain.handle('realtime-speech:cancel-all', async () => {
      await this.speaker.cancel();
      return { success: true };
    });
    
    ipcMain.handle('realtime-speech:queue-status', async () => {
      return this.speaker.getStatus();
    });
    
    ipcMain.handle('realtime-speech:respond-to-function', async (event, callId, result) => {
      try {
        const success = this.respondToFunctionCall(callId, result);
        return { success };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    console.log('[RealtimeSpeech] IPC handlers registered (compatibility)');
  }
}

// Singleton instance
let instance = null;

function getRealtimeSpeech() {
  if (!instance) {
    instance = new RealtimeSpeech();
  }
  return instance;
}

module.exports = { RealtimeSpeech, getRealtimeSpeech, PRIORITY };
