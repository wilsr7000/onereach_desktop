/**
 * Speech Recognition Bridge for Electron
 * 
 * Provides speech-to-text functionality for web apps running in Electron
 * since the Web Speech API doesn't work reliably in Electron.
 * 
 * Uses OpenAI Whisper API for transcription.
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
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

class SpeechRecognitionBridge {
  constructor() {
    this.apiKey = null;
    this.isRecording = false;
    this.tempDir = path.join(os.tmpdir(), 'onereach-speech');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }
  
  /**
   * Initialize with API key
   */
  initialize(apiKey) {
    this.apiKey = apiKey;
    console.log('[SpeechBridge] Initialized with API key');
  }
  
  /**
   * Set up IPC handlers
   */
  setupIPC() {
    // Get API key from settings
    ipcMain.handle('speech:get-api-key', async () => {
      if (global.settingsManager) {
        return global.settingsManager.get('openaiApiKey') || null;
      }
      return null;
    });
    
    // Transcribe audio using Whisper
    ipcMain.handle('speech:transcribe', async (event, options) => {
      try {
        const { audioData, language, format } = options;
        
        // Get API key
        let apiKey = this.apiKey;
        if (!apiKey && global.settingsManager) {
          apiKey = global.settingsManager.get('openaiApiKey');
        }
        
        if (!apiKey) {
          return {
            success: false,
            error: 'OpenAI API key not configured. Please set it in Settings.'
          };
        }
        
        // Decode base64 audio data
        const audioBuffer = Buffer.from(audioData, 'base64');
        
        // Save to temp file
        const tempFile = path.join(this.tempDir, `audio_${Date.now()}.${format || 'webm'}`);
        fs.writeFileSync(tempFile, audioBuffer);
        
        // Transcribe using Whisper
        const result = await this.transcribeWithWhisper(tempFile, apiKey, language);
        
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
        const { filePath, language } = options;
        
        let apiKey = this.apiKey;
        if (!apiKey && global.settingsManager) {
          apiKey = global.settingsManager.get('openaiApiKey');
        }
        
        if (!apiKey) {
          return {
            success: false,
            error: 'OpenAI API key not configured'
          };
        }
        
        return await this.transcribeWithWhisper(filePath, apiKey, language);
        
      } catch (error) {
        console.error('[SpeechBridge] File transcription error:', error);
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Check if speech bridge is available
    ipcMain.handle('speech:is-available', () => {
      let apiKey = this.apiKey;
      if (!apiKey && global.settingsManager) {
        apiKey = global.settingsManager.get('openaiApiKey');
      }
      return {
        available: true,
        hasApiKey: !!apiKey,
        method: 'whisper'
      };
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
    
    console.log('[SpeechBridge] IPC handlers registered');
  }
  
  /**
   * Transcribe audio file using OpenAI Whisper API
   */
  async transcribeWithWhisper(filePath, apiKey, language = 'en') {
    return new Promise((resolve, reject) => {
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      
      // Create multipart form data boundary
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      
      // Build multipart form data
      const formParts = [];
      
      // Add file part
      formParts.push(
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
        `Content-Type: audio/${path.extname(filePath).slice(1) || 'webm'}\r\n\r\n`
      );
      
      const filePartHeader = Buffer.from(formParts.join(''));
      const filePartFooter = Buffer.from('\r\n');
      
      // Add model part
      const modelPart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-1\r\n`
      );
      
      // Add language part (optional)
      const languagePart = language ? Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language}\r\n`
      ) : Buffer.alloc(0);
      
      // Add response format part
      const formatPart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
      );
      
      // End boundary
      const endBoundary = Buffer.from(`--${boundary}--\r\n`);
      
      // Combine all parts
      const requestBody = Buffer.concat([
        filePartHeader,
        fileBuffer,
        filePartFooter,
        modelPart,
        languagePart,
        formatPart,
        endBoundary
      ]);
      
      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': requestBody.length
        }
      };
      
      console.log('[SpeechBridge] Sending to Whisper API...');
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode === 200) {
              console.log('[SpeechBridge] Transcription successful');
              resolve({
                success: true,
                text: response.text,
                language: language
              });
            } else {
              console.error('[SpeechBridge] API error:', response);
              resolve({
                success: false,
                error: response.error?.message || 'Transcription failed'
              });
            }
          } catch (e) {
            console.error('[SpeechBridge] Parse error:', e);
            resolve({
              success: false,
              error: 'Failed to parse response'
            });
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('[SpeechBridge] Request error:', error);
        resolve({
          success: false,
          error: error.message
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: 'Request timed out'
        });
      });
      
      req.setTimeout(60000); // 60 second timeout
      req.write(requestBody);
      req.end();
    });
  }
  
  /**
   * Clean up temp files
   */
  cleanup() {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.tempDir, file));
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// Singleton instance
let speechBridge = null;

function getSpeechBridge() {
  if (!speechBridge) {
    speechBridge = new SpeechRecognitionBridge();
  }
  return speechBridge;
}

module.exports = {
  SpeechRecognitionBridge,
  getSpeechBridge
};
