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
const { getUnifiedClaudeService } = require('./unified-claude');
const fs = require('fs');
const path = require('path');

class MetadataGenerator {
  constructor(clipboardManager) {
    this.clipboardManager = clipboardManager;
    this.claudeAPI = new ClaudeAPI();
    this.openaiAPI = getOpenAIAPI();
    
    // Model configuration
    // Note: Vision/voice tasks can use specialized models, but GSX Create only uses Claude 4.5 Opus/Sonnet
    this.models = {
      vision: 'claude-sonnet-4-5-20250929',  // Claude Sonnet 4.5 for vision tasks
      text: 'gpt-5.2'                         // GPT-5.2 for large context text (allowed for non-GSX tasks)
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
   * Priority: 1) Headless Claude (free), 2) OpenAI API, 3) Claude API
   */
  async generateAudioMetadata(item, apiKey, spaceContext) {
    // Build the prompt for audio analysis
    const prompt = this.buildAudioPrompt(item, spaceContext);
    
    // Priority 1: Try headless Claude first (FREE)
    try {
      console.log('[MetadataGen] Trying headless Claude for audio (free)...');
      const unifiedClaude = getUnifiedClaudeService();
      const result = await unifiedClaude.complete(prompt, {
        operation: 'metadata-generation',
        saveToSpaces: false,
        forceHeadless: true
      });
      
      if (result.success && result.response) {
        console.log('[MetadataGen] ✅ Headless Claude succeeded for audio (FREE)');
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          metadata._model_used = 'claude-headless';
          metadata._method = 'headless';
          metadata._cost = 0;
          return metadata;
        }
      }
    } catch (headlessError) {
      console.log('[MetadataGen] Headless Claude failed for audio:', headlessError.message);
    }
    
    // Priority 2: Try OpenAI API (if key available)
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    if (openaiKey) {
      console.log('[MetadataGen] Trying GPT-5.2 for audio (OpenAI API)...');
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
        metadata._method = 'openai-api';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for audio:', error.message);
      }
    }
    
    // Priority 3: Fallback to Claude API
    console.log('[MetadataGen] Falling back to Claude API for audio...');
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaudeDirectAPI(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata._method = 'claude-api';
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
   * Priority: 1) Headless Claude (free), 2) OpenAI API, 3) Claude API
   */
  async generateTextMetadata(item, apiKey, spaceContext) {
    const content = item.content || item.text || item.preview || '';
    const isCode = item.fileCategory === 'code' || item.source === 'code';
    
    // Build the prompt for text/code analysis
    const prompt = this.buildTextPrompt(item, spaceContext);
    
    // Priority 1: Try headless Claude first (FREE)
    try {
      console.log('[MetadataGen] Trying headless Claude first (free)...');
      const unifiedClaude = getUnifiedClaudeService();
      const result = await unifiedClaude.complete(prompt, {
        operation: 'metadata-generation',
        saveToSpaces: false,
        forceHeadless: true // Only try headless, don't fall back to API yet
      });
      
      if (result.success && result.response) {
        console.log('[MetadataGen] ✅ Headless Claude succeeded (FREE)');
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          metadata._model_used = 'claude-headless';
          metadata._method = 'headless';
          metadata._cost = 0;
          return metadata;
        }
      }
    } catch (headlessError) {
      console.log('[MetadataGen] Headless Claude failed:', headlessError.message);
    }
    
    // Priority 2: Try OpenAI API (if key available)
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    if (openaiKey) {
      console.log('[MetadataGen] Trying GPT-5.2 (OpenAI API)...');
      try {
        const metadata = await this.openaiAPI.generateMetadata(content, isCode ? 'code' : 'text', openaiKey, {
          fileName: item.fileName,
          fileExt: item.fileExt,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        metadata._method = 'openai-api';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed:', error.message);
      }
    }
    
    // Priority 3: Fallback to Claude API
    console.log('[MetadataGen] Falling back to Claude API...');
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaudeDirectAPI(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata._method = 'claude-api';
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
   * Priority: 1) Headless Claude (free), 2) OpenAI API, 3) Claude API
   */
  async generateHtmlMetadata(item, apiKey, spaceContext) {
    const plainText = item.plainText || this.stripHtml(item.content || item.html || '');
    const prompt = this.buildHtmlPrompt(item, spaceContext);
    
    // Priority 1: Try headless Claude first (FREE)
    try {
      console.log('[MetadataGen] Trying headless Claude for HTML (free)...');
      const unifiedClaude = getUnifiedClaudeService();
      const result = await unifiedClaude.complete(prompt, {
        operation: 'metadata-generation',
        saveToSpaces: false,
        forceHeadless: true
      });
      
      if (result.success && result.response) {
        console.log('[MetadataGen] ✅ Headless Claude succeeded for HTML (FREE)');
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          metadata._model_used = 'claude-headless';
          metadata._method = 'headless';
          metadata._cost = 0;
          return metadata;
        }
      }
    } catch (headlessError) {
      console.log('[MetadataGen] Headless Claude failed for HTML:', headlessError.message);
    }
    
    // Priority 2: Try OpenAI API (if key available)
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    if (openaiKey) {
      console.log('[MetadataGen] Trying GPT-5.2 for HTML (OpenAI API)...');
      try {
        const metadata = await this.openaiAPI.generateMetadata(plainText, 'html', openaiKey, {
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        metadata._method = 'openai-api';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for HTML:', error.message);
      }
    }
    
    // Priority 3: Fallback to Claude API
    console.log('[MetadataGen] Falling back to Claude API for HTML...');
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaudeDirectAPI(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata._method = 'claude-api';
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
   * Priority: 1) Headless Claude (free), 2) OpenAI API, 3) Claude API
   */
  async generateDataMetadata(item, apiKey, spaceContext) {
    const content = item.content || item.text || item.preview || '';
    const prompt = this.buildDataPrompt(item, spaceContext);
    
    // Priority 1: Try headless Claude first (FREE)
    try {
      console.log('[MetadataGen] Trying headless Claude for data (free)...');
      const unifiedClaude = getUnifiedClaudeService();
      const result = await unifiedClaude.complete(prompt, {
        operation: 'metadata-generation',
        saveToSpaces: false,
        forceHeadless: true
      });
      
      if (result.success && result.response) {
        console.log('[MetadataGen] ✅ Headless Claude succeeded for data (FREE)');
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          metadata._model_used = 'claude-headless';
          metadata._method = 'headless';
          metadata._cost = 0;
          return metadata;
        }
      }
    } catch (headlessError) {
      console.log('[MetadataGen] Headless Claude failed for data:', headlessError.message);
    }
    
    // Priority 2: Try OpenAI API (if key available)
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    if (openaiKey) {
      console.log('[MetadataGen] Trying GPT-5.2 for data (OpenAI API)...');
      try {
        const metadata = await this.openaiAPI.generateMetadata(content, 'data', openaiKey, {
          fileName: item.fileName,
          fileExt: item.fileExt,
          fileSize: item.fileSize,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        metadata._method = 'openai-api';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for data:', error.message);
      }
    }
    
    // Priority 3: Fallback to Claude API
    console.log('[MetadataGen] Falling back to Claude API for data...');
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaudeDirectAPI(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata._method = 'claude-api';
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
   * STYLE GUIDE METADATA - Specialized for design system/style guide JSON files
   */
  async generateStyleGuideMetadata(item, apiKey, spaceContext) {
    const content = item.content || item.text || item.preview || '';
    
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Parse JSON to extract key information
    let styleGuideInfo = '';
    try {
      const data = typeof content === 'string' ? JSON.parse(content) : content;
      styleGuideInfo = `
Style Guide Name: ${data.name || data.id || 'Unknown'}
Version: ${data.version || 'N/A'}
Colors: ${data.colors ? Object.keys(data.colors).join(', ') : 'N/A'}
Typography: ${data.typography?.fontFamilies?.length || 0} font families, ${data.typography?.scale?.length || 0} scale levels
Has Spacing: ${data.spacing ? 'Yes' : 'No'}
Has Shadows: ${data.shadows ? 'Yes' : 'No'}
Has Animations: ${data.animations ? 'Yes' : 'No'}
Components: ${data.components?.length || 0} defined`;
    } catch (e) {
      styleGuideInfo = content.substring(0, 2000);
    }
    
    const prompt = this.buildStyleGuidePrompt(item, styleGuideInfo, spaceContext);
    
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for Style Guide analysis');
      try {
        const metadata = await this.openaiAPI.generateMetadata(prompt, 'style-guide', openaiKey);
        metadata._model_used = 'gpt-5.2-128k';
        metadata.assetType = 'style-guide';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for style guide, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const metadata = await this.claudeAPI.generateMetadata(prompt, 'style-guide', apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata.assetType = 'style-guide';
    return metadata;
  }

  buildStyleGuidePrompt(item, styleGuideInfo, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    return `You are analyzing a STYLE GUIDE / DESIGN SYSTEM JSON file.${contextInfo}

FILE INFORMATION:
Filename: ${item.fileName || 'Unknown'}
File Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}

EXTRACTED STYLE GUIDE INFO:
${styleGuideInfo}

Analyze this style guide and provide metadata:

1. IDENTIFICATION:
   - What project/product is this style guide for?
   - What design philosophy does it represent?
   - Is it light/dark themed?

2. DESIGN CHARACTERISTICS:
   - Color palette mood (warm, cool, neutral, vibrant, muted)
   - Typography style (modern, classic, playful, professional)
   - Overall aesthetic

3. USAGE:
   - What type of application would use this?
   - Target audience based on design choices
   - Recommended use cases

Respond with JSON only:
{
  "title": "Style guide name/purpose",
  "description": "What this style guide defines and its aesthetic (2-3 sentences)",
  "designSystem": "Name of the design system if identifiable",
  "theme": "light|dark|mixed",
  "colorMood": "warm|cool|neutral|vibrant|muted|mixed",
  "typographyStyle": "modern|classic|playful|professional|technical",
  "aesthetic": "Overall design aesthetic description",
  "targetApplication": "Web app|Mobile app|Dashboard|Marketing|Documentation|General",
  "tags": ["relevant", "design", "tags"],
  "notes": "Additional observations about the style guide"
}`;
  }

  /**
   * JOURNEY MAP METADATA - Specialized for customer journey map JSON files
   */
  async generateJourneyMapMetadata(item, apiKey, spaceContext) {
    const content = item.content || item.text || item.preview || '';
    
    // Get API keys from settings
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    // Parse JSON to extract key information
    let journeyInfo = '';
    try {
      const data = typeof content === 'string' ? JSON.parse(content) : content;
      const journeyData = data.journeyData || data;
      journeyInfo = `
Journey Title: ${journeyData.title || data.name || 'Unknown'}
Project: ${data.metadata?.projectName || 'N/A'}
Version: ${data.metadata?.version || journeyData.version || 'N/A'}
Persona: ${journeyData.persona?.name || 'N/A'}
Persona Role: ${journeyData.persona?.role || 'N/A'}
Number of Journeys: ${journeyData.persona?.journeys?.length || 0}
Number of Stages: ${journeyData.persona?.journeys?.[0]?.stages?.length || 0}
Has Triggers: ${journeyData.persona?.journeys?.[0]?.triggers ? 'Yes' : 'No'}`;
    } catch (e) {
      journeyInfo = content.substring(0, 2000);
    }
    
    const prompt = this.buildJourneyMapPrompt(item, journeyInfo, spaceContext);
    
    if (openaiKey) {
      console.log('[MetadataGen] Using GPT-5.2 for Journey Map analysis');
      try {
        const metadata = await this.openaiAPI.generateMetadata(prompt, 'journey-map', openaiKey);
        metadata._model_used = 'gpt-5.2-128k';
        metadata.assetType = 'journey-map';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for journey map, falling back to Claude:', error.message);
      }
    }
    
    // Fallback to Claude
    const metadata = await this.claudeAPI.generateMetadata(prompt, 'journey-map', apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata.assetType = 'journey-map';
    return metadata;
  }

  buildJourneyMapPrompt(item, journeyInfo, spaceContext) {
    let contextInfo = '';
    if (spaceContext) {
      contextInfo = `\nSPACE: "${spaceContext.name}"`;
      if (spaceContext.purpose) contextInfo += ` - ${spaceContext.purpose}`;
    }

    return `You are analyzing a CUSTOMER JOURNEY MAP JSON file.${contextInfo}

FILE INFORMATION:
Filename: ${item.fileName || 'Unknown'}
File Size: ${item.fileSize ? this.formatBytes(item.fileSize) : 'Unknown'}

EXTRACTED JOURNEY MAP INFO:
${journeyInfo}

Analyze this journey map and provide metadata:

1. IDENTIFICATION:
   - What journey/process is being mapped?
   - Who is the target persona?
   - What is the business context?

2. JOURNEY CHARACTERISTICS:
   - Type of journey (customer acquisition, onboarding, support, etc.)
   - Complexity level (simple, moderate, complex)
   - Key stages identified

3. USAGE:
   - What decisions could this inform?
   - Target audience for this map
   - Potential action items

Respond with JSON only:
{
  "title": "Journey map title/purpose",
  "description": "What journey this maps and key insights (2-3 sentences)",
  "journeyType": "acquisition|onboarding|support|purchase|engagement|other",
  "persona": "Primary persona name if identifiable",
  "personaType": "customer|employee|partner|user",
  "complexity": "simple|moderate|complex",
  "keyStages": ["main", "journey", "stages"],
  "businessContext": "What business problem this addresses",
  "tags": ["relevant", "journey", "tags"],
  "notes": "Key insights or recommendations from the journey map"
}`;
  }

  /**
   * URL/WEB LINK METADATA - Specialized for web URLs
   * Priority: 1) Headless Claude (free), 2) OpenAI API, 3) Claude API
   */
  async generateUrlMetadata(item, apiKey, spaceContext) {
    const url = item.content || item.text || item.url || '';
    const prompt = this.buildUrlPrompt(item, spaceContext);
    
    // Priority 1: Try headless Claude first (FREE)
    try {
      console.log('[MetadataGen] Trying headless Claude for URL (free)...');
      const unifiedClaude = getUnifiedClaudeService();
      const result = await unifiedClaude.complete(prompt, {
        operation: 'metadata-generation',
        saveToSpaces: false,
        forceHeadless: true
      });
      
      if (result.success && result.response) {
        console.log('[MetadataGen] ✅ Headless Claude succeeded for URL (FREE)');
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          metadata._model_used = 'claude-headless';
          metadata._method = 'headless';
          metadata._cost = 0;
          return metadata;
        }
      }
    } catch (headlessError) {
      console.log('[MetadataGen] Headless Claude failed for URL:', headlessError.message);
    }
    
    // Priority 2: Try OpenAI API (if key available)
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    if (openaiKey) {
      console.log('[MetadataGen] Trying GPT-5.2 for URL (OpenAI API)...');
      try {
        const metadata = await this.openaiAPI.generateMetadata(url, 'url', openaiKey, {
          pageTitle: item.pageTitle,
          pageDescription: item.pageDescription,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        metadata._method = 'openai-api';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for URL:', error.message);
      }
    }
    
    // Priority 3: Fallback to Claude API
    console.log('[MetadataGen] Falling back to Claude API for URL...');
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaudeDirectAPI(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata._method = 'claude-api';
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
   * Priority: 1) Headless Claude (free), 2) OpenAI API, 3) Claude API
   */
  async generateFileMetadata(item, apiKey, spaceContext) {
    const prompt = this.buildFilePrompt(item, spaceContext);
    
    // Priority 1: Try headless Claude first (FREE)
    try {
      console.log('[MetadataGen] Trying headless Claude for file (free)...');
      const unifiedClaude = getUnifiedClaudeService();
      const result = await unifiedClaude.complete(prompt, {
        operation: 'metadata-generation',
        saveToSpaces: false,
        forceHeadless: true
      });
      
      if (result.success && result.response) {
        console.log('[MetadataGen] ✅ Headless Claude succeeded for file (FREE)');
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          metadata._model_used = 'claude-headless';
          metadata._method = 'headless';
          metadata._cost = 0;
          return metadata;
        }
      }
    } catch (headlessError) {
      console.log('[MetadataGen] Headless Claude failed for file:', headlessError.message);
    }
    
    // Priority 2: Try OpenAI API (if key available)
    const settingsManager = global.settingsManager;
    const openaiKey = settingsManager?.get('openaiApiKey') || process.env.OPENAI_API_KEY;
    
    if (openaiKey) {
      console.log('[MetadataGen] Trying GPT-5.2 for file (OpenAI API)...');
      try {
        const content = `File: ${item.fileName || 'Unknown'}`;
        const metadata = await this.openaiAPI.generateMetadata(content, 'file', openaiKey, {
          fileName: item.fileName,
          fileExt: item.fileExt,
          fileSize: item.fileSize,
          spaceContext
        });
        metadata._model_used = 'gpt-5.2';
        metadata._method = 'openai-api';
        return metadata;
      } catch (error) {
        console.warn('[MetadataGen] GPT-5.2 failed for file:', error.message);
      }
    }
    
    // Priority 3: Fallback to Claude API
    console.log('[MetadataGen] Falling back to Claude API for file...');
    const messageContent = [{ type: 'text', text: prompt }];
    const metadata = await this.callClaudeDirectAPI(messageContent, apiKey);
    metadata._model_used = 'claude-sonnet-4-5-20250929';
    metadata._method = 'claude-api';
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
      else if (item.jsonSubtype === 'style-guide') {
        // STYLE GUIDE - Specialized JSON file for design systems
        metadata = await this.generateStyleGuideMetadata(item, apiKey, spaceContext);
      }
      else if (item.jsonSubtype === 'journey-map') {
        // JOURNEY MAP - Specialized JSON file for customer journey mapping
        metadata = await this.generateJourneyMapMetadata(item, apiKey, spaceContext);
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
        // Detect actual image type from magic bytes, not filename
        const mimeType = this.detectImageMimeType(buffer);
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
      } catch (e) {
        console.error('[MetadataGen] Error reading image file:', e);
        return null;
      }
    }
    
    // Try loading from stored file path in items directory
    if (item.fileName && item.id) {
      const storedPath = require('path').join(
        this.clipboardManager.storage.storageRoot,
        'items',
        item.id,
        item.fileName
      );
      
      if (require('fs').existsSync(storedPath)) {
        try {
          const buffer = require('fs').readFileSync(storedPath);
          // Detect actual image type from magic bytes, not filename
          const mimeType = this.detectImageMimeType(buffer);
          return `data:${mimeType};base64,${buffer.toString('base64')}`;
        } catch (e) {
          console.error('[MetadataGen] Error reading stored image file:', e);
        }
      }
    }
    
    
    return null;
  }

  /**
   * Helper: Detect image MIME type from buffer using magic bytes
   */
  detectImageMimeType(buffer) {
    if (!buffer || buffer.length < 4) {
      return 'image/png'; // Default fallback
    }
    
    // Check magic bytes
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg';
    }
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png';
    }
    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif';
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer.length > 11 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp';
    }
    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return 'image/bmp';
    }
    // ICO: 00 00 01 00
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
      return 'image/x-icon';
    }
    // TIFF: 49 49 2A 00 (little endian) or 4D 4D 00 2A (big endian)
    if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
        (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)) {
      return 'image/tiff';
    }
    // AVIF: starts with ftyp box containing 'avif'
    if (buffer.length > 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
      const brand = buffer.slice(8, 12).toString('ascii');
      if (brand === 'avif' || brand === 'avis') {
        return 'image/avif';
      }
      if (brand === 'heic' || brand === 'heix' || brand === 'mif1') {
        return 'image/heic';
      }
    }
    
    // Default to PNG
    return 'image/png';
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
   * Uses Unified Claude Service for text-only prompts (headless first, then API)
   * Falls back to direct API for vision requests (which have image content)
   */
  async callClaude(messageContent, apiKey) {
    // Check if this is a text-only prompt (string) vs vision prompt (array with image)
    const isVisionRequest = Array.isArray(messageContent);
    
    // For text-only prompts, try the unified service (headless first, API fallback)
    if (!isVisionRequest) {
      try {
        console.log('[MetadataGen] Using Unified Claude Service for text prompt');
        const unifiedClaude = getUnifiedClaudeService();
        const result = await unifiedClaude.complete(messageContent, {
          operation: 'metadata-generation',
          saveToSpaces: false // Don't save metadata generation prompts to Spaces
        });
        
        if (result.success && result.response) {
          console.log('[MetadataGen] Unified Claude succeeded via', result.method);
          const jsonMatch = result.response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const metadata = JSON.parse(jsonMatch[0]);
            metadata._method = result.method;
            metadata._cost = result.cost || 0;
            return metadata;
          }
        }
      } catch (unifiedError) {
        console.log('[MetadataGen] Unified Claude failed, using direct API:', unifiedError.message);
      }
    }
    
    // For vision requests or if unified service fails, use direct API
    return this.callClaudeDirectAPI(messageContent, apiKey);
  }
  
  /**
   * Helper: Direct Claude API call (for vision requests or fallback)
   */
  async callClaudeDirectAPI(messageContent, apiKey) {
    const https = require('https');
    
    const postData = JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
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
              metadata._method = 'direct-api';
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
