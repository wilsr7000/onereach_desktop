/**
 * AI Conversation Capture Module
 * 
 * Automatically captures and saves AI conversations from Claude, ChatGPT, 
 * Gemini, Perplexity, and Grok to Spaces.
 * 
 * Features:
 * - Auto-capture conversations with images and files
 * - Privacy controls (pause, per-conversation opt-out, private mode, undo)
 * - Copy conversations to multiple Spaces
 * - Markdown formatting with metadata
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// AI service configurations
const AI_SERVICE_CONFIG = {
  'Claude': {
    icon: '🤖',
    color: '#ff6b35',
    spaceName: 'Claude Conversations'
  },
  'ChatGPT': {
    icon: '💬',
    color: '#10a37f',
    spaceName: 'ChatGPT Conversations'
  },
  'Gemini': {
    icon: '✨',
    color: '#4285f4',
    spaceName: 'Gemini Conversations'
  },
  'Perplexity': {
    icon: '🔍',
    color: '#8b5cf6',
    spaceName: 'Perplexity Conversations'
  },
  'Grok': {
    icon: '🚀',
    color: '#6b7280',
    spaceName: 'Grok Conversations'
  }
};

class ConversationCapture {
  constructor(spacesAPI, settingsManager) {
    this.spacesAPI = spacesAPI;
    this.settingsManager = settingsManager;
    
    // Active conversations by service
    this.activeConversations = new Map(); // serviceId -> conversation object
    
    // Privacy state
    this.paused = false;
    this.privateModeSessions = new Set(); // Track private mode windows
    
    // Undo tracking
    this.pendingUndos = new Map(); // itemId -> { timeout, serviceId }
    
    // Service spaces cache
    this.serviceSpaces = new Map(); // serviceId -> spaceId
    
    // Load state
    this._loadState();
  }

  /**
   * Check if capture is enabled
   */
  isEnabled() {
    const settings = this.settingsManager?.get('aiConversationCapture') || {};
    return settings.enabled !== false; // Default to true
  }

  /**
   * Check if capture is paused
   */
  isPaused() {
    return this.paused;
  }

  /**
   * Set pause state
   */
  setPaused(paused) {
    this.paused = paused;
    console.log(`[ConversationCapture] Capture ${paused ? 'paused' : 'resumed'}`);
  }

  /**
   * Mark a window as private mode
   */
  setPrivateMode(windowId, isPrivate) {
    if (isPrivate) {
      this.privateModeSessions.add(windowId);
    } else {
      this.privateModeSessions.delete(windowId);
    }
  }

  /**
   * Check if a window is in private mode
   */
  isPrivateMode(windowId) {
    return this.privateModeSessions.has(windowId);
  }

  /**
   * Capture a user prompt (from request)
   */
  async capturePrompt(serviceId, requestData) {
    // Validation
    if (!serviceId || typeof serviceId !== 'string') {
      console.error('[ConversationCapture] Invalid serviceId:', serviceId);
      return;
    }
    
    if (!requestData) {
      console.warn('[ConversationCapture] No request data provided');
      return;
    }
    
    // Check if capture should proceed
    if (!this._shouldCapture(serviceId)) {
      return;
    }

    try {
      // Build conversation key: service + external conversation ID (if available)
      // For new conversations without an ID yet, generate a temporary local ID
      let conversationKey;
      if (requestData.externalConversationId) {
        conversationKey = `${serviceId}:${requestData.externalConversationId}`;
      } else {
        // Generate temporary ID for new conversations
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        conversationKey = `${serviceId}:${tempId}`;
        console.log(`[ConversationCapture] No external ID provided, using temporary: ${tempId}`);
      }
      
      console.log(`[ConversationCapture] Capturing prompt for key: ${conversationKey}`);
      
      // Get or create active conversation
      let conversation = this.activeConversations.get(conversationKey);
      
      if (!conversation) {
        conversation = this._createNewConversation(serviceId, requestData);
        conversation.externalConversationId = requestData.externalConversationId;
        conversation.tempConversationKey = conversationKey; // Store temp key for later update
        this.activeConversations.set(conversationKey, conversation);
        console.log(`[ConversationCapture] Created new conversation for ${conversationKey}`);
      }

      // Add prompt to conversation
      const extractedText = this._extractPromptText(requestData);
      
      // Skip only if explicitly empty or a placeholder
      if (extractedText === '' || extractedText === '[Message captured]') {
        console.log(`[ConversationCapture] Skipping empty/placeholder prompt (extractedText: "${extractedText}")`);
        return;
      }
      
      // Skip if no real content
      if (!extractedText || extractedText.trim().length === 0) {
        console.log(`[ConversationCapture] Skipping whitespace-only prompt`);
        return;
      }
      
      // Check for duplicate - don't add if last user message is identical
      const lastMessage = conversation.messages[conversation.messages.length - 1];
      if (lastMessage && lastMessage.role === 'user' && lastMessage.content === extractedText) {
        console.log(`[ConversationCapture] Skipping duplicate prompt`);
        return;
      }
      
      const prompt = {
        role: 'user',
        content: extractedText,
        timestamp: requestData.timestamp || new Date().toISOString(),
        model: requestData.model
      };

      conversation.messages.push(prompt);
      conversation.lastActivity = Date.now();
      
      console.log(`[ConversationCapture] Captured prompt for ${conversationKey}`);
    } catch (error) {
      console.error(`[ConversationCapture] Error in capturePrompt:`, error);
    }
  }

  /**
   * Capture AI response (from streaming complete)
   */
  async captureResponse(serviceId, responseData) {
    console.log(`[ConversationCapture] ======== captureResponse START ========`);
    console.log(`[ConversationCapture]   Service: ${serviceId}`);
    console.log(`[ConversationCapture]   Message length: ${responseData?.message?.length || 0}`);
    console.log(`[ConversationCapture]   Artifacts count: ${responseData?.artifacts?.length || 0}`);
    console.log(`[ConversationCapture]   External conv ID: ${responseData?.externalConversationId || 'none'}`);
    
    if (responseData?.artifacts && responseData.artifacts.length > 0) {
      console.log(`[ConversationCapture]   📄 Artifacts:`, JSON.stringify(responseData.artifacts, null, 2).substring(0, 800));
    }
    
    // Validation
    if (!serviceId || typeof serviceId !== 'string') {
      console.error('[ConversationCapture] Invalid serviceId:', serviceId);
      return;
    }
    
    if (!responseData || !responseData.message) {
      console.warn('[ConversationCapture] No response message provided');
      return;
    }
    
    // Check if capture should proceed
    if (!this._shouldCapture(serviceId)) {
      return;
    }

    try {
      // Build conversation key: service + external conversation ID (if available)
      const conversationKey = responseData.externalConversationId 
        ? `${serviceId}:${responseData.externalConversationId}`
        : serviceId;
      
      console.log(`[ConversationCapture] Capturing response for key: ${conversationKey}`);
      
      // Get or create conversation (create if missing - prompt may have been missed)
      let conversation = this.activeConversations.get(conversationKey);
      
      // If not found and we have an externalConversationId, check if there's a temp conversation to upgrade
      if (!conversation && responseData.externalConversationId) {
        console.log(`[ConversationCapture] Searching for temporary conversation to upgrade...`);
        // Find conversation with temp key for this service
        for (const [key, conv] of this.activeConversations.entries()) {
          if (key.startsWith(`${serviceId}:temp-`) && !conv.externalConversationId) {
            console.log(`[ConversationCapture] Found temp conversation: ${key}, upgrading to ${conversationKey}`);
            // Upgrade temporary conversation to real one
            conversation = conv;
            conversation.externalConversationId = responseData.externalConversationId;
            // Move to new key
            this.activeConversations.delete(key);
            this.activeConversations.set(conversationKey, conversation);
            break;
          }
        }
      }
      
      if (!conversation) {
        console.warn(`[ConversationCapture] No active conversation for ${conversationKey}, creating one`);
        conversation = this._createNewConversation(serviceId, responseData);
        conversation.externalConversationId = responseData.externalConversationId;
        this.activeConversations.set(conversationKey, conversation);
      }

      // Add response to conversation
      const response = {
        role: 'assistant',
        content: responseData.message || '',
        timestamp: responseData.timestamp || new Date().toISOString(),
        requestId: responseData.requestId,
        artifacts: responseData.artifacts || [] // Store artifacts with the message
      };
      
      // For ChatGPT: Extract code blocks as artifacts if no explicit artifacts provided
      if (serviceId === 'ChatGPT' && (!responseData.artifacts || responseData.artifacts.length === 0)) {
        const extractedCodeBlocks = this._extractCodeBlocksAsArtifacts(responseData.message || '');
        if (extractedCodeBlocks.length > 0) {
          console.log(`[ConversationCapture] Extracted ${extractedCodeBlocks.length} code blocks from ChatGPT response`);
          response.artifacts = extractedCodeBlocks;
        }
      }

      conversation.messages.push(response);
      conversation.lastActivity = Date.now();
      conversation.exchangeCount++;
      
      // Log artifacts if present
      if (responseData.artifacts && responseData.artifacts.length > 0) {
        console.log(`[ConversationCapture] Captured ${responseData.artifacts.length} artifacts for ${conversationKey}`);
        console.log(`[ConversationCapture] Artifact details:`, JSON.stringify(responseData.artifacts, null, 2));
        conversation.hasArtifacts = true;
      }

      console.log(`[ConversationCapture] Captured response for ${conversationKey}, exchanges: ${conversation.exchangeCount}`);

      // Save conversation after each exchange
      await this._saveConversation(conversationKey, conversation);
    } catch (error) {
      console.error(`[ConversationCapture] Error in captureResponse:`, error);
    }
  }

  /**
   * Capture media (images/files)
   */
  captureMedia(serviceId, files, externalConversationId = null) {
    const conversationKey = externalConversationId 
      ? `${serviceId}:${externalConversationId}`
      : serviceId;
      
    const conversation = this.activeConversations.get(conversationKey);
    if (!conversation) {
      return;
    }

    if (!conversation.media) {
      conversation.media = [];
    }

    conversation.media.push(...files);
    conversation.hasImages = conversation.hasImages || files.some(f => f.type?.includes('image'));
    conversation.hasFiles = conversation.hasFiles || files.some(f => !f.type?.includes('image'));
    
    console.log(`[ConversationCapture] Captured ${files.length} media files for ${conversationKey}`);
  }

  /**
   * Capture a downloaded file as an artifact (Word docs, PDFs, etc.)
   * @param {string} serviceId - AI service (e.g., 'Claude')
   * @param {Object} fileInfo - Download information
   */
  async captureDownloadedArtifact(serviceId, fileInfo) {
    console.log(`[ConversationCapture] captureDownloadedArtifact called for ${serviceId}:`, fileInfo.filename);
    
    // Find the active conversation for this service
    let conversationKey = null;
    let conversation = null;
    
    // First try to find conversation with external ID
    for (const [key, conv] of this.activeConversations.entries()) {
      if (key.startsWith(serviceId + ':')) {
        conversationKey = key;
        conversation = conv;
        break;
      }
    }
    
    // Fallback to service-only key
    if (!conversation) {
      conversationKey = serviceId;
      conversation = this.activeConversations.get(conversationKey);
    }
    
    if (!conversation) {
      console.warn('[ConversationCapture] No active conversation for downloaded artifact');
      return;
    }
    
    console.log(`[ConversationCapture] Found conversation: ${conversationKey}`);
    
    // Read file content as base64
    const fs = require('fs');
    const fileContent = fs.readFileSync(fileInfo.path);
    const base64Content = fileContent.toString('base64');
    
    console.log(`[ConversationCapture] Read file: ${fileInfo.size} bytes`);
    
    // Create artifact in compatible format
    const artifact = {
      type: 'downloaded_file',  // New type
      name: 'downloaded_file',
      id: `download-${Date.now()}`,
      input: {
        filename: fileInfo.filename,
        file_data: base64Content,  // Base64 encoded
        size: fileInfo.size,
        mimeType: fileInfo.mimeType,
        description: `Downloaded file: ${fileInfo.filename}`
      },
      source: 'download'
    };
    
    // Add to last message's artifacts
    if (conversation.messages.length > 0) {
      const lastMessage = conversation.messages[conversation.messages.length - 1];
      if (!lastMessage.artifacts) {
        lastMessage.artifacts = [];
      }
      lastMessage.artifacts.push(artifact);
      
      console.log(`[ConversationCapture] ✅ Captured downloaded artifact: ${fileInfo.filename} (${fileInfo.size} bytes)`);
      
      // Trigger save
      await this._saveConversation(conversationKey, conversation);
    } else {
      console.warn('[ConversationCapture] No messages in conversation to attach artifact to');
    }
    
    // DO NOT clean up temp file - the download handler will do that
    // The file is shared between our capture logic and the Space save logic
    console.log(`[ConversationCapture] ✅ Artifact captured, file will be cleaned up by download handler`);
  }

  /**
   * Get current active conversation for a service
   */
  getCurrentConversation(serviceId) {
    return this.activeConversations.get(serviceId);
  }

  /**
   * Mark current conversation as "do not save"
   */
  markDoNotSave(serviceId) {
    const conversation = this.activeConversations.get(serviceId);
    if (conversation) {
      conversation.doNotSave = true;
      console.log(`[ConversationCapture] Marked ${serviceId} conversation as do not save`);
    }
  }

  /**
   * Check if current conversation is marked do not save
   */
  isMarkedDoNotSave(serviceId) {
    const conversation = this.activeConversations.get(serviceId);
    return conversation?.doNotSave || false;
  }

  /**
   * Save conversation to Space
   */
  async _saveConversation(conversationKey, conversation) {
    console.log(`[ConversationCapture] ===== _saveConversation called for ${conversationKey} =====`);
    
    // Extract serviceId from conversationKey (format: "ServiceId" or "ServiceId:externalId")
    const serviceId = conversationKey.split(':')[0];
    
    // Check do not save flag
    if (conversation.doNotSave) {
      console.log(`[ConversationCapture] Skipping save for ${conversationKey} (marked do not save)`);
      return;
    }

    console.log('[ConversationCapture] Getting or creating service space...');
    // Get or create service space
    const spaceId = await this._getOrCreateServiceSpace(serviceId);
    if (!spaceId) {
      console.error(`[ConversationCapture] ❌ Failed to get/create space for ${serviceId}`);
      return;
    }
    
    console.log(`[ConversationCapture] Space ID obtained: ${spaceId}`);

    try {
      // Format conversation as markdown
      console.log('[ConversationCapture] Formatting conversation as markdown...');
      const markdown = this._formatConversationMarkdown(serviceId, conversation, spaceId);
      console.log('[ConversationCapture] Markdown length:', markdown.length);
      
      // Prepare metadata
      const metadata = {
        conversationId: conversation.id,
        aiService: serviceId,
        model: conversation.model,
        startTime: conversation.startTime,
        exchangeCount: conversation.exchangeCount,
        hasImages: conversation.hasImages || false,
        hasFiles: conversation.hasFiles || false,
        hasCode: markdown.includes('```'),
        tags: ['ai-conversation', serviceId.toLowerCase()],
        // Mark as markdown and chatbot conversation for proper rendering
        fileType: 'markdown',
        jsonSubtype: 'chatbot-conversation',
        // Add structured JSON for asset type detection
        jsonData: {
          conversationId: conversation.id,
          aiService: serviceId,
          model: conversation.model,
          startTime: conversation.startTime,
          exchangeCount: conversation.exchangeCount,
          messages: conversation.messages.map((m, index) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            messageIndex: index
          })),
          media: conversation.media || []
        }
      };
      
      console.log('[ConversationCapture] Metadata prepared:', JSON.stringify(metadata, null, 2));

      // Check if conversation already saved (update mode)
      if (conversation.savedItemId) {
        console.log('[ConversationCapture] Updating existing item:', conversation.savedItemId);
        // Update existing item
        try {
          await this.spacesAPI.items.update(spaceId, conversation.savedItemId, {
            content: markdown,
            metadata
          });
          console.log(`[ConversationCapture] ✅ Updated conversation ${conversation.id} in Space`);
        } catch (updateError) {
          console.error(`[ConversationCapture] Failed to update conversation:`, updateError);
          // If update fails, try creating a new item instead
          conversation.savedItemId = null;
          return await this._saveConversation(conversationKey, conversation);
        }
      } else {
        console.log('[ConversationCapture] Creating NEW item in space');
        // Save as new item with retry logic
        let retries = 3;
        let lastError = null;
        
        
        while (retries > 0) {
          try {
            console.log(`[ConversationCapture] Attempt ${4-retries}/3: Calling spacesAPI.items.add...`);
            const item = await this.spacesAPI.items.add(spaceId, {
              type: 'text',  // Use 'text' type (markdown will be detected by metadata)
              content: markdown,
              metadata
            });
            
            console.log(`[ConversationCapture] items.add returned:`, item);
            
            conversation.savedItemId = item.id;
            console.log(`[ConversationCapture] ✅✅✅ Saved new conversation ${conversation.id} to Space with item ID ${item.id}`);

            // Save structured JSON version for asset type detection
            const jsonData = {
              conversationId: conversation.id,
              aiService: serviceId,
              model: conversation.model,
              startTime: conversation.startTime,
              exchangeCount: conversation.exchangeCount,
              messages: conversation.messages.map((m, index) => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
                messageIndex: index
              })),
              media: conversation.media || []
            };
            
            // Store JSON data as item metadata for asset type detection
            conversation.savedItemMetadata = jsonData;
            console.log('[ConversationCapture] Structured JSON metadata prepared for asset type detection');

            // Save artifacts as separate items
            const artifactItemIds = await this._saveArtifacts(spaceId, conversation, item.id);
            if (artifactItemIds.length > 0) {
              console.log(`[ConversationCapture] Saved ${artifactItemIds.length} artifacts as separate items`);
              
              // Re-format markdown with artifact links
              const updatedMarkdown = this._formatConversationMarkdown(serviceId, conversation, spaceId, artifactItemIds);
              
              // Update conversation item with artifact references
              try {
                await this.spacesAPI.items.update(spaceId, item.id, {
                  content: updatedMarkdown,
                  metadata: {
                    ...metadata,
                    artifactItemIds: artifactItemIds
                  }
                });
                console.log('[ConversationCapture] Updated conversation with artifact references');
              } catch (updateError) {
                console.warn('[ConversationCapture] Failed to update conversation with artifact refs:', updateError);
              }
            }

            // Save media files
            if (conversation.media && conversation.media.length > 0) {
              console.log('[ConversationCapture] Saving media files...');
              await this._saveMediaFiles(spaceId, conversation);
            }

            // Show undo toast
            console.log('[ConversationCapture] Showing undo toast...');
            this._showUndoToast(item.id, serviceId);
            
            // Register as Space asset
            try {
              await this.spacesAPI.metadata.setAsset(spaceId, 'chatbot-conversation', {
                conversationId: conversation.id,
                aiService: serviceId,
                model: conversation.model,
                messageCount: conversation.messages.length,
                attachmentCount: conversation.media?.length || 0,
                lastUpdated: new Date().toISOString()
              });
              console.log('[ConversationCapture] Registered as Space asset');
            } catch (assetError) {
              console.warn('[ConversationCapture] Failed to register asset metadata:', assetError);
              // Non-critical, continue anyway
            }
            
            console.log('[ConversationCapture] ===== SAVE COMPLETE =====');
            return; // Success!
          } catch (error) {
            lastError = error;
            retries--;
            
            console.error(`[ConversationCapture] ❌ Save attempt failed:`, error);
            
            if (retries > 0) {
              console.warn(`[ConversationCapture] Retrying... (${retries} left)`);
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
            }
          }
        }
        
        // All retries exhausted
        console.error(`[ConversationCapture] ❌❌❌ Failed to save conversation after all retries:`, lastError);
      }
    } catch (error) {
      console.error(`[ConversationCapture] ❌ Error in _saveConversation:`, error);
    }
  }

  /**
   * Extract code blocks from ChatGPT message text and convert to artifact format
   * @param {string} messageText - The message text containing code blocks
   * @returns {Array} Array of artifact objects
   */
  _extractCodeBlocksAsArtifacts(messageText) {
    if (!messageText || typeof messageText !== 'string') {
      return [];
    }
    
    const artifacts = [];
    // Match fenced code blocks: ```language\ncode\n```
    const codeBlockRegex = /```(\w+)?\n?([\s\S]*?)```/g;
    let match;
    let blockIndex = 0;
    
    while ((match = codeBlockRegex.exec(messageText)) !== null) {
      const language = match[1] || 'text';
      const code = match[2].trim();
      
      // Skip empty code blocks or very small ones (likely formatting artifacts)
      if (!code || code.length < 10) {
        continue;
      }
      
      // Skip if it looks like it's just an example (heuristic: contains "example" or "sample")
      const context = messageText.substring(Math.max(0, match.index - 100), match.index).toLowerCase();
      const isExample = context.includes('example') || context.includes('sample') || context.includes('for instance');
      
      // Create artifact in ChatGPT format (mimicking Claude's structure for compatibility)
      artifacts.push({
        type: 'code_block',  // Different from Claude's 'tool_use'
        name: 'code_block',
        id: `chatgpt-code-${Date.now()}-${blockIndex}`,
        language: language,
        input: {
          language: language,
          file_text: code,  // Use same field as Claude for consistency
          description: `Code block ${blockIndex + 1}${isExample ? ' (example)' : ''}`,
          path: null  // ChatGPT doesn't provide paths
        },
        // Add flag to help _saveArtifacts know this is from ChatGPT
        source: 'chatgpt',
        isExample: isExample
      });
      
      blockIndex++;
    }
    
    console.log(`[ConversationCapture] Extracted ${artifacts.length} code blocks from message`);
    return artifacts;
  }

  /**
   * Save artifacts as separate Space items
   */
  async _saveArtifacts(spaceId, conversation, conversationItemId) {
    const artifactItemIds = [];
    
    // Collect all artifacts from all assistant messages
    const artifacts = [];
    for (const msg of conversation.messages) {
      if (msg.role === 'assistant' && msg.artifacts && msg.artifacts.length > 0) {
        artifacts.push(...msg.artifacts);
      }
    }
    
    if (artifacts.length === 0) {
      return artifactItemIds;
    }
    
    console.log(`[ConversationCapture] Saving ${artifacts.length} artifacts as separate items...`);
    
    for (const artifact of artifacts) {
      try {
        // Support multiple artifact types:
        // - Claude's tool_use (SVG, code generation)
        // - ChatGPT's code_block (extracted from markdown)
        // - downloaded_file (binary files like .docx, .pdf)
        const isClaudeArtifact = artifact.type === 'tool_use';
        const isChatGPTCodeBlock = artifact.type === 'code_block';
        const isDownloadedFile = artifact.type === 'downloaded_file';
        
        if (!isClaudeArtifact && !isChatGPTCodeBlock && !isDownloadedFile) {
          console.log(`[ConversationCapture] Skipping unsupported artifact type: ${artifact.type}`);
          continue;
        }
        
        if (!artifact.input) {
          continue;
        }
        
        let artifactContent, isBinaryFile = false, fileName;
        
        if (isDownloadedFile) {
          // Binary file - use base64
          artifactContent = artifact.input.file_data;
          isBinaryFile = true;
          fileName = artifact.input.filename;
          
          if (!artifactContent) {
            console.log(`[ConversationCapture] Skipping downloaded file (no data): ${fileName}`);
            continue;
          }
          
          console.log(`[ConversationCapture] Processing downloaded file: ${fileName} (${artifact.input.size} bytes)`);
        } else {
          // Text-based artifact (code, SVG, etc.)
          artifactContent = artifact.input.file_text || artifact.input.content || artifact.input.code;
          if (!artifactContent) {
            console.log(`[ConversationCapture] Skipping artifact ${artifact.name} (no content)`);
            continue;
          }
        }
        
        // Determine file type from artifact
        let fileExtension = 'txt';
        let itemType = 'text';
        let fileType = null;
        let fileCategory = null;
        let language = artifact.input.language || artifact.language || '';
        
        // Handle downloaded binary files
        if (isDownloadedFile) {
          // Extract extension from filename
          const path = require('path');
          const ext = path.extname(fileName).toLowerCase();
          fileExtension = ext.replace('.', '');
          itemType = 'file';
          
          // Map extension to file type and category
          if (ext === '.docx' || ext === '.doc') {
            fileCategory = 'document';
            fileType = 'document';
          } else if (ext === '.pdf') {
            fileCategory = 'document';
            fileType = 'pdf';
          } else if (ext === '.xlsx' || ext === '.xls') {
            fileCategory = 'data';
            fileType = 'spreadsheet';
          } else if (ext === '.pptx' || ext === '.ppt') {
            fileCategory = 'document';
            fileType = 'presentation';
          } else if (ext === '.zip' || ext === '.rar' || ext === '.7z') {
            fileCategory = 'archive';
            fileType = 'archive';
          } else if (ext === '.csv') {
            fileCategory = 'data';
            fileType = 'data';
          } else if (ext === '.txt') {
            fileCategory = 'document';
            fileType = 'text';
          }
          
          console.log(`[ConversationCapture] Downloaded file type: ${fileExtension}, category: ${fileCategory}`);
        }
        // Check for SVG content (text-based)
        else if (artifact.name === 'create_file' || (artifactContent && artifactContent.trim().startsWith('<svg'))) {
          fileExtension = 'svg';
          itemType = 'file';
          fileType = 'image-file';  // Mark as image file
          fileCategory = 'media';   // Media category
          language = 'svg';
        } else if (language === 'javascript' || language === 'js') {
          fileExtension = 'js';
          fileCategory = 'code';
        } else if (language === 'python' || language === 'py') {
          fileExtension = 'py';
          fileCategory = 'code';
        } else if (language === 'html') {
          fileExtension = 'html';
          fileCategory = 'code';
        } else if (language === 'css') {
          fileExtension = 'css';
          fileCategory = 'code';
        } else if (language === 'json') {
          fileExtension = 'json';
          fileCategory = 'data';
        } else if (language === 'markdown' || language === 'md') {
          fileExtension = 'md';
          fileCategory = 'document';
        }
        
        // Generate filename from path or description
        if (!isDownloadedFile) {
          // For text-based artifacts, generate filename
          fileName = `artifact-${Date.now()}.${fileExtension}`;
          if (artifact.input.path) {
            const pathParts = artifact.input.path.split('/');
            fileName = pathParts[pathParts.length - 1];
          } else if (artifact.input.description) {
            // Clean description to make a valid filename
            const cleanDesc = artifact.input.description
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .substring(0, 50);
            fileName = `${cleanDesc}.${fileExtension}`;
          } else if (isChatGPTCodeBlock) {
            // For ChatGPT code blocks, use language-based naming
            fileName = `code-${language || 'snippet'}-${Date.now()}.${fileExtension}`;
          }
        }
        // else: fileName already set for downloaded files
        
        // Prepare metadata linking back to conversation
        const artifactMetadata = {
          sourceType: 'ai-artifact',
          aiService: conversation.aiService || 'ChatGPT',
          conversationId: conversation.id,
          conversationItemId: conversationItemId,
          artifactName: artifact.name,
          artifactId: artifact.id,
          description: artifact.input.description || '',
          language: language,
          createdFrom: 'ai-conversation-capture',
          tags: ['ai-artifact', conversation.aiService?.toLowerCase() || 'chatgpt', artifact.name]
        };
        
        // Add isExample flag for ChatGPT code blocks if it's marked as example
        if (isChatGPTCodeBlock && artifact.isExample) {
          artifactMetadata.isExample = true;
          artifactMetadata.tags.push('example');
        }
        
        console.log(`[ConversationCapture] Saving artifact: ${fileName}`);
        
        // Save artifact as separate item
        // For binary files, use fileData; for text, use content
        const itemData = {
          type: itemType,
          fileName: fileName,
          fileType: fileType,        // Add file type
          fileCategory: fileCategory, // Add file category
          fileExt: `.${fileExtension}`, // Add file extension (with dot prefix)
          metadata: artifactMetadata
        };
        
        if (isBinaryFile) {
          itemData.fileData = artifactContent;  // Base64 for binary files
          itemData.fileSize = artifact.input.size;
          console.log(`[ConversationCapture] Saving binary file: ${fileName} (${artifact.input.size} bytes)`);
        } else {
          itemData.content = artifactContent;  // Text content
        }
        
        const artifactItem = await this.spacesAPI.items.add(spaceId, itemData);
        
        artifactItemIds.push(artifactItem.id);
        console.log(`[ConversationCapture] ✅ Saved artifact as item ${artifactItem.id}`);
        
      } catch (error) {
        console.error(`[ConversationCapture] Failed to save artifact ${artifact.name}:`, error);
        // Continue with other artifacts
      }
    }
    
    return artifactItemIds;
  }

  /**
   * Save media files to Space
   */
  async _saveMediaFiles(spaceId, conversation) {
    for (let i = 0; i < conversation.media.length; i++) {
      const media = conversation.media[i];
      
      try {
        // Extract base64 data
        let fileData = null;
        let fileName = media.fileName || `media_${Date.now()}.jpg`;
        
        if (media.data) {
          if (media.data.startsWith('data:')) {
            // Base64 data URL
            const matches = media.data.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
              fileData = Buffer.from(matches[2], 'base64');
              const mimeType = matches[1];
              const ext = mimeType.split('/')[1] || 'jpg';
              fileName = media.fileName || `image_${Date.now()}.${ext}`;
            }
          }
        }

        if (!fileData) {
          console.warn('[ConversationCapture] Could not extract media data');
          continue;
        }

        // Find which message this media belongs to
        const messageIndex = this._findMessageForMedia(media, conversation.messages);
        
        // Comprehensive linking metadata
        const metadata = {
          // Linking metadata
          linkedToConversation: conversation.id,
          linkedToConversationItem: conversation.savedItemId,
          aiService: conversation.aiService || 'Unknown',
          messageIndex: messageIndex,
          messageTimestamp: conversation.messages[messageIndex]?.timestamp,
          attachmentOrder: i,
          
          // Media metadata
          mediaType: media.type,
          fileName: fileName,
          capturedAt: media.timestamp || new Date().toISOString(),
          source: 'ai-conversation'
        };

        // Save to Space with full metadata
        const savedItem = await this.spacesAPI.items.add(spaceId, {
          type: media.type?.includes('image') ? 'image' : 'file',
          content: fileData,
          metadata: metadata
        });
        
        // Store item ID back in media for reference
        media.itemId = savedItem.id;

        console.log(`[ConversationCapture] Saved media file: ${fileName} with comprehensive metadata`);
      } catch (error) {
        console.error('[ConversationCapture] Error saving media file:', error);
      }
    }
  }
  
  /**
   * Find which message a media item belongs to based on timing
   */
  _findMessageForMedia(media, messages) {
    if (!media.timestamp || !messages || messages.length === 0) {
      return messages.length - 1; // Default to last message
    }
    
    const mediaTime = new Date(media.timestamp).getTime();
    
    // Find closest message by timestamp (within 5 seconds)
    let closestIndex = messages.length - 1;
    let closestDiff = Infinity;
    
    for (let i = 0; i < messages.length; i++) {
      const msgTime = new Date(messages[i].timestamp).getTime();
      const diff = Math.abs(msgTime - mediaTime);
      
      if (diff < closestDiff && diff < 5000) { // Within 5 seconds
        closestDiff = diff;
        closestIndex = i;
      }
    }
    
    return closestIndex;
  }

  /**
   * Format conversation as markdown
   * @param {string} serviceId - AI service identifier
   * @param {object} conversation - Conversation data
   * @param {string} spaceId - Space ID
   * @param {Array} artifactItemIds - Optional array of artifact item IDs for linking
   */
  _formatConversationMarkdown(serviceId, conversation, spaceId, artifactItemIds = []) {
    const config = AI_SERVICE_CONFIG[serviceId] || {};
    const lines = [];

    // Clean header with icon and metadata
    lines.push(`# ${config.icon || '💬'} ${serviceId} Conversation`);
    lines.push('');
    
    // Subtle metadata line
    const metadata = [];
    if (conversation.model) metadata.push(conversation.model);
    metadata.push(`${conversation.exchangeCount} ${conversation.exchangeCount === 1 ? 'exchange' : 'exchanges'}`);
    metadata.push(new Date(conversation.startTime).toLocaleDateString());
    lines.push(`*${metadata.join(' • ')}*`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Track artifact index for linking to saved items
    let artifactIndex = 0;

    // Clean conversation format
    for (let i = 0; i < conversation.messages.length; i++) {
      const msg = conversation.messages[i];
      const isUser = msg.role === 'user';
      const timestamp = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      if (isUser) {
        // User messages: bold with subtle timestamp
        lines.push(`**You** <sub>${timestamp}</sub>`);
        lines.push(msg.content);
        lines.push('');
      } else {
        // Assistant messages: clean with subtle timestamp
        lines.push(`**${serviceId}** <sub>${timestamp}</sub>`);
        lines.push(msg.content);
        lines.push('');
        
        // Add artifacts if present
        if (msg.artifacts && msg.artifacts.length > 0) {
          for (const artifact of msg.artifacts) {
            // Format artifact based on type
            if (artifact.type === 'tool_use' && artifact.input) {
              const artifactContent = artifact.input.file_text || artifact.input.content || artifact.input.code;
              
              // Skip artifacts without content (like present_files)
              if (!artifactContent) {
                continue;
              }
              
              lines.push('');
              lines.push(`**📄 Artifact: ${artifact.name || 'Document'}**`);
              
              // Show description if available
              if (artifact.input.description) {
                lines.push(`*${artifact.input.description}*`);
              }
              
              // Always show the artifact content inline for preview
              lines.push('');
              const language = artifact.input.language || (artifact.name === 'create_file' ? 'svg' : '');
              
              if (language) {
                lines.push(`\`\`\`${language}`);
                lines.push(artifactContent);
                lines.push('```');
              } else {
                lines.push(artifactContent);
              }
              lines.push('');
              
              // Add link to separate artifact item if available
              if (artifactItemIds[artifactIndex]) {
                lines.push(`🔗 [View as separate file](spaces://${spaceId}/${artifactItemIds[artifactIndex]})`);
                lines.push('');
                artifactIndex++;
              }
            } else if (artifact.content) {
              // Generic artifact with content
              lines.push('');
              lines.push(`**📄 ${artifact.type || 'Artifact'}**`);
              lines.push('');
              lines.push(artifact.content);
              lines.push('');
            }
          }
        }
        
        // Add media references inline if present
        if (conversation.media && conversation.media.length > 0) {
          const msgTime = new Date(msg.timestamp).getTime();
          const relevantMedia = conversation.media.filter(m => {
            const mediaTime = new Date(m.timestamp || msg.timestamp).getTime();
            return Math.abs(mediaTime - msgTime) < 5000;
          });
          
          for (const media of relevantMedia) {
            if (media.type?.includes('image')) {
              const fileName = media.fileName || 'image.jpg';
              const itemId = media.itemId || '';
              
              // Inline image reference
              if (itemId && spaceId) {
                lines.push(`![](spaces://${spaceId}/${itemId})`);
                lines.push('');
              }
            }
          }
        }
      }
      
      // Add separator between exchanges (except after last message)
      if (!isUser && i < conversation.messages.length - 1) {
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Get or create service-specific Space
   */
  async _getOrCreateServiceSpace(serviceId) {
    console.log(`[ConversationCapture] _getOrCreateServiceSpace for ${serviceId}`);
    
    // Check cache
    if (this.serviceSpaces.has(serviceId)) {
      const cachedId = this.serviceSpaces.get(serviceId);
      console.log(`  ✅ Found in cache: ${cachedId}`);
      return cachedId;
    }

    const config = AI_SERVICE_CONFIG[serviceId];
    if (!config) {
      console.error(`[ConversationCapture] ❌ Unknown service: ${serviceId}`);
      return null;
    }
    
    console.log(`  Config found:`, config);

    try {
      // Check if space already exists
      console.log(`  Fetching existing spaces...`);
      const spaces = await this.spacesAPI.list();
      console.log(`  Total spaces found: ${spaces.length}`);
      
      const existingSpace = spaces.find(s => s.name === config.spaceName);

      if (existingSpace) {
        console.log(`  ✅ Found existing space: ${existingSpace.id}`);
        this.serviceSpaces.set(serviceId, existingSpace.id);
        return existingSpace.id;
      }

      // Create new space
      console.log(`  Creating NEW space: ${config.spaceName}`);
      const newSpace = await this.spacesAPI.create(config.spaceName, {
        icon: config.icon,
        color: config.color
      });
      
      console.log(`  Space created:`, newSpace);

      this.serviceSpaces.set(serviceId, newSpace.id);
      console.log(`[ConversationCapture] ✅ Created Space: ${config.spaceName} with ID ${newSpace.id}`);
      
      return newSpace.id;
    } catch (error) {
      console.error(`[ConversationCapture] ❌ Error creating space for ${serviceId}:`, error);
      return null;
    }
  }

  /**
   * Copy conversation to another Space
   */
  async copyConversationToSpace(conversationId, targetSpaceId) {
    // Implementation for manual space assignment
    console.log(`[ConversationCapture] Copying conversation ${conversationId} to Space ${targetSpaceId}`);
    // TODO: Implement full copy logic with media
  }
  
  /**
   * Get all media items linked to a conversation
   * @param {string} spaceId - The space ID
   * @param {string} conversationId - The conversation ID
   * @returns {Promise<Array>} Media items with full metadata
   */
  async getConversationMedia(spaceId, conversationId) {
    try {
      const items = await this.spacesAPI.items.list(spaceId);
      const mediaItems = items.filter(item => 
        item.metadata?.linkedToConversation === conversationId
      );
      
      console.log(`[ConversationCapture] Found ${mediaItems.length} media items for conversation ${conversationId}`);
      return mediaItems;
    } catch (error) {
      console.error('[ConversationCapture] Error getting conversation media:', error);
      return [];
    }
  }

  /**
   * Show undo toast
   */
  _showUndoToast(itemId, serviceId) {
    const settings = this.settingsManager?.get('aiConversationCapture') || {};
    if (settings.enableUndoWindow === false) {
      return;
    }

    const durationMs = (settings.undoWindowMinutes || 5) * 60 * 1000;
    
    // Set timeout
    const timeout = setTimeout(() => {
      this.pendingUndos.delete(itemId);
    }, durationMs);

    this.pendingUndos.set(itemId, { timeout, serviceId });

    // Emit event for UI to show toast
    if (global.broadcastHUDActivity) {
      global.broadcastHUDActivity({
        type: 'conversation-saved',
        itemId,
        serviceId,
        durationMs,
        message: `Conversation saved to ${AI_SERVICE_CONFIG[serviceId]?.spaceName || serviceId}`
      });
    }
  }

  /**
   * Undo save
   */
  async undoSave(itemId) {
    const pending = this.pendingUndos.get(itemId);
    if (!pending) {
      return { success: false, error: 'Undo window expired' };
    }

    try {
      // Delete item
      await this.spacesAPI.items.delete(itemId);
      
      // Clear timeout
      clearTimeout(pending.timeout);
      this.pendingUndos.delete(itemId);

      console.log(`[ConversationCapture] Undid save for item ${itemId}`);
      return { success: true };
    } catch (error) {
      console.error('[ConversationCapture] Error undoing save:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if conversation should be captured
   */
  _shouldCapture(serviceId) {
    console.log(`[ConversationCapture] _shouldCapture check for ${serviceId}:`);
    
    // Check if enabled
    const enabled = this.isEnabled();
    console.log(`  - isEnabled(): ${enabled}`);
    if (!enabled) {
      console.log(`  ❌ BLOCKED: Not enabled`);
      return false;
    }

    // Check if paused
    console.log(`  - paused: ${this.paused}`);
    if (this.paused) {
      console.log(`  ❌ BLOCKED: Paused`);
      return false;
    }

    // Check if conversation marked do not save
    const conversation = this.activeConversations.get(serviceId);
    const doNotSave = conversation?.doNotSave || false;
    console.log(`  - doNotSave flag: ${doNotSave}`);
    if (doNotSave) {
      console.log(`  ❌ BLOCKED: Marked do not save`);
      return false;
    }

    console.log(`  ✅ ALLOWED: All checks passed`);
    return true;
  }

  /**
   * Create new conversation object
   */
  _createNewConversation(serviceId, initialData) {
    return {
      id: `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      serviceId,
      startTime: new Date().toISOString(),
      lastActivity: Date.now(),
      messages: [],
      media: [],
      exchangeCount: 0,
      model: initialData.model,
      hasImages: false,
      hasFiles: false,
      hasCode: false,
      doNotSave: false,
      savedItemId: null
    };
  }

  /**
   * Extract prompt text from request data
   */
  _extractPromptText(requestData) {
    console.log('[ConversationCapture] _extractPromptText called with keys:', Object.keys(requestData || {}));
    console.log('[ConversationCapture] message type:', typeof requestData.message);
    console.log('[ConversationCapture] message value:', JSON.stringify(requestData.message)?.substring(0, 200));
    
    if (typeof requestData.message === 'string') {
      console.log('[ConversationCapture] Found string message:', requestData.message.substring(0, 100));
      return requestData.message;
    }

    if (Array.isArray(requestData.message)) {
      console.log('[ConversationCapture] Found message array with', requestData.message.length, 'messages');
      
      // ChatGPT format: Look for user messages in the array
      // Format: { author: { role: 'user' }, content: { content_type: 'text', parts: ['...'] } }
      for (let i = requestData.message.length - 1; i >= 0; i--) {
        const msg = requestData.message[i];
        
        // Skip non-user messages
        if (msg.author?.role && msg.author.role !== 'user') {
          continue;
        }
        if (msg.role && msg.role !== 'user') {
          continue;
        }
        
        // ChatGPT specific: content.parts array format
        if (msg.content?.parts && Array.isArray(msg.content.parts)) {
          const text = msg.content.parts
            .filter(part => typeof part === 'string')
            .join('\n');
          if (text) {
            console.log('[ConversationCapture] Extracted from content.parts:', text.substring(0, 100));
            return text;
          }
        }
        
        // Handle content as string
        if (typeof msg.content === 'string') {
          console.log('[ConversationCapture] Extracted from content string:', msg.content.substring(0, 100));
          return msg.content;
        }
        
        // Handle content blocks (Anthropic format)
        if (Array.isArray(msg.content)) {
          const textBlocks = msg.content
            .filter(block => block.type === 'text')
            .map(block => block.text || '')
            .join('\n');
          if (textBlocks) {
            console.log('[ConversationCapture] Extracted from content blocks:', textBlocks.substring(0, 100));
            return textBlocks;
          }
        }
        
        // Fallback to text field
        if (msg.text) {
          console.log('[ConversationCapture] Extracted from text field:', msg.text.substring(0, 100));
          return msg.text;
        }
      }
      
      console.log('[ConversationCapture] No user message found in array');
      return '';
    }

    if (requestData.prompt) {
      console.log('[ConversationCapture] Found prompt field');
      return requestData.prompt;
    }

    // Grok format: may have different field names
    // Check for common Grok field names
    if (requestData.query) {
      console.log('[ConversationCapture] Found query field (Grok)');
      return requestData.query;
    }
    
    if (requestData.input) {
      console.log('[ConversationCapture] Found input field');
      return requestData.input;
    }
    
    if (requestData.text) {
      console.log('[ConversationCapture] Found text field');
      return requestData.text;
    }
    
    if (requestData.content) {
      console.log('[ConversationCapture] Found content field');
      return typeof requestData.content === 'string' ? requestData.content : JSON.stringify(requestData.content);
    }
    
    // Grok specific: messages array with different structure
    if (requestData.messages && Array.isArray(requestData.messages)) {
      console.log('[ConversationCapture] Found messages array with', requestData.messages.length, 'items');
      // Get last user message
      for (let i = requestData.messages.length - 1; i >= 0; i--) {
        const msg = requestData.messages[i];
        if (msg.role === 'user' || !msg.role) {
          if (msg.content) return msg.content;
          if (msg.text) return msg.text;
          if (msg.message) return msg.message;
        }
      }
    }
    
    // Grok: check for nested conversation structure
    if (requestData.conversation?.messages) {
      const msgs = requestData.conversation.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' || !msgs[i].role) {
          return msgs[i].content || msgs[i].text || '';
        }
      }
    }

    // Log all top-level keys for debugging unknown formats
    console.log('[ConversationCapture] Unknown format. All keys:', Object.keys(requestData).join(', '));
    console.log('[ConversationCapture] No message found, returning empty');
    return '';
  }

  /**
   * Check for conversation timeout and save
   */
  async checkConversationTimeouts() {
    const settings = this.settingsManager?.get('aiConversationCapture') || {};
    const timeoutMs = (settings.conversationTimeoutMinutes || 30) * 60 * 1000;
    const now = Date.now();

    for (const [serviceId, conversation] of this.activeConversations.entries()) {
      if (now - conversation.lastActivity > timeoutMs) {
        console.log(`[ConversationCapture] Conversation timeout for ${serviceId}, finalizing...`);
        await this._saveConversation(serviceId, conversation);
        this.activeConversations.delete(serviceId);
      }
    }
  }

  /**
   * Load state from disk
   */
  _loadState() {
    try {
      const statePath = path.join(app.getPath('userData'), 'conversation-capture-state.json');
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        
        // Restore pause state if configured
        const settings = this.settingsManager?.get('aiConversationCapture') || {};
        if (settings.clearPauseOnRestart !== false) {
          this.paused = false; // Clear pause on restart (default behavior)
        } else {
          this.paused = data.paused || false;
        }

        console.log('[ConversationCapture] State loaded from disk');
      }
    } catch (error) {
      console.error('[ConversationCapture] Error loading state:', error);
    }
  }

  /**
   * Save state to disk
   */
  _saveState() {
    try {
      const statePath = path.join(app.getPath('userData'), 'conversation-capture-state.json');
      const data = {
        paused: this.paused,
        lastSaved: new Date().toISOString()
      };
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[ConversationCapture] Error saving state:', error);
    }
  }
}

// Singleton instance
let instance = null;

function getConversationCapture(spacesAPI, settingsManager) {
  console.log('[ConversationCapture] getConversationCapture called, instance exists:', !!instance);
  if (!instance) {
    console.log('[ConversationCapture] Creating NEW instance...');
    instance = new ConversationCapture(spacesAPI, settingsManager);
    console.log('[ConversationCapture] Instance created successfully');
    
    // Set up periodic timeout checks
    setInterval(() => {
      instance.checkConversationTimeouts();
    }, 60000); // Check every minute
  }
  return instance;
}

module.exports = {
  ConversationCapture,
  getConversationCapture,
  AI_SERVICE_CONFIG
};
