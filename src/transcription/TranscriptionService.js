/**
 * TranscriptionService - Unified transcription using ElevenLabs Scribe
 * 
 * This is the SINGLE source of truth for all transcription in the app.
 * Replaces: OpenAI Whisper, AssemblyAI, and other transcription services.
 * 
 * Features:
 * - High-quality speech-to-text transcription
 * - Word-level timestamps
 * - Speaker diarization (identification of multiple speakers)
 * - Language detection and multi-language support
 * - Multi-channel audio support
 * - LLM-powered speaker name identification
 * 
 * @module src/transcription/TranscriptionService
 */

import { ElevenLabsService } from '../video/audio/ElevenLabsService.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getOpenAIAPI } = require('../../openai-api.js');
const { getSettingsManager } = require('../../settings-manager.js');

/**
 * Unified transcription service
 * All transcription requests should go through this service
 */
export class TranscriptionService {
  constructor() {
    this.elevenLabs = new ElevenLabsService();
  }

  /**
   * Transcribe audio/video file with speaker diarization
   * 
   * @param {string} audioPath - Path to audio or video file
   * @param {Object} options - Transcription options
   * @param {string} [options.language] - ISO language code (e.g., 'en', 'es', 'fr'). Auto-detects if not specified.
   * @param {boolean} [options.diarize=true] - Enable speaker identification
   * @param {number} [options.numSpeakers] - Expected number of speakers (1-32). Auto-detects if not specified.
   * @param {boolean} [options.multiChannel=false] - Separate transcripts per audio channel
   * @param {string} [options.projectId] - Project ID for budget tracking
   * @returns {Promise<TranscriptionResult>} Transcription result
   * 
   * @example
   * const service = new TranscriptionService();
   * const result = await service.transcribe('/path/to/audio.mp3', {
   *   language: 'en',
   *   diarize: true
   * });
   * console.log(result.text);           // Full transcription text
   * console.log(result.words);          // Word-level timestamps with speaker IDs
   * console.log(result.speakers);       // List of identified speakers
   */
  async transcribe(audioPath, options = {}) {
    const {
      language = null,
      diarize = true,
      numSpeakers = null,
      multiChannel = false,
      projectId = null
    } = options;

    console.log('[TranscriptionService] Starting transcription:', audioPath);
    console.log('[TranscriptionService] Options:', { language, diarize, numSpeakers, multiChannel });

    try {
      const result = await this.elevenLabs.transcribeAudio(audioPath, {
        languageCode: language,
        diarize,
        numSpeakers,
        multiChannel
      }, {
        projectId,
        operation: 'transcribe'
      });

      // Transform to standard format
      const transcriptionResult = {
        success: true,
        // Full text
        text: result.text || result.transcription,
        
        // Language info
        language: result.language,
        languageProbability: result.languageProbability,
        
        // Word-level timestamps with speaker IDs
        words: (result.words || []).map(w => ({
          text: w.text,
          start: w.start,
          end: w.end,
          speaker: w.speaker_id || w.speakerId || null,
          confidence: w.logprob ? Math.exp(w.logprob) : null,
          type: w.type || 'word'
        })),
        
        // Segments (grouped by speaker or punctuation)
        segments: result.segments || [],
        
        // Speaker information
        speakers: result.speakers || [],
        speakerCount: result.speakerCount || (result.speakers?.length || 0),
        
        // Source tracking
        source: 'elevenlabs-scribe',
        
        // Timing info
        duration: this._calculateDuration(result.words),
        wordCount: (result.words || []).length
      };

      console.log(`[TranscriptionService] Completed: ${transcriptionResult.wordCount} words, ${transcriptionResult.speakerCount} speakers`);

      return transcriptionResult;
    } catch (error) {
      console.error('[TranscriptionService] Error:', error);
      return {
        success: false,
        error: error.message,
        source: 'elevenlabs-scribe'
      };
    }
  }

