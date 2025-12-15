/**
 * Specialized Metadata Generation for Different Asset Types
 * Each asset type has its own prompt and processing logic
 * Incorporates Space metadata for better contextualization
 * 
 * MODEL ROUTING:
 * - Claude Sonnet 4: Vision tasks (images, video thumbnails, PDF thumbnails)
 * - GPT-5.2: Large context text tasks (code, text, data, HTML, URLs, audio transcripts)
 */

const ClaudeAPI = require('./claude-api');
const { getOpenAIAPI } = require('./openai-api');
const fs = require('fs');
const path = require('path');

class MetadataGenerator {
  constructor(clipboardManager) {
    this.clipboardManager = clipboardManager;
    this.claudeAPI = new ClaudeAPI();
    this.openaiAPI = getOpenAIAPI();
    
    // Model configuration
    this.models = {
      vision: 'claude-sonnet-4-20250514',  // Claude for vision tasks
      text: 'gpt-5.2'                       // GPT-5.2 for large context text
    };
  }
  
  /**
   * Determine which model to use based on content type
   * @param {string} contentType - Type of content
   * @param {boolean} hasVisualContent - Whether visual analysis is needed
   * @returns {Object} Model info { provider, model, reason }
   */
  selectModel(contentType, hasVisualContent = false) {
    // Vision tasks always use Claude
    if (hasVisualContent) {
      return {
        provider: 'claude',
        model: this.models.vision,
        reason: 'Visual content requires vision model'
      };
    }
    
    // Text-based tasks use GPT-5.2 for better context handling
    const textTypes = ['code', 'text', 'data', 'html', 'url', 'audio', 'file'];
    if (textTypes.includes(contentType)) {
      return {
        provider: 'openai',
        model: this.models.text,
        reason: `GPT-5.2 for ${contentType} analysis (256K context)`
      };
    }
    
    // Default to Claude for anything else
    return {
      provider: 'claude',
      model: this.models.vision,
      reason: 'Default handler'
    };
  }

  /**
   * Get Space context for better metadata generation
   */
  getSpaceContext(spaceId) {
    if (!spaceId || spaceId === 'unclassified') {
      return null;
    }

    try {
      const space = this.clipboardManager.spaces.find(s => s.id === spaceId);
      if (!space) return null;

      // Get Space metadata if available
      const spaceMetadata = this.clipboardManager.storage.getSpaceMetadata(spaceId);
      
      return {
        name: space.name,
        description: space.description || '',
        icon: space.icon,
        purpose: spaceMetadata?.purpose || '',
        tags: spaceMetadata?.tags || [],
        category: spaceMetadata?.category || '',
        projectType: spaceMetadata?.projectType || ''
      };
    } catch (error) {
      console.error('[MetadataGen] Error getting space context:', error);
      return null;
    }
  }

  /**
   * IMAGE METADATA - Specialized for screenshots, photos, diagrams
   */
  async generateImageMetadata(item, imageData, apiKey, spaceContext) {
    const prompt = this.buildImagePrompt(item, spaceContext);
    
    const messageContent = [
      {
        type: 'text',
        text: prompt
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: this.extractMediaType(imageData),
          data: this.extractBase64(imageData)
        }
      }
    ];

    return await this.callClaude(messageContent, apiKey);
  }

  buildImagePrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\n\nSPACE CONTEXT: This image is being saved to the "${spaceContext.name}" Space`;
      if (spaceContext.purpose) contextInfo += ` (Purpose: ${spaceContext.purpose})`;
      if (spaceContext.category) contextInfo += ` [Category: ${spaceContext.category}]`;
      if (spaceContext.tags && spaceContext.tags.length > 0) {
        contextInfo += `\nSpace tags: ${spaceContext.tags.join(', ')}`;
      }
    }

    return `You are analyzing an image for a knowledge management system. Analyze this ${item.isScreenshot ? 'SCREENSHOT' : 'image'} carefully.${contextInfo}

ANALYSIS REQUIREMENTS:

