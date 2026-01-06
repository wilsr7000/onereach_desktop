/**
 * ElevenLabsService - ElevenLabs TTS API integration
 * @module src/video/audio/ElevenLabsService
 */

import { AudioReplacer } from './AudioReplacer.js';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
import { getSettingsManager } from '../../../settings-manager.js';
const { getBudgetManager } = require('../../../budget-manager.js');
const logger = require('../../logger.js');

// ElevenLabs voice IDs (popular voices)
const VOICE_IDS = {
  'Rachel': '21m00Tcm4TlvDq8ikWAM',
  'Domi': 'AZnzlk1XvdvUeBnXmlld',
  'Bella': 'EXAVITQu4vr4xnSDxMaL',
  'Antoni': 'ErXwobaYiN019PkySvjV',
  'Elli': 'MF3mGyEYCl7XYWbV9V6O',
  'Josh': 'TxGEqnHWrfWFTfGW9XjX',
  'Arnold': 'VR6AewLTigWG4xSOukaG',
  'Adam': 'pNInz6obpgDQGcFmaJgB',
  'Sam': 'yoZ06aMxZJJ28mfd3POQ'
};

/**
 * Service for ElevenLabs TTS integration
 */
export class ElevenLabsService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.audioReplacer = new AudioReplacer();
  }

  /**
   * Get API key from environment or settings
   * @returns {string|null} API key
   */
  getApiKey() {
    // Check environment first
    if (process.env.ELEVENLABS_API_KEY) {
      return process.env.ELEVENLABS_API_KEY;
    }
    
    // Check settings manager (encrypted storage)
    try {
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('elevenLabsApiKey');
      if (apiKey) {
        return apiKey;
      }
    } catch (e) {
      logger.warn('ElevenLabsService: Could not get API key from settings manager', { error: e.message });
    }
    
    // Fallback: Check legacy settings file
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return settings.elevenlabsApiKey || settings.elevenLabsApiKey || null;
      } catch (e) {
        return null;
      }
    }
    
    return null;
  }

  /**
   * Generate audio using ElevenLabs API
   * @param {string} text - Text to convert to speech
   * @param {string} voice - Voice name or ID
   * @param {Object} trackingOptions - Options for budget tracking
   * @param {string} trackingOptions.projectId - Project ID for tracking
   * @param {string} trackingOptions.operation - Operation name
   * @returns {Promise<string>} Path to generated audio file
   */
  async generateAudio(text, voice = 'Rachel', trackingOptions = {}) {
    const outputPath = path.join(this.outputDir, `elevenlabs_${Date.now()}.mp3`);
    
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found. Please set ELEVENLABS_API_KEY in your environment or settings.');
    }

    const voiceId = VOICE_IDS[voice] || voice; // Use as ID if not in map
    const characterCount = text.length;

    // Check budget before making the API call
    try {
      const budgetManager = getBudgetManager();
      const pricing = budgetManager.getPricing().elevenlabs || { costPer1K: 0.30 };
      const estimatedCost = (characterCount / 1000) * pricing.costPer1K;
      
      const operation = trackingOptions.operation || 'generateAudio';
      const budgetCheck = budgetManager.checkBudgetWithWarning('elevenlabs', estimatedCost, operation);
      
      if (budgetCheck.exceeded) {
        logger.warn('ElevenLabsService: API call proceeding despite budget exceeded', {
          operation,
          characterCount,
          estimatedCost,
          remaining: budgetCheck.remaining
        });
      }
    } catch (budgetError) {
      logger.warn('ElevenLabsService: Budget check failed, proceeding with call', {
        error: budgetError.message
      });
    }

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        text: text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      });

      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Calling ElevenLabs API with voice:', voice, voiceId);
      console.log(`[ElevenLabsService] Text length: ${characterCount} characters`);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', (chunk) => {
            errorData += chunk;
          });
          res.on('end', () => {
            reject(new Error(`ElevenLabs API error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] Audio generated:', outputPath);
          
          // Track usage after successful generation
          try {
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
              operation: trackingOptions.operation || 'generateAudio',
              characters: characterCount
            });
            logger.info('ElevenLabsService usage tracked', { characterCount });
          } catch (trackingError) {
            logger.error('ElevenLabsService tracking error', { 
              error: trackingError.message, 
              operation: 'trackUsage' 
            });
          }
          
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Replace audio in a specific time range with ElevenLabs generated audio
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Options
   * @param {string} options.projectId - Project ID for budget tracking
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async replaceAudioWithElevenLabs(inputPath, options = {}, progressCallback = null) {
    const {
      startTime,
      endTime,
      text,
      markerName = 'segment',
      voice = 'Rachel',
      outputPath = null,
      projectId = null
    } = options;

    if (!text || text.trim() === '') {
      throw new Error('No text provided for audio generation');
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_elevenlabs_${Date.now()}.mp4`);
    const jobId = `elevenlabs_${Date.now()}`;

    try {
      if (progressCallback) {
        progressCallback({ jobId, status: 'Calling ElevenLabs API...', percent: 5 });
      }

      console.log('[ElevenLabsService] Generating audio for text:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
      
      // Call ElevenLabs API to generate audio (with budget tracking)
      const audioFilePath = await this.generateAudio(text, voice, {
        projectId,
        operation: `replaceAudio:${markerName}`
      });
      
      console.log('[ElevenLabsService] Audio generated, now processing video...');
      console.log('[ElevenLabsService] This may take several minutes for long videos.');
      
      if (progressCallback) {
        progressCallback({ jobId, status: 'Audio generated! Processing video (may take a few minutes)...', percent: 15 });
      }

      // Use FFmpeg to replace the audio segment
      const result = await this.audioReplacer.replaceAudioSegment(
        inputPath, audioFilePath, startTime, endTime, output, progressCallback
      );
      
      // Clean up temp audio file
      if (fs.existsSync(audioFilePath)) {
        fs.unlinkSync(audioFilePath);
      }

      if (progressCallback) {
        progressCallback({ jobId, status: 'Complete!', percent: 100 });
      }

      return { 
        success: true, 
        outputPath: output, 
        jobId,
        message: `Audio replaced with ElevenLabs for "${markerName}"`
      };

    } catch (error) {
      logger.error('ElevenLabsService replacement error', { 
        error: error.message, 
        stack: error.stack,
        operation: 'elevenLabsReplace' 
      });
      throw error;
    }
  }

  /**
   * Get available voices (hardcoded fallback)
   * @returns {Object} Voice name to ID mapping
   */
  getAvailableVoices() {
    return { ...VOICE_IDS };
  }

  /**
   * Fetch all available voices from ElevenLabs API
   * @returns {Promise<Array>} Array of voice objects
   */
  async listVoices() {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ElevenLabsService.js:listVoices',message:'listVoices called',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    const apiKey = this.getApiKey();
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ElevenLabsService.js:listVoices-apiKey',message:'API key check',data:{hasKey:!!apiKey,keyLength:apiKey?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/voices',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `API error: ${res.statusCode}`));
              return;
            }
            console.log(`[ElevenLabsService] Fetched ${result.voices?.length || 0} voices`);
            resolve(result.voices || []);
          } catch (e) {
            reject(new Error('Failed to parse voices response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Generate sound effects from text prompt
   * @param {string} prompt - Description of the sound effect
   * @param {Object} options - Generation options
   * @param {number} options.durationSeconds - Duration in seconds (0.5-22)
   * @param {boolean} options.promptInfluence - How much the prompt influences the output (0-1)
   * @param {Object} trackingOptions - Budget tracking options
   * @returns {Promise<string>} Path to generated audio file
   */
  async generateSoundEffect(prompt, options = {}, trackingOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const outputPath = path.join(this.outputDir, `sfx_${Date.now()}.mp3`);
    const { durationSeconds = 5, promptInfluence = 0.5 } = options;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        text: prompt,
        duration_seconds: Math.min(22, Math.max(0.5, durationSeconds)),
        prompt_influence: Math.min(1, Math.max(0, promptInfluence))
      });

      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/sound-generation',
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Generating SFX:', prompt.substring(0, 50));

      const file = fs.createWriteStream(outputPath);
      const req = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Sound generation error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] SFX generated:', outputPath);
          
          // Track usage
          try {
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
              operation: 'generateSFX',
              prompt: prompt.substring(0, 100),
              durationSeconds
            });
          } catch (e) {
            console.warn('[ElevenLabsService] Usage tracking error:', e.message);
          }
          
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Generate music from text prompt using Eleven Music API
   * @param {string} prompt - Description of the music to generate
   * @param {Object} options - Generation options
   * @param {number} options.durationMs - Duration in milliseconds (default 30000)
   * @param {boolean} options.instrumental - Force instrumental only, no vocals (default true)
   * @param {string} options.modelId - Model ID (default 'music_v1')
   * @param {Object} trackingOptions - Budget tracking options
   * @returns {Promise<string>} Path to generated audio file
   */
  async generateMusic(prompt, options = {}, trackingOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const outputPath = path.join(this.outputDir, `music_${Date.now()}.mp3`);
    const { 
      durationMs = 30000, 
      instrumental = true,
      modelId = 'music_v1'
    } = options;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        prompt: prompt,
        music_length_ms: Math.min(300000, Math.max(5000, durationMs)), // 5s to 5min
        force_instrumental: instrumental,
        model_id: modelId
      });

      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/music',
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Generating music:', prompt.substring(0, 50));
      console.log('[ElevenLabsService] Duration:', durationMs, 'ms, Instrumental:', instrumental);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Music generation error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] Music generated:', outputPath);
          
          // Track usage
          try {
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
              operation: 'generateMusic',
              prompt: prompt.substring(0, 100),
              durationMs
            });
          } catch (e) {
            console.warn('[ElevenLabsService] Usage tracking error:', e.message);
          }
          
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Get music composition plan/suggestions from Eleven Music API
   * @param {string} prompt - Base prompt to generate variations from
   * @param {Object} options - Options
   * @param {number} options.durationMs - Target duration in milliseconds
   * @returns {Promise<Object>} Composition plan with suggestions
   */
  async getMusicCompositionPlan(prompt, options = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const { durationMs = 30000 } = options;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        prompt: prompt,
        music_length_ms: Math.min(300000, Math.max(5000, durationMs)),
        model_id: 'music_v1'
      });

      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/music/plan',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Getting music composition plan for:', prompt.substring(0, 50));

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Music plan error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Music composition plan received');
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse music plan response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Speech-to-Speech voice transformation
   * @param {string} audioPath - Path to input audio file
   * @param {string} voiceId - Target voice ID
   * @param {Object} options - Transformation options
   * @param {Object} trackingOptions - Budget tracking options
   * @returns {Promise<string>} Path to transformed audio file
   */
  async speechToSpeech(audioPath, voiceId, options = {}, trackingOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const outputPath = path.join(this.outputDir, `sts_${Date.now()}.mp3`);
    const { stability = 0.5, similarityBoost = 0.75, modelId = 'eleven_english_sts_v2' } = options;

    // Read the audio file
    const audioBuffer = fs.readFileSync(audioPath);
    const boundary = '----ElevenLabsBoundary' + Date.now();

    // Build multipart form data
    let formData = '';
    formData += `--${boundary}\r\n`;
    formData += `Content-Disposition: form-data; name="audio"; filename="audio.mp3"\r\n`;
    formData += `Content-Type: audio/mpeg\r\n\r\n`;

    const formDataEnd = `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\n${modelId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="voice_settings"\r\n\r\n` +
      JSON.stringify({ stability, similarity_boost: similarityBoost }) +
      `\r\n--${boundary}--\r\n`;

    const bodyStart = Buffer.from(formData);
    const bodyEnd = Buffer.from(formDataEnd);
    const body = Buffer.concat([bodyStart, audioBuffer, bodyEnd]);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/speech-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Speech-to-Speech transformation with voice:', voiceId);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Speech-to-Speech error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] STS output generated:', outputPath);
          
          // Track usage
          try {
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
              operation: 'speechToSpeech',
              voiceId
            });
          } catch (e) {
            console.warn('[ElevenLabsService] Usage tracking error:', e.message);
          }
          
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Isolate vocals/speech from audio (remove background noise)
   * @param {string} audioPath - Path to input audio file
   * @param {Object} trackingOptions - Budget tracking options
   * @returns {Promise<string>} Path to isolated audio file
   */
  async isolateAudio(audioPath, trackingOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const outputPath = path.join(this.outputDir, `isolated_${Date.now()}.mp3`);

    // Read the audio file
    const audioBuffer = fs.readFileSync(audioPath);
    const boundary = '----ElevenLabsBoundary' + Date.now();

    // Build multipart form data
    let formData = '';
    formData += `--${boundary}\r\n`;
    formData += `Content-Disposition: form-data; name="audio"; filename="audio.mp3"\r\n`;
    formData += `Content-Type: audio/mpeg\r\n\r\n`;

    const formDataEnd = `\r\n--${boundary}--\r\n`;

    const bodyStart = Buffer.from(formData);
    const bodyEnd = Buffer.from(formDataEnd);
    const body = Buffer.concat([bodyStart, audioBuffer, bodyEnd]);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/audio-isolation',
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Isolating audio from:', audioPath);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Audio isolation error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] Audio isolated:', outputPath);
          
          // Track usage
          try {
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
              operation: 'isolateAudio'
            });
          } catch (e) {
            console.warn('[ElevenLabsService] Usage tracking error:', e.message);
          }
          
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Create a dubbing project
   * @param {string} videoPath - Path to video file
   * @param {Array<string>} targetLanguages - Target language codes (e.g., ['es', 'fr'])
   * @param {Object} options - Dubbing options
   * @param {Object} trackingOptions - Budget tracking options
   * @returns {Promise<Object>} Dubbing project info with ID
   */
  async createDubbingProject(videoPath, targetLanguages, options = {}, trackingOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    const {
      sourceLanguage = 'en',
      numSpeakers = 1,
      watermark = false,
      projectName = `Dub_${Date.now()}`
    } = options;

    // Read the video file
    const videoBuffer = fs.readFileSync(videoPath);
    const boundary = '----ElevenLabsBoundary' + Date.now();
    const ext = path.extname(videoPath).toLowerCase();
    const mimeType = ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';

    // Build multipart form data
    let formParts = [];
    
    // File part
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${path.basename(videoPath)}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));
    formParts.push(videoBuffer);
    formParts.push(Buffer.from('\r\n'));
    
    // Target languages
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="target_lang"\r\n\r\n${targetLanguages.join(',')}\r\n`
    ));
    
    // Source language
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_lang"\r\n\r\n${sourceLanguage}\r\n`
    ));
    
    // Number of speakers
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="num_speakers"\r\n\r\n${numSpeakers}\r\n`
    ));
    
    // Watermark
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="watermark"\r\n\r\n${watermark}\r\n`
    ));
    
    // Project name
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="name"\r\n\r\n${projectName}\r\n`
    ));
    
    // End boundary
    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/dubbing',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Creating dubbing project:', projectName);
      console.log('[ElevenLabsService] Target languages:', targetLanguages);

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Dubbing error: ${res.statusCode}`));
              return;
            }
            
            console.log('[ElevenLabsService] Dubbing project created:', result.dubbing_id);
            
            // Track usage
            try {
              const budgetManager = getBudgetManager();
              budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
                operation: 'createDubbing',
                dubbingId: result.dubbing_id,
                targetLanguages
              });
            } catch (e) {
              console.warn('[ElevenLabsService] Usage tracking error:', e.message);
            }
            
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse dubbing response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get dubbing project status
   * @param {string} dubbingId - Dubbing project ID
   * @returns {Promise<Object>} Dubbing status
   */
  async getDubbingStatus(dubbingId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/dubbing/${dubbingId}`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Status error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse status response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Download dubbed audio for a specific language
   * @param {string} dubbingId - Dubbing project ID
   * @param {string} languageCode - Target language code
   * @returns {Promise<string>} Path to downloaded audio file
   */
  async downloadDubbedAudio(dubbingId, languageCode) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const outputPath = path.join(this.outputDir, `dubbed_${languageCode}_${Date.now()}.mp3`);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/dubbing/${dubbingId}/audio/${languageCode}`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      console.log('[ElevenLabsService] Downloading dubbed audio:', languageCode);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Download error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] Dubbed audio downloaded:', outputPath);
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.end();
    });
  }

  /**
   * Get user subscription info (quota/limits)
   * @returns {Promise<Object>} Subscription info
   */
  async getUserSubscription() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/user/subscription',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Subscription error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Got subscription info');
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse subscription response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Get user info
   * @returns {Promise<Object>} User info
   */
  async getUserInfo() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/user',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `User info error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse user response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Transcribe audio using ElevenLabs Scribe API (Speech-to-Text)
   * Replaces OpenAI Whisper with ElevenLabs Scribe for transcription
   * @param {string} audioPath - Path to audio/video file to transcribe
   * @param {Object} options - Transcription options
   * @param {string} options.languageCode - ISO language code (e.g., 'en', 'es')
   * @param {number} options.temperature - Randomness (0-2, default 0)
   * @param {boolean} options.multiChannel - Separate transcripts per channel
   * @param {boolean} options.diarize - Enable speaker diarization (default: true)
   * @param {number} options.numSpeakers - Expected number of speakers (1-32, null for auto)
   * @param {Object} trackingOptions - Budget tracking options
   * @returns {Promise<Object>} Transcription result with text, word timestamps, and speaker IDs
   */
  async transcribeAudio(audioPath, options = {}, trackingOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const {
      languageCode = null,
      temperature = 0,
      multiChannel = false,
      diarize = true,  // Enable speaker diarization by default
      numSpeakers = null,  // Auto-detect number of speakers
      modelId = 'scribe_v1'
    } = options;

    console.log('[ElevenLabsService] Transcribing with Scribe:', path.basename(audioPath));
    console.log('[ElevenLabsService] Speaker diarization:', diarize ? 'enabled' : 'disabled');

    // Read the audio file
    const audioBuffer = fs.readFileSync(audioPath);
    const boundary = '----ElevenLabsBoundary' + Date.now();
    const ext = path.extname(audioPath).toLowerCase();
    
    // Determine MIME type
    const mimeTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac'
    };
    const mimeType = mimeTypes[ext] || 'audio/mpeg';

    // Build multipart form data
    let formParts = [];
    
    // Model ID (required)
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\n${modelId}\r\n`
    ));
    
    // File (required)
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${path.basename(audioPath)}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));
    formParts.push(audioBuffer);
    formParts.push(Buffer.from('\r\n'));
    
    // Language code (optional)
    if (languageCode) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language_code"\r\n\r\n${languageCode}\r\n`
      ));
    }
    
    // Temperature (optional)
    if (temperature !== undefined && temperature !== null) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="temperature"\r\n\r\n${temperature}\r\n`
      ));
    }
    
    // Speaker diarization (enabled by default)
    if (diarize) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="diarize"\r\n\r\ntrue\r\n`
      ));
      
      // Number of speakers (optional, only when diarize is true)
      if (numSpeakers && !multiChannel) {
        formParts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="num_speakers"\r\n\r\n${Math.min(32, Math.max(1, numSpeakers))}\r\n`
        ));
      }
    }
    
    // Multi-channel (optional)
    if (multiChannel) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="use_multi_channel"\r\n\r\ntrue\r\n`
      ));
    }
    
    // End boundary
    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/speech-to-text',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Calling Scribe API for transcription...');

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Transcription error: ${res.statusCode} - ${responseData}`));
              return;
            }
            
            console.log('[ElevenLabsService] Scribe transcription complete');
            console.log(`[ElevenLabsService] Language: ${result.language_code}, Words: ${result.words?.length || 0}`);
            
            // Extract unique speakers from the transcription
            const speakers = new Set();
            (result.words || []).forEach(w => {
              if (w.speaker_id) speakers.add(w.speaker_id);
            });
            console.log(`[ElevenLabsService] Detected speakers: ${speakers.size > 0 ? Array.from(speakers).join(', ') : 'none'}`);
            
            // Track usage
            try {
              const budgetManager = getBudgetManager();
              budgetManager.trackUsage('elevenlabs', trackingOptions.projectId || null, {
                operation: 'transcribeAudio',
                language: result.language_code,
                wordCount: result.words?.length || 0,
                speakerCount: speakers.size
              });
            } catch (e) {
              console.warn('[ElevenLabsService] Usage tracking error:', e.message);
            }
            
            // Return in a format compatible with the existing code
            resolve({
              transcription: result.text,
              text: result.text,
              language: result.language_code,
              languageProbability: result.language_probability,
              words: result.words || [],
              speakers: Array.from(speakers),  // List of unique speaker IDs
              speakerCount: speakers.size,
              // Map to segments format for compatibility
              segments: (result.words || []).map((w, i) => ({
                text: w.text,
                start: w.start,
                end: w.end,
                type: w.type || 'word',
                speakerId: w.speaker_id,
                confidence: w.logprob ? Math.exp(w.logprob) : null
              })),
              source: 'elevenlabs-scribe'
            });
          } catch (e) {
            reject(new Error('Failed to parse transcription response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get character usage statistics
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Usage statistics
   */
  async getUsageStats(options = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const { startDate, endDate } = options;
    let queryParams = '';
    if (startDate) queryParams += `start_unix=${Math.floor(new Date(startDate).getTime() / 1000)}`;
    if (endDate) queryParams += `${queryParams ? '&' : ''}end_unix=${Math.floor(new Date(endDate).getTime() / 1000)}`;

    return new Promise((resolve, reject) => {
      const pathWithQuery = '/v1/usage/character-stats' + (queryParams ? `?${queryParams}` : '');
      
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: pathWithQuery,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Usage stats error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Got usage stats');
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse usage stats response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ==================== STUDIO PROJECTS API ====================

  /**
   * Create a new Studio project
   * @param {string} name - Project name
   * @param {Object} options - Project options
   * @param {string} options.defaultVoiceId - Default voice ID for the project
   * @param {string} options.defaultModelId - Default model ID
   * @param {string} options.title - Project title (metadata)
   * @param {string} options.author - Author name (metadata)
   * @param {string} options.qualityPreset - Output quality (standard, high, ultra, ultra_lossless)
   * @returns {Promise<Object>} Created project info with project_id
   */
  async createStudioProject(name, options = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const {
      defaultVoiceId = null,
      defaultModelId = 'eleven_multilingual_v2',
      title = null,
      author = null,
      qualityPreset = 'high'
    } = options;

    const formData = new URLSearchParams();
    formData.append('name', name);
    if (defaultVoiceId) formData.append('default_title_voice_id', defaultVoiceId);
    if (defaultVoiceId) formData.append('default_paragraph_voice_id', defaultVoiceId);
    if (defaultModelId) formData.append('default_model_id', defaultModelId);
    if (title) formData.append('title', title);
    if (author) formData.append('author', author);
    formData.append('quality_preset', qualityPreset);

    const postData = formData.toString();

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/studio/projects',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Creating Studio project:', name);

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200 && res.statusCode !== 201) {
              reject(new Error(result.detail?.message || `Studio project error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Studio project created:', result.project_id);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse studio project response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Get a Studio project by ID
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} Project details
   */
  async getStudioProject(projectId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/studio/projects/${projectId}`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Get project error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse project response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * List all Studio projects
   * @returns {Promise<Array>} Array of projects
   */
  async listStudioProjects() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/studio/projects',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `List projects error: ${res.statusCode}`));
              return;
            }
            console.log(`[ElevenLabsService] Found ${result.projects?.length || 0} studio projects`);
            resolve(result.projects || []);
          } catch (e) {
            reject(new Error('Failed to parse projects response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Delete a Studio project
   * @param {string} projectId - Project ID to delete
   * @returns {Promise<boolean>} Success
   */
  async deleteStudioProject(projectId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/studio/projects/${projectId}`,
        method: 'DELETE',
        headers: {
          'xi-api-key': apiKey
        }
      };

      console.log('[ElevenLabsService] Deleting Studio project:', projectId);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            console.log('[ElevenLabsService] Studio project deleted:', projectId);
            resolve(true);
          } else {
            try {
              const result = JSON.parse(data);
              reject(new Error(result.detail?.message || `Delete project error: ${res.statusCode}`));
            } catch (e) {
              reject(new Error(`Delete project error: ${res.statusCode}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ==================== VOICE CLONING API ====================

  /**
   * Clone a voice from audio samples (Instant Voice Cloning)
   * @param {string} name - Name for the cloned voice
   * @param {Array<string>} audioFilePaths - Array of audio file paths (samples)
   * @param {Object} options - Cloning options
   * @param {string} options.description - Voice description
   * @param {Object} options.labels - Voice labels (accent, age, gender, etc.)
   * @returns {Promise<Object>} Created voice info with voice_id
   */
  async cloneVoice(name, audioFilePaths, options = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    if (!audioFilePaths || audioFilePaths.length === 0) {
      throw new Error('At least one audio sample is required for voice cloning');
    }

    const { description = '', labels = {} } = options;
    const boundary = '----ElevenLabsBoundary' + Date.now();

    // Build multipart form data
    let formParts = [];

    // Name (required)
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`
    ));

    // Description
    if (description) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="description"\r\n\r\n${description}\r\n`
      ));
    }

    // Labels (as JSON string)
    if (Object.keys(labels).length > 0) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="labels"\r\n\r\n${JSON.stringify(labels)}\r\n`
      ));
    }

    // Audio files
    for (const audioPath of audioFilePaths) {
      if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`);
      }
      const audioBuffer = fs.readFileSync(audioPath);
      const fileName = path.basename(audioPath);
      const ext = path.extname(audioPath).toLowerCase();
      const mimeType = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';

      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
      ));
      formParts.push(audioBuffer);
      formParts.push(Buffer.from('\r\n'));
    }

    // End boundary
    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/voices/add',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Cloning voice:', name, 'with', audioFilePaths.length, 'samples');

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Voice cloning error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Voice cloned:', result.voice_id);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse voice cloning response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Delete a voice
   * @param {string} voiceId - Voice ID to delete
   * @returns {Promise<boolean>} Success
   */
  async deleteVoice(voiceId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/voices/${voiceId}`,
        method: 'DELETE',
        headers: {
          'xi-api-key': apiKey
        }
      };

      console.log('[ElevenLabsService] Deleting voice:', voiceId);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            console.log('[ElevenLabsService] Voice deleted:', voiceId);
            resolve(true);
          } else {
            try {
              const result = JSON.parse(data);
              reject(new Error(result.detail?.message || `Delete voice error: ${res.statusCode}`));
            } catch (e) {
              reject(new Error(`Delete voice error: ${res.statusCode}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Edit voice settings
   * @param {string} voiceId - Voice ID
   * @param {Object} updates - Updates to apply
   * @param {string} updates.name - New name
   * @param {string} updates.description - New description
   * @param {Object} updates.labels - New labels
   * @returns {Promise<Object>} Updated voice
   */
  async editVoice(voiceId, updates = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const { name, description, labels } = updates;
    const boundary = '----ElevenLabsBoundary' + Date.now();

    let formParts = [];

    if (name) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`
      ));
    }

    if (description !== undefined) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="description"\r\n\r\n${description}\r\n`
      ));
    }

    if (labels) {
      formParts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="labels"\r\n\r\n${JSON.stringify(labels)}\r\n`
      ));
    }

    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/voices/${voiceId}/edit`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Editing voice:', voiceId);

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Edit voice error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Voice updated:', voiceId);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse edit voice response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get voice details
   * @param {string} voiceId - Voice ID
   * @returns {Promise<Object>} Voice details
   */
  async getVoice(voiceId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/voices/${voiceId}`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Get voice error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse voice response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ==================== VOICE DESIGN API ====================

  /**
   * Generate a new voice from a text description
   * @param {Object} options - Voice design options
   * @param {string} options.gender - Gender (male, female)
   * @param {string} options.age - Age (young, middle_aged, old)
   * @param {string} options.accent - Accent (american, british, african, australian, indian)
   * @param {number} options.accentStrength - Accent strength (0.3-2.0)
   * @param {string} options.text - Sample text to generate with the voice
   * @returns {Promise<Object>} Generated voice preview with audio
   */
  async designVoice(options = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const {
      gender = 'female',
      age = 'middle_aged',
      accent = 'american',
      accentStrength = 1.0,
      text = 'Hello, this is a sample of my voice. I am testing the voice design feature which requires at least one hundred characters of text to properly generate a preview.'
    } = options;

    const postData = JSON.stringify({
      gender,
      age,
      accent,
      accent_strength: Math.min(2.0, Math.max(0.3, accentStrength)),
      text
    });

    const outputPath = path.join(this.outputDir, `voice_design_${Date.now()}.mp3`);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/voice-generation/generate-voice',
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Designing voice:', gender, age, accent);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(requestOptions, (res) => {
        // Check for generated voice ID in headers
        const generatedVoiceId = res.headers['generated_voice_id'];

        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Voice design error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] Voice design preview generated:', outputPath);
          resolve({
            audioPath: outputPath,
            generatedVoiceId: generatedVoiceId,
            settings: { gender, age, accent, accentStrength }
          });
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Save a designed voice to your library
   * @param {string} generatedVoiceId - ID from voice design preview
   * @param {string} name - Name for the voice
   * @param {string} description - Voice description
   * @returns {Promise<Object>} Saved voice info
   */
  async saveDesignedVoice(generatedVoiceId, name, description = '') {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const postData = JSON.stringify({
      voice_name: name,
      voice_description: description,
      generated_voice_id: generatedVoiceId
    });

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/voice-generation/create-voice',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Saving designed voice:', name);

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Save voice error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Designed voice saved:', result.voice_id);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse save voice response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  // ==================== AUDIO LANGUAGE DETECTION ====================

  /**
   * Detect the language spoken in an audio file
   * @param {string} audioPath - Path to audio file
   * @returns {Promise<Object>} Detected language info
   */
  async detectLanguage(audioPath) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const audioBuffer = fs.readFileSync(audioPath);
    const boundary = '----ElevenLabsBoundary' + Date.now();
    const ext = path.extname(audioPath).toLowerCase();
    const mimeType = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';

    let formParts = [];
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${path.basename(audioPath)}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));
    formParts.push(audioBuffer);
    formParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/audio-language-detection',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      console.log('[ElevenLabsService] Detecting language in:', path.basename(audioPath));

      let responseData = '';
      const req = https.request(requestOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Language detection error: ${res.statusCode}`));
              return;
            }
            console.log('[ElevenLabsService] Detected language:', result.detected_language);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse language detection response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ==================== MODELS API ====================

  /**
   * List all available TTS models
   * @returns {Promise<Array>} Array of model objects
   */
  async listModels() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/models',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `List models error: ${res.statusCode}`));
              return;
            }
            console.log(`[ElevenLabsService] Found ${result.length || 0} models`);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse models response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ==================== TTS STREAMING API ====================

  /**
   * Generate audio with streaming (returns readable stream)
   * @param {string} text - Text to convert to speech
   * @param {string} voice - Voice name or ID
   * @param {Object} options - Generation options
   * @param {string} options.modelId - Model ID to use
   * @param {number} options.stability - Voice stability (0-1)
   * @param {number} options.similarityBoost - Similarity boost (0-1)
   * @param {Function} onData - Callback for each audio chunk
   * @returns {Promise<string>} Path to saved audio file
   */
  async generateAudioStream(text, voice = 'Rachel', options = {}, onData = null) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const voiceId = VOICE_IDS[voice] || voice;
    const {
      modelId = 'eleven_monolingual_v1',
      stability = 0.5,
      similarityBoost = 0.75
    } = options;

    const outputPath = path.join(this.outputDir, `stream_${Date.now()}.mp3`);

    const postData = JSON.stringify({
      text: text,
      model_id: modelId,
      voice_settings: {
        stability: stability,
        similarity_boost: similarityBoost
      }
    });

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/text-to-speech/${voiceId}/stream`,
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Starting audio stream for:', text.substring(0, 50) + '...');

      const file = fs.createWriteStream(outputPath);
      const req = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Stream error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.on('data', (chunk) => {
          file.write(chunk);
          if (onData) {
            onData(chunk);
          }
        });

        res.on('end', () => {
          file.end();
          console.log('[ElevenLabsService] Stream complete:', outputPath);
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  // ==================== HISTORY API ====================

  /**
   * Get generation history
   * @param {Object} options - Query options
   * @param {number} options.pageSize - Number of items per page (1-1000)
   * @param {string} options.startAfterId - Start after this history item ID
   * @param {string} options.voiceId - Filter by voice ID
   * @returns {Promise<Object>} History with items and pagination
   */
  async getHistory(options = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const { pageSize = 100, startAfterId = null, voiceId = null } = options;

    let queryParams = `page_size=${pageSize}`;
    if (startAfterId) queryParams += `&start_after_history_item_id=${startAfterId}`;
    if (voiceId) queryParams += `&voice_id=${voiceId}`;

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/history?${queryParams}`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Get history error: ${res.statusCode}`));
              return;
            }
            console.log(`[ElevenLabsService] Got ${result.history?.length || 0} history items`);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse history response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Get a specific history item
   * @param {string} historyItemId - History item ID
   * @returns {Promise<Object>} History item details
   */
  async getHistoryItem(historyItemId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/history/${historyItemId}`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Get history item error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse history item response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Get audio for a history item
   * @param {string} historyItemId - History item ID
   * @returns {Promise<string>} Path to downloaded audio file
   */
  async getHistoryItemAudio(historyItemId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const outputPath = path.join(this.outputDir, `history_${historyItemId}_${Date.now()}.mp3`);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/history/${historyItemId}/audio`,
        method: 'GET',
        headers: {
          'xi-api-key': apiKey
        }
      };

      const file = fs.createWriteStream(outputPath);
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => {
            reject(new Error(`Get history audio error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[ElevenLabsService] History audio downloaded:', outputPath);
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.end();
    });
  }

  /**
   * Delete a history item
   * @param {string} historyItemId - History item ID to delete
   * @returns {Promise<boolean>} Success
   */
  async deleteHistoryItem(historyItemId) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/history/${historyItemId}`,
        method: 'DELETE',
        headers: {
          'xi-api-key': apiKey
        }
      };

      console.log('[ElevenLabsService] Deleting history item:', historyItemId);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            console.log('[ElevenLabsService] History item deleted:', historyItemId);
            resolve(true);
          } else {
            try {
              const result = JSON.parse(data);
              reject(new Error(result.detail?.message || `Delete history item error: ${res.statusCode}`));
            } catch (e) {
              reject(new Error(`Delete history item error: ${res.statusCode}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Delete multiple history items
   * @param {Array<string>} historyItemIds - Array of history item IDs
   * @returns {Promise<boolean>} Success
   */
  async deleteHistoryItems(historyItemIds) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found');
    }

    const postData = JSON.stringify({
      history_item_ids: historyItemIds
    });

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/history/delete',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[ElevenLabsService] Deleting', historyItemIds.length, 'history items');

      const req = https.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            console.log('[ElevenLabsService] History items deleted');
            resolve(true);
          } else {
            try {
              const result = JSON.parse(data);
              reject(new Error(result.detail?.message || `Delete history items error: ${res.statusCode}`));
            } catch (e) {
              reject(new Error(`Delete history items error: ${res.statusCode}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}














