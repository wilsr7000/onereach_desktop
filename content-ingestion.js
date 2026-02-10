/**
 * Content Ingestion Service
 * 
 * Unified layer for adding items to spaces from any entry point:
 * - Black Hole widget (drag-drop, paste)
 * - Clipboard Viewer (right-click paste)
 * - Smart Export
 * - GSX Create
 * 
 * Provides consistent validation, error handling, and retry logic.
 */

const fs = require('fs');
const path = require('path');

// Valid content types
const VALID_TYPES = ['text', 'html', 'image', 'file', 'code', 'url', 'web-monitor', 'data-source'];

// Max retry attempts for transient failures
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 200; // ms, will be multiplied by attempt number

/**
 * Validation error with specific error code
 */
class ValidationError extends Error {
  constructor(message, code, field) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Content Ingestion Service
 * 
 * Singleton service that handles all content additions to spaces.
 */
class ContentIngestionService {
  constructor(clipboardManager) {
    this.clipboardManager = clipboardManager;
    this._operationId = 0;
  }

  /**
   * Generate unique operation ID for tracing
   */
  _getOperationId() {
    return `op-${Date.now()}-${++this._operationId}`;
  }

  /**
   * Log operation with consistent format
   */
  _log(opId, level, message, data = {}) {
    const prefix = `[ContentIngestion:${opId}]`;
    const logData = { ...data, timestamp: new Date().toISOString() };
    
    switch (level) {
      case 'error':
        console.error(prefix, message, logData);
        break;
      case 'warn':
        console.warn(prefix, message, logData);
        break;
      default:
        console.log(prefix, message, logData);
    }
  }

  /**
   * Validate that a space exists
   * @param {string} spaceId - The space ID to validate
   * @returns {boolean} - True if space exists
   */
  validateSpaceExists(spaceId) {
    if (!spaceId) {
      return true; // Will default to 'unclassified'
    }
    
    if (spaceId === 'unclassified') {
      return true;
    }

    // Check if space exists in the storage
    if (this.clipboardManager && this.clipboardManager.storage) {
      const spaces = this.clipboardManager.storage.index?.spaces || [];
      return spaces.some(s => s.id === spaceId);
    }
    
    // If we can't verify, allow it (fail open)
    return true;
  }

  /**
   * Validate content based on type
   * @param {string} type - Content type
   * @param {object} data - Content data
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateContent(type, data) {
    const errors = [];

    // Check type is valid
    if (!VALID_TYPES.includes(type)) {
      errors.push(`Invalid content type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    // Check data exists
    if (!data) {
      errors.push('Content data is required');
      return { valid: false, errors };
    }

    // Type-specific validation
    switch (type) {
      case 'text':
        if (!data.content && data.content !== '') {
          errors.push('Text content is required');
        } else if (typeof data.content !== 'string') {
          errors.push('Text content must be a string');
        } else if (data.content.trim().length === 0) {
          errors.push('Text content cannot be empty');
        }
        break;

      case 'html':
        if (!data.content && !data.html) {
          errors.push('HTML content is required');
        }
        break;

      case 'image':
        if (!data.dataUrl && !data.content) {
          errors.push('Image data is required (dataUrl or content)');
        } else {
          const imageData = data.dataUrl || data.content;
          if (typeof imageData !== 'string') {
            errors.push('Image data must be a string');
          } else if (!imageData.startsWith('data:image/') && !this._isValidBase64(imageData)) {
            errors.push('Image data must be a valid data URL or base64 string');
          }
        }
        break;

      case 'file':
        // File can come from two sources:
        // 1. File path (copying existing file)
        // 2. File data (drag-drop from browser)
        if (!data.filePath && !data.fileData) {
          errors.push('File path or file data is required');
        }
        if (data.fileData && !data.fileName) {
          errors.push('File name is required when providing file data');
        }
        if (data.filePath && typeof data.filePath === 'string') {
          // Validate file exists if path is provided
          if (!fs.existsSync(data.filePath)) {
            errors.push(`File not found: ${data.filePath}`);
          }
        }
        break;

      case 'code':
        if (!data.content) {
          errors.push('Code content is required');
        }
        break;
    }

    // Validate spaceId if provided
    if (data.spaceId && !this.validateSpaceExists(data.spaceId)) {
      errors.push(`Space not found: ${data.spaceId}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Check if string is valid base64
   */
  _isValidBase64(str) {
    if (!str || typeof str !== 'string') return false;
    try {
      // Try to decode - if it fails, not valid base64
      const decoded = Buffer.from(str, 'base64').toString('base64');
      return decoded === str || str.length > 100; // Allow for whitespace differences
    } catch {
      return false;
    }
  }