1. DESCRIBE WHAT YOU SEE:
   - For screenshots: What application/website is shown? What's the user doing?
   - For photos: What's in the image? Setting? Subject?
   - For diagrams: What does it illustrate? What's the main concept?
   - For UI mockups: What interface/feature is shown?
   - For charts/graphs: What data is visualized?

2. EXTRACT READABLE TEXT:
   - Any visible text, labels, titles, buttons, menu items
   - Error messages, code snippets, terminal output
   - Document titles, headings, captions

3. IDENTIFY CONTEXT:
   - Application name (Chrome, VS Code, Figma, etc.)
   - Website domain (if visible in URL bar)
   - Tool or platform being used
   - Operating system indicators

4. DETERMINE PURPOSE:
   - Why might someone capture this?
   - What task or workflow is this related to?
   - What information does it preserve?

${spaceContext ? `5. RELATE TO SPACE: How does this image relate to the "${spaceContext.name}" Space purpose?` : ''}

Respond with JSON only:
{
  "title": "Clear, descriptive title (3-8 words)",
  "description": "Detailed description of what's in the image (2-3 sentences)",
  "notes": "Specific details: any visible text, UI elements, important features",
  "instructions": "How this image might be used or referenced",
  "tags": ["relevant", "tags", "based", "on", "content"],
  "source": "Application or platform shown (e.g., 'Chrome', 'VS Code', 'Figma')",
  "category": "screenshot|photo|diagram|design|chart|document|ui-mockup|other",
  "ai_detected": false,
  "extracted_text": "Any readable text in the image",
  "visible_urls": ["any", "urls", "shown"],
  "app_detected": "Specific app name if identifiable"
}`;
  }

  /**
   * VIDEO METADATA - Specialized for video content
   */
  async generateVideoMetadata(item, thumbnail, apiKey, spaceContext) {
    const prompt = this.buildVideoPrompt(item, spaceContext);
    
    const messageContent = thumbnail ? [
      {
        type: 'text',
        text: prompt
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: this.extractBase64(thumbnail)
        }
      }
    ] : [
      {
        type: 'text',
        text: prompt
      }
    ];

    return await this.callClaude(messageContent, apiKey);
  }

  buildVideoPrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    const videoInfo = [
      `Filename: ${item.fileName || 'Unknown'}`,
      `Duration: ${item.metadata?.duration || 'Unknown'}`,
      `Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}`,
      item.metadata?.resolution ? `Resolution: ${item.metadata.resolution}` : '',
      item.metadata?.uploader ? `Uploader: ${item.metadata.uploader}` : '',
      item.metadata?.youtubeDescription ? `YouTube Description:\n${item.metadata.youtubeDescription.substring(0, 500)}` : '',
      item.metadata?.transcript ? `Has Transcript: Yes (${item.metadata.transcript.length} chars)` : ''
    ].filter(Boolean).join('\n');

    return `You are analyzing a VIDEO file for a knowledge management system.${contextInfo}

VIDEO INFORMATION:
${videoInfo}

${thumbnail ? 'THUMBNAIL: A preview frame from the video is attached. Use it to understand the video content.' : ''}

${item.metadata?.transcript ? `
TRANSCRIPT EXCERPT (first 500 chars):
${item.metadata.transcript.substring(0, 500)}...
` : ''}

ANALYSIS REQUIREMENTS:

1. CONTENT SUMMARY:
   - What is this video about?
   - Main topic or subject matter
   - Key points or themes

2. CATEGORIZATION:
   - Video type: tutorial, interview, presentation, recording, entertainment, etc.
   - Subject area: technology, business, education, entertainment, etc.
   - Content format: talking head, screen recording, animation, live action, etc.

3. KEY INFORMATION:
   - Main speaker(s) or presenter(s)
   - Topics covered
   - Notable quotes or key moments
   - Target audience

4. USAGE CONTEXT:
   - Why would someone save this video?
   - What information does it provide?
   - When might they reference it?

