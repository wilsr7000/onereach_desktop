/**
 * Speech Recognition Bridge for Electron
 * 
 * Provides speech-to-text functionality for web apps running in Electron
 * since the Web Speech API doesn't work reliably in Electron.
 * 
 * Uses ElevenLabs Scribe API for transcription (unified TranscriptionService).
 * 
 * Usage from web app:
 *   // Check if running in Electron
 *   if (window.speechBridge) {
 *     // Use Electron's speech bridge
 *     const result = await window.speechBridge.transcribe(audioBlob);
 *   } else {
 *     // Fall back to Web Speech API
 *     const recognition = new webkitSpeechRecognition();
 *   }
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class SpeechRecognitionBridge {
  constructor() {
    this.isRecording = false;
    this.tempDir = path.join(os.tmpdir(), 'onereach-speech');
    this.transcriptionService = null;
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }
  
  /**
   * Get the TranscriptionService (lazy load)
   */
  async getTranscriptionService() {
    if (!this.transcriptionService) {
      const { getTranscriptionService } = await import('./src/transcription/index.js');
      this.transcriptionService = getTranscriptionService();
    }
    return this.transcriptionService;
  }
  
  /**
   * Set up IPC handlers
   */
  setupIPC() {
    // Transcribe audio using ElevenLabs Scribe
    ipcMain.handle('speech:transcribe', async (event, options) => {
      try {
        const { audioData, language, format } = options;
        
        // Decode base64 audio data
        const audioBuffer = Buffer.from(audioData, 'base64');
        
        // Save to temp file
        const tempFile = path.join(this.tempDir, `audio_${Date.now()}.${format || 'webm'}`);
        fs.writeFileSync(tempFile, audioBuffer);
        
        // Get transcription service
        const service = await this.getTranscriptionService();
        
        // Check if service is available
        const isAvailable = await service.isAvailable();
        if (!isAvailable) {
          fs.unlinkSync(tempFile);
          return {
            success: false,
            error: 'ElevenLabs API key not configured. Please set it in Settings.'
          };
        }
        
        // Transcribe using unified service
        const result = await service.transcribe(tempFile, {
          language: language || null,
          diarize: true  // Enable speaker identification
        });
        
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
        
        return result;
        
      } catch (error) {
        console.error('[SpeechBridge] Transcription error:', error);
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Transcribe from file path
    ipcMain.handle('speech:transcribe-file', async (event, options) => {
      try {
        const { filePath, language, diarize = true } = options;
        
        // Get transcription service
        const service = await this.getTranscriptionService();
        
        // Check if service is available
        const isAvailable = await service.isAvailable();
        if (!isAvailable) {
          return {
            success: false,
            error: 'ElevenLabs API key not configured'
          };
        }
        
        // Transcribe using unified service
        return await service.transcribe(filePath, {
          language: language || null,
          diarize
        });
        
      } catch (error) {
        console.error('[SpeechBridge] File transcription error:', error);
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Check if speech bridge is available
    ipcMain.handle('speech:is-available', async () => {
      try {
        const service = await this.getTranscriptionService();
        const isAvailable = await service.isAvailable();
        const info = service.getServiceInfo();
        
        return {
          available: true,
          hasApiKey: isAvailable,
          method: 'elevenlabs-scribe',
          features: info.features
        };
      } catch (e) {
        return {
          available: false,
          hasApiKey: false,
          method: 'elevenlabs-scribe',
          error: e.message
        };
      }
    });
    
    // Request microphone permission from macOS
    ipcMain.handle('speech:request-mic-permission', async () => {
      if (process.platform !== 'darwin') {
        return { granted: true, status: 'not-darwin' };
      }
      
      const { systemPreferences } = require('electron');
      try {
        const status = systemPreferences.getMediaAccessStatus('microphone');
        console.log(`[SpeechBridge] Microphone status: ${status}`);
        
        if (status === 'granted') {
          return { granted: true, status };
        }
        
        console.log('[SpeechBridge] Requesting microphone access...');
        const granted = await systemPreferences.askForMediaAccess('microphone');
        const newStatus = systemPreferences.getMediaAccessStatus('microphone');
        console.log(`[SpeechBridge] Microphone access result: ${granted}, status: ${newStatus}`);
        
        return { granted, status: newStatus };
      } catch (err) {
        console.error('[SpeechBridge] Error requesting mic permission:', err);
        return { granted: false, status: 'error', error: err.message };
      }
    });
    
    // Get transcription service info
    ipcMain.handle('speech:get-service-info', async () => {
      try {
        const service = await this.getTranscriptionService();
        return service.getServiceInfo();
      } catch (e) {
        return { error: e.message };
      }
    });
    
    console.log('[SpeechBridge] IPC handlers registered (using ElevenLabs Scribe)');
  }
  
  /**
   * Clean up temp files
   */
  cleanup() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.tempDir, file));
        }
      }
    } catch (e) {
      console.error('[SpeechBridge] Cleanup error:', e);
    }
  }
}

// Singleton instance
let instance = null;

function getSpeechBridge() {
  if (!instance) {
    instance = new SpeechRecognitionBridge();
  }
  return instance;
}

module.exports = { SpeechRecognitionBridge, getSpeechBridge };