  /**
   * Transcribe a specific time range from a video/audio file
   * Extracts audio segment first, then transcribes
   * 
   * @param {string} inputPath - Path to video/audio file
   * @param {Object} options - Options
   * @param {number} options.startTime - Start time in seconds
   * @param {number} options.endTime - End time in seconds
   * @param {string} [options.language] - Language code
   * @param {boolean} [options.diarize=true] - Enable speaker identification
   * @returns {Promise<TranscriptionResult>} Transcription result with adjusted timestamps
   */
  async transcribeRange(inputPath, options = {}) {
    const { startTime = 0, endTime, language, diarize = true, projectId } = options;

    console.log(`[TranscriptionService] Transcribing range: ${startTime}s - ${endTime}s`);

    // For range transcription, we need to extract audio first
    // This requires ffmpeg - delegate to video editor for audio extraction
    // For now, pass through to main transcription with a note about range
    
    const result = await this.transcribe(inputPath, {
      language,
      diarize,
      projectId
    });

    if (!result.success) {
      return result;
    }

    // Filter words to the specified range and adjust timestamps
    const filteredWords = result.words.filter(w => 
      w.start >= startTime && (endTime === undefined || w.end <= endTime)
    );

    // Adjust timestamps to be relative to startTime
    const adjustedWords = filteredWords.map(w => ({
      ...w,
      start: w.start - startTime,
      end: w.end - startTime
    }));

    return {
      ...result,
      words: adjustedWords,
      text: adjustedWords.map(w => w.text).join(' '),
      startTime,
      endTime,
      duration: endTime - startTime
    };
  }

  /**
   * Identify speaker names from transcription using LLM analysis
   * 
   * Analyzes the transcript to identify who each speaker might be based on:
   * - Greetings and introductions ("Hi, I'm John")
   * - Name mentions ("Thanks Sarah", "John said...")
   * - Role indicators (interviewer vs interviewee patterns)
   * - Conversational context
   * 
   * @param {TranscriptionResult} transcriptionResult - Result from transcribe()
   * @param {Object} options - Options
   * @param {string} [options.context] - Additional context about the recording (e.g., "podcast interview", "team meeting")
   * @param {Array<string>} [options.expectedNames] - List of expected participant names to help identification
   * @param {string} [options.projectId] - Project ID for budget tracking
   * @returns {Promise<SpeakerIdentificationResult>} Speaker identification result
   * 
   * @example
   * const transcription = await service.transcribe('/path/to/meeting.mp3');
   * const identified = await service.identifySpeakers(transcription, {
   *   context: 'Team standup meeting',
   *   expectedNames: ['Alice', 'Bob', 'Charlie']
   * });
   * console.log(identified.speakerMap); // { speaker_0: 'Alice', speaker_1: 'Bob' }
   */
  async identifySpeakers(transcriptionResult, options = {}) {
    const {
      context = null,
      expectedNames = [],
      projectId = null
    } = options;

    if (!transcriptionResult || !transcriptionResult.success) {
      return {
        success: false,
        error: 'Invalid transcription result provided',
        speakerMap: {}
      };
    }

    // Check if there are speakers to identify
    const speakers = transcriptionResult.speakers || [];
    if (speakers.length === 0) {
      console.log('[TranscriptionService] No speakers to identify in transcription');
      return {
        success: true,
        speakerMap: {},
        confidence: 1,
        message: 'No distinct speakers detected in transcription'
      };
    }

    // Get OpenAI API key
    let apiKey;
    try {
      const settingsManager = getSettingsManager();
      apiKey = settingsManager.get('openaiApiKey');
    } catch (e) {
      console.warn('[TranscriptionService] Could not get OpenAI API key from settings:', e.message);
    }

    if (!apiKey) {
      return {
        success: false,
        error: 'OpenAI API key not configured. Please set it in Settings.',
        speakerMap: {}
      };
    }

    console.log(`[TranscriptionService] Identifying ${speakers.length} speakers using LLM...`);

    // Format transcript as a conversation for the LLM
    const formattedTranscript = this._formatTranscriptForSpeakerIdentification(transcriptionResult);

    try {
      const result = await this._callOpenAIForSpeakerIdentification(
        formattedTranscript,
        speakers,
        { context, expectedNames, apiKey, projectId }
      );

      // Apply speaker names to the transcription result if requested
      if (result.success && result.speakerMap) {
        console.log('[TranscriptionService] Speaker identification complete:', result.speakerMap);
      }

      return result;

    } catch (error) {
      console.error('[TranscriptionService] Speaker identification error:', error);
      return {
        success: false,
        error: error.message,
        speakerMap: {}
      };
    }
  }

