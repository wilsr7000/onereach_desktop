/**
 * Asset Pipeline Service
 * 
 * Central orchestrator for the full asset lifecycle with verification at each stage:
 * 1. Validation - Content type detection, size limits, format validation
 * 2. Asset Identification - Detect file type, MIME, determine processing path
 * 3. Checksum - Calculate content hash before storage
 * 4. Storage - Atomic write to disk
 * 5. Thumbnail Generation - Type-specific thumbnails
 * 6. Metadata Generation - AI title, description, tags
 * 7. Verification - Confirm file exists, readable
 * 8. Final Checksum - Store verification hash
 * 
 * Each stage emits events to the dashboard for monitoring.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// Stage definitions
const STAGES = {
  VALIDATION: 'validation',
  IDENTIFICATION: 'identification',
  CHECKSUM: 'checksum',
  STORAGE: 'storage',
  THUMBNAIL: 'thumbnail',
  METADATA: 'metadata',
  VERIFY: 'verify',
  FINAL_CHECKSUM: 'finalChecksum'
};

// Content type categories
const CONTENT_TYPES = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  CODE: 'code',
  DATA: 'data',
  TEXT: 'text',
  HTML: 'html',
  URL: 'url',
  FILE: 'file'
};

// File size limits (in bytes)
const SIZE_LIMITS = {
  image: 100 * 1024 * 1024,    // 100MB
  video: 10 * 1024 * 1024 * 1024, // 10GB
  audio: 500 * 1024 * 1024,   // 500MB
  document: 100 * 1024 * 1024, // 100MB
  code: 50 * 1024 * 1024,      // 50MB
  data: 100 * 1024 * 1024,     // 100MB
  text: 10 * 1024 * 1024,      // 10MB
  html: 50 * 1024 * 1024,      // 50MB
  file: 1024 * 1024 * 1024     // 1GB default
};

class AssetPipeline {
  constructor(dependencies = {}) {
    this.clipboardManager = dependencies.clipboardManager;
    this.thumbnailPipeline = dependencies.thumbnailPipeline;
    this.metadataGenerator = dependencies.metadataGenerator;
    this.verifier = dependencies.verifier;
    this.dashboardAPI = dependencies.dashboardAPI;
    
    this._operationCounter = 0;
    this._activeOperations = new Map();
  }

  /**
   * Generate unique operation ID
   */
  _generateOperationId() {
    return `pipe-${Date.now()}-${++this._operationCounter}`;
  }

  /**
   * Emit stage event to dashboard
   */
  _emitStageEvent(operationId, stage, success, details = {}) {
    const event = {
      operationId,
      stage,
      success,
      timestamp: Date.now(),
      ...details
    };
    
    console.log(`[Pipeline:${operationId}] Stage ${stage}: ${success ? 'SUCCESS' : 'FAILED'}`, details);
    
    // Update dashboard if available
    if (this.dashboardAPI) {
      this.dashboardAPI.recordPipelineStage(stage, success, operationId, details);
    }
    
    return event;
  }

  /**
   * Process an asset through the full pipeline
   * 
   * @param {Object} input - Input data
   * @param {string} input.type - Content type (text, image, file, etc.)
   * @param {*} input.content - The actual content
   * @param {string} input.spaceId - Target space ID
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} - Pipeline result
   */
  async process(input, options = {}) {
    const operationId = this._generateOperationId();
    const startTime = Date.now();
    
    console.log(`[Pipeline:${operationId}] Starting pipeline for ${input.type}`);
    
    const result = {
      operationId,
      success: false,
      stages: {},
      itemId: null,
      checksum: null,
      errors: []
    };
    
    this._activeOperations.set(operationId, result);
    
    try {
      // Stage 1: Validation
      const validationResult = await this._stageValidation(operationId, input, options);
      result.stages.validation = validationResult;
      if (!validationResult.success) {
        result.errors.push(validationResult.error);
        return this._finalizeResult(result, startTime);
      }
      
      // Stage 2: Identification
      const identificationResult = await this._stageIdentification(operationId, input, validationResult.data);
      result.stages.identification = identificationResult;
      if (!identificationResult.success) {
        result.errors.push(identificationResult.error);
        return this._finalizeResult(result, startTime);
      }
      
      // Stage 3: Checksum (pre-storage)
      const checksumResult = await this._stageChecksum(operationId, input, identificationResult.data);
      result.stages.checksum = checksumResult;
      result.checksum = checksumResult.data?.checksum;
      
      // Stage 4: Storage
      const storageResult = await this._stageStorage(operationId, input, identificationResult.data, options);
      result.stages.storage = storageResult;
      if (!storageResult.success) {
        result.errors.push(storageResult.error);
        return this._finalizeResult(result, startTime);
      }
      result.itemId = storageResult.data?.itemId;
      
      // Stage 5: Thumbnail (non-blocking for some types)
      const thumbnailResult = await this._stageThumbnail(operationId, input, storageResult.data, options);
      result.stages.thumbnail = thumbnailResult;
      
      // Stage 6: Metadata (async, can continue without)
      const metadataResult = await this._stageMetadata(operationId, input, storageResult.data, options);
      result.stages.metadata = metadataResult;
      
      // Stage 7: Verification
      const verifyResult = await this._stageVerification(operationId, storageResult.data);
      result.stages.verify = verifyResult;
      if (!verifyResult.success) {
        result.errors.push(verifyResult.error);
        // Don't fail the whole pipeline for verification issues - they can be auto-fixed
      }
      
      // Stage 8: Final Checksum
      const finalChecksumResult = await this._stageFinalChecksum(operationId, storageResult.data, checksumResult.data?.checksum);
      result.stages.finalChecksum = finalChecksumResult;
      
      // Mark success if storage completed
      result.success = storageResult.success;
      
      return this._finalizeResult(result, startTime);
      
    } catch (error) {
      console.error(`[Pipeline:${operationId}] Fatal error:`, error);
      result.errors.push(error.message);
      return this._finalizeResult(result, startTime);
    } finally {
      this._activeOperations.delete(operationId);
    }
  }

  /**
   * Finalize result with timing
   */
  _finalizeResult(result, startTime) {
    result.duration = Date.now() - startTime;
    result.completedAt = new Date().toISOString();
    
    // Notify dashboard of completion
    if (this.dashboardAPI) {
      if (result.success) {
        this.dashboardAPI.recordItemAdded(
          result.stages.identification?.data?.contentType || 'unknown',
          result.stages.storage?.data?.spaceId,
          { operationId: result.operationId }
        );
      } else if (result.errors.length > 0) {
        this.dashboardAPI.recordError(
          'pipeline',
          result.errors[0],
          { operationId: result.operationId, allErrors: result.errors }
        );
      }
    }
    
    return result;
  }

  // ==================== STAGE 1: VALIDATION ====================
  
  async _stageValidation(operationId, input, options) {
    const errors = [];
    
    try {
      // Check required fields
      if (!input.type) {
        errors.push('Content type is required');
      }
      
      // Check content exists
      if (input.type === 'file') {
        if (!input.filePath && !input.fileData && !input.content) {
          errors.push('File path, file data, or content is required');
        }
        if (input.filePath && !fs.existsSync(input.filePath)) {
          errors.push(`File not found: ${input.filePath}`);
        }
      } else if (!input.content && !input.dataUrl && !input.html) {
        errors.push('Content is required');
      }
      
      // Check size limits
      const size = this._getContentSize(input);
      const typeLimit = SIZE_LIMITS[input.type] || SIZE_LIMITS.file;
      if (size > typeLimit) {
        errors.push(`Content exceeds size limit: ${this._formatBytes(size)} > ${this._formatBytes(typeLimit)}`);
      }
      
      const success = errors.length === 0;
      this._emitStageEvent(operationId, STAGES.VALIDATION, success, { errors, size });
      
      return {
        success,
        error: errors[0],
        data: { validated: success, size, errors }
      };
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.VALIDATION, false, { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ==================== STAGE 2: IDENTIFICATION ====================
  
  async _stageIdentification(operationId, input, validationData) {
    try {
      let contentType = input.type;
      let mimeType = input.mimeType;
      let fileExtension = input.fileExt;
      let fileCategory = null;
      
      // Detect from file if available
      if (input.filePath) {
        fileExtension = path.extname(input.filePath).toLowerCase();
        mimeType = this._getMimeType(fileExtension);
        fileCategory = this._getFileCategory(fileExtension);
      } else if (input.fileName) {
        fileExtension = path.extname(input.fileName).toLowerCase();
        mimeType = mimeType || this._getMimeType(fileExtension);
        fileCategory = this._getFileCategory(fileExtension);
      }
      
      // Determine content type from MIME if not specified
      if (contentType === 'file' && mimeType) {
        if (mimeType.startsWith('image/')) contentType = 'image-file';
        else if (mimeType.startsWith('video/')) contentType = 'video';
        else if (mimeType.startsWith('audio/')) contentType = 'audio';
        else if (mimeType === 'application/pdf') contentType = 'pdf';
      }
      
      // Check for URL content
      if (contentType === 'text' && input.content) {
        const trimmed = input.content.trim();
        if (/^https?:\/\/[^\s]+$/.test(trimmed)) {
          contentType = 'url';
          // Check for YouTube
          if (/youtube\.com|youtu\.be/.test(trimmed)) {
            contentType = 'youtube';
          }
        }
      }
      
      const data = {
        contentType,
        mimeType,
        fileExtension,
        fileCategory,
        processingPath: this._determineProcessingPath(contentType)
      };
      
      this._emitStageEvent(operationId, STAGES.IDENTIFICATION, true, data);
      return { success: true, data };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.IDENTIFICATION, false, { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ==================== STAGE 3: CHECKSUM ====================
  
  async _stageChecksum(operationId, input, identificationData) {
    try {
      const hash = crypto.createHash('sha256');
      
      if (input.filePath && fs.existsSync(input.filePath)) {
        // Hash file content
        const fileBuffer = fs.readFileSync(input.filePath);
        hash.update(fileBuffer);
      } else if (input.fileData) {
        // Hash base64 data
        hash.update(Buffer.from(input.fileData, 'base64'));
      } else if (input.content) {
        // Hash string content
        hash.update(input.content);
      } else if (input.dataUrl) {
        // Hash data URL
        hash.update(input.dataUrl);
      } else if (input.html) {
        hash.update(input.html);
      }
      
      const checksum = hash.digest('hex').substring(0, 16); // First 16 chars
      
      this._emitStageEvent(operationId, STAGES.CHECKSUM, true, { checksum });
      return { success: true, data: { checksum } };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.CHECKSUM, false, { error: error.message });
      // Checksum failure shouldn't block the pipeline
      return { success: true, data: { checksum: null, error: error.message } };
    }
  }

  // ==================== STAGE 4: STORAGE ====================
  
  async _stageStorage(operationId, input, identificationData, options) {
    try {
      if (!this.clipboardManager) {
        throw new Error('Clipboard manager not initialized');
      }
      
      // Build item for storage
      const item = this._buildStorageItem(input, identificationData, options);
      
      // Add to clipboard manager
      await this.clipboardManager.addToHistory(item);
      
      // Get the stored item ID
      const storedItem = this.clipboardManager.history?.[0];
      const itemId = storedItem?.id || item.id;
      
      this._emitStageEvent(operationId, STAGES.STORAGE, true, { 
        itemId, 
        spaceId: item.spaceId,
        type: item.type 
      });
      
      return { 
        success: true, 
        data: { 
          itemId, 
          spaceId: item.spaceId,
          item: storedItem || item
        } 
      };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.STORAGE, false, { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ==================== STAGE 5: THUMBNAIL ====================
  
  async _stageThumbnail(operationId, input, storageData, options) {
    try {
      if (!this.thumbnailPipeline) {
        // Skip if no thumbnail pipeline available
        this._emitStageEvent(operationId, STAGES.THUMBNAIL, true, { skipped: true });
        return { success: true, data: { skipped: true } };
      }
      
      const item = storageData.item;
      
      // Check if thumbnail already exists
      if (item.thumbnail) {
        this._emitStageEvent(operationId, STAGES.THUMBNAIL, true, { exists: true });
        return { success: true, data: { exists: true } };
      }
      
      // Generate thumbnail based on type
      const thumbnail = await this.thumbnailPipeline.generate(item);
      
      if (thumbnail) {
        // Update item with thumbnail
        if (this.clipboardManager?.storage) {
          // Update in storage
          const fullItem = this.clipboardManager.storage.loadItem(item.id);
          if (fullItem) {
            fullItem.thumbnail = thumbnail;
            // Re-save would happen through storage layer
          }
        }
        
        this._emitStageEvent(operationId, STAGES.THUMBNAIL, true, { generated: true });
        return { success: true, data: { thumbnail, generated: true } };
      }
      
      this._emitStageEvent(operationId, STAGES.THUMBNAIL, true, { skipped: true, reason: 'No thumbnail generated' });
      return { success: true, data: { skipped: true } };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.THUMBNAIL, false, { error: error.message });
      // Thumbnail failure shouldn't block pipeline
      return { success: false, error: error.message, recoverable: true };
    }
  }

  // ==================== STAGE 6: METADATA ====================
  
  async _stageMetadata(operationId, input, storageData, options) {
    try {
      // Skip if auto-metadata disabled or no generator
      if (options.skipMetadata || !this.metadataGenerator) {
        this._emitStageEvent(operationId, STAGES.METADATA, true, { skipped: true });
        return { success: true, data: { skipped: true } };
      }
      
      // Check if API key is available
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      
      if (!apiKey) {
        this._emitStageEvent(operationId, STAGES.METADATA, true, { skipped: true, reason: 'No API key' });
        return { success: true, data: { skipped: true, reason: 'No API key' } };
      }
      
      // Queue metadata generation (async)
      const itemId = storageData.itemId;
      
      // Generate metadata
      const result = await this.metadataGenerator.generateMetadataForItem(itemId, apiKey);
      
      if (result.success) {
        this._emitStageEvent(operationId, STAGES.METADATA, true, { 
          generated: true,
          title: result.metadata?.title?.substring(0, 50)
        });
        return { success: true, data: { metadata: result.metadata } };
      }
      
      this._emitStageEvent(operationId, STAGES.METADATA, false, { error: result.error });
      return { success: false, error: result.error, recoverable: true };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.METADATA, false, { error: error.message });
      // Metadata failure shouldn't block pipeline
      return { success: false, error: error.message, recoverable: true };
    }
  }

  // ==================== STAGE 7: VERIFICATION ====================
  
  async _stageVerification(operationId, storageData) {
    try {
      if (!this.verifier) {
        this._emitStageEvent(operationId, STAGES.VERIFY, true, { skipped: true });
        return { success: true, data: { skipped: true } };
      }
      
      const verification = await this.verifier.verifyItem(storageData.itemId);
      
      this._emitStageEvent(operationId, STAGES.VERIFY, verification.valid, verification);
      return { success: verification.valid, data: verification };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.VERIFY, false, { error: error.message });
      return { success: false, error: error.message, recoverable: true };
    }
  }

  // ==================== STAGE 8: FINAL CHECKSUM ====================
  
  async _stageFinalChecksum(operationId, storageData, originalChecksum) {
    try {
      if (!this.verifier || !originalChecksum) {
        this._emitStageEvent(operationId, STAGES.FINAL_CHECKSUM, true, { skipped: true });
        return { success: true, data: { skipped: true } };
      }
      
      // Recalculate checksum from stored content
      const verification = await this.verifier.verifyChecksum(storageData.itemId, originalChecksum);
      
      this._emitStageEvent(operationId, STAGES.FINAL_CHECKSUM, verification.match, {
        originalChecksum,
        storedChecksum: verification.checksum,
        match: verification.match
      });
      
      return { 
        success: verification.match, 
        data: {
          originalChecksum,
          storedChecksum: verification.checksum,
          match: verification.match
        }
      };
      
    } catch (error) {
      this._emitStageEvent(operationId, STAGES.FINAL_CHECKSUM, false, { error: error.message });
      return { success: false, error: error.message, recoverable: true };
    }
  }

  // ==================== HELPER METHODS ====================

  _buildStorageItem(input, identificationData, options) {
    const baseItem = {
      type: input.type,
      spaceId: input.spaceId || options.spaceId || 'unclassified',
      timestamp: Date.now(),
      source: input.source || 'pipeline',
      pinned: false
    };
    
    switch (input.type) {
      case 'text':
        return {
          ...baseItem,
          content: input.content,
          text: input.content,
          plainText: input.content,
          preview: input.content.substring(0, 200)
        };
        
      case 'html':
        return {
          ...baseItem,
          content: input.html || input.content,
          html: input.html || input.content,
          plainText: input.plainText || '',
          preview: input.plainText?.substring(0, 200) || 'HTML Content'
        };
        
      case 'image':
        return {
          ...baseItem,
          content: input.dataUrl || input.content,
          dataUrl: input.dataUrl || input.content,
          thumbnail: input.thumbnail,
          preview: 'Image'
        };
        
      case 'file':
        return {
          ...baseItem,
          type: 'file',
          filePath: input.filePath,
          fileName: input.fileName || (input.filePath ? path.basename(input.filePath) : 'file'),
          fileSize: input.fileSize,
          fileType: identificationData.contentType,
          fileCategory: identificationData.fileCategory,
          fileExt: identificationData.fileExtension,
          mimeType: identificationData.mimeType,
          fileData: input.fileData,
          thumbnail: input.thumbnail,
          preview: `File: ${input.fileName || 'Unknown'}`
        };
        
      default:
        return {
          ...baseItem,
          content: input.content,
          preview: String(input.content || '').substring(0, 200)
        };
    }
  }

  _getContentSize(input) {
    if (input.filePath && fs.existsSync(input.filePath)) {
      return fs.statSync(input.filePath).size;
    }
    if (input.fileSize) {
      return input.fileSize;
    }
    if (input.fileData) {
      return input.fileData.length * 0.75; // Base64 approximation
    }
    if (input.content) {
      return Buffer.byteLength(input.content, 'utf8');
    }
    if (input.dataUrl) {
      return input.dataUrl.length * 0.75;
    }
    return 0;
  }

  _getMimeType(ext) {
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.ts': 'application/typescript',
      '.py': 'text/x-python',
      '.txt': 'text/plain',
      '.md': 'text/markdown'
    };
    return mimeTypes[ext?.toLowerCase()] || 'application/octet-stream';
  }

  _getFileCategory(ext) {
    const categories = {
      image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'],
      video: ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'],
      audio: ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'],
      document: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
      code: ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt'],
      data: ['.json', '.xml', '.yaml', '.yml', '.csv', '.tsv'],
      text: ['.txt', '.md', '.log', '.rtf'],
      archive: ['.zip', '.tar', '.gz', '.rar', '.7z']
    };
    
    const lowerExt = ext?.toLowerCase();
    for (const [category, extensions] of Object.entries(categories)) {
      if (extensions.includes(lowerExt)) {
        return category;
      }
    }
    return 'other';
  }

  _determineProcessingPath(contentType) {
    const paths = {
      'image': 'visual',
      'image-file': 'visual',
      'video': 'media',
      'audio': 'media',
      'pdf': 'document',
      'text': 'text',
      'html': 'rich',
      'code': 'text',
      'data': 'structured',
      'url': 'link',
      'youtube': 'youtube'
    };
    return paths[contentType] || 'generic';
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Get status of active operations
   */
  getActiveOperations() {
    return Array.from(this._activeOperations.entries()).map(([id, result]) => ({
      operationId: id,
      stages: Object.keys(result.stages),
      errors: result.errors.length
    }));
  }
}

// Singleton instance
let instance = null;

function getAssetPipeline(dependencies) {
  if (!instance) {
    instance = new AssetPipeline(dependencies);
  } else if (dependencies) {
    // Update dependencies
    Object.assign(instance, dependencies);
  }
  return instance;
}

function resetAssetPipeline() {
  instance = null;
}

module.exports = {
  AssetPipeline,
  getAssetPipeline,
  resetAssetPipeline,
  STAGES,
  CONTENT_TYPES,
  SIZE_LIMITS
};

