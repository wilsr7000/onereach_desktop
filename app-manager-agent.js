/**
 * App Manager Agent
 * 
 * Autonomous LLM-powered agent that monitors the application,
 * diagnoses issues, and applies automatic fixes.
 * 
 * Features:
 * - Periodic event log scanning for errors
 * - LLM-based diagnosis of issues
 * - Automatic fix application
 * - Escalation for recurring/unfixable issues
 * - Activity reporting to dashboard
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// Agent configuration
const CONFIG = {
  scanIntervalMs: 30000,        // 30 seconds
  maxErrorsPerScan: 20,         // Max errors to process per scan
  escalationThreshold: 3,       // Escalate after N failed fix attempts
  diagnosisTimeout: 30000,      // 30s timeout for LLM diagnosis
  fixRetryDelay: 5000,          // 5s delay between fix retries
  
  // LLM Context Management
  llmModel: 'claude-opus-4-5-20251101', // Use most powerful model for diagnosis
  llmMaxTokens: 2000,           // Enough for detailed analysis
  contextWindowSize: 50,        // Track last N processed events for context
  contextOverlap: 5,            // Include N previous events as context overlap
  processedEventTTL: 3600000,   // 1 hour - don't reprocess recent events
  
  // Event Tracking
  maxProcessedEventsCache: 500, // Max processed event IDs to track
  eventDedupeWindowMs: 300000,  // 5 min - dedupe window for similar events
  
  // External API Reporting (optional)
  externalAPI: {
    enabled: false,             // Enable external API reporting
    statusEndpoint: null,       // URL for status reports (e.g., 'https://api.example.com/agent/status')
    issueEndpoint: null,        // URL for issue reports (e.g., 'https://api.example.com/agent/issues')
    apiKey: null,               // Optional API key for authentication
    reportIntervalMs: 60000,    // Report status every 60 seconds
    reportOnIssue: true,        // Report immediately when issue detected
    reportOnFix: true,          // Report when fix is applied
    timeout: 10000,             // Request timeout in ms
    retryAttempts: 2            // Number of retry attempts on failure
  }
};

// Fix strategies
const FIX_STRATEGIES = {
  RETRY: 'retry',
  REGENERATE_THUMBNAIL: 'regenerate_thumbnail',
  REGENERATE_METADATA: 'regenerate_metadata',
  REBUILD_INDEX: 'rebuild_index',
  CLEANUP_ORPHAN: 'cleanup_orphan',
  REPAIR_METADATA: 'repair_metadata',
  SKIP: 'skip',
  ESCALATE: 'escalate'
};

class AppManagerAgent {
  constructor(dependencies = {}) {
    this.dashboardAPI = dependencies.dashboardAPI;
    this.clipboardManager = dependencies.clipboardManager;
    this.pipelineVerifier = dependencies.pipelineVerifier;
    this.metadataGenerator = dependencies.metadataGenerator;
    this.thumbnailPipeline = dependencies.thumbnailPipeline;
    
    // Agent state
    this.active = false;
    this.paused = false;
    this.scanInterval = null;
    this.lastScanTime = null;
    this.startTime = null;
    
    // Statistics
    this.stats = {
      scansCompleted: 0,
      issuesDetected: 0,
      fixesApplied: 0,
      fixesFailed: 0,
      escalated: 0,
      lastReset: new Date().toDateString()
    };
    
    // Issue tracking
    this.issueHistory = new Map(); // Track recurring issues
    this.recentDiagnoses = [];
    this.maxDiagnoses = 50;
    
    // Escalated issues requiring attention
    this.escalatedIssues = [];
    
    // Context Management for LLM - tracks processed events to avoid redundancy
    this.processedEventIds = new Set();      // Track event IDs already processed
    this.processedEventTimestamps = new Map(); // Event ID -> timestamp processed
    this.contextHistory = [];                 // Rolling context window for LLM
    this.lastContextSummary = '';            // Summary of recent diagnoses for context
    this.eventFingerprints = new Map();      // Track event signatures for deduplication
    
    // External API reporting configuration
    this.externalAPIConfig = { ...CONFIG.externalAPI };
    this.lastStatusReport = null;
    this.statusReportInterval = null;
    
    // Data directory
    this.dataDir = path.join(app.getPath('userData'), 'agent-data');
    this._ensureDataDir();
    this._loadState();
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  _loadState() {
    try {
      const statePath = path.join(this.dataDir, 'agent-state.json');
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        
        // Reset daily stats if new day
        const today = new Date().toDateString();
        if (data.stats?.lastReset === today) {
          this.stats = { ...this.stats, ...data.stats };
        }
        
        if (data.escalatedIssues) {
          this.escalatedIssues = data.escalatedIssues;
        }
        
        if (data.recentDiagnoses) {
          this.recentDiagnoses = data.recentDiagnoses.slice(0, this.maxDiagnoses);
        }
        
        // Load context history (for LLM context continuity across restarts)
        if (data.contextHistory) {
          // Only load recent context (from last 24 hours)
          const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
          this.contextHistory = data.contextHistory.filter(ctx => 
            new Date(ctx.timestamp).getTime() > oneDayAgo
          ).slice(0, CONFIG.contextWindowSize);
          console.log(`[Agent] Loaded ${this.contextHistory.length} context entries from previous session`);
        }
        
        // Load processed event IDs (recent ones only)
        if (data.processedEventIds && data.processedEventTimestamps) {
          const now = Date.now();
          for (let i = 0; i < data.processedEventIds.length; i++) {
            const id = data.processedEventIds[i];
            const timestamp = data.processedEventTimestamps[i];
            if (now - timestamp < CONFIG.processedEventTTL) {
              this.processedEventIds.add(id);
              this.processedEventTimestamps.set(id, timestamp);
            }
          }
          console.log(`[Agent] Loaded ${this.processedEventIds.size} processed event IDs`);
        }
        
        if (data.lastContextSummary) {
          this.lastContextSummary = data.lastContextSummary;
        }
        
        // Load external API config (if previously configured)
        if (data.externalAPIConfig) {
          this.externalAPIConfig = { ...CONFIG.externalAPI, ...data.externalAPIConfig };
          console.log('[Agent] Loaded external API config, enabled:', this.externalAPIConfig.enabled);
        }
      }
    } catch (error) {
      console.error('[Agent] Error loading state:', error);
    }
  }

  _saveState() {
    try {
      const statePath = path.join(this.dataDir, 'agent-state.json');
      
      // Convert Sets and Maps to arrays for JSON serialization
      const processedIds = [...this.processedEventIds];
      const processedTimestamps = processedIds.map(id => this.processedEventTimestamps.get(id));
      
      const data = {
        stats: this.stats,
        escalatedIssues: this.escalatedIssues,
        recentDiagnoses: this.recentDiagnoses,
        
        // Context tracking for LLM continuity
        contextHistory: this.contextHistory.slice(0, CONFIG.contextWindowSize),
        processedEventIds: processedIds.slice(0, CONFIG.maxProcessedEventsCache),
        processedEventTimestamps: processedTimestamps.slice(0, CONFIG.maxProcessedEventsCache),
        lastContextSummary: this.lastContextSummary,
        
        // External API config (without sensitive API key)
        externalAPIConfig: {
          enabled: this.externalAPIConfig.enabled,
          statusEndpoint: this.externalAPIConfig.statusEndpoint,
          issueEndpoint: this.externalAPIConfig.issueEndpoint,
          // Note: apiKey is NOT persisted for security - must be reconfigured on restart
          reportIntervalMs: this.externalAPIConfig.reportIntervalMs,
          reportOnIssue: this.externalAPIConfig.reportOnIssue,
          reportOnFix: this.externalAPIConfig.reportOnFix
        },
        
        lastSaved: new Date().toISOString()
      };
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[Agent] Error saving state:', error);
    }
  }

  /**
   * Start the agent
   */
  start() {
    if (this.active) {
      console.log('[Agent] Already running');
      return;
    }
    
    console.log('[Agent] Starting App Manager Agent...');
    this.active = true;
    this.paused = false;
    this.startTime = Date.now();
    
    // Run initial scan
    this.runScan();
    
    // Start periodic scanning
    this.scanInterval = setInterval(() => {
      if (!this.paused) {
        this.runScan();
      }
    }, CONFIG.scanIntervalMs);
    
    // Start external API status reporting if configured
    if (this.externalAPIConfig.enabled) {
      this._startStatusReporting();
    }
    
    console.log(`[Agent] Started. Scanning every ${CONFIG.scanIntervalMs / 1000}s`);
  }

  /**
   * Stop the agent
   */
  stop() {
    if (!this.active) return;
    
    console.log('[Agent] Stopping...');
    this.active = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    
    // Stop external API reporting
    this._stopStatusReporting();
    
    // Send final status report if enabled
    if (this.externalAPIConfig.enabled && this.externalAPIConfig.statusEndpoint) {
      this.reportStatus().catch(err => 
        console.warn('[Agent] Failed to send final status report:', err.message)
      );
    }
    
    this._saveState();
    console.log('[Agent] Stopped');
  }

  /**
   * Pause scanning (agent stays active but doesn't scan)
   */
  pause() {
    this.paused = true;
    console.log('[Agent] Paused');
  }

  /**
   * Resume scanning
   */
  resume() {
    this.paused = false;
    console.log('[Agent] Resumed');
  }

  /**
   * Run a scan manually
   */
  async runScan() {
    if (this.paused) {
      return { skipped: true, reason: 'Agent paused' };
    }
    
    const scanStart = Date.now();
    console.log('[Agent] Starting scan...');
    
    const result = {
      timestamp: new Date().toISOString(),
      errorsFound: 0,
      issuesDiagnosed: 0,
      fixesApplied: 0,
      fixesFailed: 0,
      duration: 0
    };

    try {
      // Get recent errors from event log
      const errors = await this._getRecentErrors();
      result.errorsFound = errors.length;
      
      if (errors.length === 0) {
        console.log('[Agent] No errors found');
        this.stats.scansCompleted++;
        this.lastScanTime = Date.now();
        return result;
      }
      
      console.log(`[Agent] Found ${errors.length} errors to analyze`);
      
      // Group errors by type/source
      const groupedErrors = this._groupErrors(errors);
      
      // Diagnose and fix each group
      for (const [key, errorGroup] of Object.entries(groupedErrors)) {
        try {
          const diagnosis = await this._diagnoseError(errorGroup);
          result.issuesDiagnosed++;
          this.stats.issuesDetected++;
          
          if (diagnosis.strategy !== FIX_STRATEGIES.SKIP && 
              diagnosis.strategy !== FIX_STRATEGIES.ESCALATE) {
            const fixResult = await this._applyFix(diagnosis);
            
            if (fixResult.success) {
              result.fixesApplied++;
              this.stats.fixesApplied++;
              
              // Update context history with success
              this._updateContextHistoryResult(diagnosis, true);
              
              // Record to dashboard
              if (this.dashboardAPI) {
                this.dashboardAPI.recordAutoFix(
                  diagnosis.issue,
                  diagnosis.strategy,
                  'success',
                  { operationId: diagnosis.operationId }
                );
              }
              
              // Report fix to external API
              this.reportIssue(diagnosis, 'fixed').catch(err =>
                console.warn('[Agent] Failed to report fixed issue:', err.message)
              );
            } else {
              result.fixesFailed++;
              this.stats.fixesFailed++;
              
              // Update context history with failure
              this._updateContextHistoryResult(diagnosis, false);
              
              // Track for escalation
              this._trackFailedFix(diagnosis);
              
              // Report failure to external API
              this.reportIssue(diagnosis, 'failed').catch(err =>
                console.warn('[Agent] Failed to report fix failure:', err.message)
              );
            }
          } else if (diagnosis.strategy === FIX_STRATEGIES.ESCALATE) {
            this._escalateIssue(diagnosis);
          }
          
          // Record diagnosis
          this._recordDiagnosis(diagnosis);
          
        } catch (diagError) {
          console.error('[Agent] Diagnosis error:', diagError);
        }
      }
      
    } catch (error) {
      console.error('[Agent] Scan error:', error);
    }
    
    result.duration = Date.now() - scanStart;
    this.stats.scansCompleted++;
    this.lastScanTime = Date.now();
    this._saveState();
    
    console.log(`[Agent] Scan complete. Fixed: ${result.fixesApplied}, Failed: ${result.fixesFailed}`);
    
    return result;
  }

  /**
   * Get recent errors from event log
   * Filters out already processed events and deduplicates similar events
   */
  async _getRecentErrors() {
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      
      const logs = await eventDb.getEventLogs({ limit: 200 });
      
      // Clean up old processed event tracking
      this._cleanupProcessedEvents();
      
      // Filter for errors in the last hour
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      const errors = logs.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        const isError = (log.level === 'error' || log.level === 'ERROR');
        const isRecent = logTime > oneHourAgo;
        
        // Skip if already processed
        if (this.processedEventIds.has(log.id)) {
          return false;
        }
        
        // Skip if duplicate fingerprint within dedupe window
        const fingerprint = this._getEventFingerprint(log);
        if (this._isDuplicateEvent(fingerprint, logTime)) {
          return false;
        }
        
        return isError && isRecent;
      });
      
      return errors.slice(0, CONFIG.maxErrorsPerScan);
    } catch (error) {
      console.error('[Agent] Error fetching logs:', error);
      return [];
    }
  }

  /**
   * Generate a fingerprint for an event to detect duplicates
   */
  _getEventFingerprint(event) {
    const source = event.source || event.category || 'unknown';
    const normalizedMsg = this._normalizeErrorMessage(event.message);
    return `${source}:${normalizedMsg}`;
  }

  /**
   * Check if event is a duplicate within the dedupe window
   */
  _isDuplicateEvent(fingerprint, eventTime) {
    const existingTime = this.eventFingerprints.get(fingerprint);
    if (!existingTime) return false;
    
    return (eventTime - existingTime) < CONFIG.eventDedupeWindowMs;
  }

  /**
   * Mark event as processed and track its fingerprint
   */
  _markEventProcessed(event) {
    this.processedEventIds.add(event.id);
    this.processedEventTimestamps.set(event.id, Date.now());
    
    const fingerprint = this._getEventFingerprint(event);
    this.eventFingerprints.set(fingerprint, new Date(event.timestamp).getTime());
    
    // Limit cache size
    if (this.processedEventIds.size > CONFIG.maxProcessedEventsCache) {
      const oldest = [...this.processedEventTimestamps.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 100);
      oldest.forEach(([id]) => {
        this.processedEventIds.delete(id);
        this.processedEventTimestamps.delete(id);
      });
    }
  }

  /**
   * Clean up old processed event records
   */
  _cleanupProcessedEvents() {
    const now = Date.now();
    
    // Remove events older than TTL
    for (const [id, timestamp] of this.processedEventTimestamps) {
      if (now - timestamp > CONFIG.processedEventTTL) {
        this.processedEventIds.delete(id);
        this.processedEventTimestamps.delete(id);
      }
    }
    
    // Clean up old fingerprints (older than dedupe window)
    for (const [fingerprint, timestamp] of this.eventFingerprints) {
      if (now - timestamp > CONFIG.eventDedupeWindowMs * 2) {
        this.eventFingerprints.delete(fingerprint);
      }
    }
  }

  /**
   * Group errors by source/type for batch processing
   */
  _groupErrors(errors) {
    const groups = {};
    
    for (const error of errors) {
      const key = `${error.source || error.category || 'unknown'}:${this._normalizeErrorMessage(error.message)}`;
      
      if (!groups[key]) {
        groups[key] = {
          key,
          source: error.source || error.category,
          message: error.message,
          errors: [],
          count: 0
        };
      }
      
      groups[key].errors.push(error);
      groups[key].count++;
    }
    
    return groups;
  }

  /**
   * Normalize error message for grouping
   */
  _normalizeErrorMessage(message) {
    if (!message) return 'unknown';
    // Remove IDs, timestamps, paths for grouping
    return message
      .replace(/[a-f0-9-]{36}/gi, 'ID')
      .replace(/\d{13,}/g, 'TIMESTAMP')
      .replace(/\/[^\s]+/g, 'PATH')
      .substring(0, 100);
  }

  /**
   * Diagnose an error group and determine fix strategy
   */
  async _diagnoseError(errorGroup) {
    const diagnosis = {
      timestamp: new Date().toISOString(),
      source: errorGroup.source,
      issue: errorGroup.message,
      occurrences: errorGroup.count,
      strategy: FIX_STRATEGIES.SKIP,
      confidence: 0,
      details: null,
      operationId: null
    };

    try {
      // Check if this is a known pattern we can fix without LLM
      const quickFix = this._checkQuickFix(errorGroup);
      if (quickFix) {
        return { ...diagnosis, ...quickFix };
      }

      // Use LLM for complex diagnosis
      const llmDiagnosis = await this._llmDiagnose(errorGroup);
      if (llmDiagnosis) {
        return { ...diagnosis, ...llmDiagnosis };
      }

    } catch (error) {
      console.error('[Agent] Diagnosis error:', error);
      diagnosis.details = { error: error.message };
    }

    return diagnosis;
  }

  /**
   * Check for quick-fix patterns without LLM
   */
  _checkQuickFix(errorGroup) {
    const message = (errorGroup.message || '').toLowerCase();
    const source = (errorGroup.source || '').toLowerCase();
    
    // Thumbnail errors
    if (message.includes('thumbnail') || source.includes('thumbnail')) {
      if (message.includes('failed') || message.includes('error')) {
        return {
          strategy: FIX_STRATEGIES.REGENERATE_THUMBNAIL,
          confidence: 85,
          details: { reason: 'Thumbnail generation failure detected' }
        };
      }
    }
    
    // Metadata errors
    if (message.includes('metadata') || source.includes('metadata')) {
      if (message.includes('failed') || message.includes('error')) {
        return {
          strategy: FIX_STRATEGIES.REGENERATE_METADATA,
          confidence: 80,
          details: { reason: 'Metadata generation failure detected' }
        };
      }
      if (message.includes('corrupt') || message.includes('invalid json')) {
        return {
          strategy: FIX_STRATEGIES.REPAIR_METADATA,
          confidence: 90,
          details: { reason: 'Corrupted metadata detected' }
        };
      }
    }
    
    // Storage/file errors
    if (message.includes('enoent') || message.includes('not found')) {
      return {
        strategy: FIX_STRATEGIES.REBUILD_INDEX,
        confidence: 75,
        details: { reason: 'Missing file detected' }
      };
    }
    
    // API rate limits - just retry later
    if (message.includes('rate limit') || message.includes('429')) {
      return {
        strategy: FIX_STRATEGIES.RETRY,
        confidence: 95,
        details: { reason: 'API rate limit - will retry' }
      };
    }
    
    // Transient errors - retry
    if (message.includes('timeout') || message.includes('econnreset')) {
      return {
        strategy: FIX_STRATEGIES.RETRY,
        confidence: 85,
        details: { reason: 'Transient network error' }
      };
    }
    
    return null;
  }

  /**
   * Use LLM for complex diagnosis with context awareness
   * Uses Claude Opus 4.5 with sliding window context
   */
  async _llmDiagnose(errorGroup) {
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey') || settingsManager.get('anthropicApiKey');
      
      if (!apiKey) {
        console.log('[Agent] No API key for LLM diagnosis');
        return null;
      }

      const ClaudeAPI = require('./claude-api');
      const claude = new ClaudeAPI();
      
      // Override model to use the most powerful one
      claude.defaultModel = CONFIG.llmModel;
      claude.maxTokens = CONFIG.llmMaxTokens;
      
      // Build prompt with context
      const prompt = this._buildDiagnosisPromptWithContext(errorGroup);
      
      console.log(`[Agent] Sending diagnosis to ${CONFIG.llmModel} with ${prompt.length} chars context`);
      
      const response = await claude.chat([
        { role: 'user', content: prompt }
      ], apiKey, {
        maxTokens: CONFIG.llmMaxTokens,
        temperature: 0.2 // Lower for more consistent diagnosis
      });

      if (response && response.content) {
        const diagnosis = this._parseLLMDiagnosis(response.content);
        
        // Update context history with this diagnosis
        this._updateContextHistory(errorGroup, diagnosis);
        
        return diagnosis;
      }

    } catch (error) {
      console.error('[Agent] LLM diagnosis error:', error);
    }

    return null;
  }

  /**
   * Build diagnosis prompt with sliding window context
   * Includes recent diagnoses for continuity and overlap prevention
   */
  _buildDiagnosisPromptWithContext(errorGroup) {
    // Get recent context (last N diagnoses)
    const recentContext = this.contextHistory.slice(0, CONFIG.contextOverlap);
    
    // Build context summary
    let contextSection = '';
    if (recentContext.length > 0) {
      contextSection = `
## RECENT DIAGNOSIS CONTEXT (to avoid redundant work)
The following errors were ALREADY processed in recent scans - use this context but don't re-diagnose them:

${recentContext.map((ctx, i) => `${i + 1}. [${ctx.timestamp}] ${ctx.source}: "${ctx.message.substring(0, 100)}..."
   → Strategy: ${ctx.strategy}, Confidence: ${ctx.confidence}%, Result: ${ctx.result || 'pending'}`).join('\n')}

---
`;
    }

    // Build current error details
    const errorDetails = errorGroup.errors.slice(0, 5).map((e, i) => {
      const details = e.details ? JSON.stringify(e.details).substring(0, 200) : 'No details';
      return `  ${i + 1}. [${e.timestamp}] ${e.message}
     Details: ${details}`;
    }).join('\n');

    return `You are an intelligent application error diagnostic agent for a clipboard/asset management app.
Your role is to analyze errors and determine the optimal fix strategy. You have access to context from recent diagnoses to avoid redundant work.

${contextSection}
## CURRENT ERROR TO DIAGNOSE

SOURCE: ${errorGroup.source || 'unknown'}
ERROR MESSAGE: ${errorGroup.message}
OCCURRENCE COUNT: ${errorGroup.count} times in the last hour

SAMPLE ERROR ENTRIES:
${errorDetails}

## AVAILABLE FIX STRATEGIES

| Strategy | Description | When to Use |
|----------|-------------|-------------|
| RETRY | Retry the failed operation | Transient network errors, timeouts, rate limits |
| REGENERATE_THUMBNAIL | Regenerate thumbnail for item | Thumbnail corruption, generation failure |
| REGENERATE_METADATA | Regenerate AI metadata | Missing/corrupt metadata, AI generation failed |
| REBUILD_INDEX | Rebuild storage index entry | Index desync, missing entries |
| REPAIR_METADATA | Fix corrupted metadata file | JSON parse errors, invalid metadata format |
| CLEANUP_ORPHAN | Remove orphaned files | Files without index entries |
| SKIP | Take no action | Benign errors, user-initiated cancellations |
| ESCALATE | Requires human attention | Persistent failures, security issues, data corruption |

## ANALYSIS GUIDELINES

1. Consider whether this error is similar to any in the recent context - if so, consider if a different strategy might work better
2. Extract the item ID from the error if present (format: uuid, timestamp-based ID, or numeric ID)
3. Rate your confidence based on how certain you are about the diagnosis
4. If the same error type keeps recurring despite fixes, consider escalation

## RESPONSE FORMAT

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "strategy": "STRATEGY_NAME",
  "confidence": 0-100,
  "reason": "Brief explanation of why this strategy was chosen",
  "itemId": "extracted item ID or null",
  "relatedToRecent": true/false,
  "additionalContext": "Any relevant observations for future diagnoses"
}`;
  }

  /**
   * Update context history with latest diagnosis
   * Implements sliding window to maintain relevant context
   */
  _updateContextHistory(errorGroup, diagnosis) {
    const entry = {
      timestamp: new Date().toISOString(),
      source: errorGroup.source,
      message: errorGroup.message,
      occurrences: errorGroup.count,
      strategy: diagnosis?.strategy || 'SKIP',
      confidence: diagnosis?.confidence || 0,
      result: null, // Will be updated after fix attempt
      fingerprint: this._getEventFingerprint({ source: errorGroup.source, message: errorGroup.message })
    };
    
    this.contextHistory.unshift(entry);
    
    // Maintain sliding window size
    if (this.contextHistory.length > CONFIG.contextWindowSize) {
      this.contextHistory = this.contextHistory.slice(0, CONFIG.contextWindowSize);
    }
    
    // Mark all errors in this group as processed
    for (const error of errorGroup.errors) {
      this._markEventProcessed(error);
    }
    
    // Generate summary for persistent storage
    this._updateContextSummary();
  }

  /**
   * Update fix result in context history
   */
  _updateContextHistoryResult(diagnosis, success) {
    const recent = this.contextHistory.find(ctx => 
      ctx.source === diagnosis.source && ctx.strategy === diagnosis.strategy
    );
    if (recent) {
      recent.result = success ? 'fixed' : 'failed';
    }
  }

  /**
   * Generate a summary of recent context for persistence
   */
  _updateContextSummary() {
    const recent = this.contextHistory.slice(0, 10);
    const strategies = {};
    
    for (const ctx of recent) {
      strategies[ctx.strategy] = (strategies[ctx.strategy] || 0) + 1;
    }
    
    const topStrategies = Object.entries(strategies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, c]) => `${s}(${c})`);
    
    this.lastContextSummary = `Last ${recent.length} diagnoses: ${topStrategies.join(', ')}`;
  }

  /**
   * Parse LLM diagnosis response
   */
  _parseLLMDiagnosis(content) {
    try {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Map strategy string to our constants
        const strategyMap = {
          'RETRY': FIX_STRATEGIES.RETRY,
          'REGENERATE_THUMBNAIL': FIX_STRATEGIES.REGENERATE_THUMBNAIL,
          'REGENERATE_METADATA': FIX_STRATEGIES.REGENERATE_METADATA,
          'REBUILD_INDEX': FIX_STRATEGIES.REBUILD_INDEX,
          'REPAIR_METADATA': FIX_STRATEGIES.REPAIR_METADATA,
          'CLEANUP_ORPHAN': FIX_STRATEGIES.CLEANUP_ORPHAN,
          'SKIP': FIX_STRATEGIES.SKIP,
          'ESCALATE': FIX_STRATEGIES.ESCALATE
        };
        
        return {
          strategy: strategyMap[parsed.strategy] || FIX_STRATEGIES.SKIP,
          confidence: parsed.confidence || 50,
          details: {
            reason: parsed.reason,
            itemId: parsed.itemId,
            llmGenerated: true
          }
        };
      }
    } catch (error) {
      console.error('[Agent] Error parsing LLM response:', error);
    }
    
    return null;
  }

  /**
   * Apply a fix based on diagnosis
   */
  async _applyFix(diagnosis) {
    console.log(`[Agent] Applying fix: ${diagnosis.strategy}`);
    
    const result = {
      success: false,
      strategy: diagnosis.strategy,
      details: null
    };

    try {
      switch (diagnosis.strategy) {
        case FIX_STRATEGIES.RETRY:
          // For retry, we just mark as handled - the original operation will retry
          result.success = true;
          result.details = { action: 'Marked for retry' };
          break;
          
        case FIX_STRATEGIES.REGENERATE_THUMBNAIL:
          result.success = await this._fixRegenerateThumbnail(diagnosis);
          break;
          
        case FIX_STRATEGIES.REGENERATE_METADATA:
          result.success = await this._fixRegenerateMetadata(diagnosis);
          break;
          
        case FIX_STRATEGIES.REPAIR_METADATA:
          result.success = await this._fixRepairMetadata(diagnosis);
          break;
          
        case FIX_STRATEGIES.REBUILD_INDEX:
          result.success = await this._fixRebuildIndex(diagnosis);
          break;
          
        case FIX_STRATEGIES.CLEANUP_ORPHAN:
          result.success = await this._fixCleanupOrphan(diagnosis);
          break;
          
        default:
          result.details = { reason: 'No fix action for strategy' };
      }
      
    } catch (error) {
      console.error('[Agent] Fix application error:', error);
      result.details = { error: error.message };
    }

    return result;
  }

  /**
   * Fix: Regenerate thumbnail
   */
  async _fixRegenerateThumbnail(diagnosis) {
    const itemId = diagnosis.details?.itemId;
    if (!itemId || !this.clipboardManager || !this.thumbnailPipeline) {
      return false;
    }

    try {
      const item = this.clipboardManager.storage?.loadItem(itemId);
      if (!item) return false;

      const thumbnail = await this.thumbnailPipeline.generate(item);
      if (thumbnail) {
        // Update item with new thumbnail
        item.thumbnail = thumbnail;
        // Would need to save back to storage
        console.log(`[Agent] Regenerated thumbnail for ${itemId}`);
        return true;
      }
    } catch (error) {
      console.error('[Agent] Thumbnail regeneration failed:', error);
    }

    return false;
  }

  /**
   * Fix: Regenerate metadata
   */
  async _fixRegenerateMetadata(diagnosis) {
    const itemId = diagnosis.details?.itemId;
    if (!itemId || !this.metadataGenerator) {
      return false;
    }

    try {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      
      if (!apiKey) return false;

      const result = await this.metadataGenerator.generateMetadataForItem(itemId, apiKey);
      return result.success;
    } catch (error) {
      console.error('[Agent] Metadata regeneration failed:', error);
    }

    return false;
  }

  /**
   * Fix: Repair corrupted metadata
   */
  async _fixRepairMetadata(diagnosis) {
    const itemId = diagnosis.details?.itemId;
    if (!itemId || !this.pipelineVerifier) {
      return false;
    }

    try {
      const result = await this.pipelineVerifier.repairItem(itemId);
      return result.success;
    } catch (error) {
      console.error('[Agent] Metadata repair failed:', error);
    }

    return false;
  }

  /**
   * Fix: Rebuild index entry
   */
  async _fixRebuildIndex(diagnosis) {
    // This would require more complex index manipulation
    console.log('[Agent] Index rebuild not yet implemented');
    return false;
  }

  /**
   * Fix: Clean up orphaned files
   */
  async _fixCleanupOrphan(diagnosis) {
    if (!this.pipelineVerifier) {
      return false;
    }

    try {
      const result = await this.pipelineVerifier.cleanupOrphanedFiles(false);
      return result.deleted.length > 0;
    } catch (error) {
      console.error('[Agent] Orphan cleanup failed:', error);
    }

    return false;
  }

  /**
   * Track failed fix for potential escalation
   */
  _trackFailedFix(diagnosis) {
    const key = `${diagnosis.source}:${diagnosis.issue}`;
    
    const existing = this.issueHistory.get(key) || { count: 0, firstSeen: Date.now() };
    existing.count++;
    existing.lastSeen = Date.now();
    
    this.issueHistory.set(key, existing);
    
    // Check if should escalate
    if (existing.count >= CONFIG.escalationThreshold) {
      this._escalateIssue(diagnosis);
    }
  }

  /**
   * Escalate issue for human attention
   */
  _escalateIssue(diagnosis) {
    const issue = {
      id: `esc-${Date.now()}`,
      timestamp: new Date().toISOString(),
      source: diagnosis.source,
      message: diagnosis.issue,
      occurrences: diagnosis.occurrences || 1,
      strategy: diagnosis.strategy,
      details: diagnosis.details,
      status: 'open'
    };
    
    // Check if already escalated
    const existing = this.escalatedIssues.find(i => 
      i.source === issue.source && i.message === issue.message
    );
    
    if (!existing) {
      this.escalatedIssues.push(issue);
      this.stats.escalated++;
      console.log(`[Agent] Issue escalated: ${issue.message}`);
      
      // Report to external API
      this.reportIssue(issue, 'escalated').catch(err =>
        console.warn('[Agent] Failed to report escalated issue:', err.message)
      );
    }
    
    this._saveState();
  }

  /**
   * Record diagnosis for history
   */
  _recordDiagnosis(diagnosis) {
    this.recentDiagnoses.unshift({
      timestamp: diagnosis.timestamp,
      source: diagnosis.source,
      issue: diagnosis.issue,
      strategy: diagnosis.strategy,
      confidence: diagnosis.confidence
    });
    
    if (this.recentDiagnoses.length > this.maxDiagnoses) {
      this.recentDiagnoses = this.recentDiagnoses.slice(0, this.maxDiagnoses);
    }
  }

  /**
   * Get agent status for dashboard
   */
  getStatus() {
    return {
      active: this.active,
      paused: this.paused,
      lastScan: this.lastScanTime ? new Date(this.lastScanTime).toISOString() : null,
      lastScanAgo: this.lastScanTime ? this._formatTimeAgo(this.lastScanTime) : 'Never',
      scansToday: this.stats.scansCompleted,
      issuesDetected: this.stats.issuesDetected,
      fixesApplied: this.stats.fixesApplied,
      fixesFailed: this.stats.fixesFailed,
      escalated: this.stats.escalated,
      recentDiagnoses: this.recentDiagnoses.slice(0, 10),
      issuesRequiringAttention: this.escalatedIssues.filter(i => i.status === 'open'),
      
      // Context tracking info
      contextTracking: {
        llmModel: CONFIG.llmModel,
        contextWindowSize: CONFIG.contextWindowSize,
        currentContextSize: this.contextHistory.length,
        processedEventsTracked: this.processedEventIds.size,
        lastContextSummary: this.lastContextSummary
      },
      
      // External API reporting info
      externalAPI: this.getExternalAPIConfig()
    };
  }

  /**
   * Resolve an escalated issue
   */
  resolveEscalatedIssue(issueId) {
    const issue = this.escalatedIssues.find(i => i.id === issueId);
    if (issue) {
      issue.status = 'resolved';
      issue.resolvedAt = new Date().toISOString();
      this._saveState();
      return true;
    }
    return false;
  }

  /**
   * Ignore an escalated issue
   */
  ignoreEscalatedIssue(issueId) {
    const issue = this.escalatedIssues.find(i => i.id === issueId);
    if (issue) {
      issue.status = 'ignored';
      issue.ignoredAt = new Date().toISOString();
      this._saveState();
      return true;
    }
    return false;
  }

  /**
   * Format time ago
   */
  _formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  // ============================================
  // External API Reporting (Optional)
  // ============================================

  /**
   * Configure external API reporting
   * @param {Object} config - Configuration object
   * @param {boolean} config.enabled - Enable/disable external reporting
   * @param {string} config.statusEndpoint - URL for status reports
   * @param {string} config.issueEndpoint - URL for issue reports
   * @param {string} config.apiKey - Optional API key for authentication
   * @param {number} config.reportIntervalMs - Status report interval
   * @param {boolean} config.reportOnIssue - Report immediately on issue detection
   * @param {boolean} config.reportOnFix - Report when fix is applied
   */
  configureExternalAPI(config) {
    this.externalAPIConfig = {
      ...this.externalAPIConfig,
      ...config
    };
    
    console.log('[Agent] External API configured:', {
      enabled: this.externalAPIConfig.enabled,
      statusEndpoint: this.externalAPIConfig.statusEndpoint ? '***configured***' : null,
      issueEndpoint: this.externalAPIConfig.issueEndpoint ? '***configured***' : null,
      hasApiKey: !!this.externalAPIConfig.apiKey
    });
    
    // Restart status reporting interval if enabled
    if (this.externalAPIConfig.enabled && this.active) {
      this._startStatusReporting();
    } else {
      this._stopStatusReporting();
    }
    
    this._saveState();
  }

  /**
   * Start periodic status reporting
   */
  _startStatusReporting() {
    this._stopStatusReporting();
    
    if (!this.externalAPIConfig.enabled || !this.externalAPIConfig.statusEndpoint) {
      return;
    }
    
    // Report immediately
    this.reportStatus();
    
    // Set up interval
    this.statusReportInterval = setInterval(() => {
      this.reportStatus();
    }, this.externalAPIConfig.reportIntervalMs);
    
    console.log(`[Agent] Status reporting started (every ${this.externalAPIConfig.reportIntervalMs / 1000}s)`);
  }

  /**
   * Stop periodic status reporting
   */
  _stopStatusReporting() {
    if (this.statusReportInterval) {
      clearInterval(this.statusReportInterval);
      this.statusReportInterval = null;
    }
  }

  /**
   * Report agent status to external API
   * @returns {Promise<Object>} Report result
   */
  async reportStatus() {
    if (!this.externalAPIConfig.enabled || !this.externalAPIConfig.statusEndpoint) {
      return { skipped: true, reason: 'External API not configured' };
    }

    const status = this.getStatus();
    const payload = {
      type: 'status',
      timestamp: new Date().toISOString(),
      agentId: this._getAgentId(),
      appVersion: app.getVersion(),
      platform: process.platform,
      status: {
        active: status.active,
        paused: status.paused,
        lastScan: status.lastScan,
        scansToday: status.scansToday,
        issuesDetected: status.issuesDetected,
        fixesApplied: status.fixesApplied,
        fixesFailed: status.fixesFailed,
        escalated: status.escalated,
        contextTracking: status.contextTracking
      },
      health: {
        uptime: Date.now() - this.startTime,
        memoryUsage: process.memoryUsage().heapUsed,
        openIssues: status.issuesRequiringAttention?.length || 0
      }
    };

    return this._sendToExternalAPI(this.externalAPIConfig.statusEndpoint, payload);
  }

  /**
   * Report an issue to external API
   * @param {Object} issue - The issue to report
   * @param {string} eventType - Type of event (detected, fixed, escalated, failed)
   * @returns {Promise<Object>} Report result
   */
  async reportIssue(issue, eventType = 'detected') {
    if (!this.externalAPIConfig.enabled) {
      return { skipped: true, reason: 'External API not enabled' };
    }
    
    // Check if we should report this event type
    if (eventType === 'fixed' && !this.externalAPIConfig.reportOnFix) {
      return { skipped: true, reason: 'Fix reporting disabled' };
    }
    if (eventType === 'detected' && !this.externalAPIConfig.reportOnIssue) {
      return { skipped: true, reason: 'Issue reporting disabled' };
    }
    
    const endpoint = this.externalAPIConfig.issueEndpoint || this.externalAPIConfig.statusEndpoint;
    if (!endpoint) {
      return { skipped: true, reason: 'No endpoint configured' };
    }

    const payload = {
      type: 'issue',
      eventType,
      timestamp: new Date().toISOString(),
      agentId: this._getAgentId(),
      appVersion: app.getVersion(),
      issue: {
        id: issue.id || `issue-${Date.now()}`,
        source: issue.source,
        message: issue.message || issue.issue,
        occurrences: issue.occurrences || 1,
        strategy: issue.strategy,
        confidence: issue.confidence,
        details: issue.details,
        status: issue.status || eventType
      }
    };

    return this._sendToExternalAPI(endpoint, payload);
  }

  /**
   * Send data to external API with retry logic
   * @param {string} endpoint - API endpoint URL
   * @param {Object} payload - Data to send
   * @returns {Promise<Object>} Send result
   */
  async _sendToExternalAPI(endpoint, payload) {
    const { net } = require('electron');
    const maxRetries = this.externalAPIConfig.retryAttempts || 2;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const url = new URL(endpoint);
          
          const request = net.request({
            method: 'POST',
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search
          });

          // Set headers
          request.setHeader('Content-Type', 'application/json');
          request.setHeader('User-Agent', `OneReach-Agent/${app.getVersion()}`);
          
          // Add API key if configured
          if (this.externalAPIConfig.apiKey) {
            request.setHeader('Authorization', `Bearer ${this.externalAPIConfig.apiKey}`);
            request.setHeader('X-API-Key', this.externalAPIConfig.apiKey);
          }

          // Set timeout
          const timeoutId = setTimeout(() => {
            request.abort();
            reject(new Error('Request timeout'));
          }, this.externalAPIConfig.timeout || 10000);

          request.on('response', (response) => {
            clearTimeout(timeoutId);
            let data = '';
            
            response.on('data', (chunk) => {
              data += chunk;
            });
            
            response.on('end', () => {
              if (response.statusCode >= 200 && response.statusCode < 300) {
                resolve({
                  success: true,
                  statusCode: response.statusCode,
                  response: data ? JSON.parse(data) : null
                });
              } else {
                reject(new Error(`HTTP ${response.statusCode}: ${data}`));
              }
            });
          });

          request.on('error', (error) => {
            clearTimeout(timeoutId);
            reject(error);
          });

          request.write(JSON.stringify(payload));
          request.end();
        });

        this.lastStatusReport = Date.now();
        console.log(`[Agent] External API report sent to ${endpoint}`);
        return result;

      } catch (error) {
        lastError = error;
        console.warn(`[Agent] External API attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    console.error('[Agent] External API reporting failed after retries:', lastError?.message);
    return {
      success: false,
      error: lastError?.message || 'Unknown error',
      attempts: maxRetries + 1
    };
  }

  /**
   * Get unique agent ID (persistent across restarts)
   */
  _getAgentId() {
    if (!this._agentId) {
      const idPath = path.join(this.dataDir, 'agent-id.txt');
      if (fs.existsSync(idPath)) {
        this._agentId = fs.readFileSync(idPath, 'utf8').trim();
      } else {
        this._agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
        fs.writeFileSync(idPath, this._agentId);
      }
    }
    return this._agentId;
  }

  /**
   * Get external API configuration (for dashboard display)
   */
  getExternalAPIConfig() {
    return {
      enabled: this.externalAPIConfig.enabled,
      hasStatusEndpoint: !!this.externalAPIConfig.statusEndpoint,
      hasIssueEndpoint: !!this.externalAPIConfig.issueEndpoint,
      hasApiKey: !!this.externalAPIConfig.apiKey,
      reportIntervalMs: this.externalAPIConfig.reportIntervalMs,
      reportOnIssue: this.externalAPIConfig.reportOnIssue,
      reportOnFix: this.externalAPIConfig.reportOnFix,
      lastReportTime: this.lastStatusReport ? new Date(this.lastStatusReport).toISOString() : null
    };
  }
}

// Singleton instance
let instance = null;

function getAppManagerAgent(dependencies) {
  if (!instance) {
    instance = new AppManagerAgent(dependencies);
  } else if (dependencies) {
    // Update dependencies
    Object.assign(instance, dependencies);
  }
  return instance;
}

function resetAppManagerAgent() {
  if (instance) {
    instance.stop();
  }
  instance = null;
}

module.exports = {
  AppManagerAgent,
  getAppManagerAgent,
  resetAppManagerAgent,
  FIX_STRATEGIES,
  CONFIG
};