${spaceContext ? `5. SPACE RELEVANCE: How does this video relate to the "${spaceContext.name}" Space?` : ''}

Respond with JSON only:
{
  "title": "Clear, descriptive video title",
  "shortDescription": "One sentence summary",
  "longDescription": "Detailed 2-3 sentence description",
  "category": "tutorial|interview|presentation|screen-recording|entertainment|educational|documentary|demo|other",
  "topics": ["main", "topics", "covered"],
  "speakers": ["speaker", "names"],
  "keyPoints": ["bullet", "point", "summaries"],
  "tags": ["relevant", "searchable", "tags"],
  "targetAudience": "Who this is for",
  "notes": "Additional notes or context"
}`;
  }

  /**
   * AUDIO METADATA - Specialized for audio files, podcasts, music
   * Uses GPT-5.2 for transcript analysis (large context)
   */
  async generateAudioMetadata(item, apiKey, spaceContext) {
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Use GPT-5.2 for audio analysis if OpenAI key available (good for long transcripts)
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for audio analysis');
      try {
        const content = [
          `Audio file: ${item.fileName || 'Unknown'}`,
          `Duration: ${item.metadata?.duration || 'Unknown'}`,
          item.metadata?.transcript ? `\nTranscript:\n${item.metadata.transcript}` : ''
        ].join('\n');
        
        const metadata = await this.openaiAPI.generateMetadata(content, 'audio', openaiKey, {
          fileName: item.fileName,
          duration: item.metadata?.duration,
          transcript: item.metadata?.transcript,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const prompt = this.buildAudioPrompt(item, spaceContext);
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaude(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-20250514';
    return metadata;
  }

  buildAudioPrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    const audioInfo = [
      `Filename: ${item.fileName || 'Unknown'}`,
      `Format: ${item.fileExt || 'Unknown'}`,
      `Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}`,
      item.metadata?.duration ? `Duration: ${item.metadata.duration}` : '',
      item.metadata?.transcript ? `Has Transcript: Yes` : 'No transcript available'
    ].filter(Boolean).join('\n');

    return `You are analyzing an AUDIO file for a knowledge management system.${contextInfo}

AUDIO FILE INFORMATION:
${audioInfo}

${item.metadata?.transcript ? `
TRANSCRIPT:
${item.metadata.transcript.substring(0, 2000)}
${item.metadata.transcript.length > 2000 ? '...[truncated]' : ''}
` : ''}

ANALYSIS REQUIREMENTS:

1. CONTENT IDENTIFICATION:
   - What is this audio about?
   - Is it: podcast, music, recording, audiobook, voice memo, sound effect, other?
   - Main topic or subject

2. STRUCTURE & FORMAT:
   - Number of speakers (if applicable)
   - Format: monologue, conversation, interview, lecture, music
   - Production quality: professional, casual, raw recording

3. KEY INFORMATION:
   - Main topics discussed
   - Speaker names (if identifiable from transcript)
   - Key points or takeaways
   - Notable quotes

4. CATEGORIZATION:
   - Genre or category
   - Subject area
   - Target audience

${spaceContext ? `5. SPACE RELEVANCE: How does this audio relate to "${spaceContext.name}"?` : ''}

Respond with JSON only:
{
  "title": "Clear title for this audio",
  "description": "2-3 sentence description of content",
  "audioType": "podcast|music|voice-memo|audiobook|interview|lecture|recording|other",
  "topics": ["main", "topics"],
  "speakers": ["speaker", "names"],
  "keyPoints": ["important", "points"],
  "tags": ["relevant", "tags"],
  "genre": "Category or genre",
  "notes": "Additional notes"
}`;
  }

  /**
   * TEXT/CODE METADATA - Specialized for text documents and code
   * Uses GPT-5.2 for large context handling
   */
  async generateTextMetadata(item, apiKey, spaceContext) {
    const content = item.content || item.text || item.preview || '';
    const isCode = item.fileCategory === 'code' || item.source === 'code';
    
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Use GPT-5.2 for text analysis if OpenAI key available
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for text/code analysis');
      try {
        const metadata = await this.openaiAPI.generateMetadata(content, isCode ? 'code' : 'text', openaiKey, {
          fileName: item.fileName,
          fileExt: item.fileExt,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const prompt = this.buildTextPrompt(item, spaceContext);
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaude(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-20250514';
    return metadata;
  }

  buildTextPrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
      if (spaceContext.projectType) contextInfo += ` [${spaceContext.projectType}]`;
    }

    const isCode = item.fileCategory === 'code' || item.source === 'code';
    const content = item.content || item.text || item.preview || '';

    if (isCode) {
      return `You are analyzing CODE for a knowledge management system.${contextInfo}