  /**
   * Transcribe and identify speakers in one call
   * Convenience method that combines transcription with speaker identification
   * 
   * @param {string} audioPath - Path to audio file
   * @param {Object} options - Combined options for transcription and speaker identification
   * @returns {Promise<TranscriptionResult>} Transcription with identified speaker names
   */
  async transcribeWithSpeakerNames(audioPath, options = {}) {
    const {
      // Transcription options
      language = null,
      diarize = true,
      numSpeakers = null,
      multiChannel = false,
      // Speaker identification options
      context = null,
      expectedNames = [],
      projectId = null
    } = options;

    // First, transcribe the audio
    const transcription = await this.transcribe(audioPath, {
      language,
      diarize,
      numSpeakers,
      multiChannel,
      projectId
    });

    if (!transcription.success) {
      return transcription;
    }

    // If there are multiple speakers, try to identify them
    if (transcription.speakerCount > 0) {
      const identification = await this.identifySpeakers(transcription, {
        context,
        expectedNames,
        projectId
      });

      if (identification.success && Object.keys(identification.speakerMap).length > 0) {
        // Enrich the transcription with speaker names
        transcription.speakerNames = identification.speakerMap;
        transcription.speakerIdentificationConfidence = identification.confidence;
        transcription.speakerRoles = identification.roles || {};

        // Update words with speaker names
        transcription.words = transcription.words.map(w => ({
          ...w,
          speakerName: w.speaker ? identification.speakerMap[w.speaker] || w.speaker : null
        }));

        // Create enriched text with speaker names
        transcription.textWithSpeakers = this._formatTranscriptWithNames(transcription);
      }
    }

    return transcription;
  }

  /**
   * Format transcript for speaker identification prompt
   * @private
   */
  _formatTranscriptForSpeakerIdentification(transcriptionResult) {
    const words = transcriptionResult.words || [];
    if (words.length === 0) return transcriptionResult.text;

    // Group words by speaker and create conversation format
    const segments = [];
    let currentSegment = { speaker: null, text: [] };

    for (const word of words) {
      const speaker = word.speaker || 'unknown';
      
      if (speaker !== currentSegment.speaker) {
        if (currentSegment.text.length > 0) {
          segments.push({
            speaker: currentSegment.speaker,
            text: currentSegment.text.join(' ')
          });
        }
        currentSegment = { speaker, text: [word.text] };
      } else {
        currentSegment.text.push(word.text);
      }
    }

    // Add final segment
    if (currentSegment.text.length > 0) {
      segments.push({
        speaker: currentSegment.speaker,
        text: currentSegment.text.join(' ')
      });
    }

    // Format as dialogue
    return segments
      .map(s => `[${s.speaker}]: ${s.text}`)
      .join('\n\n');
  }

