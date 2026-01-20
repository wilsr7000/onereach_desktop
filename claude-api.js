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
    
    // Get API key from settings if not provided
    if (!apiKey) {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      apiKey = settingsManager.get('llmApiKey') || 
               settingsManager.get('anthropicApiKey') ||
               settingsManager.get('llmConfig.anthropic.apiKey');
    }
    
    if (!apiKey) {
      throw new Error('API key is required for chat');
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
}

// Export both the class and a singleton instance for backward compatibility
const claudeAPI = new ClaudeAPI();
module.exports = ClaudeAPI;
module.exports.default = claudeAPI; 