  /**
   * Normalize input data to consistent format
   * @param {string} type - Content type
   * @param {object} data - Raw input data
   * @returns {object} - Normalized data
   */
  normalizeInput(type, data) {
    const normalized = { ...data };

    // Ensure spaceId defaults to 'unclassified'
    if (!normalized.spaceId) {
      normalized.spaceId = 'unclassified';
    }

    // Ensure timestamp
    if (!normalized.timestamp) {
      normalized.timestamp = Date.now();
    }

    switch (type) {
      case 'text':
        // Trim whitespace
        if (normalized.content) {
          normalized.content = normalized.content.trim();
        }
        break;

      case 'html':
        // Ensure both content and html fields are set
        if (normalized.html && !normalized.content) {
          normalized.content = normalized.html;
        } else if (normalized.content && !normalized.html) {
          normalized.html = normalized.content;
        }
        break;

      case 'image':
        // Normalize image data field name
        if (normalized.dataUrl && !normalized.content) {
          normalized.content = normalized.dataUrl;
        }
        break;

      case 'file':
        // Extract filename from path if not provided
        if (normalized.filePath && !normalized.fileName) {
          normalized.fileName = path.basename(normalized.filePath);
        }
        // Ensure fileSize is set
        if (normalized.filePath && !normalized.fileSize) {
          try {
            const stats = fs.statSync(normalized.filePath);
            normalized.fileSize = stats.size;
          } catch (e) {
            // Ignore - fileSize is optional
          }
        }
        break;
    }

    return normalized;
  }

  /**
   * Add item with validation and retry logic
   * @param {string} type - Content type: text, html, image, file, code
   * @param {object} data - Content data
   * @param {object} options - Additional options
   * @returns {Promise<{ success: boolean, itemId?: string, error?: string }>}
   */
  async addItem(type, data, options = {}) {
    const opId = this._getOperationId();
    this._log(opId, 'info', `Adding ${type} item`, { 
      spaceId: data?.spaceId,
      hasContent: !!data?.content,
      hasFileData: !!data?.fileData,
      fileName: data?.fileName
    });

    try {
      // Step 1: Validate
      const validation = this.validateContent(type, data);
      if (!validation.valid) {
        this._log(opId, 'error', 'Validation failed', { errors: validation.errors });
        return {
          success: false,
          error: validation.errors.join('; '),
          code: 'VALIDATION_ERROR'
        };
      }

      // Step 2: Normalize
      const normalizedData = this.normalizeInput(type, data);
      this._log(opId, 'info', 'Data normalized', { 
        spaceId: normalizedData.spaceId,
        type 
      });

      // Step 3: Add with retry
      const result = await this._addWithRetry(opId, type, normalizedData, options);
      
      if (result.success) {
        this._log(opId, 'info', 'Item added successfully', { itemId: result.itemId });
      } else {
        this._log(opId, 'error', 'Failed to add item', { error: result.error });
      }

      return result;

    } catch (error) {
      this._log(opId, 'error', 'Unexpected error', { 
        error: error.message,
        stack: error.stack 
      });
      return this.handleError(error, { opId, type, spaceId: data?.spaceId });
    }
  }

  /**
   * Add item with retry logic for transient failures
   */
  async _addWithRetry(opId, type, data, options) {
    let lastError = null;
    const maxRetries = options.maxRetries || MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._doAdd(type, data, options);
        return result;
      } catch (error) {
        lastError = error;
        
        // Check if error is retryable
        if (!this._isRetryableError(error)) {
          this._log(opId, 'warn', 'Non-retryable error, giving up', { 
            error: error.message,
            attempt 
          });
          break;
        }

        if (attempt < maxRetries) {
          const delay = RETRY_DELAY_BASE * attempt;
          this._log(opId, 'warn', `Attempt ${attempt} failed, retrying in ${delay}ms`, { 
            error: error.message 
          });
          await this._sleep(delay);
        }
      }
    }