  /**
   * Call OpenAI API for speaker identification with optional web search
   * @private
   */
  async _callOpenAIForSpeakerIdentification(formattedTranscript, speakers, options) {
    const { context, expectedNames, apiKey, projectId, videoTitle } = options;
    const https = require('https');

    // Step 1: First pass - analyze transcript and determine if web search would help
    console.log('[TranscriptionService] Step 1: Analyzing transcript for speaker clues...');
    
    const analysisPrompt = `You are an expert at analyzing conversations to identify speakers.

Analyze this transcribed conversation and extract any clues that could help identify the speakers.

TRANSCRIPT:
${formattedTranscript}

${context ? `CONTEXT: ${context}` : ''}
${videoTitle ? `VIDEO TITLE: ${videoTitle}` : ''}
${expectedNames?.length > 0 ? `EXPECTED PARTICIPANTS: ${expectedNames.join(', ')}` : ''}

SPEAKERS TO IDENTIFY: ${speakers.join(', ')}

Analyze and respond with JSON:
{
  "namesFound": ["Any names mentioned in the transcript"],
  "organizationsFound": ["Any organizations, companies, or institutions mentioned"],
  "topicsDiscussed": ["Main topics being discussed"],
  "rolePatterns": {
    "speaker_0": "Appears to be interviewer/host/etc based on speaking patterns",
    "speaker_1": "Appears to be guest/expert/etc"
  },
  "needsWebSearch": true/false,
  "suggestedSearchQueries": ["Search queries that would help identify speakers"],
  "initialGuess": {
    "speaker_0": "Best guess based on transcript alone",
    "speaker_1": "Best guess based on transcript alone"
  },
  "confidence": 0.0 to 1.0
}`;

    const analysisResult = await this._makeOpenAIRequest(apiKey, analysisPrompt, 'gpt-4o-mini');
    console.log('[TranscriptionService] Analysis result:', JSON.stringify(analysisResult, null, 2));

    // Step 2: If web search would help, perform searches
    let webSearchResults = [];
    if (analysisResult.needsWebSearch && analysisResult.suggestedSearchQueries?.length > 0) {
      console.log('[TranscriptionService] Step 2: Performing web searches...');
      
      // Combine context for smarter searches
      const searchQueries = analysisResult.suggestedSearchQueries.slice(0, 3); // Limit to 3 searches
      
      // Add video title based search if available
      if (videoTitle && !searchQueries.some(q => q.includes(videoTitle))) {
        searchQueries.unshift(`${videoTitle} interview speakers`);
      }
      
      for (const query of searchQueries) {
        try {
          console.log(`[TranscriptionService] Searching: "${query}"`);
          const searchResult = await this._performWebSearch(query);
          if (searchResult) {
            webSearchResults.push({
              query,
              results: searchResult
            });
          }
        } catch (searchError) {
          console.warn(`[TranscriptionService] Search failed for "${query}":`, searchError.message);
        }
      }
      console.log(`[TranscriptionService] Got ${webSearchResults.length} search results`);
    }

    // Step 3: Final identification with all gathered information
    console.log('[TranscriptionService] Step 3: Final speaker identification...');
    
    let finalPrompt = `You are an expert at identifying speakers in conversations.

Based on the following information, identify who each speaker is.

TRANSCRIPT EXCERPT (first 2000 chars):
${formattedTranscript.substring(0, 2000)}${formattedTranscript.length > 2000 ? '...' : ''}

SPEAKERS TO IDENTIFY: ${speakers.join(', ')}

ANALYSIS FROM TRANSCRIPT:
- Names mentioned: ${analysisResult.namesFound?.join(', ') || 'none'}
- Organizations: ${analysisResult.organizationsFound?.join(', ') || 'none'}  
- Topics: ${analysisResult.topicsDiscussed?.join(', ') || 'none'}
- Role patterns: ${JSON.stringify(analysisResult.rolePatterns || {})}
- Initial guess: ${JSON.stringify(analysisResult.initialGuess || {})}
`;

    if (webSearchResults.length > 0) {
      finalPrompt += `\nWEB SEARCH RESULTS:\n`;
      for (const search of webSearchResults) {
        finalPrompt += `\nQuery: "${search.query}"\n`;
        finalPrompt += `Results: ${search.results.substring(0, 1000)}\n`;
      }
    }

    if (context) {
      finalPrompt += `\nADDITIONAL CONTEXT: ${context}`;
    }

    if (videoTitle) {
      finalPrompt += `\nVIDEO TITLE: ${videoTitle}`;
    }

    finalPrompt += `

Now provide the final speaker identification in JSON format:

{
  "speakerMap": {
    "speaker_0": "Full name if known, otherwise descriptive label like 'Host' or 'Interviewer'",
    "speaker_1": "Full name if known, otherwise descriptive label"
  },
  "confidence": 0.0 to 1.0,
  "reasoning": "Detailed explanation of how you identified each speaker, citing evidence from transcript and web search",
  "roles": {
    "speaker_0": "Role (host, interviewer, guest, expert, etc.)",
    "speaker_1": "Role"
  },
  "clues": ["Specific evidence that helped identification"],
  "webSearchUsed": true/false,
  "sourcesUsed": ["List any sources from web search that helped"]
}

Be confident in your identification if the evidence is strong. Use full names when you can determine them.`;

    const finalResult = await this._makeOpenAIRequest(apiKey, finalPrompt, 'gpt-4o');

    return {
      success: true,
      speakerMap: finalResult.speakerMap || analysisResult.initialGuess || {},
      confidence: finalResult.confidence || analysisResult.confidence || 0.5,
      reasoning: finalResult.reasoning || '',
      roles: finalResult.roles || analysisResult.rolePatterns || {},
      clues: finalResult.clues || [],
      webSearchUsed: webSearchResults.length > 0,
      sourcesUsed: finalResult.sourcesUsed || [],
      _model: 'gpt-4o',
      _provider: 'openai'
    };
  }

  /**
   * Make a request to OpenAI API
   * @private
   */
  async _makeOpenAIRequest(apiKey, prompt, model = 'gpt-4o-mini') {
    const https = require('https');
    
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert analyst. Always respond with valid JSON only, no markdown formatting or extra text.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 2000,
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const requestOptions = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode !== 200) {
              const errorMsg = response.error?.message || `API error: ${res.statusCode}`;
              reject(new Error(errorMsg));
              return;
            }

            const content = response.choices[0]?.message?.content;
            if (!content) {
              reject(new Error('No content in API response'));
              return;
            }

