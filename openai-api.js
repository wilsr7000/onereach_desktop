/**
 * OpenAI API Client for GPT-5.2
 * Used for large context window tasks (text, code, data analysis)
 * 
 * GPT-5.2 Features:
 * - 256K context window
 * - Improved reasoning and analysis
 * - Better structured output (JSON mode)
 * 
 * Uses unified pricing from pricing-config.js
 */

const https = require('https');
const { getBudgetManager } = require('./budget-manager');
const getLogger = require('./event-logger');
const { getLLMUsageTracker } = require('./llm-usage-tracker');
const { calculateCost } = require('./pricing-config');

class OpenAIAPI {
  constructor() {
    this.baseURL = 'api.openai.com';
    this.defaultModel = 'gpt-5.2'; // GPT-5.2 - latest model with 256K context
    this.maxTokens = 4096;
  }

  /**
   * Generate metadata for text-based content using GPT-5.2
   * Best for: code, text, data files, HTML, URLs (large context)
   * 
   * @param {string} content - The content to analyze
   * @param {string} contentType - Type of content
   * @param {string} apiKey - OpenAI API key
   * @param {Object} options - Additional options
   * @param {string} options.projectId - Project ID for budget tracking
   * @returns {Promise<Object>} Generated metadata
   */
  async generateMetadata(content, contentType, apiKey, options = {}) {
    const logger = getLogger();
    
    if (!apiKey) {
      const error = new Error('OpenAI API key is required');
      logger.logAPIError('/v1/chat/completions', error, { operation: 'generateMetadata', contentType });
      throw error;
    }

    const prompt = this.buildPrompt(content, contentType, options);
    
    logger.info('OpenAI API request', {
      event: 'api:request',
      provider: 'openai',
      model: this.defaultModel,
      operation: `generateMetadata:${contentType}`,
      contentLength: content.length
    });

    return this.callAPI(prompt, apiKey, {
      operation: `generateMetadata:${contentType}`,
      projectId: options.projectId
    });
  }

