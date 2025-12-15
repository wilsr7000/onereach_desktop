/**
 * OpenAI API Client for GPT-5.2
 * Used for large context window tasks (text, code, data analysis)
 * 
 * GPT-5.2 Features:
 * - 256K context window
 * - Improved reasoning and analysis
 * - Better structured output (JSON mode)
 */

const https = require('https');

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
   * @returns {Promise<Object>} Generated metadata
   */
  async generateMetadata(content, contentType, apiKey, options = {}) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const prompt = this.buildPrompt(content, contentType, options);
    
    console.log(`[OpenAI API] Using GPT-5.2 for ${contentType} analysis`);
    console.log(`[OpenAI API] Content length: ${content.length} chars`);

    return this.callAPI(prompt, apiKey);
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
   */
  async callAPI(prompt, apiKey) {
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

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode !== 200) {
              const errorMsg = response.error?.message || `API error: ${res.statusCode}`;
              console.error('[OpenAI API] Error:', errorMsg);
              reject(new Error(errorMsg));
              return;
            }

            const content = response.choices[0]?.message?.content;
            if (!content) {
              reject(new Error('No content in API response'));
              return;
            }

            // Parse the JSON response
            const metadata = JSON.parse(content);
            
            // Add model info
            metadata._model = this.defaultModel;
            metadata._provider = 'openai';
            
            console.log('[OpenAI API] Successfully generated metadata');
            resolve(metadata);
            
          } catch (error) {
            console.error('[OpenAI API] Parse error:', error.message);
            reject(new Error('Failed to parse API response: ' + error.message));
          }
        });
      });

      req.on('error', (error) => {
        console.error('[OpenAI API] Request error:', error.message);
        reject(error);
      });

      req.write(postData);
      req.end();
    });
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