            resolve(JSON.parse(content));
          } catch (error) {
            reject(new Error('Failed to parse API response: ' + error.message));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Perform web search using DuckDuckGo
   * @private
   */
  async _performWebSearch(query) {
    const https = require('https');
    
    return new Promise((resolve, reject) => {
      // Use DuckDuckGo instant answer API (free, no API key needed)
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
      
      console.log(`[TranscriptionService] Web search: ${query}`);
      
      const req = https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            
            // Extract useful information from DuckDuckGo response
            let searchSummary = '';
            
            if (result.Abstract) {
              searchSummary += `Abstract: ${result.Abstract}\n`;
            }
            
            if (result.RelatedTopics && result.RelatedTopics.length > 0) {
              const topics = result.RelatedTopics
                .filter(t => t.Text)
                .slice(0, 5)
                .map(t => t.Text);
              if (topics.length > 0) {
                searchSummary += `Related: ${topics.join(' | ')}\n`;
              }
            }
            
            if (result.Infobox?.content) {
              const infoboxData = result.Infobox.content
                .filter(item => item.label && item.value)
                .slice(0, 5)
                .map(item => `${item.label}: ${item.value}`);
              if (infoboxData.length > 0) {
                searchSummary += `Info: ${infoboxData.join(', ')}\n`;
              }
            }
            
            // If DuckDuckGo didn't return much, try a fallback search
            if (!searchSummary || searchSummary.length < 50) {
              // Return a note that we should try Google search or other method
              searchSummary = `Limited results for "${query}". `;
              if (result.AbstractSource) {
                searchSummary += `Source: ${result.AbstractSource}. `;
              }
            }
            
            resolve(searchSummary || null);
          } catch (error) {
            console.warn('[TranscriptionService] Search parse error:', error.message);
            resolve(null);
          }
        });
      });
      
      req.on('error', (error) => {
        console.warn('[TranscriptionService] Search request error:', error.message);
        resolve(null); // Don't reject, just return null
      });
      
      // Set timeout
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Call OpenAI API for speaker identification (legacy method kept for compatibility)
   * @private
   * @deprecated Use _callOpenAIForSpeakerIdentification instead
   */
  async _callOpenAIForSpeakerIdentificationSimple(formattedTranscript, speakers, options) {
    const { context, expectedNames, apiKey, projectId } = options;
    const https = require('https');

    // Build the prompt
    let prompt = `You are an expert at analyzing conversations and identifying speakers.

Analyze this transcribed conversation and try to identify who each speaker might be.

TRANSCRIPT:
${formattedTranscript}

SPEAKERS TO IDENTIFY: ${speakers.join(', ')}
`;

    if (context) {
      prompt += `\nCONTEXT: ${context}`;
    }

    if (expectedNames && expectedNames.length > 0) {
      prompt += `\nEXPECTED PARTICIPANTS: ${expectedNames.join(', ')}`;
    }

    prompt += `

Based on the conversation content, identify each speaker by looking for:
1. Direct introductions ("I'm John", "My name is Sarah")
2. Addressing by name ("Thanks Mike", "Sarah, what do you think?")
3. Self-references in third person
4. Role indicators (interviewer asks questions, interviewee responds)
5. Speaking patterns and context clues

Provide your analysis in JSON format:

{
  "speakerMap": {
    "speaker_0": "Name or best guess (or 'Unknown' if cannot determine)",
    "speaker_1": "Name or best guess"
  },
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief explanation of how you identified each speaker",
  "roles": {
    "speaker_0": "Role if identifiable (e.g., 'host', 'interviewer', 'guest')",
    "speaker_1": "Role if identifiable"
  },
  "clues": ["List of specific phrases or context that helped identification"]
}

If you cannot confidently identify a speaker, use a descriptive label like "Host", "Guest 1", "Interviewer", etc.
Respond with valid JSON only.`;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert conversation analyst. Always respond with valid JSON only, no markdown formatting or extra text.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 1000,
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const requestOptions = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode !== 200) {
              const errorMsg = response.error?.message || `API error: ${res.statusCode}`;
              console.error('[TranscriptionService] OpenAI API Error:', errorMsg);
              reject(new Error(errorMsg));
              return;
            }

            const content = response.choices[0]?.message?.content;
            if (!content) {
              reject(new Error('No content in API response'));
              return;
            }

            // Parse the JSON response
            const result = JSON.parse(content);
            
            resolve({
              success: true,
              speakerMap: result.speakerMap || {},
              confidence: result.confidence || 0.5,
              reasoning: result.reasoning || '',
              roles: result.roles || {},
              clues: result.clues || [],
              _model: 'gpt-4o-mini',
              _provider: 'openai'
            });
            
          } catch (error) {
            console.error('[TranscriptionService] Parse error:', error.message);
            reject(new Error('Failed to parse API response: ' + error.message));
          }
        });
      });

      req.on('error', (error) => {
        console.error('[TranscriptionService] Request error:', error.message);
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Format transcript with identified speaker names
   * @private
   */
  _formatTranscriptWithNames(transcriptionResult) {
    const words = transcriptionResult.words || [];
    const speakerMap = transcriptionResult.speakerNames || {};
    
    if (words.length === 0) return transcriptionResult.text;

    // Group words by speaker
    const segments = [];
    let currentSegment = { speaker: null, text: [] };

    for (const word of words) {
      const speakerId = word.speaker || 'unknown';
      const speakerName = speakerMap[speakerId] || speakerId;
      
      if (speakerId !== currentSegment.speaker) {
        if (currentSegment.text.length > 0) {
          const name = speakerMap[currentSegment.speaker] || currentSegment.speaker;
          segments.push(`${name}: ${currentSegment.text.join(' ')}`);
        }
        currentSegment = { speaker: speakerId, text: [word.text] };
      } else {
        currentSegment.text.push(word.text);
      }
    }

    // Add final segment
    if (currentSegment.text.length > 0) {
      const name = speakerMap[currentSegment.speaker] || currentSegment.speaker;
      segments.push(`${name}: ${currentSegment.text.join(' ')}`);
    }

    return segments.join('\n\n');
  }

  /**
   * Check if transcription service is available
   * @returns {Promise<boolean>} True if API key is configured
   */
  async isAvailable() {
    try {
      const apiKey = this.elevenLabs.getApiKey();
      return !!apiKey;
    } catch {
      return false;
    }
  }

  /**
   * Get service information
   * @returns {Object} Service info
   */
  getServiceInfo() {
    return {
      name: 'ElevenLabs Scribe',
      provider: 'elevenlabs',
      features: [
        'speech-to-text',
        'word-timestamps',
        'speaker-diarization',
        'language-detection',
        'multi-channel'
      ],
      maxSpeakers: 32,
      supportedFormats: ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'flac']
    };
  }

  /**
   * Calculate total duration from words
   * @private
   */
  _calculateDuration(words) {
    if (!words || words.length === 0) return 0;
    const lastWord = words[words.length - 1];
    return lastWord.end || lastWord.start || 0;
  }
}