  /**
   * Build specialized prompt based on content type
   */
  buildPrompt(content, contentType, options = {}) {
    const spaceContext = options.spaceContext || null;
    let contextInfo = '';
    
    if (spaceContext) {
      contextInfo = `\nSPACE CONTEXT: This content belongs to "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    const prompts = {
      code: this.buildCodePrompt(content, contextInfo, options),
      text: this.buildTextPrompt(content, contextInfo, options),
      data: this.buildDataPrompt(content, contextInfo, options),
      html: this.buildHtmlPrompt(content, contextInfo, options),
      url: this.buildUrlPrompt(content, contextInfo, options),
      audio: this.buildAudioPrompt(content, contextInfo, options),
      file: this.buildFilePrompt(content, contextInfo, options)
    };

    return prompts[contentType] || prompts.text;
  }

  buildCodePrompt(content, contextInfo, options) {
    const fileName = options.fileName || 'code';
    const fileExt = options.fileExt || '';
    
    return `You are an expert code analyst. Analyze this code file thoroughly.${contextInfo}

FILE: ${fileName}
EXTENSION: ${fileExt}

CODE:
\`\`\`
${content}
\`\`\`

Provide a comprehensive analysis in JSON format:

{
  "title": "Clear, descriptive title for this code",
  "description": "Detailed explanation of what this code does (2-3 sentences)",
  "language": "Programming language detected",
  "purpose": "Primary purpose and use case",
  "functions": ["List of main functions/methods/classes"],
  "dependencies": ["External libraries or modules used"],
  "patterns": ["Design patterns or programming paradigms used"],
  "complexity": "simple|moderate|complex",
  "qualityNotes": "Code quality observations",
  "tags": ["relevant", "searchable", "tags"],
  "suggestedImprovements": ["Optional improvement suggestions"],
  "notes": "Additional context or important details"
}

Respond with valid JSON only.`;
  }

  buildTextPrompt(content, contextInfo, options) {
    return `You are a content analyst. Analyze this text document thoroughly.${contextInfo}

CONTENT:
${content}

Provide a comprehensive analysis in JSON format:

{
  "title": "Clear, descriptive title (3-8 words)",
  "description": "Summary of what this text is about (2-3 sentences)",
  "contentType": "notes|article|documentation|message|list|meeting-notes|email|report|other",
  "topics": ["Main topics covered"],
  "keyPoints": ["Key points or important information"],
  "actionItems": ["Any tasks, todos, or action items mentioned"],
  "entities": ["People, organizations, or key entities mentioned"],
  "sentiment": "positive|neutral|negative|mixed",
  "tags": ["relevant", "searchable", "tags"],
  "notes": "Additional context or observations"
}

Respond with valid JSON only.`;
  }

  buildDataPrompt(content, contextInfo, options) {
    const fileName = options.fileName || 'data';
    const fileExt = options.fileExt || '';
    
    return `You are a data analyst. Analyze this data file thoroughly.${contextInfo}

FILE: ${fileName}
FORMAT: ${fileExt}

DATA:
${content}

Provide a comprehensive analysis in JSON format:

{
  "title": "Clear title describing this data",
  "description": "What this data represents (2-3 sentences)",
  "dataType": "config|dataset|api-response|export|schema|log|metrics|other",
  "format": "JSON|CSV|YAML|XML|other",
  "structure": "Description of data structure",
  "entities": ["Main data entities or objects"],
  "keyFields": ["Important fields or properties"],
  "recordCount": "Number of records if applicable",
  "purpose": "Likely use case for this data",
  "dataQuality": "Observations about data completeness/validity",
  "tags": ["relevant", "searchable", "tags"],
  "notes": "Additional insights or observations"
}

Respond with valid JSON only.`;
  }

  buildHtmlPrompt(content, contextInfo, options) {
    return `You are a web content analyst. Analyze this HTML/web content.${contextInfo}

CONTENT:
${content}

Provide a comprehensive analysis in JSON format:

{
  "title": "Document title or main heading",
  "description": "What this document covers (2-3 sentences)",
  "documentType": "article|report|webpage|documentation|presentation|email|form|other",
  "topics": ["Main topics covered"],
  "keyPoints": ["Important points or information"],
  "structure": ["Main sections or headings"],
  "author": "Author name if identifiable",
  "source": "Source website or platform if identifiable",
  "links": ["Important links mentioned"],
  "tags": ["relevant", "searchable", "tags"],
  "notes": "Additional context or summary"
}

Respond with valid JSON only.`;
  }

  buildUrlPrompt(content, contextInfo, options) {
    const pageTitle = options.pageTitle || '';
    const pageDescription = options.pageDescription || '';
    
    return `You are a web resource analyst. Analyze this URL/web link.${contextInfo}

URL: ${content}
${pageTitle ? `PAGE TITLE: ${pageTitle}` : ''}
${pageDescription ? `PAGE DESCRIPTION: ${pageDescription}` : ''}

Based on the URL structure and any available metadata, provide analysis in JSON format:

{
  "title": "Clear title for this link",
  "description": "What this link is and why it's useful (2 sentences)",
  "urlType": "article|documentation|tool|repository|video|social-media|resource|api|other",
  "platform": "Website or platform name",
  "domain": "Domain category (tech, business, education, etc.)",
  "topics": ["Relevant topics"],
  "tags": ["searchable", "tags"],
  "purpose": "Why someone might save this link",
  "notes": "Additional context"
}

Respond with valid JSON only.`;
  }

  buildAudioPrompt(content, contextInfo, options) {
    const fileName = options.fileName || 'audio';
    const duration = options.duration || 'Unknown';
    const transcript = options.transcript || '';
    
    return `You are an audio content analyst. Analyze this audio file information.${contextInfo}

FILE: ${fileName}
DURATION: ${duration}
${transcript ? `\nTRANSCRIPT:\n${transcript}` : 'No transcript available.'}

Provide analysis in JSON format:

{
  "title": "Clear title for this audio",
  "description": "What this audio contains (2-3 sentences)",
  "audioType": "podcast|music|voice-memo|audiobook|interview|lecture|recording|meeting|other",
  "topics": ["Main topics if applicable"],
  "speakers": ["Speaker names if identifiable"],
  "keyPoints": ["Key points or highlights"],
  "genre": "Category or genre",
  "mood": "Mood or tone",
  "tags": ["relevant", "tags"],
  "notes": "Additional observations"
}

Respond with valid JSON only.`;
  }

  buildFilePrompt(content, contextInfo, options) {
    const fileName = options.fileName || 'file';
    const fileExt = options.fileExt || '';
    const fileSize = options.fileSize || 0;
    
    return `You are a file analyst. Analyze this file based on its metadata.${contextInfo}

FILENAME: ${fileName}
EXTENSION: ${fileExt}
SIZE: ${this.formatBytes(fileSize)}

Provide analysis in JSON format:

{
  "title": "Clear, descriptive title",
  "description": "What this file likely contains (2 sentences)",
  "fileCategory": "Document type or category",
  "purpose": "Likely use case",
  "relatedTools": ["Applications that work with this file type"],
  "tags": ["relevant", "tags"],
  "notes": "Additional context"
}

Respond with valid JSON only.`;
  }

  /**
   * Call OpenAI API
   * @param {string} prompt - The prompt to send
   * @param {string} apiKey - OpenAI API key
   * @param {Object} trackingOptions - Options for budget tracking
   * @param {string} trackingOptions.operation - Operation name for tracking
   * @param {string} trackingOptions.projectId - Project ID for tracking
   */
  async callAPI(prompt, apiKey, trackingOptions = {}) {
    const logger = getLogger();
    
    // Check budget before making the call
    try {
      const budgetManager = getBudgetManager();
      
      // Estimate cost based on prompt length
      const estimatedInputTokens = Math.ceil(prompt.length / 4);
      const estimatedOutputTokens = this.maxTokens;
      // Pricing is per 1M tokens, use the model-specific or default pricing
      const pricing = budgetManager.getPricing().openai?.[this.defaultModel] || { input: 5.00, output: 15.00 };
      const estimatedCost = (estimatedInputTokens / 1000000) * pricing.input + 
                           (estimatedOutputTokens / 1000000) * pricing.output;
      
      const budgetCheck = budgetManager.checkBudgetWithWarning('openai', estimatedCost, trackingOptions.operation || 'api_call');
      
      if (budgetCheck.exceeded) {
        logger.warn('OpenAI API call proceeding despite budget exceeded', {
          event: 'budget:exceeded',
          provider: 'openai',
          operation: trackingOptions.operation,
          estimatedCost,
          remaining: budgetCheck.remaining
        });
      }
    } catch (budgetError) {
      logger.warn('OpenAI budget check failed, proceeding with call', {
        error: budgetError.message
      });
    }

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: this.defaultModel,
        messages: [
          {
            role: 'system',
            content: 'You are a precise metadata generator. Always respond with valid JSON only, no markdown formatting or extra text.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_completion_tokens: this.maxTokens, // GPT-5.2 uses max_completion_tokens
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const options = {
        hostname: this.baseURL,
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const requestStartTime = Date.now();
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          const logger = getLogger();
          const requestDuration = Date.now() - requestStartTime;
          
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode !== 200) {
              const errorMsg = response.error?.message || `API error: ${res.statusCode}`;
              logger.logAPIError('/v1/chat/completions', new Error(errorMsg), {
                provider: 'openai',
                statusCode: res.statusCode,
                operation: trackingOptions.operation,
                duration: requestDuration
              });
              reject(new Error(errorMsg));
              return;
            }

            const content = response.choices[0]?.message?.content;
            if (!content) {
              logger.logAPIError('/v1/chat/completions', new Error('No content in API response'), {
                provider: 'openai',
                operation: trackingOptions.operation
              });
              reject(new Error('No content in API response'));
              return;
            }

            // Parse the JSON response
            const metadata = JSON.parse(content);
            
            // Add model info
            metadata._model = this.defaultModel;
            metadata._provider = 'openai';
            
            // Track usage if available in response
            const usage = response.usage;
            if (usage) {
              try {
                // Use LLMUsageTracker as the single entry point
                // It will delegate to BudgetManager for centralized storage
                const llmTracker = getLLMUsageTracker();
                llmTracker.trackOpenAICall({
                  model: this.defaultModel,
                  inputTokens: usage.prompt_tokens || 0,
                  outputTokens: usage.completion_tokens || 0,
                  feature: this._getFeatureFromOperation(trackingOptions.operation),
                  purpose: trackingOptions.operation,
                  projectId: trackingOptions.projectId,
                  duration: requestDuration,
                  success: true
                });
                
                logger.logNetworkRequest('POST', '/v1/chat/completions', res.statusCode, requestDuration);
                logger.info('OpenAI API usage tracked', {
                  event: 'api:usage',
                  provider: 'openai',
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  operation: trackingOptions.operation
                });
                
                // Add usage info to metadata
                metadata._usage = {
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  totalTokens: usage.total_tokens
                };
              } catch (trackingError) {
                logger.warn('OpenAI API usage tracking failed', {
                  error: trackingError.message,
                  operation: trackingOptions.operation
                });
              }
            }
            
            logger.info('OpenAI API request successful', {
              event: 'api:success',
              provider: 'openai',
              operation: trackingOptions.operation,
              duration: requestDuration
            });
            resolve(metadata);
            
          } catch (error) {
            logger.logAPIError('/v1/chat/completions', error, {
              provider: 'openai',
              operation: trackingOptions.operation,
              parseError: true
            });
            reject(new Error('Failed to parse API response: ' + error.message));
          }
        });
      });

      req.on('error', (error) => {
        const logger = getLogger();
        logger.logAPIError('/v1/chat/completions', error, {
          provider: 'openai',
          operation: trackingOptions.operation,
          networkError: true
        });
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Generate audio suggestions for a video marker/scene
   * @param {Object} marker - Marker data with description, transcription, tags
   * @param {string} type - 'music' or 'sfx' (sound effects)
   * @param {string} apiKey - OpenAI API key
   * @param {Object} options - Additional options
   * @returns {Promise<Array>} Array of 5 audio prompt suggestions
   */
  async generateAudioSuggestions(marker, type, apiKey, options = {}) {
    const logger = getLogger();
    
    if (!apiKey) {
      const error = new Error('OpenAI API key is required');
      logger.logAPIError('/v1/chat/completions', error, { operation: 'generateAudioSuggestions', type });
      throw error;
    }

    const prompt = this.buildAudioSuggestionPrompt(marker, type, options);
    
    logger.info('OpenAI audio suggestions request', {
      event: 'api:request',
      provider: 'openai',
      operation: `audioSuggestions:${type}`,
      markerName: marker.name
    });

    const result = await this.callAPI(prompt, apiKey, {
      operation: `audioSuggestions:${type}`,
      projectId: options.projectId
    });

    return result.suggestions || [];
  }

  /**
   * Build prompt for audio suggestions based on marker context
   * @param {Object} marker - Marker with description, transcription, tags, duration
   * @param {string} type - 'music' or 'sfx'
   * @param {Object} options - Additional context
   * @returns {string} The prompt for OpenAI
   */
  buildAudioSuggestionPrompt(marker, type, options = {}) {
    const duration = marker.duration || (marker.outTime - marker.inTime) || 10;
    const durationStr = duration.toFixed(1);
    
    const context = {
      name: marker.name || 'Untitled Scene',
      description: marker.description || '',
      transcription: marker.transcription || '',
      tags: (marker.tags || []).join(', '),
      duration: durationStr
    };

    if (type === 'music') {
      return this._buildMusicPrompt(context);
    } else {
      return this._buildSFXPrompt(context);
    }
  }

  /**
   * Build music suggestion prompt
   */
  _buildMusicPrompt(context) {
    return `You are a professional music supervisor for film and video. Based on the scene context below, suggest 5 different music options that would work well as background music.

SCENE CONTEXT:
- Scene Name: ${context.name}
- Description: ${context.description || 'No description provided'}
- Transcript/Dialogue: ${context.transcription || 'No dialogue'}
- Tags: ${context.tags || 'None'}
- Duration: ${context.duration} seconds

Generate 5 diverse music suggestions. Each suggestion should be distinctly different in style, mood, or genre. Consider the emotional tone, pacing, and content of the scene.

Respond with valid JSON only:

{
  "suggestions": [
    {
      "id": 1,
      "title": "Short descriptive title (3-5 words)",
      "prompt": "Detailed prompt for AI music generation (include genre, mood, tempo, instruments, style)",
      "description": "Brief explanation of why this works for the scene",
      "genre": "Primary genre",
      "mood": "Primary mood/emotion",
      "tempo": "slow|medium|fast",
      "instrumental": true
    },
    ... (4 more suggestions)
  ]
}

Make the prompts detailed and specific for best AI music generation results. Vary the suggestions across different genres (cinematic, electronic, acoustic, orchestral, ambient, etc.) and moods.`;
  }

  /**
   * Build sound effect suggestion prompt
   */
  _buildSFXPrompt(context) {
    return `You are a professional sound designer for film and video. Based on the scene context below, suggest 5 different sound effect options that would enhance the scene.

SCENE CONTEXT:
- Scene Name: ${context.name}
- Description: ${context.description || 'No description provided'}
- Transcript/Dialogue: ${context.transcription || 'No dialogue'}
- Tags: ${context.tags || 'None'}
- Duration: ${context.duration} seconds

Generate 5 diverse sound effect suggestions. Consider what sounds would naturally occur in this scene, what ambient sounds would set the mood, and what sound design elements could enhance the emotional impact.

Respond with valid JSON only:

{
  "suggestions": [
    {
      "id": 1,
      "title": "Short descriptive title (3-5 words)",
      "prompt": "Detailed prompt for AI sound effect generation (be specific about the sounds, layers, intensity)",
      "description": "Brief explanation of why this works for the scene",
      "category": "ambient|action|foley|atmosphere|transition|impact",
      "intensity": "subtle|moderate|intense"
    },
    ... (4 more suggestions)
  ]
}

Make the prompts detailed and specific. Include layered sounds where appropriate (e.g., "city ambience with distant traffic, occasional car horns, and light wind"). Vary between ambient backgrounds, specific sound effects, and atmospheric design.`;
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }

  /**
   * Check if content needs large context (use GPT-5.2)
   */
  static needsLargeContext(content) {
    // Use GPT-5.2 for content > 50K chars (benefits from 256K context)
    return content && content.length > 50000;
  }

  /**
   * Get recommended model based on content size
   */
  static getRecommendedModel(contentLength) {
    if (contentLength > 100000) {
      return { model: 'gpt-5.2', reason: 'Very large content (>100K chars)' };
    }
    if (contentLength > 50000) {
      return { model: 'gpt-5.2', reason: 'Large content (>50K chars)' };
    }
    return { model: 'gpt-5.2', reason: 'Standard analysis' };
  }
  
  /**
   * Map operation name to feature category for dashboard
   */
  _getFeatureFromOperation(operation) {
    if (!operation) return 'other';
    const op = operation.toLowerCase();
    if (op.includes('metadata')) return 'metadata-generation';
    if (op.includes('gsx') || op.includes('create')) return 'gsx-create';
    if (op.includes('agent') || op.includes('diagnos')) return 'agent-diagnosis';
    if (op.includes('code')) return 'code-analysis';
    if (op.includes('text')) return 'text-analysis';
    if (op.includes('generative') || op.includes('search')) return 'generative-search';
    return 'other';
  }

  /**
   * Evaluate items for generative search
   * Optimized for fast batch evaluation with JSON responses
   * 
   * @param {string} prompt - Evaluation prompt with criteria and items
   * @param {string} apiKey - OpenAI API key
   * @param {Object} options - Options
   * @param {boolean} options.jsonMode - Request JSON response (default: true)
   * @param {number} options.maxTokens - Max response tokens (default: 1500)
   * @param {number} options.temperature - Temperature (default: 0.2 for consistency)
   * @returns {Promise<string>} Raw response content
   */
  async evaluateForGenerativeSearch(prompt, apiKey, options = {}) {
    const logger = getLogger();
    
    if (!apiKey) {
      throw new Error('OpenAI API key is required for generative search');
    }

    const maxTokens = options.maxTokens || 1500;
    const temperature = options.temperature || 0.2;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: this.defaultModel,
        messages: [
          {
            role: 'system',
            content: 'You are an expert content evaluator. Evaluate items precisely and return only valid JSON. Be consistent in your scoring.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_completion_tokens: maxTokens,
        temperature: temperature,
        response_format: { type: 'json_object' }
      });

      const requestOptions = {
        hostname: this.baseURL,
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const requestStartTime = Date.now();
      const req = https.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          const requestDuration = Date.now() - requestStartTime;
          
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode !== 200) {
              const errorMsg = response.error?.message || `API error: ${res.statusCode}`;
              logger.logAPIError('/v1/chat/completions', new Error(errorMsg), {
                provider: 'openai',
                operation: 'generativeSearch',
                statusCode: res.statusCode
              });
              reject(new Error(errorMsg));
              return;
            }

            const content = response.choices[0]?.message?.content;
            if (!content) {
              reject(new Error('No content in API response'));
              return;
            }

            // Track usage
            const usage = response.usage;
            if (usage) {
              try {
                const llmTracker = getLLMUsageTracker();
                llmTracker.trackOpenAICall({
                  model: this.defaultModel,
                  inputTokens: usage.prompt_tokens || 0,
                  outputTokens: usage.completion_tokens || 0,
                  feature: 'generative-search',
                  purpose: 'generativeSearch',
                  projectId: options.projectId,
                  duration: requestDuration,
                  success: true
                });
              } catch (trackingError) {
                // Ignore tracking errors
              }
            }

            resolve(content);
            
          } catch (error) {
            reject(new Error('Failed to parse API response: ' + error.message));
          }
        });
      });

      req.on('error', (error) => {
        logger.logAPIError('/v1/chat/completions', error, {
          provider: 'openai',
          operation: 'generativeSearch',
          networkError: true
        });
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Estimate token count for cost calculation
   * @param {string} text - Text to estimate
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text) return 0;
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }

  /**
   * Get pricing info for cost estimation
   * @returns {Object} Pricing per 1K tokens
   */
  static getPricing() {
    return {
      model: 'gpt-5.2',
      inputPer1k: 0.005,
      outputPer1k: 0.015
    };
  }
}

// Singleton instance
let openaiAPIInstance = null;

function getOpenAIAPI() {
  if (!openaiAPIInstance) {
    openaiAPIInstance = new OpenAIAPI();
  }
  return openaiAPIInstance;
}

module.exports = { OpenAIAPI, getOpenAIAPI };






