    return this.handleError(lastError, { opId, type, spaceId: data?.spaceId });
  }

  /**
   * Check if an error is retryable
   */
  _isRetryableError(error) {
    if (!error) return false;
    
    const message = error.message?.toLowerCase() || '';
    
    // Retryable conditions
    return (
      message.includes('ebusy') ||      // File busy
      message.includes('enoent') ||     // File not found (might be timing)
      message.includes('eagain') ||     // Resource temporarily unavailable
      message.includes('timeout') ||    // Timeout
      message.includes('lock') ||       // Lock contention
      error.code === 'EBUSY' ||
      error.code === 'EAGAIN'
    );
  }

  /**
   * Sleep helper
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Actually perform the add operation
   * Uses asset pipeline if available for full lifecycle processing
   */
  async _doAdd(type, data, options) {
    if (!this.clipboardManager) {
      throw new Error('Clipboard manager not initialized');
    }

    // Try to use asset pipeline for full lifecycle processing
    if (options.usePipeline !== false) {
      try {
        const { getAssetPipeline } = require('./asset-pipeline');
        const pipeline = getAssetPipeline();
        
        if (pipeline && pipeline.clipboardManager) {
          const pipelineInput = {
            type,
            content: data.content,
            dataUrl: data.dataUrl,
            html: data.html,
            filePath: data.filePath,
            fileData: data.fileData,
            fileName: data.fileName,
            fileSize: data.fileSize,
            mimeType: data.mimeType,
            spaceId: data.spaceId,
            source: data.source || 'content-ingestion'
          };
          
          const result = await pipeline.process(pipelineInput, options);
          
          if (result.success) {
            return {
              success: true,
              itemId: result.itemId,
              checksum: result.checksum,
              pipeline: true
            };
          }
          // If pipeline fails, fall through to direct add
          console.log('[ContentIngestion] Pipeline failed, falling back to direct add');
        }
      } catch (error) {
        // Pipeline not available, use direct add
        console.log('[ContentIngestion] Pipeline not available:', error.message);
      }
    }

    // Direct add (fallback or when pipeline not used)
    const item = {
      type,
      spaceId: data.spaceId,
      timestamp: data.timestamp || Date.now(),
      source: data.source || 'content-ingestion',
      ...this._buildTypeSpecificFields(type, data)
    };

    // Add metadata if provided
    if (data.metadata) {
      item.metadata = data.metadata;
    }

    // Add context if provided (for app context capture)
    if (options.context) {
      item.metadata = {
        ...item.metadata,
        context: options.context
      };
    }

    // Use the clipboard manager's addToHistory method
    this.clipboardManager.addToHistory(item);

    // Get the item ID from the most recent history entry
    const history = this.clipboardManager.history || [];
    const addedItem = history[0];

    return {
      success: true,
      itemId: addedItem?.id || 'unknown'
    };
  }

  /**
   * Build type-specific fields for the item
   */
  _buildTypeSpecificFields(type, data) {
    switch (type) {
      case 'text':
        return {
          content: data.content,
          text: data.content,
          plainText: data.content,
          preview: data.content.substring(0, 200)
        };

      case 'html':
        return {
          content: data.content || data.html,
          html: data.html || data.content,
          plainText: data.plainText || '',
          preview: data.plainText?.substring(0, 200) || 'HTML Content'
        };

      case 'image':
        return {
          content: data.content || data.dataUrl,
          dataUrl: data.dataUrl || data.content,
          preview: 'Image',
          thumbnail: data.thumbnail
        };

      case 'file':
        return {
          content: data.fileData || '',
          filePath: data.filePath,
          fileName: data.fileName,
          fileSize: data.fileSize,
          fileType: data.fileType || data.mimeType,
          mimeType: data.mimeType || data.fileType,
          preview: data.fileName || 'File',
          fileData: data.fileData
        };

      case 'code':
        return {
          content: data.content,
          language: data.language || 'text',
          preview: data.content.substring(0, 200)
        };

      default:
        return {
          content: data.content,
          preview: String(data.content || '').substring(0, 200)
        };
    }
  }

  /**
   * Handle errors consistently
   * @param {Error} error - The error
   * @param {object} context - Error context
   * @returns {{ success: false, error: string, code?: string }}
   */
  handleError(error, context = {}) {
    const { opId, type, spaceId } = context;

    // Log full error details
    console.error(`[ContentIngestion:${opId || 'unknown'}] Error:`, {
      message: error?.message,
      code: error?.code,
      type,
      spaceId,
      stack: error?.stack
    });

    // Return user-friendly error
    let userMessage = 'Failed to save item';
    let errorCode = 'UNKNOWN_ERROR';

    if (error instanceof ValidationError) {
      userMessage = error.message;
      errorCode = error.code || 'VALIDATION_ERROR';
    } else if (error?.message) {
      // Map common errors to user-friendly messages
      const msg = error.message.toLowerCase();
      
      if (msg.includes('disk') || msg.includes('enospc')) {
        userMessage = 'Disk is full. Please free up space and try again.';
        errorCode = 'DISK_FULL';
      } else if (msg.includes('permission') || msg.includes('eacces')) {
        userMessage = 'Permission denied. Check file permissions.';
        errorCode = 'PERMISSION_DENIED';
      } else if (msg.includes('not found') || msg.includes('enoent')) {
        userMessage = 'File or folder not found.';
        errorCode = 'NOT_FOUND';
      } else if (msg.includes('not initialized')) {
        userMessage = 'System not ready. Please try again.';
        errorCode = 'NOT_INITIALIZED';
      } else {
        userMessage = `Error: ${error.message}`;
        errorCode = 'OPERATION_FAILED';
      }
    }

    return {
      success: false,
      error: userMessage,
      code: errorCode,
      details: error?.message
    };
  }

  /**
   * Convenience methods for specific content types
   */
  async addText(content, spaceId, options = {}) {
    return this.addItem('text', { content, spaceId }, options);
  }

  async addHtml(html, spaceId, options = {}) {
    return this.addItem('html', { content: html, html, spaceId, ...options });
  }

  async addImage(dataUrl, spaceId, options = {}) {
    return this.addItem('image', { dataUrl, spaceId }, options);
  }

  async addFile(data, spaceId, options = {}) {
    return this.addItem('file', { ...data, spaceId }, options);
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the ContentIngestionService singleton
 * @param {object} clipboardManager - The clipboard manager instance
 * @returns {ContentIngestionService}
 */
function getContentIngestionService(clipboardManager) {
  if (!instance && clipboardManager) {
    instance = new ContentIngestionService(clipboardManager);
  } else if (clipboardManager && instance.clipboardManager !== clipboardManager) {
    // Update clipboard manager if a new one is provided
    instance.clipboardManager = clipboardManager;
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
function resetContentIngestionService() {
  instance = null;
}

/**
 * Utility: Retry an async operation with exponential backoff
 * Use this for file operations that may have transient failures
 * 
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Options
 * @param {number} options.maxRetries - Max attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 200)
 * @param {Function} options.shouldRetry - Function to check if error is retryable
 * @returns {Promise<any>} - Result of the operation
 */
async function retryOperation(operation, options = {}) {
  const maxRetries = options.maxRetries || MAX_RETRIES;
  const baseDelay = options.baseDelay || RETRY_DELAY_BASE;
  const shouldRetry = options.shouldRetry || ((error) => {
    if (!error) return false;
    const msg = error.message?.toLowerCase() || '';
    return (
      msg.includes('ebusy') ||
      msg.includes('enoent') ||
      msg.includes('eagain') ||
      msg.includes('timeout') ||
      msg.includes('lock') ||
      error.code === 'EBUSY' ||
      error.code === 'EAGAIN'
    );
  });

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (!shouldRetry(error) || attempt >= maxRetries) {
        throw error;
      }

      const delay = baseDelay * attempt;
      console.log(`[ContentIngestion] Attempt ${attempt} failed, retrying in ${delay}ms:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = {
  ContentIngestionService,
  getContentIngestionService,
  resetContentIngestionService,
  retryOperation,
  ValidationError,
  VALID_TYPES
};

