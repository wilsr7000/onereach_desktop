/**
 * @deprecated Use lib/ai-service.js instead.
 * This file is retained for backward compatibility but all consumers
 * have been migrated to the centralized AI service.
 * See: const ai = require('./lib/ai-service');
 */
console.warn('[ClaudeAPI] DEPRECATED — use lib/ai-service.js instead');

const { app, net } = require('electron');
const getLogger = require('./event-logger');
const { getBudgetManager } = require('./budget-manager');
const { getLLMUsageTracker } = require('./llm-usage-tracker');
const { calculateCost } = require('./pricing-config');

class ClaudeAPI {
  constructor() {
    this.baseURL = 'https://api.anthropic.com/v1';
    this.defaultModel = 'claude-opus-4-5-20251101'; // Claude Opus 4.5 - most capable model
    this.maxTokens = 1000; // Default max tokens for responses
  }

  /**
   * Check budget before making an API call and emit warning if exceeded
   * Uses unified pricing from pricing-config.js
   * @param {string} operation - Operation name for tracking
   * @param {number} estimatedInputTokens - Estimated input tokens
   * @param {number} estimatedOutputTokens - Estimated output tokens
   * @param {string} projectId - Optional project ID
   */
  checkBudgetBeforeCall(operation, estimatedInputTokens, estimatedOutputTokens, projectId = null) {
    const logger = getLogger();
    try {
      const budgetManager = getBudgetManager();
      
      // Use unified pricing from pricing-config.js
      const costResult = calculateCost(this.defaultModel, estimatedInputTokens, estimatedOutputTokens);
      
      const budgetCheck = budgetManager.preCheckBudget(
        'anthropic', 
        this.defaultModel, 
        estimatedInputTokens, 
        estimatedOutputTokens, 
        projectId
      );
      
      if (budgetCheck.blocked) {
        logger.warn('Claude API call blocked by hard budget limit', {
          event: 'budget:blocked',
          provider: 'anthropic',
          operation,
          estimatedCost: costResult.totalCost
        });
        return { exceeded: true, blocked: true, warning: budgetCheck.warnings };
      }
      
      if (budgetCheck.warnings?.length > 0) {
        logger.warn('Claude API call proceeding with budget warning', {
          event: 'budget:warning',
          provider: 'anthropic',
          operation,
          estimatedCost: costResult.totalCost,
          warnings: budgetCheck.warnings
        });
      }
      
      return budgetCheck;
    } catch (budgetError) {
      logger.warn('Claude budget check failed, proceeding with call', {
        error: budgetError.message
      });
      return { exceeded: false, blocked: false, warning: null };
    }
  }

  /**
   * Track usage after a successful API call
   * Delegates to LLMUsageTracker which handles BudgetManager integration
   * @param {string} operation - Operation name
   * @param {Object} usage - Usage data from API response
   * @param {string} projectId - Optional project ID
   */
  trackUsage(operation, usage, projectId = null) {
    const logger = getLogger();
    try {
      // Use LLMUsageTracker as the single entry point
      // It will delegate to BudgetManager for centralized storage
      const llmTracker = getLLMUsageTracker();
      llmTracker.trackClaudeCall({
        model: usage.model || this.defaultModel,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        feature: this._getFeatureFromOperation(operation),
        purpose: operation,
        projectId,
        success: true
      });
      
      logger.info('Claude API usage tracked', {
        event: 'api:usage',
        provider: 'anthropic',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        operation
      });
    } catch (trackingError) {
      logger.warn('Claude API usage tracking failed', {
        error: trackingError.message,
        operation
      });
    }
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
    if (op.includes('vision') || op.includes('image')) return 'vision-analysis';
    return 'other';
  }

