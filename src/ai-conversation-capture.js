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
const { getLogQueue } = require('../lib/log-event-queue');
const log = getLogQueue();

// AI service configurations
const AI_SERVICE_CONFIG = {
  Claude: {
    icon: '🤖',
    color: '#ff6b35',
    spaceName: 'Claude Conversations',
  },
  ChatGPT: {
    icon: '💬',
    color: '#10a37f',
    spaceName: 'ChatGPT Conversations',
  },
  Gemini: {
    icon: '✨',
    color: '#4285f4',
    spaceName: 'Gemini Conversations',
  },
  Perplexity: {
    icon: '🔍',
    color: '#8b5cf6',
    spaceName: 'Perplexity Conversations',
  },
  Grok: {
    icon: '🚀',
    color: '#6b7280',
    spaceName: 'Grok Conversations',
  },
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
    log.info('app', '[ConversationCapture] Capture', { v0: paused ? 'paused' : 'resumed' });
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
      log.error('app', '[ConversationCapture] Invalid serviceId', { error: serviceId });
      return;
    }

    if (!requestData) {
      log.warn('app', '[ConversationCapture] No request data provided');
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
        log.info('app', '[ConversationCapture] No external ID provided, using temporary:', { v0: tempId });
      }

      log.info('app', '[ConversationCapture] Capturing prompt for key:', { v0: conversationKey });

      // Get or create active conversation
      let conversation = this.activeConversations.get(conversationKey);

      if (!conversation) {
        conversation = this._createNewConversation(serviceId, requestData);
        conversation.externalConversationId = requestData.externalConversationId;
        conversation.tempConversationKey = conversationKey; // Store temp key for later update
        this.activeConversations.set(conversationKey, conversation);
        log.info('app', '[ConversationCapture] Created new conversation for', { v0: conversationKey });
      }

      // Add prompt to conversation
      const extractedText = this._extractPromptText(requestData);

      // Skip only if explicitly empty or a placeholder
      if (extractedText === '' || extractedText === '[Message captured]') {
        log.info('app', '[ConversationCapture] Skipping empty/placeholder prompt (extractedText: "")', {
          v0: extractedText,
        });
        return;
      }

      // Skip if no real content
      if (!extractedText || extractedText.trim().length === 0) {
        log.info('app', '[ConversationCapture] Skipping whitespace-only prompt');
        return;
      }

      // Check for duplicate - don't add if last user message is identical
      const lastMessage = conversation.messages[conversation.messages.length - 1];
      if (lastMessage && lastMessage.role === 'user' && lastMessage.content === extractedText) {
        log.info('app', '[ConversationCapture] Skipping duplicate prompt');
        return;
      }

      const prompt = {
        role: 'user',
        content: extractedText,
        timestamp: requestData.timestamp || new Date().toISOString(),
        model: requestData.model,
      };

      conversation.messages.push(prompt);
      conversation.lastActivity = Date.now();

      log.info('app', '[ConversationCapture] Captured prompt for', { v0: conversationKey });
    } catch (error) {
      log.error('app', '[ConversationCapture] Error in capturePrompt:', { arg0: error });
    }
  }

  /**
   * Capture AI response (from streaming complete)
   */
  async captureResponse(serviceId, responseData) {
    log.info('app', '[ConversationCapture] ======== captureResponse START ========');
    log.info('app', '[ConversationCapture] Service:', { v0: serviceId });
    log.info('app', '[ConversationCapture] Message length:', { v0: responseData?.message?.length || 0 });
    log.info('app', '[ConversationCapture] Artifacts count:', { v0: responseData?.artifacts?.length || 0 });
    log.info('app', '[ConversationCapture] External conv ID:', { v0: responseData?.externalConversationId || 'none' });

    if (responseData?.artifacts && responseData.artifacts.length > 0) {
      log.info('app', 'ConversationCapture artifacts', {
        artifacts: JSON.stringify(responseData.artifacts, null, 2).substring(0, 800),
      });
    }

    // Validation
    if (!serviceId || typeof serviceId !== 'string') {
      log.error('app', '[ConversationCapture] Invalid serviceId', { error: serviceId });
      return;
    }

    if (!responseData || !responseData.message) {
      log.warn('app', '[ConversationCapture] No response message provided');
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

      log.info('app', '[ConversationCapture] Capturing response for key:', { v0: conversationKey });

      // Get or create conversation (create if missing - prompt may have been missed)
      let conversation = this.activeConversations.get(conversationKey);

      // If not found and we have an externalConversationId, check if there's a temp conversation to upgrade
      if (!conversation && responseData.externalConversationId) {
        log.info('app', '[ConversationCapture] Searching for temporary conversation to upgrade...');
        // Find conversation with temp key for this service
        for (const [key, conv] of this.activeConversations.entries()) {
          if (key.startsWith(`${serviceId}:temp-`) && !conv.externalConversationId) {
            log.info('app', '[ConversationCapture] Found temp conversation: , upgrading to', {
              v0: key,
              v1: conversationKey,
            });
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
        log.warn('app', '[ConversationCapture] No active conversation for , creating one', { v0: conversationKey });
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
        artifacts: responseData.artifacts || [], // Store artifacts with the message
      };

      // For ChatGPT: Extract code blocks as artifacts if no explicit artifacts provided
      if (serviceId === 'ChatGPT' && (!responseData.artifacts || responseData.artifacts.length === 0)) {
        const extractedCodeBlocks = this._extractCodeBlocksAsArtifacts(responseData.message || '');
        if (extractedCodeBlocks.length > 0) {
          log.info('app', '[ConversationCapture] Extracted code blocks from ChatGPT response', {
            v0: extractedCodeBlocks.length,
          });
          response.artifacts = extractedCodeBlocks;
        }
      }

      conversation.messages.push(response);
      conversation.lastActivity = Date.now();
      conversation.exchangeCount++;

      // Log artifacts if present
      if (responseData.artifacts && responseData.artifacts.length > 0) {
        log.info('app', '[ConversationCapture] Captured artifacts for', {
          v0: responseData.artifacts.length,
          v1: conversationKey,
        });
        log.info('app', 'ConversationCapture artifact details', { artifacts: responseData.artifacts });
        conversation.hasArtifacts = true;
      }

      log.info('app', '[ConversationCapture] Captured response for , exchanges:', {
        v0: conversationKey,
        v1: conversation.exchangeCount,
      });

      // Save conversation after each exchange
      await this._saveConversation(conversationKey, conversation);
    } catch (error) {
      log.error('app', '[ConversationCapture] Error in captureResponse:', { arg0: error });
    }
  }

  /**
   * Capture media (images/files)
   */
  captureMedia(serviceId, files, externalConversationId = null) {
    const conversationKey = externalConversationId ? `${serviceId}:${externalConversationId}` : serviceId;

    const conversation = this.activeConversations.get(conversationKey);
    if (!conversation) {
      return;
    }

    if (!conversation.media) {
      conversation.media = [];
    }

    conversation.media.push(...files);
    conversation.hasImages = conversation.hasImages || files.some((f) => f.type?.includes('image'));
    conversation.hasFiles = conversation.hasFiles || files.some((f) => !f.type?.includes('image'));

    log.info('app', '[ConversationCapture] Captured media files for', { v0: files.length, v1: conversationKey });
  }

  /**
   * Capture a downloaded file as an artifact (Word docs, PDFs, etc.)
   * @param {string} serviceId - AI service (e.g., 'Claude')
   * @param {Object} fileInfo - Download information
   */
  async captureDownloadedArtifact(serviceId, fileInfo) {
    log.info('app', '[ConversationCapture] captureDownloadedArtifact called for :', {
      v0: serviceId,
      arg0: fileInfo.filename,
    });

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
      log.warn('app', '[ConversationCapture] No active conversation for downloaded artifact');
      return;
    }

    log.info('app', '[ConversationCapture] Found conversation:', { v0: conversationKey });

    // Read file content as base64
    const fs = require('fs');
    const fileContent = fs.readFileSync(fileInfo.path);
    const base64Content = fileContent.toString('base64');

    log.info('app', '[ConversationCapture] Read file: bytes', { v0: fileInfo.size });

    // Create artifact in compatible format
    const artifact = {
      type: 'downloaded_file', // New type
      name: 'downloaded_file',
      id: `download-${Date.now()}`,
      input: {
        filename: fileInfo.filename,
        file_data: base64Content, // Base64 encoded
        size: fileInfo.size,
        mimeType: fileInfo.mimeType,
        description: `Downloaded file: ${fileInfo.filename}`,
      },
      source: 'download',
    };

    // Add to last message's artifacts
    if (conversation.messages.length > 0) {
      const lastMessage = conversation.messages[conversation.messages.length - 1];
      if (!lastMessage.artifacts) {
        lastMessage.artifacts = [];
      }
      lastMessage.artifacts.push(artifact);

      log.info('app', '[ConversationCapture] ✅ Captured downloaded artifact: ( bytes)', {
        v0: fileInfo.filename,
        v1: fileInfo.size,
      });

      // Trigger save
      await this._saveConversation(conversationKey, conversation);
    } else {
      log.warn('app', '[ConversationCapture] No messages in conversation to attach artifact to');
    }

    // DO NOT clean up temp file - the download handler will do that
    // The file is shared between our capture logic and the Space save logic
    log.info('app', '[ConversationCapture] ✅ Artifact captured, file will be cleaned up by download handler');
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
      log.info('app', '[ConversationCapture] Marked conversation as do not save', { v0: serviceId });
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
    log.info('app', '[ConversationCapture] ===== _saveConversation called for =====', { v0: conversationKey });

    // Extract serviceId from conversationKey (format: "ServiceId" or "ServiceId:externalId")
    const serviceId = conversationKey.split(':')[0];

    // Check do not save flag
    if (conversation.doNotSave) {
      log.info('app', '[ConversationCapture] Skipping save for (marked do not save)', { v0: conversationKey });
      return;
    }

    log.info('app', '[ConversationCapture] Getting or creating service space...');
    // Get or create service space
    const spaceId = await this._getOrCreateServiceSpace(serviceId);
    if (!spaceId) {
      log.error('app', '[ConversationCapture] ❌ Failed to get/create space for', { v0: serviceId });
      return;
    }

    log.info('app', '[ConversationCapture] Space ID obtained:', { v0: spaceId });

    try {
      // Format conversation as markdown
      log.info('app', '[ConversationCapture] Formatting conversation as markdown...');
      const markdown = this._formatConversationMarkdown(serviceId, conversation, spaceId);
      log.info('app', '[ConversationCapture] Markdown length', { data: markdown.length });

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
            messageIndex: index,
          })),
          media: conversation.media || [],
        },
      };

      log.info('app', 'ConversationCapture metadata prepared', { metadata });

      // Check if conversation already saved (update mode)
      if (conversation.savedItemId) {
        log.info('app', '[ConversationCapture] Updating existing item', { data: conversation.savedItemId });
        // Update existing item
        try {
          await this.spacesAPI.items.update(spaceId, conversation.savedItemId, {
            content: markdown,
            metadata,
          });
          log.info('app', '[ConversationCapture] ✅ Updated conversation in Space', { v0: conversation.id });
        } catch (updateError) {
          log.error('app', '[ConversationCapture] Failed to update conversation:', { arg0: updateError });
          // If update fails, try creating a new item instead
          conversation.savedItemId = null;
          return await this._saveConversation(conversationKey, conversation);
        }
      } else {
        log.info('app', '[ConversationCapture] Creating NEW item in space');
        // Save as new item with retry logic
        let retries = 3;
        let lastError = null;

        while (retries > 0) {
          try {
            log.info('app', '[ConversationCapture] Attempt /3: Calling spacesAPI.items.add...', { v0: 4 - retries });
            const item = await this.spacesAPI.items.add(spaceId, {
              type: 'text', // Use 'text' type (markdown will be detected by metadata)
              content: markdown,
              metadata,
            });

            log.info('app', '[ConversationCapture] items.add returned:', { arg0: item });

            conversation.savedItemId = item.id;
            log.info('app', '[ConversationCapture] ✅✅✅ Saved new conversation to Space with item ID', {
              v0: conversation.id,
              v1: item.id,
            });

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
                messageIndex: index,
              })),
              media: conversation.media || [],
            };

            // Store JSON data as item metadata for asset type detection
            conversation.savedItemMetadata = jsonData;
            log.info('app', '[ConversationCapture] Structured JSON metadata prepared for asset type detection');

            // Save artifacts as separate items
            const artifactItemIds = await this._saveArtifacts(spaceId, conversation, item.id);
            if (artifactItemIds.length > 0) {
              log.info('app', '[ConversationCapture] Saved artifacts as separate items', {
                v0: artifactItemIds.length,
              });

              // Re-format markdown with artifact links
              const updatedMarkdown = this._formatConversationMarkdown(
                serviceId,
                conversation,
                spaceId,
                artifactItemIds
              );

              // Update conversation item with artifact references
              try {
                await this.spacesAPI.items.update(spaceId, item.id, {
                  content: updatedMarkdown,
                  metadata: {
                    ...metadata,
                    artifactItemIds: artifactItemIds,
                  },
                });
                log.info('app', '[ConversationCapture] Updated conversation with artifact references');
              } catch (updateError) {
                log.warn('app', '[ConversationCapture] Failed to update conversation with artifact refs', {
                  data: updateError,
                });
              }
            }

            // Save media files
            if (conversation.media && conversation.media.length > 0) {
              log.info('app', '[ConversationCapture] Saving media files...');
              await this._saveMediaFiles(spaceId, conversation);
            }

            // Show undo toast
            log.info('app', '[ConversationCapture] Showing undo toast...');
            this._showUndoToast(item.id, serviceId);

            // Register as Space asset
            try {
              await this.spacesAPI.metadata.setAsset(spaceId, 'chatbot-conversation', {
                conversationId: conversation.id,
                aiService: serviceId,
                model: conversation.model,
                messageCount: conversation.messages.length,
                attachmentCount: conversation.media?.length || 0,
                lastUpdated: new Date().toISOString(),
              });
              log.info('app', '[ConversationCapture] Registered as Space asset');
            } catch (assetError) {
              log.warn('app', '[ConversationCapture] Failed to register asset metadata', { data: assetError });
              // Non-critical, continue anyway
            }

            log.info('app', '[ConversationCapture] ===== SAVE COMPLETE =====');
            return; // Success!
          } catch (error) {
            lastError = error;
            retries--;

            log.error('app', '[ConversationCapture] ❌ Save attempt failed:', { arg0: error });

            if (retries > 0) {
              log.warn('app', '[ConversationCapture] Retrying... ( left)', { v0: retries });
              await new Promise((resolve) => {
                setTimeout(resolve, 1000);
              }); // Wait 1s before retry
            }
          }
        }

        // All retries exhausted
        log.error('app', '[ConversationCapture] ❌❌❌ Failed to save conversation after all retries:', {
          arg0: lastError,
        });
      }
    } catch (error) {
      log.error('app', '[ConversationCapture] ❌ Error in _saveConversation:', { arg0: error });
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
        type: 'code_block', // Different from Claude's 'tool_use'
        name: 'code_block',
        id: `chatgpt-code-${Date.now()}-${blockIndex}`,
        language: language,
        input: {
          language: language,
          file_text: code, // Use same field as Claude for consistency
          description: `Code block ${blockIndex + 1}${isExample ? ' (example)' : ''}`,
          path: null, // ChatGPT doesn't provide paths
        },
        // Add flag to help _saveArtifacts know this is from ChatGPT
        source: 'chatgpt',
        isExample: isExample,
      });

      blockIndex++;
    }

    log.info('app', '[ConversationCapture] Extracted code blocks from message', { v0: artifacts.length });
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

    log.info('app', '[ConversationCapture] Saving artifacts as separate items...', { v0: artifacts.length });

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
          log.info('app', '[ConversationCapture] Skipping unsupported artifact type:', { v0: artifact.type });
          continue;
        }

        if (!artifact.input) {
          continue;
        }

        let artifactContent,
          isBinaryFile = false,
          fileName;

        if (isDownloadedFile) {
          // Binary file - use base64
          artifactContent = artifact.input.file_data;
          isBinaryFile = true;
          fileName = artifact.input.filename;

          if (!artifactContent) {
            log.info('app', '[ConversationCapture] Skipping downloaded file (no data):', { v0: fileName });
            continue;
          }

          log.info('app', '[ConversationCapture] Processing downloaded file: ( bytes)', {
            v0: fileName,
            v1: artifact.input.size,
          });
        } else {
          // Text-based artifact (code, SVG, etc.)
          artifactContent = artifact.input.file_text || artifact.input.content || artifact.input.code;
          if (!artifactContent) {
            log.info('app', '[ConversationCapture] Skipping artifact (no content)', { v0: artifact.name });
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

          log.info('app', '[ConversationCapture] Downloaded file type: , category:', {
            v0: fileExtension,
            v1: fileCategory,
          });
        }
        // Check for SVG content (text-based)
        else if (artifact.name === 'create_file' || (artifactContent && artifactContent.trim().startsWith('<svg'))) {
          fileExtension = 'svg';
          itemType = 'file';
          fileType = 'image-file'; // Mark as image file
          fileCategory = 'media'; // Media category
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
          tags: ['ai-artifact', conversation.aiService?.toLowerCase() || 'chatgpt', artifact.name],
        };

        // Add isExample flag for ChatGPT code blocks if it's marked as example
        if (isChatGPTCodeBlock && artifact.isExample) {
          artifactMetadata.isExample = true;
          artifactMetadata.tags.push('example');
        }

        log.info('app', '[ConversationCapture] Saving artifact:', { v0: fileName });

        // Save artifact as separate item
        // For binary files, use fileData; for text, use content
        const itemData = {
          type: itemType,
          fileName: fileName,
          fileType: fileType, // Add file type
          fileCategory: fileCategory, // Add file category
          fileExt: `.${fileExtension}`, // Add file extension (with dot prefix)
          metadata: artifactMetadata,
        };

        if (isBinaryFile) {
          itemData.fileData = artifactContent; // Base64 for binary files
          itemData.fileSize = artifact.input.size;
          log.info('app', '[ConversationCapture] Saving binary file: ( bytes)', {
            v0: fileName,
            v1: artifact.input.size,
          });
        } else {
          itemData.content = artifactContent; // Text content
        }

        const artifactItem = await this.spacesAPI.items.add(spaceId, itemData);

        artifactItemIds.push(artifactItem.id);
        log.info('app', '[ConversationCapture] ✅ Saved artifact as item', { v0: artifactItem.id });
      } catch (error) {
        log.error('app', '[ConversationCapture] Failed to save artifact :', { v0: artifact.name, arg0: error });
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
          log.warn('app', '[ConversationCapture] Could not extract media data');
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
          source: 'ai-conversation',
        };

        // Save to Space with full metadata
        const savedItem = await this.spacesAPI.items.add(spaceId, {
          type: media.type?.includes('image') ? 'image' : 'file',
          content: fileData,
          metadata: metadata,
        });

        // Store item ID back in media for reference
        media.itemId = savedItem.id;

        log.info('app', '[ConversationCapture] Saved media file: with comprehensive metadata', { v0: fileName });
      } catch (error) {
        log.error('app', '[ConversationCapture] Error saving media file', { error: error });
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

      if (diff < closestDiff && diff < 5000) {
        // Within 5 seconds
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
          const relevantMedia = conversation.media.filter((m) => {
            const mediaTime = new Date(m.timestamp || msg.timestamp).getTime();
            return Math.abs(mediaTime - msgTime) < 5000;
          });

          for (const media of relevantMedia) {
            if (media.type?.includes('image')) {
              const _fileName = media.fileName || 'image.jpg';
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
    log.info('app', '[ConversationCapture] _getOrCreateServiceSpace for', { v0: serviceId });

    // Check cache
    if (this.serviceSpaces.has(serviceId)) {
      const cachedId = this.serviceSpaces.get(serviceId);
      log.info('app', 'Found in cache:', { v0: cachedId });
      return cachedId;
    }

    const config = AI_SERVICE_CONFIG[serviceId];
    if (!config) {
      log.error('app', '[ConversationCapture] ❌ Unknown service:', { v0: serviceId });
      return null;
    }

    log.info('app', 'Config found', { config });

    try {
      // Check if space already exists
      log.info('app', 'Fetching existing spaces...');
      const spaces = await this.spacesAPI.list();
      log.info('app', 'Total spaces found:', { v0: spaces.length });

      const existingSpace = spaces.find((s) => s.name === config.spaceName);

      if (existingSpace) {
        log.info('app', 'Found existing space:', { v0: existingSpace.id });
        this.serviceSpaces.set(serviceId, existingSpace.id);
        return existingSpace.id;
      }

      // Create new space
      log.info('app', 'Creating NEW space:', { v0: config.spaceName });
      const newSpace = await this.spacesAPI.create(config.spaceName, {
        icon: config.icon,
        color: config.color,
      });

      log.info('app', 'Space created', { newSpace });

      this.serviceSpaces.set(serviceId, newSpace.id);
      log.info('app', '[ConversationCapture] ✅ Created Space: with ID', { v0: config.spaceName, v1: newSpace.id });

      return newSpace.id;
    } catch (error) {
      log.error('app', '[ConversationCapture] ❌ Error creating space for :', { v0: serviceId, arg0: error });
      return null;
    }
  }

  /**
   * Copy conversation to another Space
   */
  async copyConversationToSpace(conversationId, targetSpaceId) {
    // Implementation for manual space assignment
    log.info('app', '[ConversationCapture] Copying conversation to Space', { v0: conversationId, v1: targetSpaceId });
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
      const mediaItems = items.filter((item) => item.metadata?.linkedToConversation === conversationId);

      log.info('app', '[ConversationCapture] Found media items for conversation', {
        v0: mediaItems.length,
        v1: conversationId,
      });
      return mediaItems;
    } catch (error) {
      log.error('app', '[ConversationCapture] Error getting conversation media', { error: error });
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
        message: `Conversation saved to ${AI_SERVICE_CONFIG[serviceId]?.spaceName || serviceId}`,
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

      log.info('app', '[ConversationCapture] Undid save for item', { v0: itemId });
      return { success: true };
    } catch (error) {
      log.error('app', '[ConversationCapture] Error undoing save', { error: error });
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if conversation should be captured
   */
  _shouldCapture(serviceId) {
    log.info('app', '[ConversationCapture] _shouldCapture check for :', { v0: serviceId });

    // Check if enabled
    const enabled = this.isEnabled();
    log.info('app', '- isEnabled():', { v0: enabled });
    if (!enabled) {
      log.info('app', 'BLOCKED: Not enabled');
      return false;
    }

    // Check if paused
    log.info('app', '- paused:', { v0: this.paused });
    if (this.paused) {
      log.info('app', 'BLOCKED: Paused');
      return false;
    }

    // Check if conversation marked do not save
    const conversation = this.activeConversations.get(serviceId);
    const doNotSave = conversation?.doNotSave || false;
    log.info('app', '- doNotSave flag:', { v0: doNotSave });
    if (doNotSave) {
      log.info('app', 'BLOCKED: Marked do not save');
      return false;
    }

    log.info('app', 'ALLOWED: All checks passed');
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
      savedItemId: null,
    };
  }

  /**
   * Extract prompt text from request data
   */
  _extractPromptText(requestData) {
    log.info('app', 'ConversationCapture _extractPromptText called', { keys: Object.keys(requestData || {}) });
    log.info('app', '[ConversationCapture] message type', { data: typeof requestData.message });
    log.info('app', 'ConversationCapture message value', {
      messagePreview: JSON.stringify(requestData.message)?.substring(0, 200),
    });

    if (typeof requestData.message === 'string') {
      log.info('app', 'ConversationCapture found string message', {
        messagePreview: requestData.message.substring(0, 100),
      });
      return requestData.message;
    }

    if (Array.isArray(requestData.message)) {
      log.info('app', '[ConversationCapture] Found message array with', {
        arg0: requestData.message.length,
        arg1: 'messages',
      });

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
          const text = msg.content.parts.filter((part) => typeof part === 'string').join('\n');
          if (text) {
            log.info('app', 'ConversationCapture extracted from content.parts', {
              textPreview: text.substring(0, 100),
            });
            return text;
          }
        }

        // Handle content as string
        if (typeof msg.content === 'string') {
          log.info('app', 'ConversationCapture extracted from content string', {
            textPreview: msg.content.substring(0, 100),
          });
          return msg.content;
        }

        // Handle content blocks (Anthropic format)
        if (Array.isArray(msg.content)) {
          const textBlocks = msg.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text || '')
            .join('\n');
          if (textBlocks) {
            log.info('app', 'ConversationCapture extracted from content blocks', {
              textPreview: textBlocks.substring(0, 100),
            });
            return textBlocks;
          }
        }

        // Fallback to text field
        if (msg.text) {
          log.info('app', 'ConversationCapture extracted from text field', { textPreview: msg.text.substring(0, 100) });
          return msg.text;
        }
      }

      log.info('app', '[ConversationCapture] No user message found in array');
      return '';
    }

    if (requestData.prompt) {
      log.info('app', '[ConversationCapture] Found prompt field');
      return requestData.prompt;
    }

    // Grok format: may have different field names
    // Check for common Grok field names
    if (requestData.query) {
      log.info('app', '[ConversationCapture] Found query field (Grok)');
      return requestData.query;
    }

    if (requestData.input) {
      log.info('app', '[ConversationCapture] Found input field');
      return requestData.input;
    }

    if (requestData.text) {
      log.info('app', '[ConversationCapture] Found text field');
      return requestData.text;
    }

    if (requestData.content) {
      log.info('app', '[ConversationCapture] Found content field');
      return typeof requestData.content === 'string' ? requestData.content : JSON.stringify(requestData.content);
    }

    // Grok specific: messages array with different structure
    if (requestData.messages && Array.isArray(requestData.messages)) {
      log.info('app', '[ConversationCapture] Found messages array with', {
        arg0: requestData.messages.length,
        arg1: 'items',
      });
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
    log.info('app', 'ConversationCapture unknown format', { keys: Object.keys(requestData) });
    log.info('app', '[ConversationCapture] No message found, returning empty');
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
        log.info('app', '[ConversationCapture] Conversation timeout for , finalizing...', { v0: serviceId });
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

        log.info('app', '[ConversationCapture] State loaded from disk');
      }
    } catch (error) {
      log.error('app', '[ConversationCapture] Error loading state', { error: error });
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
        lastSaved: new Date().toISOString(),
      };
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
    } catch (error) {
      log.error('app', '[ConversationCapture] Error saving state', { error: error });
    }
  }
}

// Singleton instance
let instance = null;

function getConversationCapture(spacesAPI, settingsManager) {
  log.info('app', '[ConversationCapture] getConversationCapture called, instance exists', { data: !!instance });
  if (!instance) {
    log.info('app', '[ConversationCapture] Creating NEW instance...');
    instance = new ConversationCapture(spacesAPI, settingsManager);
    log.info('app', '[ConversationCapture] Instance created successfully');

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
  AI_SERVICE_CONFIG,
};