/**
 * @typedef {Object} TranscriptionResult
 * @property {boolean} success - Whether transcription succeeded
 * @property {string} [text] - Full transcription text
 * @property {string} [language] - Detected language code
 * @property {number} [languageProbability] - Language detection confidence
 * @property {Word[]} [words] - Word-level timestamps
 * @property {Segment[]} [segments] - Text segments
 * @property {string[]} [speakers] - List of speaker IDs
 * @property {number} [speakerCount] - Number of unique speakers
 * @property {string} source - Transcription service used
 * @property {number} [duration] - Audio duration in seconds
 * @property {number} [wordCount] - Total word count
 * @property {string} [error] - Error message if failed
 */

/**
 * @typedef {Object} Word
 * @property {string} text - The word text
 * @property {number} start - Start time in seconds
 * @property {number} end - End time in seconds
 * @property {string|null} speaker - Speaker ID if diarization enabled
 * @property {number|null} confidence - Word confidence score
 * @property {string} type - Word type ('word', 'punctuation', etc.)
 */

/**
 * @typedef {Object} Segment
 * @property {string} text - Segment text
 * @property {number} start - Start time in seconds
 * @property {number} end - End time in seconds
 * @property {string|null} speakerId - Speaker ID
 */

/**
 * @typedef {Object} SpeakerIdentificationResult
 * @property {boolean} success - Whether identification succeeded
 * @property {Object<string, string>} speakerMap - Map of speaker IDs to identified names
 * @property {number} [confidence] - Overall confidence score (0-1)
 * @property {string} [reasoning] - Explanation of how speakers were identified
 * @property {Object<string, string>} [roles] - Map of speaker IDs to roles (host, guest, etc.)
 * @property {string[]} [clues] - Context clues that helped identification
 * @property {string} [error] - Error message if failed
 */

// Singleton instance for easy import
let instance = null;

/**
 * Get the singleton TranscriptionService instance
 * @returns {TranscriptionService}
 */
export function getTranscriptionService() {
  if (!instance) {
    instance = new TranscriptionService();
  }
  return instance;
}

export default TranscriptionService;