  /**
   * Generate metadata for clipboard content using Claude
   * @param {string} content - The content to analyze
   * @param {string} contentType - Type of content (text, code, html, etc.)
   * @param {string} apiKey - Claude API key
   * @param {string} customPrompt - Optional custom prompt from user
   * @param {string} imageData - Optional base64 image data for vision analysis
   * @returns {Promise<Object>} Generated metadata
   */
  async generateMetadata(content, contentType, apiKey, customPrompt = '', imageData = null) {
    if (!apiKey) {
      throw new Error('API key is required');
    }

    // Truncate content if too long (keep under 10k chars for efficiency)
    const truncatedContent = content.length > 10000 
      ? content.substring(0, 10000) + '...\n[Content truncated for analysis]'
      : content;

    // Build the message content based on whether we have an image
    let messageContent;
    
    const logger = getLogger();
    
    if (imageData && contentType === 'image') {
      // For images, use Claude's vision capabilities
      logger.info('Claude API vision request', {
        event: 'api:request',
        provider: 'anthropic',
        model: this.defaultModel,
        contentType: 'image',
        hasCustomPrompt: !!customPrompt
      });
      
      // Validate image data
      if (!imageData || imageData.length < 100) {
        throw new Error('Invalid or empty image data provided');
      }
      
      // Extract media type and validate
      let mediaType = 'image/png'; // default
      let base64Data = imageData;
      
      if (imageData.startsWith('data:')) {
        const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          mediaType = matches[1];
          base64Data = matches[2];
        } else {
          throw new Error('Invalid data URL format for image');
        }
      }
      
      // Validate base64 data
      if (base64Data.length < 50) {
        throw new Error('Image data appears to be too small or corrupted');
      }
      
      logger.debug('Claude API image data', {
        mediaType,
        base64Length: base64Data.length
      });
      
      messageContent = [
        {
          type: 'text',
          text: `You are analyzing an image for a clipboard management system. Look at this image carefully and describe what you actually see.

IMPORTANT: Analyze the ACTUAL VISUAL CONTENT of the image. Do not give generic responses about image data or clipboard systems.

Provide a JSON response with the following fields:

- description: Describe EXACTLY what you see in this image. Be specific about objects, text, UI elements, people, or whatever is visible (1-2 sentences)
- notes: List specific details you observe - any text you can read, colors, layout, important elements, etc. (2-3 sentences)
- instructions: Based on what you see, suggest how this specific image might be used
- tags: 3-8 tags based on what's ACTUALLY IN THE IMAGE (e.g., if it's a screenshot of code, use "code", "programming", etc.)
- source: Your best guess about where this specific image came from based on its content
- ai_detected: true if this looks like AI-generated imagery, false otherwise
- category: Choose the most appropriate: screenshot, photo, diagram, design, chart, document, meme, other

${customPrompt ? `Additional analysis requested: ${customPrompt}` : ''}
${content && content !== 'Filename: Screenshot' ? `Context: ${content}` : ''}

Remember: Describe what you ACTUALLY SEE in the image, not generic metadata about images.
Respond with valid JSON only, no markdown formatting.`
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data
          }
        }
      ];
    } else {
      // For non-image content, use text-only prompt
      logger.info('Claude API text request', {
        event: 'api:request',
        provider: 'anthropic',
        model: this.defaultModel,
        contentType,
        hasCustomPrompt: !!customPrompt
      });
      
      // Special handling for HTML content
      let analysisPrompt;
      if (contentType === 'html') {
        analysisPrompt = `Analyze the following HTML document and generate comprehensive metadata for a clipboard management system.

This is an HTML document that should be analyzed for its content and structure, not just as code.

Provide a JSON response with the following fields:
- description: A clear description of what this document contains based on its content (1-2 sentences)
- notes: Key information, main topics, or important sections found in the document (2-3 sentences)
- instructions: The purpose of this document or how it might be used
- tags: An array of 3-8 relevant tags based on the document's content and topics (lowercase, single words or short phrases)
- source: Best guess of where this came from (smart-export, generated-document, website, etc.)
- ai_detected: Boolean indicating if this appears to be AI-generated content
- category: One of: report, documentation, article, presentation, data-visualization, form, other

Additional instructions:
${customPrompt || 'Focus on the actual content and meaning of the document, not the HTML structure itself.'}

HTML Document to analyze:
"""
${truncatedContent}
"""

Respond with valid JSON only, no markdown formatting.`;
      } else if (contentType === 'code') {
        analysisPrompt = `Analyze the following code and generate comprehensive metadata for a clipboard management system.

Provide a JSON response with the following fields:
- description: What this code does or implements (1-2 sentences)
- notes: Key functions, classes, or important logic in the code (2-3 sentences)
- instructions: How this code might be used or its purpose in a project
- tags: An array of 3-8 relevant tags (include programming language, frameworks, and key concepts)
- source: Best guess of where this came from (IDE, GitHub, documentation, etc.)
- ai_detected: Boolean indicating if this appears to be AI-generated code
- category: One of: script, library, component, configuration, test, snippet, other

Additional instructions:
${customPrompt || 'Focus on understanding the code\'s functionality and purpose.'}

Code to analyze:
"""
${truncatedContent}
"""

Respond with valid JSON only, no markdown formatting.`;
      } else if (contentType === 'data') {
        analysisPrompt = `Analyze the following data file and generate comprehensive metadata for a clipboard management system.

Provide a JSON response with the following fields:
- description: What kind of data this file contains (1-2 sentences)
- notes: Key structures, fields, or patterns in the data (2-3 sentences)
- instructions: How this data might be used or processed
- tags: An array of 3-8 relevant tags (include data format, content type, and use cases)
- source: Best guess of where this came from (API, database, export, etc.)
- ai_detected: Boolean indicating if this appears to be AI-generated data
- category: One of: configuration, api-response, database-export, structured-data, settings, other

Additional instructions:
${customPrompt || 'Focus on the data structure and potential use cases.'}

Data content to analyze:
"""
${truncatedContent}
"""

Respond with valid JSON only, no markdown formatting.`;
      } else if (contentType === 'document') {
        analysisPrompt = `Analyze the following document information and generate comprehensive metadata for a clipboard management system.

Provide a JSON response with the following fields:
- description: What this document likely contains based on its name and type (1-2 sentences)
- notes: Any observations about the document type, size, or potential content (2-3 sentences)
- instructions: How this document might be used or its likely purpose
- tags: An array of 3-8 relevant tags based on the document type and likely content
- source: Best guess of where this came from (office app, download, email attachment, etc.)
- ai_detected: Boolean indicating if this might be an AI-generated document
- category: One of: report, presentation, spreadsheet, form, manual, contract, other

Additional instructions:
${customPrompt || 'Make educated guesses based on the filename and document type.'}

Document information:
"""
${truncatedContent}
"""

Respond with valid JSON only, no markdown formatting.`;
      } else if (contentType === 'file') {
        analysisPrompt = `Analyze the following file information and generate comprehensive metadata for a clipboard management system.

Provide a JSON response with the following fields:
- description: What this file is based on its name and type (1-2 sentences)
- notes: Any relevant observations about the file (2-3 sentences)
- instructions: Potential use cases for this file
- tags: An array of 3-8 relevant tags based on the file type and name
- source: Best guess of where this came from
- ai_detected: Boolean indicating if this might be AI-generated
- category: One of: archive, executable, media, document, data, system, other

Additional instructions:
${customPrompt || 'Make educated guesses based on the filename and file type.'}

File information:
"""
${truncatedContent}
"""

Respond with valid JSON only, no markdown formatting.`;
      } else {
        // Standard prompt for other content types
        analysisPrompt = `Analyze the following ${contentType} content and generate comprehensive metadata for a clipboard management system.

Provide a JSON response with the following fields:
- description: A clear, concise description of what this content is (1-2 sentences)
- notes: Any important observations or context about the content (2-3 sentences)
- instructions: How this content might be used or its purpose
- tags: An array of 3-8 relevant tags (lowercase, single words or short phrases)
- source: Best guess of where this came from (website, app, etc.)
- ai_detected: Boolean indicating if this appears to be AI-generated content
- category: One of: code, documentation, data, creative, communication, reference, other

Additional instructions:
${customPrompt || 'Focus on practical categorization and searchability.'}

Content to analyze:
"""
${truncatedContent}
"""

Respond with valid JSON only, no markdown formatting.`;
      }
      
      messageContent = analysisPrompt;
    }

    try {
      // Log the message type being sent
      if (imageData) {
        logger.debug('Claude API sending vision request', {
          imageDataLength: imageData.length
        });
      }
      
      // Estimate tokens and check budget before making the call
      const messageContentStr = typeof messageContent === 'string' 
        ? messageContent 
        : JSON.stringify(messageContent);
      const estimatedInputTokens = Math.ceil(messageContentStr.length / 4);
      const estimatedOutputTokens = this.maxTokens;
      
      this.checkBudgetBeforeCall(
        `generateMetadata:${contentType}`, 
        estimatedInputTokens, 
        estimatedOutputTokens
      );
      
      // Use Electron's net module for the request
      const requestData = JSON.stringify({
        model: this.defaultModel,
        max_tokens: this.maxTokens,
        temperature: 0.3, // Lower temperature for more consistent metadata
        messages: [{
          role: 'user',
          content: messageContent
        }]
      });

      const data = await this.makeRequest(`${this.baseURL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, requestData);
      
      // Track usage from response
      if (data.usage) {
        this.trackUsage(`generateMetadata:${contentType}`, data.usage);
      }
      
      // Extract JSON from Claude's response
      const content = data.content[0].text;
      
      // Debug log the raw response
      logger.debug('Claude API response received', {
        responseLength: content.length
      });
      
      // Try to parse JSON from the response
      let metadata;
      try {
        // Remove any markdown code blocks if present
        const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/{[\s\S]*}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
        metadata = JSON.parse(jsonStr);
        logger.info('Claude API metadata parsed successfully', {
          event: 'api:success',
          provider: 'anthropic',
          contentType
        });
      } catch (parseError) {
        logger.warn('Claude API JSON parse failed, using fallback', {
          error: parseError.message,
          contentType
        });
        // Fallback to basic extraction
        metadata = this.extractBasicMetadata(content, contentType);
      }

      // Ensure all expected fields exist
      const result = {
        description: metadata.description || '',
        notes: metadata.notes || '',
        instructions: metadata.instructions || '',
        tags: Array.isArray(metadata.tags) ? metadata.tags : [],
        source: metadata.source || 'unknown',
        ai_generated: metadata.ai_detected || false,
        ai_assisted: false,
        ai_model: 'claude-opus-4-5',
        ai_provider: 'Anthropic',
        category: metadata.category || 'other'
      };
      
      // Add image-specific metadata if it's an image
      if (contentType === 'image' && metadata.category) {
        result.image_type = metadata.category;
      }
      
      return result;
    } catch (error) {
      logger.logAPIError('/v1/messages', error, {
        provider: 'anthropic',
        contentType,
        model: this.defaultModel
      });
      throw error;
    }
  }

  /**
   * Fallback method to extract basic metadata if JSON parsing fails
   */
  extractBasicMetadata(responseText, contentType) {
    const lines = responseText.split('\n');
    const metadata = {
      description: '',
      notes: '',
      instructions: '',
      tags: [],
      source: 'unknown',
      ai_detected: false,
      category: 'other'
    };

    // Try to extract fields from the response text
    lines.forEach(line => {
      if (line.includes('description:')) {
        metadata.description = line.split('description:')[1].trim();
      } else if (line.includes('tags:')) {
        const tagStr = line.split('tags:')[1].trim();
        metadata.tags = tagStr.split(',').map(t => t.trim());
      }
    });

    // If still no description, create a basic one
    if (!metadata.description) {
      metadata.description = `${contentType} content captured from clipboard`;
    }

    return metadata;
  }

  /**
   * Make HTTP request using Electron's net module
   */
  async makeRequest(url, options, body) {
    return new Promise((resolve, reject) => {
      const request = net.request({
        url,
        method: options.method,
        headers: options.headers
      });

      let responseData = '';

      request.on('response', (response) => {
        response.on('data', (chunk) => {
          responseData += chunk;
        });

        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              const data = JSON.parse(responseData);
              resolve(data);
            } catch (error) {
              reject(new Error('Failed to parse response as JSON'));
            }
          } else {
            reject(new Error(`Claude API error: ${response.statusCode} - ${responseData}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      if (body) {
        request.write(body);
      }
      
      request.end();
    });
  }

  /**
   * Generic chat method for conversation-style interactions
   * Used by the App Manager Agent for complex diagnosis
   * @param {Array} messages - Array of message objects with role and content
   * @param {string} apiKey - API key (or null to use settings)
   * @param {Object} options - Options including maxTokens, temperature, model
   * @returns {Promise<Object>} Response object with content
   */
  async chat(messages, apiKey = null, options = {}) {
    const logger = getLogger();
    
    // Helper to extract valid Anthropic key from a string (handles copy-paste errors like "Anthr: sk-ant-...")
    const extractAnthropicKey = (str) => {
      if (!str) return null;
      // Look for sk-ant- pattern anywhere in the string
      const match = str.match(/sk-ant-[A-Za-z0-9_-]+/);
      return match ? match[0] : null;
    };
    
    // If apiKey was passed, clean it in case it has a prefix (e.g., "Anthr: sk-ant-...")
    if (apiKey) {
      const cleanedKey = extractAnthropicKey(apiKey);
      if (cleanedKey) {
        apiKey = cleanedKey;
      }
      // If cleanup found nothing but key exists, we'll let it proceed and validate later
    }
    
    // Get API key from settings if not provided (or if provided key couldn't be cleaned)
    if (!apiKey) {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      
      // Try to find an Anthropic key - prioritize dedicated anthropicApiKey
      const anthropicApiKey = settingsManager.get('anthropicApiKey');
      const nestedKey = settingsManager.get('llmConfig.anthropic.apiKey');
      const llmApiKey = settingsManager.get('llmApiKey');
      const provider = settingsManager.get('llmProvider');
      
      // Priority: dedicated anthropic key > nested config > llmApiKey (only if it's an Anthropic key)
      const cleanAnthropicKey = extractAnthropicKey(anthropicApiKey);
      const cleanNestedKey = extractAnthropicKey(nestedKey);
      const cleanLlmKey = extractAnthropicKey(llmApiKey);
      
      if (cleanAnthropicKey) {
        apiKey = cleanAnthropicKey;
      } else if (cleanNestedKey) {
        apiKey = cleanNestedKey;
      } else if (cleanLlmKey) {
        apiKey = cleanLlmKey;
      } else if (llmApiKey && provider === 'anthropic') {
        // User has llmApiKey set with anthropic provider, but key doesn't look like Anthropic format
        // Still try it in case they have a valid key with different format
        apiKey = llmApiKey;
      }
      
      console.log('[ClaudeAPI] Key lookup:', {
        hasAnthropicApiKey: !!anthropicApiKey,
        cleanedAnthropicKey: !!cleanAnthropicKey,
        hasNestedKey: !!nestedKey,
        hasLlmApiKey: !!llmApiKey,
        provider,
        selectedKeyPrefix: apiKey?.substring(0, 12)
      });
    }
    
    if (!apiKey) {
      throw new Error('Anthropic API key not found. Please add your Anthropic API key (starts with sk-ant-) in Settings > API Keys.');
    }
    
    // Validate key format and give helpful error
    if (!apiKey.startsWith('sk-ant-')) {
      const keyType = apiKey.startsWith('sk-proj-') ? 'OpenAI' : 
                      apiKey.startsWith('sk-') ? 'OpenAI' : 'unknown';
      throw new Error(`Invalid API key format for Claude. You provided a ${keyType} key (${apiKey.substring(0, 10)}...), but Claude requires an Anthropic API key that starts with "sk-ant-". Please add your Anthropic key in Settings.`);
    }

    const {
      maxTokens = this.maxTokens,
      temperature = 0.3,
      model = this.defaultModel,
      system = null
    } = options;

    // Estimate tokens for budget check
    const totalContentLength = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedInputTokens = Math.ceil(totalContentLength / 4);
    
    try {
      this.checkBudgetBeforeCall('chat', estimatedInputTokens, maxTokens);
    } catch (budgetError) {
      logger.warn('Chat budget warning', { error: budgetError.message });
      // Continue anyway - budget is advisory
    }

    try {
      const requestBody = {
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        messages: messages
      };
      
      // Add system prompt if provided
      if (system) {
        requestBody.system = system;
      }

      const requestData = JSON.stringify(requestBody);

      logger.debug('Claude chat request', {
        model,
        maxTokens,
        messageCount: messages.length,
        estimatedInputTokens
      });

      const data = await this.makeRequest(`${this.baseURL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, requestData);

      // Track usage
      if (data.usage) {
        this.trackUsage('chat', data.usage);
        
        // Track in LLM usage tracker
        try {
          const llmTracker = getLLMUsageTracker();
          llmTracker.trackClaudeCall({
            model: model,
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            feature: 'agent-diagnosis',
            purpose: 'App Manager Agent chat'
          });
        } catch (trackerError) {
          // Tracker might not be available
        }
      }

      if (data.content && data.content.length > 0) {
        return {
          content: data.content[0].text,
          usage: data.usage,
          model: data.model,
          stopReason: data.stop_reason
        };
      } else {
        throw new Error('No content in Claude response');
      }
    } catch (error) {
      logger.logAPIError('/v1/messages (chat)', error, {
        provider: 'anthropic',
        model
      });
      throw error;
    }
  }

  /**
   * Simple text completion - convenience wrapper around chat
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Options including systemPrompt, maxTokens, temperature, model
   * @returns {Promise<string>} The completion text
   */
  async complete(prompt, options = {}) {
    const {
      systemPrompt = null,
      maxTokens = this.maxTokens,
      temperature = 0.3,
      model = this.defaultModel
    } = options;

    const messages = [{ role: 'user', content: prompt }];
    
    const chatOptions = {
      maxTokens,
      temperature,
      model
    };
    
    if (systemPrompt) {
      chatOptions.system = systemPrompt;
    }

    const response = await this.chat(messages, null, chatOptions);
    return response?.content || null;
  }

  /**
   * Test the API connection with a simple request
   */
  async testConnection(apiKey) {
    const logger = getLogger();
    try {
      const requestData = JSON.stringify({
        model: this.defaultModel,
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: 'Hi'
        }]
      });

      await this.makeRequest(`${this.baseURL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, requestData);

      logger.info('Claude API connection test successful', {
        event: 'api:test',
        provider: 'anthropic',
        success: true
      });
      return true;
    } catch (error) {
      logger.logAPIError('/v1/messages', error, {
        provider: 'anthropic',
        operation: 'testConnection'
      });
      return false;
    }
  }

  /**
   * Analyze logs with Claude for issue detection and fix generation
   * @param {string} prompt - The analysis prompt
   * @param {Object} options - Options including maxTokens and temperature
   * @returns {Promise<Object>} Analysis results
   */
  async analyze(prompt, options = {}) {
    const { getSettingsManager } = require('./settings-manager');
    const settingsManager = getSettingsManager();
    const settings = settingsManager.get('llmConfig.anthropic');
    
    if (!settings || !settings.apiKey) {
      throw new Error('Anthropic API key not configured. Please configure it in Settings > API Keys.');
    }

    const {
      maxTokens = 4000,
      temperature = 0.3,
      projectId = null
    } = options;

    // Check budget before making the call
    const estimatedInputTokens = Math.ceil(prompt.length / 4);
    this.checkBudgetBeforeCall('analyze', estimatedInputTokens, maxTokens, projectId);

    try {
      const requestData = JSON.stringify({
        model: settings.model || 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens,
        temperature: temperature,
        system: "You are a technical log analyzer. Analyze the provided logs and return a structured JSON response with the following fields: summary (string), issues (array of objects with title, severity, component, impact, description, fix, and optional codeChanges fields), patterns (array of strings), recommendations (array of strings), and fixes (object with immediate and longTerm arrays). Ensure the response is valid JSON that can be parsed.",
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const data = await this.makeRequest(`${this.baseURL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': settings.apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, requestData);

      // Track usage from response
      if (data.usage) {
        this.trackUsage('analyze', data.usage, projectId);
      }

      if (data.content && data.content.length > 0) {
        const responseText = data.content[0].text;
        
        // Try to parse as JSON
        try {
          // Extract JSON from the response (in case it's wrapped in markdown)
          const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || 
                           responseText.match(/```\s*([\s\S]*?)\s*```/);
          
          const jsonString = jsonMatch ? jsonMatch[1] : responseText;
          const analysis = JSON.parse(jsonString);
          
          // Ensure required fields exist with defaults
          return {
            summary: analysis.summary || 'No summary available',
            issues: analysis.issues || [],
            patterns: analysis.patterns || [],
            recommendations: analysis.recommendations || [],
            fixes: analysis.fixes || { immediate: [], longTerm: [] }
          };
        } catch (parseError) {
          const logger = getLogger();
          logger.warn('Claude API analyze parse failed', {
            error: parseError.message,
            operation: 'analyze'
          });
          // Return a structured response even if parsing fails
          return {
            summary: responseText,
            issues: [],
            patterns: [],
            recommendations: ['Failed to parse structured response. Raw analysis provided in summary.'],
            fixes: { immediate: [], longTerm: [] }
          };
        }
      } else {
        throw new Error('No content in Claude response');
      }
    } catch (error) {
      const logger = getLogger();
      logger.logAPIError('/v1/messages', error, {
        provider: 'anthropic',
        operation: 'analyze'
      });
      throw error;
    }
  }

  // ==================== AGENT PLANNING ====================

  /**
   * Plan an agent - analyze what the user wants and determine the best approach
   * @param {string} description - User's description of what they want
   * @param {Object} availableTemplates - Available execution types and their capabilities
   * @returns {Promise<Object>} Planning result with recommended approach
   */
  async planAgent(description, availableTemplates = {}) {
    const templateInfo = Object.entries(availableTemplates).map(([id, t]) => 
      `- ${id}: ${t.name} - ${t.description} (capabilities: ${t.capabilities?.join(', ')})`
    ).join('\n');

    const prompt = `Analyze this user request and plan the best approach for building a voice-activated agent:

USER REQUEST: "${description}"

AVAILABLE EXECUTION TYPES:
${templateInfo || `
- shell: Terminal commands, file operations, system tasks
- applescript: macOS app control, UI automation, system features
- nodejs: JavaScript code, API calls, data processing
- llm: Conversational AI, Q&A, text generation (no system access)
- browser: Web automation, scraping, form filling
`}

Analyze the request and identify ALL possible features this agent could have. For each feature, determine if it's feasible.

Respond in JSON format:
{
  "understanding": "What the user is trying to accomplish in one sentence",
  "executionType": "The best execution type for this task",
  "reasoning": "Why this execution type is best (2-3 sentences)",
  "features": [
    {
      "id": "feature_id",
      "name": "Feature Name",
      "description": "What this feature does",
      "enabled": true,
      "feasible": true,
      "feasibilityReason": "Why it can or can't be done",
      "priority": "core|recommended|optional",
      "requiresPermission": false
    }
  ],
  "approach": {
    "steps": ["Step 1", "Step 2", ...],
    "requirements": ["What's needed - apps, permissions, etc"],
    "challenges": ["Potential issues to handle"]
  },
  "suggestedName": "Short agent name (2-4 words)",
  "suggestedKeywords": ["keyword1", "keyword2", ...],
  "verification": {
    "canAutoVerify": true/false,
    "verificationMethod": "How to check if it worked",
    "expectedOutcome": "What success looks like"
  },
  "testPlan": {
    "tests": [
      {
        "id": "test_id",
        "name": "Test Name",
        "description": "What this test verifies",
        "testPrompt": "The voice command to test with",
        "expectedBehavior": "What should happen",
        "verificationMethod": "auto-app-state | auto-file-check | auto-process-check | manual",
        "verificationDetails": {
          "appName": "App name if checking app state",
          "checkType": "running | frontmost | player-state | file-exists",
          "expectedValue": "The expected result"
        },
        "priority": "critical | important | nice-to-have"
      }
    ],
    "setupSteps": ["Any setup needed before testing"],
    "cleanupSteps": ["Cleanup after testing"]
  },
  "confidence": 0.0-1.0
}

TEST PLAN GUIDELINES:
- Include 2-5 tests covering core functionality
- "critical" tests must pass for agent to be considered working
- "important" tests should pass but aren't blockers
- "nice-to-have" tests are optional
- Use "auto-*" verification methods when possible (auto-app-state for apps, auto-file-check for files)
- Use "manual" only when automatic verification isn't possible

FEATURE GUIDELINES:
- "core" features are essential to the agent's purpose (always enabled by default)
- "recommended" features enhance the agent (enabled by default)
- "optional" features are nice-to-have (disabled by default)
- Set feasible=false for features that cannot be implemented (e.g., require APIs we don't have, need hardware we can't access)
- Include 4-8 features total, covering the main functionality and potential enhancements`;

    try {
      const response = await this.complete(prompt, {
        maxTokens: 8000,  // Large buffer for complex plans with many features and test cases
        temperature: 0.2
      });
      
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const plan = JSON.parse(jsonMatch[0]);
          return {
            success: true,
            plan,
            raw: response
          };
        } catch (parseError) {
          console.error('[ClaudeAPI] Plan JSON parse error:', parseError.message);
          console.error('[ClaudeAPI] Attempted to parse:', jsonMatch[0].substring(0, 500) + '...');
          
          // Try to salvage a partial plan
          return {
            success: false,
            error: `JSON parse error: ${parseError.message}. The response may have been truncated.`,
            raw: response,
            partialJson: jsonMatch[0].substring(0, 1000)
          };
        }
      }
      
      return {
        success: false,
        error: 'Could not parse planning response',
        raw: response
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ==================== AGENT DIAGNOSTIC METHODS ====================

  /**
   * Diagnose why an agent action failed
   * @param {Object} agent - The agent configuration
   * @param {string} testPrompt - What was being tested
   * @param {Object} result - The verification result
   * @returns {Promise<Object>} Diagnosis with rootCause, category, and suggestedFix
   */
  async diagnoseAgentFailure(agent, testPrompt, result) {
    const prompt = `Analyze this agent test failure and identify the root cause:

AGENT:
- Name: ${agent.name}
- Type: ${agent.executionType}
- Prompt: ${agent.prompt?.substring(0, 500)}

TEST INPUT: ${testPrompt}

FAILURE RESULT:
- Verification Method: ${result.method}
- Details: ${result.details}
${result.script ? `- Script Used: ${result.script}` : ''}
${result.error ? '- Execution Error: true' : ''}

Analyze the failure and respond in this JSON format:
{
  "summary": "One-line description of what went wrong",
  "rootCause": "Technical explanation of why it failed",
  "category": "one of: command-syntax | missing-prerequisite | wrong-approach | permission-denied | app-state-issue | timing-issue | other",
  "confidence": 0.0-1.0,
  "suggestedFix": "Specific change to make"
}`;

    try {
      const response = await this.complete(prompt, {
        maxTokens: 500,
        temperature: 0.1
      });
      
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {
        summary: 'Diagnosis parsing failed',
        rootCause: response,
        category: 'other',
        confidence: 0.3,
        suggestedFix: 'Manual review required'
      };
    } catch (error) {
      return {
        summary: 'Diagnosis error',
        rootCause: error.message,
        category: 'other',
        confidence: 0,
        suggestedFix: 'Unable to diagnose - check logs manually'
      };
    }
  }

  /**
   * Generate a fix for a failed agent based on diagnosis
   * @param {Object} agent - The agent configuration
   * @param {string} testPrompt - What was being tested
   * @param {Object} diagnosis - The failure diagnosis
   * @returns {Promise<Object>} Fix with canFix, description, and changes
   */
  async generateAgentFix(agent, testPrompt, diagnosis) {
    const prompt = `Generate a fix for this agent failure:

AGENT:
${JSON.stringify(agent, null, 2)}

DIAGNOSIS:
${JSON.stringify(diagnosis, null, 2)}

TEST PROMPT: ${testPrompt}

Based on the diagnosis, generate a specific fix. Respond in JSON format:
{
  "canFix": true or false,
  "reason": "Why the fix will work (or why it can't be fixed)",
  "description": "Human-readable description of the fix",
  "fixType": "script-change | prompt-change | approach-change | add-prerequisite",
  "changes": {
    "newScript": "The corrected script/command if applicable (or null)",
    "newPrompt": "Updated agent prompt if needed (or null)",
    "preCommands": ["Commands to run before the main action"],
    "postCommands": ["Commands to run after for verification"],
    "executionType": "Changed execution type if needed (or null)"
  }
}`;

    try {
      const response = await this.complete(prompt, {
        maxTokens: 800,
        temperature: 0.1
      });
      
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {
        canFix: false,
        reason: 'Could not generate structured fix',
        description: response
      };
    } catch (error) {
      return {
        canFix: false,
        reason: error.message,
        description: 'Fix generation failed'
      };
    }
  }

  /**
   * Generate an optimized script for an agent action
   * @param {Object} agent - The agent configuration
   * @param {string} testPrompt - What to do
   * @param {string} scriptType - 'applescript' or 'shell'
   * @param {Array} previousAttempts - History of failed attempts
   * @returns {Promise<string>} The generated script
   */
  async generateOptimizedScript(agent, testPrompt, scriptType, previousAttempts = []) {
    const failureContext = previousAttempts.length > 0
      ? `\n\nPREVIOUS FAILURES (avoid these mistakes):\n${previousAttempts.map((a, i) => 
          `${i + 1}. ${a.script || 'N/A'} -> Failed: ${a.details}`
        ).join('\n')}`
      : '';

    const typeInstructions = scriptType === 'applescript'
      ? `Generate AppleScript code. Use proper "tell application" syntax. For Music app, remember to select a track before playing.`
      : `Generate a shell command. Use safe commands, no sudo or rm -rf.`;

    const prompt = `${typeInstructions}

AGENT: ${agent.name}
TASK: ${testPrompt}
${failureContext}

Generate ONLY the ${scriptType} code, no explanations or markdown:`;

    try {
      const response = await this.complete(prompt, {
        maxTokens: 300,
        temperature: 0.1
      });
      
      // Clean up response
      let script = response.trim();
      script = script.replace(/^```(applescript|bash|sh|shell)?\n?/i, '');
      script = script.replace(/\n?```$/i, '');
      
      return script;
    } catch (error) {
      throw new Error(`Script generation failed: ${error.message}`);
    }
  }
}

// Export both the class and a singleton instance for backward compatibility
const claudeAPI = new ClaudeAPI();
module.exports = ClaudeAPI;
module.exports.default = claudeAPI; 