CODE INFORMATION:
Filename: ${item.fileName || 'Code snippet'}
Language: ${item.fileExt || 'Unknown'}
Lines: ${content.split('\n').length}

CODE CONTENT:
\`\`\`
${content.substring(0, 5000)}${content.length > 5000 ? '\n...[truncated]' : ''}
\`\`\`

ANALYSIS REQUIREMENTS:

1. CODE UNDERSTANDING:
   - What does this code do?
   - Programming language
   - Main functions or classes
   - Purpose of this code

2. TECHNICAL DETAILS:
   - Framework or libraries used
   - Patterns or approaches
   - Complexity level
   - Code quality observations

3. USAGE CONTEXT:
   - What problem does this solve?
   - When might you need this?
   - How could it be used or adapted?

${spaceContext ? `4. PROJECT CONTEXT: How does this code relate to "${spaceContext.name}"${spaceContext.projectType ? ` (${spaceContext.projectType} project)` : ''}?` : ''}

Respond with JSON only:
{
  "title": "Clear title describing what this code does",
  "description": "What this code does and its purpose (2-3 sentences)",
  "language": "Programming language",
  "purpose": "Main purpose or use case",
  "functions": ["main", "functions", "or", "classes"],
  "dependencies": ["libraries", "frameworks", "used"],
  "tags": ["relevant", "technical", "tags"],
  "complexity": "simple|moderate|complex",
  "notes": "Usage tips or important details"
}`;
    } else {
      // Plain text
      return `You are analyzing TEXT CONTENT for a knowledge management system.${contextInfo}

TEXT CONTENT:
${content.substring(0, 5000)}${content.length > 5000 ? '\n...[truncated]' : ''}

ANALYSIS REQUIREMENTS:

1. CONTENT TYPE:
   - Is this: notes, article, documentation, message, list, meeting notes, other?
   - Format: prose, bullet points, structured data, conversation

2. MAIN TOPIC:
   - What is this text about?
   - Key subjects or themes
   - Main message or purpose

3. KEY INFORMATION:
   - Important facts or details
   - Action items or tasks (if any)
   - Decisions or conclusions

4. STRUCTURE:
   - How is it organized?
   - Main sections or topics
   - Notable elements

${spaceContext ? `5. SPACE CONTEXT: How does this relate to "${spaceContext.name}"?` : ''}

Respond with JSON only:
{
  "title": "Descriptive title (3-8 words)",
  "description": "What this text is about (2-3 sentences)",
  "contentType": "notes|article|documentation|message|list|meeting-notes|transcript|interview|other",
  "topics": ["main", "topics"],
  "keyPoints": ["important", "points"],
  "actionItems": ["any", "todos"],
  "tags": ["relevant", "tags"],
  "notes": "Additional context"
}`;
    }
  }

  /**
   * HTML/RICH CONTENT METADATA - Specialized for web pages, documents
   * Uses GPT-5.2 for large HTML documents
   */
  async generateHtmlMetadata(item, apiKey, spaceContext) {
    const plainText = item.plainText || this.stripHtml(item.content || item.html || '');
    
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Use GPT-5.2 for HTML analysis if OpenAI key available
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for HTML analysis');
      try {
        const metadata = await this.openaiAPI.generateMetadata(plainText, 'html', openaiKey, {
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const prompt = this.buildHtmlPrompt(item, spaceContext);
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaude(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-20250514';
    return metadata;
  }

  buildHtmlPrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    const plainText = item.plainText || this.stripHtml(item.content || item.html || '');
    const isGeneratedDoc = item.metadata?.type === 'generated-document';

    return `You are analyzing HTML/RICH CONTENT for a knowledge management system.${contextInfo}

DOCUMENT TYPE: ${isGeneratedDoc ? 'AI-Generated Document' : 'Web Content/HTML Document'}

CONTENT (Plain Text):
${plainText.substring(0, 3000)}${plainText.length > 3000 ? '\n...[truncated]' : ''}

ANALYSIS REQUIREMENTS:

1. DOCUMENT UNDERSTANDING:
   - What is this document about?
   - Document type: article, report, webpage, documentation, presentation
   - Main purpose

2. CONTENT STRUCTURE:
   - Main sections or topics
   - Key headings
   - Information hierarchy

3. KEY INFORMATION:
   - Main points or arguments
   - Important data or facts
   - Conclusions or recommendations

4. METADATA:
   - Author (if mentioned)
   - Source website or publication
   - Date or time references
   - Related links or references

${spaceContext ? `5. SPACE RELEVANCE: How does this document relate to "${spaceContext.name}"?` : ''}

Respond with JSON only:
{
  "title": "Document title or main heading",
  "description": "What this document covers (2-3 sentences)",
  "documentType": "article|report|webpage|documentation|presentation|email|other",
  "topics": ["main", "topics"],
  "keyPoints": ["important", "points"],
  "author": "Author name if identifiable",
  "source": "Source website or platform",
  "tags": ["relevant", "tags"],
  "notes": "Additional context or summary"
}`;
  }

  /**
   * PDF METADATA - Specialized for PDF documents
   */
  async generatePdfMetadata(item, thumbnail, apiKey, spaceContext) {
    const prompt = this.buildPdfPrompt(item, spaceContext, !!thumbnail);
    
    const messageContent = thumbnail ? [
      {
        type: 'text',
        text: prompt
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: this.extractBase64(thumbnail)
        }
      }
    ] : [
      {
        type: 'text',
        text: prompt
      }
    ];

    return await this.callClaude(messageContent, apiKey);
  }

  buildPdfPrompt(item, spaceContext, hasThumbnail) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    return `You are analyzing a PDF DOCUMENT for a knowledge management system.${contextInfo}

PDF INFORMATION:
Filename: ${item.fileName || 'Document.pdf'}
Pages: ${item.pageCount || 'Unknown'}
Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}
${hasThumbnail ? 'First page preview is attached as an image.' : ''}

ANALYSIS REQUIREMENTS:

Based on the filename${hasThumbnail ? ' and first page preview' : ''}:

1. DOCUMENT TYPE:
   - What kind of document is this?
   - Report, manual, invoice, presentation, form, contract, resume, other?
   - Professional context

2. SUBJECT MATTER:
   - Main topic or subject
   - Industry or domain
   - Technical level

3. PURPOSE:
   - Why would someone have this PDF?
   - What information does it contain?
   - Use cases

4. CATEGORIZATION:
   - Business category
   - Document classification
   - Organizational context

${spaceContext ? `5. SPACE CONTEXT: How might this PDF relate to "${spaceContext.name}"?` : ''}

Respond with JSON only:
{
  "title": "Clear document title (from filename${hasThumbnail ? ' or first page' : ''})",
  "description": "What this document is (2-3 sentences)",
  "documentType": "report|manual|invoice|presentation|form|contract|resume|article|specification|other",
  "subject": "Main subject area",
  "category": "Business category",
  "topics": ["relevant", "topics"],
  "tags": ["searchable", "tags"],
  "purpose": "Why someone might need this",
  "notes": "Additional context"
}`;
  }

  /**
   * DATA FILE METADATA - Specialized for JSON, CSV, YAML, etc.
   * Uses GPT-5.2 for large data files
   */
  async generateDataMetadata(item, apiKey, spaceContext) {
    const content = item.content || item.text || item.preview || '';
    
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Use GPT-5.2 for data analysis if OpenAI key available
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for data file analysis');
      try {
        const metadata = await this.openaiAPI.generateMetadata(content, 'data', openaiKey, {
          fileName: item.fileName,
          fileExt: item.fileExt,
          fileSize: item.fileSize,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const prompt = this.buildDataPrompt(item, spaceContext);
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaude(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-20250514';
    return metadata;
  }

  buildDataPrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.projectType) contextInfo += ` [${spaceContext.projectType}]`;
    }

    const content = item.content || item.text || item.preview || '';
    const preview = content.substring(0, 2000);

    return `You are analyzing a DATA FILE for a knowledge management system.${contextInfo}

DATA FILE INFORMATION:
Filename: ${item.fileName || 'data-file'}
Format: ${item.fileExt || 'Unknown'}
Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}

DATA PREVIEW:
${preview}${content.length > 2000 ? '\n...[truncated]' : ''}

ANALYSIS REQUIREMENTS:

1. DATA STRUCTURE:
   - What type of data is this?
   - Structure: array, object, table, key-value, nested
   - Data format quality

2. CONTENT:
   - What information does it contain?
   - Data domain (users, products, config, metrics, etc.)
   - Sample fields or keys

3. PURPOSE:
   - Configuration file, dataset, API response, export, backup?
   - Use case for this data
   - Source system or application

4. SCHEMA INSIGHTS:
   - Main entities or objects
   - Key fields or properties
   - Relationships or patterns

${spaceContext ? `5. PROJECT CONTEXT: How does this data relate to "${spaceContext.name}"${spaceContext.projectType ? ` (${spaceContext.projectType})` : ''}?` : ''}

Respond with JSON only:
{
  "title": "Clear title describing the data",
  "description": "What this data represents (2-3 sentences)",
  "dataType": "config|dataset|api-response|export|schema|log|other",
  "format": "JSON|CSV|YAML|XML|other",
  "entities": ["main", "entities"],
  "keyFields": ["important", "fields"],
  "purpose": "What this data is used for",
  "tags": ["relevant", "tags"],
  "notes": "Structure or usage notes"
}`;
  }

  /**
   * URL/WEB LINK METADATA - Specialized for web URLs
   * Uses GPT-5.2 for URL analysis
   */
  async generateUrlMetadata(item, apiKey, spaceContext) {
    const url = item.content || item.text || item.url || '';
    
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Use GPT-5.2 for URL analysis if OpenAI key available
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for URL analysis');
      try {
        const metadata = await this.openaiAPI.generateMetadata(url, 'url', openaiKey, {
          pageTitle: item.pageTitle,
          pageDescription: item.pageDescription,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const prompt = this.buildUrlPrompt(item, spaceContext);
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaude(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-20250514';
    return metadata;
  }

  buildUrlPrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    const url = item.content || item.text || item.url || '';
    
    let urlInfo = '';
    try {
      const urlObj = new URL(url);
      urlInfo = `
Domain: ${urlObj.hostname}
Path: ${urlObj.pathname}
Parameters: ${urlObj.search || 'None'}
      `;
    } catch (e) {
      urlInfo = `URL: ${url}`;
    }

    return `You are analyzing a WEB URL/LINK for a knowledge management system.${contextInfo}

URL INFORMATION:
${urlInfo}

${item.pageTitle ? `Page Title: ${item.pageTitle}` : ''}
${item.pageDescription ? `Page Description: ${item.pageDescription}` : ''}

ANALYSIS REQUIREMENTS:

1. WEBSITE IDENTIFICATION:
   - What website or platform is this?
   - Company or service name
   - Type of site (documentation, tool, article, etc.)

2. CONTENT CLASSIFICATION:
   - What is this link to?
   - Resource type: article, documentation, tool, video, repo, etc.
   - Purpose of the link

3. CONTEXT:
   - Why might someone save this link?
   - What information or service does it provide?
   - Use case or scenario

4. CATEGORIZATION:
   - Domain: technology, business, education, entertainment, etc.
   - Resource type
   - Utility level

${spaceContext ? `5. SPACE RELEVANCE: Why might this link be in "${spaceContext.name}"?` : ''}

Respond with JSON only:
{
  "title": "Clear title for this link",
  "description": "What this link is and why it's useful (2 sentences)",
  "urlType": "article|documentation|tool|repository|video|social-media|resource|other",
  "platform": "Website or platform name",
  "topics": ["relevant", "topics"],
  "category": "Domain category",
  "tags": ["searchable", "tags"],
  "purpose": "Why someone saved this",
  "notes": "Additional context"
}`;
  }

  /**
   * FILE METADATA - Generic file handler with Space context
   * Uses GPT-5.2 for file analysis
   */
  async generateFileMetadata(item, apiKey, spaceContext) {
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Use GPT-5.2 for file analysis if OpenAI key available
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for generic file analysis');
      try {
        const content = `File: ${item.fileName || 'Unknown'}`;
        const metadata = await this.openaiAPI.generateMetadata(content, 'file', openaiKey, {
          fileName: item.fileName,
          fileExt: item.fileExt,
          fileSize: item.fileSize,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const prompt = this.buildFilePrompt(item, spaceContext);
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaude(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-20250514';
    return metadata;
  }

  buildFilePrompt(item, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    return `You are analyzing a FILE for a knowledge management system.${contextInfo}

FILE INFORMATION:
Filename: ${item.fileName || 'Unknown'}
Type: ${item.fileExt || 'Unknown'}
Category: ${item.fileCategory || 'Unknown'}
Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}

ANALYSIS REQUIREMENTS:

Based on the filename and file type:

1. FILE IDENTIFICATION:
   - What is this file likely to contain?
   - File purpose
   - Typical use case for this file type

2. CATEGORIZATION:
   - Subject area
   - File category
   - Professional context

3. USAGE:
   - When might someone need this file?
   - What workflows involve this file type?
   - Related tools or applications

${spaceContext ? `4. SPACE CONTEXT: How might this file relate to "${spaceContext.name}"?` : ''}

Respond with JSON only:
{
  "title": "Clear, descriptive title for this file",
  "description": "What this file is and its purpose (2 sentences)",
  "fileCategory": "Categorization",
  "purpose": "Likely use case",
  "relatedTools": ["applications", "that", "use", "this"],
  "tags": ["relevant", "tags"],
  "notes": "Additional context"
}`;
  }

  /**
   * Main routing function - calls specialized handler based on asset type
   */
  async generateMetadataForItem(itemId, apiKey, customPrompt = '') {
    try {
      const item = this.clipboardManager.storage.loadItem(itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }

      // Get Space context
      const spaceContext = this.getSpaceContext(item.spaceId);
      
      console.log('[MetadataGen] Generating metadata for:', {
        itemId: item.id,
        type: item.type,
        fileType: item.fileType,
        fileCategory: item.fileCategory,
        spaceId: item.spaceId,
        spaceName: spaceContext?.name
      });

      let metadata;

      // Route to specialized handler based on type
      if (item.isScreenshot || item.type === 'image' || item.fileType === 'image-file') {
        // IMAGE
        const imageData = await this.getImageData(item);
        if (!imageData) {
          return { success: false, error: 'Could not load image data' };
        }
        metadata = await this.generateImageMetadata(item, imageData, apiKey, spaceContext);
      }
      else if (item.fileType === 'video' || item.fileCategory === 'video') {
        // VIDEO
        const thumbnail = item.thumbnail;
        metadata = await this.generateVideoMetadata(item, thumbnail, apiKey, spaceContext);
      }
      else if (item.fileType === 'audio' || item.fileCategory === 'audio') {
        // AUDIO
        metadata = await this.generateAudioMetadata(item, apiKey, spaceContext);
      }
      else if (item.fileType === 'pdf' || item.fileExt === '.pdf') {
        // PDF
        const thumbnail = item.thumbnail;
        metadata = await this.generatePdfMetadata(item, thumbnail, apiKey, spaceContext);
      }
      else if (item.fileCategory === 'data' || ['.json', '.csv', '.yaml', '.yml', '.xml'].includes(item.fileExt)) {
        // DATA FILES
        metadata = await this.generateDataMetadata(item, apiKey, spaceContext);
      }
      else if (item.type === 'html' || item.html || item.metadata?.type === 'generated-document') {
        // HTML/RICH CONTENT
        metadata = await this.generateHtmlMetadata(item, apiKey, spaceContext);
      }
      else if (item.content && item.content.trim().match(/^https?:\/\/[^\s]+$/)) {
        // URL - Check this BEFORE plain text to properly route URLs
        // Must be a single URL (no spaces) to be treated as a URL
        metadata = await this.generateUrlMetadata(item, apiKey, spaceContext);
      }
      else if (item.type === 'text' || item.fileCategory === 'code') {
        // TEXT/CODE
        metadata = await this.generateTextMetadata(item, apiKey, spaceContext);
      }
      else if (item.type === 'file') {
        // GENERIC FILE
        metadata = await this.generateFileMetadata(item, apiKey, spaceContext);
      }
      else {
        // FALLBACK - use text handler
        metadata = await this.generateTextMetadata(item, apiKey, spaceContext);
      }

      // Save metadata to item
      const updatedMetadata = {
        ...item.metadata,
        ...metadata,
        ai_metadata_generated: true,
        ai_metadata_timestamp: new Date().toISOString(),
        space_context_used: !!spaceContext
      };

      // Update the item's metadata using the clipboardManager method
      await this.clipboardManager.updateItemMetadata(itemId, updatedMetadata);

      return {
        success: true,
        metadata: updatedMetadata
      };

    } catch (error) {
      console.error('[MetadataGen] Error generating metadata:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Helper: Get image data for item
   */
  async getImageData(item) {
    if (item.thumbnail && !item.thumbnail.includes('svg+xml')) {
      return item.thumbnail;
    }
    
    if (item.content && item.content.startsWith('data:image')) {
      return item.content;
    }
    
    if (item.filePath && fs.existsSync(item.filePath)) {
      try {
        const buffer = fs.readFileSync(item.filePath);
        const ext = path.extname(item.filePath).toLowerCase().replace('.', '') || 'png';
        return `data:image/${ext};base64,${buffer.toString('base64')}`;
      } catch (e) {
        console.error('[MetadataGen] Error reading image file:', e);
        return null;
      }
    }
    
    return null;
  }

  /**
   * Helper: Extract media type from data URL
   */
  extractMediaType(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      return 'image/png';
    }
    const match = dataUrl.match(/^data:([^;]+);/);
    return match ? match[1] : 'image/png';
  }

  /**
   * Helper: Extract base64 data from data URL
   */
  extractBase64(dataUrl) {
    if (!dataUrl) return '';
    if (!dataUrl.startsWith('data:')) return dataUrl;
    
    const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    return match ? match[1] : dataUrl;
  }

  /**
   * Helper: Strip HTML tags
   */
  stripHtml(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Helper: Format bytes
   */
  formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }

  /**
   * Helper: Call Claude API
   */
  async callClaude(messageContent, apiKey) {
    const https = require('https');
    
    const postData = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: messageContent
        }
      ]
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
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
              reject(new Error(response.error?.message || `API error: ${res.statusCode}`));
              return;
            }

            const text = response.content[0].text;
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            
            if (jsonMatch) {
              const metadata = JSON.parse(jsonMatch[0]);
              resolve(metadata);
            } else {
              reject(new Error('No valid JSON in response'));
            }
          } catch (error) {
            reject(new Error('Failed to parse API response: ' + error.message));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }
}

module.exports = MetadataGenerator;
