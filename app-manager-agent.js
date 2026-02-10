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
const ai = require('./lib/ai-service');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

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

// Fallback strategies - when primary fix fails, try these alternatives
const FALLBACK_STRATEGIES = {
  [FIX_STRATEGIES.REBUILD_INDEX]: [
    FIX_STRATEGIES.CLEANUP_ORPHAN,
    FIX_STRATEGIES.REPAIR_METADATA
  ],
  [FIX_STRATEGIES.REGENERATE_THUMBNAIL]: [
    FIX_STRATEGIES.CLEANUP_ORPHAN
  ],
  [FIX_STRATEGIES.REGENERATE_METADATA]: [
    FIX_STRATEGIES.REPAIR_METADATA,
    FIX_STRATEGIES.CLEANUP_ORPHAN
  ],
  [FIX_STRATEGIES.REPAIR_METADATA]: [
    FIX_STRATEGIES.CLEANUP_ORPHAN
  ],
  [FIX_STRATEGIES.RETRY]: [
    FIX_STRATEGIES.SKIP  // After retries fail, skip
  ]
};

// Maximum attempts before escalating to user
const MAX_FIX_ATTEMPTS_BEFORE_ESCALATION = 3;

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
    
    // Broken Items Registry - tracks all items/errors that break
    // Auto-clears when app version changes
    this.brokenItemsRegistry = [];
    this.lastKnownAppVersion = null;
    this.maxBrokenItems = 500;
    
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

  /**
   * Broadcast HUD activity update to all windows
   * Uses global function set up by main.js
   */
  _broadcastHUD(data) {
    try {
      if (global.broadcastHUDActivity) {
        global.broadcastHUDActivity(data);
      }
    } catch (e) {
      // Silently ignore if not available
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
          log.info('agent', 'Loaded ... context entries from previous session', { contextHistoryCount: this.contextHistory.length })
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
          log.info('agent', 'Loaded ... processed event IDs', { processedEventIdsSize: this.processedEventIds.size })
        }
        
        if (data.lastContextSummary) {
          this.lastContextSummary = data.lastContextSummary;
        }
        
        // Load eventFingerprints for deduplication (NEW)
        if (data.eventFingerprints && Array.isArray(data.eventFingerprints)) {
          const now = Date.now();
          for (const [fingerprint, timestamp] of data.eventFingerprints) {
            // Only load fingerprints from the last hour
            if (now - timestamp < CONFIG.processedEventTTL) {
              this.eventFingerprints.set(fingerprint, timestamp);
            }
          }
          log.info('agent', 'Loaded ... event fingerprints', { eventFingerprintsSize: this.eventFingerprints.size })
        }
        
        // Load external API config (if previously configured)
        if (data.externalAPIConfig) {
          this.externalAPIConfig = { ...CONFIG.externalAPI, ...data.externalAPIConfig };
          log.info('agent', 'Loaded external API config, enabled', { enabled: this.externalAPIConfig.enabled })
        }
        
        // Load broken items registry
        if (data.brokenItemsRegistry) {
          this.brokenItemsRegistry = data.brokenItemsRegistry.slice(0, this.maxBrokenItems);
          log.info('agent', 'Loaded ... broken items from registry', { brokenItemsRegistryCount: this.brokenItemsRegistry.length })
        }
        
        // Load last known app version
        if (data.lastKnownAppVersion) {
          this.lastKnownAppVersion = data.lastKnownAppVersion;
        }
      }
    } catch (error) {
      log.error('agent', 'Error loading state', { error: error.message || error })
    }
  }

  _saveState() {
    try {
      const statePath = path.join(this.dataDir, 'agent-state.json');
      
      // Convert Sets and Maps to arrays for JSON serialization
      const processedIds = [...this.processedEventIds];
      const processedTimestamps = processedIds.map(id => this.processedEventTimestamps.get(id));
      
      // Convert eventFingerprints Map to array for persistence
      const fingerprintEntries = [...this.eventFingerprints.entries()].slice(0, CONFIG.maxProcessedEventsCache);
      
      const data = {
        stats: this.stats,
        escalatedIssues: this.escalatedIssues,
        recentDiagnoses: this.recentDiagnoses,
        
        // Context tracking for LLM continuity
        contextHistory: this.contextHistory.slice(0, CONFIG.contextWindowSize),
        processedEventIds: processedIds.slice(0, CONFIG.maxProcessedEventsCache),
        processedEventTimestamps: processedTimestamps.slice(0, CONFIG.maxProcessedEventsCache),
        eventFingerprints: fingerprintEntries, // NEW: persist fingerprints for deduplication
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
        
        // Broken items registry - tracks all errors for this version
        brokenItemsRegistry: this.brokenItemsRegistry.slice(0, this.maxBrokenItems),
        lastKnownAppVersion: this.lastKnownAppVersion || app.getVersion(),
        
        lastSaved: new Date().toISOString()
      };
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
    } catch (error) {
      log.error('agent', 'Error saving state', { error: error.message || error })
    }
  }

  /**
   * Start the agent
   */
  start() {
    if (this.active) {
      log.info('agent', 'Already running')
      return;
    }
    
    log.info('agent', 'Starting App Manager Agent...')
    this.active = true;
    this.paused = false;
    this.startTime = Date.now();
    
    // Check for version update and clear broken items if new version
    this._checkVersionAndClearRegistry();
    
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
    
    log.info('agent', 'Started. Scanning every ...s', { detail: CONFIG.scanIntervalMs / 1000 })
  }

  /**
   * Check if app version changed and clear broken items registry
   */
  _checkVersionAndClearRegistry() {
    const currentVersion = app.getVersion();
    
    if (this.lastKnownAppVersion && this.lastKnownAppVersion !== currentVersion) {
      log.info('agent', 'App updated: ... -> ...', { lastKnownAppVersion: this.lastKnownAppVersion, currentVersion })
      log.info('agent', 'Clearing ... broken items from previous version', { brokenItemsRegistryCount: this.brokenItemsRegistry.length })
      
      // Archive old broken items before clearing (for reference)
      this._archiveBrokenItems(this.lastKnownAppVersion);
      
      // Clear the registry
      this.brokenItemsRegistry = [];
      this.escalatedIssues = [];
      this.issueHistory.clear();
      this.processedEventIds.clear();
      this.processedEventTimestamps.clear();
      this.eventFingerprints.clear();
      
      // Reset daily stats for fresh start
      this.stats = {
        scansCompleted: 0,
        issuesDetected: 0,
        fixesApplied: 0,
        fixesFailed: 0,
        escalated: 0,
        lastReset: new Date().toDateString()
      };
      
      log.info('agent', 'Registry cleared for new version')
    }
    
    this.lastKnownAppVersion = currentVersion;
    this._saveState();
  }

  /**
   * Archive broken items from previous version
   */
  _archiveBrokenItems(previousVersion) {
    if (this.brokenItemsRegistry.length === 0) return;
    
    try {
      const archivePath = path.join(this.dataDir, `broken-items-archive-${previousVersion}.json`);
      const archiveData = {
        version: previousVersion,
        archivedAt: new Date().toISOString(),
        items: this.brokenItemsRegistry
      };
      fs.writeFileSync(archivePath, JSON.stringify(archiveData, null, 2));
      log.info('agent', 'Archived broken items', { count: this.brokenItemsRegistry.length, archivePath })
    } catch (error) {
      log.error('agent', 'Error archiving broken items', { error: error.message })
    }
  }

  /**
   * Stop the agent
   */
  stop() {
    if (!this.active) return;
    
    log.info('agent', 'Stopping...')
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
        log.warn('agent', 'Failed to send final status report', { error: err.message })
      );
    }
    
    this._saveState();
    log.info('agent', 'Stopped')
  }

  /**
   * Pause scanning (agent stays active but doesn't scan)
   */
  pause() {
    this.paused = true;
    log.info('agent', 'Paused')
  }

  /**
   * Resume scanning
   */
  resume() {
    this.paused = false;
    log.info('agent', 'Resumed')
  }

  /**
   * Run a scan manually
   */
  async runScan() {
    if (this.paused) {
      return { skipped: true, reason: 'Agent paused' };
    }
    
    const scanStart = Date.now();
    log.info('agent', 'Starting scan...')
    
    // Broadcast HUD: scan starting
    this._broadcastHUD({
      type: 'agent',
      phase: 'Monitor',
      action: 'Scanning for errors...'
    });
    
    const result = {
      timestamp: new Date().toISOString(),
      errorsFound: 0,
      issuesDiagnosed: 0,
      newDiagnoses: 0,      // NEW: Track diagnoses that required LLM (not cached)
      cachedDiagnoses: 0,   // NEW: Track diagnoses that used cache
      fixesApplied: 0,
      fixesFailed: 0,
      duration: 0
    };

    try {
      // Get recent errors from event log
      const errors = await this._getRecentErrors();
      result.errorsFound = errors.length;
      
      if (errors.length === 0) {
        log.info('agent', 'No errors found')
        this.stats.scansCompleted++;
        this.lastScanTime = Date.now();
        return result;
      }
      
      log.info('agent', 'Found ... errors to analyze', { errorsCount: errors.length })
      
      // Broadcast HUD: errors found
      this._broadcastHUD({
        type: 'agent',
        phase: 'Monitor',
        action: `Analyzing ${errors.length} errors...`,
        task: `Found ${errors.length} issues to diagnose`
      });
      
      // Group errors by type/source
      const groupedErrors = this._groupErrors(errors);
      
      // Diagnose and fix each group
      for (const [key, errorGroup] of Object.entries(groupedErrors)) {
        try {
          const diagnosis = await this._diagnoseError(errorGroup);
          result.issuesDiagnosed++;
          
          // Track whether this was a new diagnosis or cached
          if (diagnosis.details?.cached) {
            result.cachedDiagnoses++;
          } else {
            result.newDiagnoses++;
            this.stats.issuesDetected++;  // Only count new detections
          }
          
          // Register in broken items registry (tracks all errors for this version)
          this.registerBrokenItem(errorGroup, diagnosis);
          
          if (diagnosis.strategy !== FIX_STRATEGIES.SKIP && 
              diagnosis.strategy !== FIX_STRATEGIES.ESCALATE) {
            // Track fix attempt
            this.incrementFixAttempt(errorGroup);
            
            // Use escalation chain: primary -> alternatives -> AI workaround -> user
            const fixResult = await this._applyFixWithEscalation(diagnosis, errorGroup);
            
            if (fixResult.success) {
              result.fixesApplied++;
              this.stats.fixesApplied++;
              
              // Broadcast HUD: fix applied
              this._broadcastHUD({
                type: 'agent',
                phase: 'Monitor',
                action: 'Fix applied!',
                recent: `Fixed: ${diagnosis.issue?.substring(0, 30) || 'Error'}...`
              });
              
              // Update broken item status to fixed
              const normalizedMsg = this._normalizeErrorMessage(errorGroup.message);
              const brokenItem = this.brokenItemsRegistry.find(i => 
                i.normalizedMessage === normalizedMsg
              );
              if (brokenItem) {
                this.updateBrokenItemStatus(brokenItem.id, 'fixed', { 
                  strategy: diagnosis.strategy,
                  attempts: fixResult.attempts 
                });
              }
              
              // Update context history with success
              this._updateContextHistoryResult(diagnosis, true);
              
              // Record to dashboard
              if (this.dashboardAPI) {
                this.dashboardAPI.recordAutoFix(
                  diagnosis.issue,
                  diagnosis.strategy,
                  'success',
                  { operationId: diagnosis.operationId, attempts: fixResult.attempts }
                );
              }
              
              // Report fix to external API
              this.reportIssue(diagnosis, 'fixed').catch(err =>
                log.warn('agent', 'Failed to report fixed issue', { error: err.message })
              );
            } else if (fixResult.escalated) {
              // Error was escalated to user - don't count as failed, just waiting
              result.escalated = (result.escalated || 0) + 1;
              log.info('agent', `[Agent] Error escalated to user, awaiting intervention`)
              
              // Update context history
              this._updateContextHistoryResult(diagnosis, false, { escalated: true });
            } else {
              result.fixesFailed++;
              this.stats.fixesFailed++;
              
              // Update context history with failure
              this._updateContextHistoryResult(diagnosis, false);
              
              // Report failure to external API
              this.reportIssue(diagnosis, 'failed').catch(err =>
                log.warn('agent', 'Failed to report fix failure', { error: err.message })
              );
            }
          } else if (diagnosis.strategy === FIX_STRATEGIES.ESCALATE) {
            this._escalateIssue(diagnosis);
          }
          
          // Record diagnosis
          this._recordDiagnosis(diagnosis);
          
        } catch (diagError) {
          log.error('agent', 'Diagnosis error', { diagError })
        }
      }
      
    } catch (error) {
      log.error('agent', 'Scan error', { error: error.message || error })
    }
    
    result.duration = Date.now() - scanStart;
    this.stats.scansCompleted++;
    this.lastScanTime = Date.now();
    this._saveState();
    
    log.info('agent', 'Scan complete. Fixed: ..., Failed: ...', { fixesApplied: result.fixesApplied, fixesFailed: result.fixesFailed })
    
    // Broadcast HUD: scan complete
    this._broadcastHUD({
      type: 'agent',
      phase: 'Monitor',
      action: result.fixesApplied > 0 
        ? `Scan complete: ${result.fixesApplied} fixed` 
        : 'Scan complete',
      task: `Scanned ${result.errorsFound} errors`
    });
    
    // Generate AI summary of activity
    await this._generateActivitySummary(result);
    
    return result;
  }

  /**
   * Generate AI summary of recent activity
   * Called after each scan cycle to provide human-readable status
   */
  async _generateActivitySummary(scanResult) {
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      // Prefer anthropicApiKey for Claude API calls
      const apiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
      
      if (!apiKey) {
        log.info('agent', 'No API key for activity summary')
        return;
      }

      // Collect activity context
      const context = this._collectActivityContext(scanResult);
      
      // Skip if nothing interesting to summarize
      if (!context.hasActivity) {
        return;
      }

      const prompt = `You are a helpful AI assistant summarizing app activity for a developer.

Current App State:
${context.appState}

Recent Activity:
${context.activity}

Provide a single, concise sentence (max 80 chars) summarizing what's happening.
Focus on the most important/actionable item.
Use present tense, be specific but brief.
Examples:
- "Monitoring API rate limits, 3 errors auto-fixed"
- "Building login form, editing LoginForm.jsx"
- "Scan complete, all systems healthy"

Summary:`;

      const startTime = Date.now();
      const response = await ai.complete(prompt, {
        profile: 'standard',
        maxTokens: 150,
        system: 'You are a concise status summarizer. Respond with only the summary, nothing else.',
        feature: 'app-manager-agent'
      });
      const elapsed = Date.now() - startTime;
      
      if (response) {
        const summary = response.trim().replace(/^["']|["']$/g, '').substring(0, 100);
        
        log.info('agent', 'AI Summary (...ms): ...', { elapsed, summary })
        
        // Broadcast summary to HUD
        this._broadcastHUD({
          type: 'summary',
          phase: 'Monitor',
          action: summary,
          aiGenerated: true
        });
        
        // Send to chat as system message
        this._broadcastHUD({
          type: 'chat',
          message: `🤖 ${summary}`,
          aiGenerated: true
        });
        
        // Track cost
        const inputTokens = Math.ceil(prompt.length / 4);
        const outputTokens = Math.ceil(response.length / 4);
        const estimatedCost = (inputTokens * 0.003 + outputTokens * 0.015) / 1000; // Sonnet pricing
        
        this._broadcastHUD({
          type: 'cost',
          model: 'claude-sonnet-4-5-20250929',
          inputTokens,
          outputTokens,
          cost: estimatedCost,
          feature: 'agent-summary'
        });
      }
    } catch (error) {
      log.error('agent', 'Activity summary error', { error: error.message })
    }
  }

  /**
   * Collect activity context for AI summarization
   */
  _collectActivityContext(scanResult) {
    const context = {
      hasActivity: false,
      appState: '',
      activity: ''
    };
    
    // App state
    const appStateLines = [];
    appStateLines.push(`- Scans completed today: ${this.stats.scansCompleted}`);
    appStateLines.push(`- Issues detected: ${this.stats.issuesDetected}`);
    appStateLines.push(`- Fixes applied: ${this.stats.fixesApplied}`);
    appStateLines.push(`- Broken items tracked: ${this.brokenItemsRegistry.length}`);
    
    if (this.escalatedIssues.length > 0) {
      appStateLines.push(`- Escalated issues awaiting user: ${this.escalatedIssues.length}`);
    }
    
    context.appState = appStateLines.join('\n');
    
    // Recent activity from this scan
    const activityLines = [];
    
    // Only count NEW diagnoses as activity (not cached ones)
    // This prevents LLM summary calls when just incrementing occurrence counts
    if (scanResult.newDiagnoses > 0) {
      activityLines.push(`- Diagnosed ${scanResult.newDiagnoses} NEW errors this scan`);
      context.hasActivity = true;
    }
    
    // Log cached diagnoses for info but don't trigger activity
    if (scanResult.cachedDiagnoses > 0) {
      activityLines.push(`- Updated ${scanResult.cachedDiagnoses} existing tracked errors`);
      // Note: NOT setting hasActivity - cached diagnoses don't need new summaries
    }
    
    if (scanResult.fixesApplied > 0) {
      activityLines.push(`- Applied ${scanResult.fixesApplied} automatic fixes`);
      context.hasActivity = true;
    }
    
    if (scanResult.fixesFailed > 0) {
      activityLines.push(`- ${scanResult.fixesFailed} fixes failed`);
      context.hasActivity = true;
    }
    
    // Include recent diagnoses for context (but don't trigger summary just for historical data)
    if (this.recentDiagnoses.length > 0 && context.hasActivity) {
      const recentIssues = this.recentDiagnoses.slice(0, 3).map(d => 
        `- ${d.issue?.substring(0, 50) || 'Unknown issue'}`
      );
      activityLines.push('Recent issues:');
      activityLines.push(...recentIssues);
      // Note: Don't set hasActivity here - this is historical context, not new activity
    }
    
    // Include top broken items for context (but don't trigger summary just for historical data)
    if (this.brokenItemsRegistry.length > 0 && context.hasActivity) {
      const topBroken = this.brokenItemsRegistry
        .filter(b => b.status !== 'fixed')
        .slice(0, 2)
        .map(b => `- ${b.normalizedMessage?.substring(0, 40) || 'Error'} (${b.occurrences}x)`);
      
      if (topBroken.length > 0) {
        activityLines.push('Top issues:');
        activityLines.push(...topBroken);
        // Note: Don't set hasActivity here - this is historical context, not new activity
      }
    }
    
    context.activity = activityLines.join('\n') || 'No significant activity';
    
    // Only generate summary if THIS scan had meaningful activity
    // Don't burn LLM tokens just because historical scans happened
    // hasActivity is already set to true by the checks above when there's actual activity
    
    return context;
  }

  /**
   * Get recent errors from event log AND console logs
   * Filters out already processed events and deduplicates similar events
   */
  async _getRecentErrors() {
    const allErrors = [];
    
    // Clean up old processed event tracking
    this._cleanupProcessedEvents();
    
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    // 1. Get errors from event-db
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      const logs = await eventDb.getEventLogs({ limit: 200 });
      
      const eventDbErrors = logs.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        const isError = (log.level === 'error' || log.level === 'ERROR');
        const isRecent = logTime > oneHourAgo;
        
        if (this.processedEventIds.has(log.id)) return false;
        
        const fingerprint = this._getEventFingerprint(log);
        if (this._isDuplicateEvent(fingerprint, logTime)) return false;
        
        return isError && isRecent;
      });
      
      allErrors.push(...eventDbErrors);
    } catch (error) {
      log.warn('agent', 'Error fetching event-db logs', { error: error.message })
    }
    
    // 2. Get errors from console log files (NDJSON format)
    try {
      const consoleErrors = await this._getConsoleErrors(oneHourAgo);
      allErrors.push(...consoleErrors);
    } catch (error) {
      log.warn('agent', 'Error fetching console logs', { error: error.message })
    }
    
    // Sort by timestamp (newest first) and deduplicate
    allErrors.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return allErrors.slice(0, CONFIG.maxErrorsPerScan);
  }

  /**
   * Get errors from console log files (NDJSON format)
   * These contain console.error messages that may not be in event-db
   */
  async _getConsoleErrors(sinceTimestamp) {
    const errors = [];
    
    try {
      const logsDir = path.join(app.getPath('userData'), 'logs');
      
      if (!fs.existsSync(logsDir)) {
        return errors;
      }
      
      // Get log files from last 24 hours
      const files = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, 5); // Check last 5 log files
      
      for (const file of files) {
        const filePath = path.join(logsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        
        // Parse NDJSON and filter for errors
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            
            // Check if it's an error level log
            if (entry.level === 'ERROR' || entry.level === 'error') {
              const logTime = new Date(entry.timestamp).getTime();
              
              // Skip if too old
              if (logTime < sinceTimestamp) continue;
              
              // Create a normalized error object
              const errorObj = {
                id: `console-${logTime}-${Math.random().toString(36).substr(2, 5)}`,
                timestamp: entry.timestamp,
                level: 'error',
                source: 'console',
                category: entry.consoleMethod || 'error',
                message: entry.message || 'Unknown error',
                details: entry.args || entry.data || null
              };
              
              // Skip if already processed
              if (this.processedEventIds.has(errorObj.id)) continue;
              
              // Skip duplicates
              const fingerprint = this._getEventFingerprint(errorObj);
              if (this._isDuplicateEvent(fingerprint, logTime)) continue;
              
              // Skip agent's own "no errors found" messages
              if (errorObj.message.includes('[Agent]')) continue;
              
              // Skip known noise
              if (errorObj.message.includes('service_worker_storage') || 
                  errorObj.message.includes('Failed to delete the database')) continue;
              
              errors.push(errorObj);
            }
          } catch (parseError) {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (error) {
      log.warn('agent', 'Error reading console logs', { error: error.message })
    }
    
    return errors;
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

  // ============================================
  // Broken Items Registry
  // ============================================

  /**
   * Register a broken item in the registry
   * This tracks all errors/issues for the current app version
   * Registry is auto-cleared when app updates to a new version
   */
  registerBrokenItem(errorGroup, diagnosis = null) {
    const brokenItem = {
      id: `broken-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      registeredAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      source: errorGroup.source || 'unknown',
      message: errorGroup.message,
      normalizedMessage: this._normalizeErrorMessage(errorGroup.message),
      occurrences: errorGroup.count || 1,
      firstSeen: errorGroup.errors?.[0]?.timestamp || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      sampleErrors: (errorGroup.errors || []).slice(0, 3).map(e => ({
        timestamp: e.timestamp,
        message: e.message,
        details: e.details
      })),
      diagnosis: diagnosis ? {
        strategy: diagnosis.strategy,
        confidence: diagnosis.confidence,
        details: diagnosis.details
      } : null,
      status: 'open', // open, fixed, ignored
      fixAttempts: 0
    };
    
    // Check if similar item already exists
    const existingIndex = this.brokenItemsRegistry.findIndex(item => 
      item.normalizedMessage === brokenItem.normalizedMessage &&
      item.source === brokenItem.source
    );
    
    if (existingIndex >= 0) {
      // Update existing entry
      const existing = this.brokenItemsRegistry[existingIndex];
      existing.occurrences += brokenItem.occurrences;
      existing.lastSeen = brokenItem.lastSeen;
      if (brokenItem.diagnosis) {
        existing.diagnosis = brokenItem.diagnosis;
      }
      log.info('agent', 'Updated broken item: ... (... occurrences)', { normalizedMessage: existing.normalizedMessage, occurrences: existing.occurrences })
    } else {
      // Add new entry
      this.brokenItemsRegistry.unshift(brokenItem);
      
      // Trim if too large
      if (this.brokenItemsRegistry.length > this.maxBrokenItems) {
        this.brokenItemsRegistry = this.brokenItemsRegistry.slice(0, this.maxBrokenItems);
      }
      
      log.info('agent', 'Registered broken item: ...', { normalizedMessage: brokenItem.normalizedMessage })
    }
    
    this._saveState();
    return brokenItem;
  }

  /**
   * Update broken item status (fixed, ignored)
   */
  updateBrokenItemStatus(itemId, status, details = {}) {
    const item = this.brokenItemsRegistry.find(i => i.id === itemId);
    if (item) {
      item.status = status;
      item.statusUpdatedAt = new Date().toISOString();
      item.statusDetails = details;
      this._saveState();
      return true;
    }
    return false;
  }

  /**
   * Increment fix attempt counter for broken item
   */
  incrementFixAttempt(errorGroup) {
    const normalizedMsg = this._normalizeErrorMessage(errorGroup.message);
    const item = this.brokenItemsRegistry.find(i => 
      i.normalizedMessage === normalizedMsg &&
      i.source === (errorGroup.source || 'unknown')
    );
    if (item) {
      item.fixAttempts++;
      item.lastFixAttempt = new Date().toISOString();
      this._saveState();
    }
  }

  /**
   * Get broken items registry (for dashboard display)
   */
  getBrokenItemsRegistry(options = {}) {
    const { status = 'all', limit = 50 } = options;
    
    let items = this.brokenItemsRegistry;
    
    if (status !== 'all') {
      items = items.filter(i => i.status === status);
    }
    
    return {
      appVersion: app.getVersion(),
      totalItems: this.brokenItemsRegistry.length,
      openItems: this.brokenItemsRegistry.filter(i => i.status === 'open').length,
      items: items.slice(0, limit),
      lastCleared: this.lastKnownAppVersion !== app.getVersion() ? 'pending' : null
    };
  }

  /**
   * Manually clear broken items registry
   */
  clearBrokenItemsRegistry(archive = true) {
    if (archive && this.brokenItemsRegistry.length > 0) {
      this._archiveBrokenItems(`manual-${Date.now()}`);
    }
    
    const count = this.brokenItemsRegistry.length;
    this.brokenItemsRegistry = [];
    this._saveState();
    
    log.info('agent', 'Manually cleared ... broken items from registry', { count })
    return { cleared: count };
  }

  /**
   * Get archived broken items from previous versions
   */
  getArchivedBrokenItems() {
    const archives = [];
    
    try {
      const files = fs.readdirSync(this.dataDir);
      const archiveFiles = files.filter(f => f.startsWith('broken-items-archive-') && f.endsWith('.json'));
      
      for (const file of archiveFiles) {
        try {
          const filePath = path.join(this.dataDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          archives.push({
            filename: file,
            version: data.version,
            archivedAt: data.archivedAt,
            itemCount: data.items?.length || 0,
            items: data.items || []
          });
        } catch (err) {
          log.warn('agent', 'Error reading archive ...', { file })
        }
      }
      
      // Sort by archive date (newest first)
      archives.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
    } catch (error) {
      log.error('agent', 'Error reading archived broken items', { error: error.message || error })
    }
    
    return archives;
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
      // ARCHITECTURAL FIX: Check if this error type was already diagnosed
      // Reuse cached diagnosis from brokenItemsRegistry instead of calling LLM again
      const normalizedMsg = this._normalizeErrorMessage(errorGroup.message);
      const existingItem = this.brokenItemsRegistry.find(item => 
        item.normalizedMessage === normalizedMsg && 
        item.source === (errorGroup.source || 'unknown')
      );
      
      if (existingItem && existingItem.diagnosis) {
        log.info('agent', 'Using cached diagnosis for: ......', { detail: normalizedMsg.substring(0, 50) })
        return {
          ...diagnosis,
          strategy: existingItem.diagnosis.strategy,
          confidence: existingItem.diagnosis.confidence,
          details: { 
            ...existingItem.diagnosis.details, 
            cached: true,
            originalDiagnosisTime: existingItem.registeredAt
          }
        };
      }

      // Check if this is a known pattern we can fix without LLM
      const quickFix = this._checkQuickFix(errorGroup);
      if (quickFix) {
        return { ...diagnosis, ...quickFix };
      }

      // Use LLM for complex diagnosis - ONLY for truly new error types
      const llmDiagnosis = await this._llmDiagnose(errorGroup);
      if (llmDiagnosis) {
        return { ...diagnosis, ...llmDiagnosis };
      }

    } catch (error) {
      log.error('agent', 'Diagnosis error', { error: error.message || error })
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
    
    // CRITICAL: Skip configuration/authentication errors entirely
    // These are NOT item problems and should NEVER trigger item cleanup/deletion
    const configurationErrors = [
      'invalid x-api-key',
      'invalid api key',
      'api key',
      'unauthorized',
      '401',
      '403',
      'authentication failed',
      'auth failed',
      'not authenticated',
      'invalid credentials',
      'expired token',
      'invalid token'
    ];
    
    if (configurationErrors.some(pattern => message.includes(pattern))) {
      log.info('agent', 'Skipping configuration error (not an item problem): ...', { detail: message.substring(0, 80) })
      return {
        strategy: FIX_STRATEGIES.SKIP,
        confidence: 100,
        details: { 
          reason: 'Configuration/authentication error - not an item problem',
          action: 'User needs to check API key settings'
        }
      };
    }
    
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
    
    // Skip test log messages - these are development artifacts
    if (message.includes('test log message') || message.includes('test error')) {
      return {
        strategy: FIX_STRATEGIES.SKIP,
        confidence: 100,
        details: { reason: 'Test message - no action needed' }
      };
    }
    
    // Skip "file does not exist" warnings - these are non-critical
    if (message.includes('file does not exist') || message.includes('no content file found')) {
      return {
        strategy: FIX_STRATEGIES.SKIP,
        confidence: 90,
        details: { reason: 'Missing optional file - no action needed' }
      };
    }
    
    // Skip console.error wrappers that are just noise
    if (message.startsWith('[console.error]') && message.length < 50) {
      return {
        strategy: FIX_STRATEGIES.SKIP,
        confidence: 85,
        details: { reason: 'Generic console error wrapper' }
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
      // Prefer anthropicApiKey for Claude API calls
      const apiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
      
      if (!apiKey) {
        log.info('agent', 'No API key for LLM diagnosis')
        return null;
      }

      // Build prompt with context
      const prompt = this._buildDiagnosisPromptWithContext(errorGroup);
      
      log.info('agent', 'Sending diagnosis to ... with ... chars context', { llmModel: CONFIG.llmModel, promptCount: prompt.length })
      
      const response = await ai.chat({
        profile: 'powerful', // Claude Opus equivalent
        messages: [
          { role: 'user', content: prompt }
        ],
        maxTokens: CONFIG.llmMaxTokens,
        temperature: 0.2, // Lower for more consistent diagnosis
        feature: 'app-manager-agent'
      });

      if (response && response.content) {
        const diagnosis = this._parseLLMDiagnosis(response.content);
        
        // Update context history with this diagnosis
        this._updateContextHistory(errorGroup, diagnosis);
        
        return diagnosis;
      }

    } catch (error) {
      log.error('agent', 'LLM diagnosis error', { error: error.message || error })
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
      log.error('agent', 'Error parsing LLM response', { error: error.message || error })
    }
    
    return null;
  }

  /**
   * Apply a fix based on diagnosis
   */
  async _applyFix(diagnosis) {
    log.info('agent', 'Applying fix: ...', { strategy: diagnosis.strategy })
    
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
      log.error('agent', 'Fix application error', { error: error.message || error })
      result.details = { error: error.message };
    }

    return result;
  }

  /**
   * Apply fix with smart escalation chain
   * Tries: primary strategy -> alternatives -> AI workaround -> user escalation
   */
  async _applyFixWithEscalation(diagnosis, errorGroup) {
    const attempts = [];
    const normalizedMsg = this._normalizeErrorMessage(errorGroup?.message || diagnosis.issue);
    
    // Check if this error has already been escalated and is pending user action
    const existingEscalation = this.escalatedIssues.find(e => 
      e.normalizedMessage === normalizedMsg && e.status === 'pending_user'
    );
    if (existingEscalation) {
      log.info('agent', 'Error already escalated, waiting for user: ...', { detail: normalizedMsg.substring(0, 50) })
      return { success: false, escalated: true, waitingForUser: true };
    }
    
    // Check fix attempt count from broken items registry
    const brokenItem = this.brokenItemsRegistry.find(i => 
      i.normalizedMessage === normalizedMsg
    );
    const attemptCount = brokenItem?.fixAttempts || 0;
    
    // Step 1: Try primary strategy
    log.info('agent', 'Escalation Step 1: Trying primary strategy ...', { strategy: diagnosis.strategy })
    let result = await this._applyFix(diagnosis);
    attempts.push({ strategy: diagnosis.strategy, success: result.success, step: 'primary' });
    
    if (result.success) {
      log.info('agent', `[Agent] Primary fix succeeded`)
      return { ...result, attempts };
    }
    
    // Step 2: Try alternative strategies
    const alternatives = FALLBACK_STRATEGIES[diagnosis.strategy] || [];
    if (alternatives.length > 0) {
      log.info('agent', 'Escalation Step 2: Trying ... alternative strategies', { alternativesCount: alternatives.length })
      for (const altStrategy of alternatives) {
        const altDiagnosis = { ...diagnosis, strategy: altStrategy };
        result = await this._applyFix(altDiagnosis);
        attempts.push({ strategy: altStrategy, success: result.success, step: 'alternative' });
        
        if (result.success) {
          log.info('agent', 'Alternative fix ... succeeded', { altStrategy })
          return { ...result, attempts };
        }
      }
    }
    
    // Step 3: Ask AI for creative workaround (only after multiple failures)
    if (attemptCount >= 2) {
      log.info('agent', `[Agent] Escalation Step 3: Requesting AI workaround`)
      try {
        const workaround = await this._requestAIWorkaround(diagnosis, attempts.map(a => a.strategy));
        if (workaround?.action && workaround.action !== 'none') {
          result = await this._executeWorkaround(workaround, diagnosis);
          attempts.push({ strategy: 'ai_workaround', success: result.success, step: 'ai', workaround });
          
          if (result.success) {
            log.info('agent', 'AI workaround succeeded: ...', { description: workaround.description })
            return { ...result, attempts };
          }
        }
      } catch (error) {
        log.warn('agent', `[Agent] AI workaround request failed:`)
        attempts.push({ strategy: 'ai_workaround', success: false, step: 'ai', error: error.message });
      }
    }
    
    // Step 4: Escalate to user after MAX_FIX_ATTEMPTS_BEFORE_ESCALATION failures
    if (attemptCount >= MAX_FIX_ATTEMPTS_BEFORE_ESCALATION) {
      log.info('agent', 'Escalation Step 4: Escalating to user after ... failed attempts', { attemptCount })
      const escalation = await this._escalateToUser(diagnosis, attempts, normalizedMsg);
      return { success: false, escalated: true, escalation, attempts };
    }
    
    // Not yet ready for user escalation, will retry next scan
    log.info('agent', 'Fix failed (attempt .../...), will retry', { detail: attemptCount + 1, MAX_FIX_ATTEMPTS_BEFORE_ESCALATION })
    return { success: false, escalated: false, attempts };
  }

  /**
   * Request AI for a creative workaround when standard fixes fail
   */
  async _requestAIWorkaround(diagnosis, failedStrategies) {
    const prompt = `You are a system repair agent. The following fix strategies have failed for this error:

ERROR: ${diagnosis.issue || 'Unknown error'}
DETAILS: ${JSON.stringify(diagnosis.details || {})}
FAILED STRATEGIES: ${failedStrategies.join(', ')}

Suggest ONE creative workaround that can be applied programmatically. Options:
1. "cleanup" - Remove the broken item/entry from the system entirely
2. "hide" - Mark the item as hidden so users don't see it
3. "reset" - Reset the item to a default/empty state
4. "none" - No automated fix possible, needs human intervention

Respond with ONLY valid JSON (no markdown):
{"action": "cleanup|hide|reset|none", "description": "Brief explanation", "itemId": "extracted ID if found or null"}`;

    try {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      // Prefer anthropicApiKey for Claude API calls
      const apiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
      
      if (!apiKey) {
        log.info('agent', 'No API key for AI workaround request')
        return { action: 'none', description: 'No API key configured' };
      }
      
      const response = await ai.json(prompt, {
        profile: 'powerful', // Claude Opus equivalent
        maxTokens: 500,
        system: 'You are a helpful system repair assistant. Respond only with valid JSON.',
        feature: 'app-manager-agent'
      });
      
      if (!response) {
        return { action: 'none', description: 'No AI response' };
      }
      
      // Response is already parsed JSON from ai.json()
      return {
        action: response.action || 'none',
        description: response.description || 'AI-suggested workaround',
        itemId: response.itemId || diagnosis.details?.itemId
      };
    } catch (error) {
      log.error('agent', 'AI workaround request failed', { error: error.message })
    }
    
    return { action: 'none', description: 'Failed to get AI workaround' };
  }

  /**
   * Execute an AI-suggested workaround
   */
  async _executeWorkaround(workaround, diagnosis) {
    log.info('agent', 'Executing AI workaround: ... - ...', { action: workaround.action, description: workaround.description })
    
    const itemId = workaround.itemId || diagnosis.details?.itemId;
    
    try {
      switch (workaround.action) {
        case 'cleanup':
          // SAFETY: Never delete user items based on unrelated errors like API key failures
          // The removeOrphanedItem method now has built-in protection, but log a warning
          log.warn('agent', 'AI suggested cleanup for item ... - proceeding with safety checks', { itemId })
          if (itemId && this.clipboardManager?.storage) {
            const removed = this.clipboardManager.storage.removeOrphanedItem?.(itemId);
            if (removed) {
              log.info('agent', 'Cleaned up truly orphaned item: ...', { itemId })
              return { success: true, action: 'cleanup' };
            } else {
              log.info('agent', 'Item ... was NOT removed - it has valid content', { itemId })
              return { success: false, action: 'cleanup', reason: 'Item has valid content on disk' };
            }
          }
          // Try general orphan cleanup
          if (this.clipboardManager?.storage?.cleanupOrphanedIndexEntries) {
            const cleaned = this.clipboardManager.storage.cleanupOrphanedIndexEntries();
            return { success: cleaned > 0, action: 'cleanup', cleaned };
          }
          break;
          
        case 'hide':
          // Mark item as hidden (if storage supports it)
          if (itemId && this.clipboardManager?.storage) {
            // Most storage systems can add a "hidden" flag
            const item = this.clipboardManager.storage.loadItem?.(itemId);
            if (item) {
              item.hidden = true;
              // Would need a save method
              log.info('agent', 'Marked item as hidden: ...', { itemId })
              return { success: true, action: 'hide' };
            }
          }
          break;
          
        case 'reset':
          // Reset to default state - depends on item type
          if (itemId && this.pipelineVerifier) {
            const result = await this.pipelineVerifier.repairItem(itemId);
            return { success: result?.success || false, action: 'reset' };
          }
          break;
          
        case 'none':
        default:
          return { success: false, action: 'none', reason: 'No automated fix available' };
      }
    } catch (error) {
      log.error('agent', `[Agent] Workaround execution failed:`)
    }
    
    return { success: false, action: workaround.action, error: 'Execution failed' };
  }

  /**
   * Escalate to user when all automated fixes have failed
   * Sends notification via IPC for UI to display
   */
  async _escalateToUser(diagnosis, attempts, normalizedMessage) {
    const escalation = {
      id: `esc-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      error: diagnosis.issue || diagnosis.details?.reason || 'Unknown error',
      normalizedMessage: normalizedMessage,
      details: diagnosis.details || {},
      attemptedFixes: attempts,
      status: 'pending_user',
      suggestedActions: [
        { label: 'Ignore this error', action: 'ignore', description: 'Stop tracking this error' },
        { label: 'Delete broken item', action: 'delete', description: 'Remove the item causing the error' },
        { label: 'I fixed it manually', action: 'mark_fixed', description: 'Mark as resolved' },
        { label: 'Retry fixes', action: 'retry', description: 'Try automated fixes again' }
      ]
    };
    
    // Add to escalated issues list
    this.escalatedIssues = this.escalatedIssues || [];
    
    // Check if already escalated
    const existingIndex = this.escalatedIssues.findIndex(e => 
      e.normalizedMessage === normalizedMessage
    );
    
    if (existingIndex >= 0) {
      // Update existing escalation
      this.escalatedIssues[existingIndex] = {
        ...this.escalatedIssues[existingIndex],
        ...escalation,
        updateCount: (this.escalatedIssues[existingIndex].updateCount || 0) + 1
      };
      log.info('agent', 'Updated existing escalation for: ...', { detail: normalizedMessage.substring(0, 50) })
    } else {
      this.escalatedIssues.push(escalation);
      log.info('agent', 'New escalation created: ...', { escalationId: escalation.id })
    }
    
    // Save state
    this._saveState();
    
    // Emit event for dashboard API
    if (this.dashboardAPI?.notifyUserIntervention) {
      this.dashboardAPI.notifyUserIntervention(escalation);
    }
    
    // Send via IPC to renderer process for UI notification
    try {
      const { BrowserWindow } = require('electron');
      const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      if (mainWindow) {
        mainWindow.webContents.send('agent:user-intervention-needed', escalation);
        log.info('agent', `[Agent] Sent intervention notification to renderer`)
      }
    } catch (error) {
      log.warn('agent', 'Could not send IPC notification', { error: error.message })
    }
    
    this.stats.escalated++;
    
    return escalation;
  }

  /**
   * Handle user response to an escalation
   */
  async handleUserEscalationResponse(escalationId, action, details = {}) {
    const escalation = this.escalatedIssues.find(e => e.id === escalationId);
    if (!escalation) {
      return { success: false, error: 'Escalation not found' };
    }
    
    log.info('agent', 'User responded to escalation ...: ...', { escalationId, action })
    
    switch (action) {
      case 'ignore':
        escalation.status = 'ignored';
        // Also update broken items registry
        const brokenItem = this.brokenItemsRegistry.find(i => 
          i.normalizedMessage === escalation.normalizedMessage
        );
        if (brokenItem) {
          this.updateBrokenItemStatus(brokenItem.id, 'ignored', { reason: 'User ignored' });
        }
        break;
        
      case 'delete':
        // Attempt to delete the problematic item
        const itemId = escalation.details?.itemId || details.itemId;
        if (itemId && this.clipboardManager?.storage?.removeOrphanedItem) {
          this.clipboardManager.storage.removeOrphanedItem(itemId);
        }
        escalation.status = 'resolved';
        break;
        
      case 'mark_fixed':
        escalation.status = 'resolved';
        const fixedItem = this.brokenItemsRegistry.find(i => 
          i.normalizedMessage === escalation.normalizedMessage
        );
        if (fixedItem) {
          this.updateBrokenItemStatus(fixedItem.id, 'fixed', { reason: 'User marked as fixed' });
        }
        break;
        
      case 'retry':
        escalation.status = 'retry_requested';
        // Reset fix attempts to allow retry
        const retryItem = this.brokenItemsRegistry.find(i => 
          i.normalizedMessage === escalation.normalizedMessage
        );
        if (retryItem) {
          retryItem.fixAttempts = 0;
        }
        break;
        
      default:
        return { success: false, error: 'Unknown action' };
    }
    
    escalation.resolvedAt = new Date().toISOString();
    escalation.resolvedAction = action;
    this._saveState();
    
    return { success: true, escalation };
  }

  /**
   * Get pending escalations for UI display
   */
  getPendingEscalations() {
    return (this.escalatedIssues || []).filter(e => e.status === 'pending_user');
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
        log.info('agent', 'Regenerated thumbnail for ...', { itemId })
        return true;
      }
    } catch (error) {
      log.error('agent', 'Thumbnail regeneration failed', { error: error.message || error })
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
      // Prefer anthropicApiKey for metadata generation (uses Claude API)
      const apiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
      
      if (!apiKey) return false;

      const result = await this.metadataGenerator.generateMetadataForItem(itemId, apiKey);
      return result.success;
    } catch (error) {
      log.error('agent', 'Metadata regeneration failed', { error: error.message || error })
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
      log.error('agent', 'Metadata repair failed', { error: error.message || error })
    }

    return false;
  }

  /**
   * Fix: Rebuild index entry - removes orphaned entries from storage index
   */
  async _fixRebuildIndex(diagnosis) {
    if (!this.clipboardManager?.storage) {
      log.info('agent', 'No clipboard storage available for index rebuild')
      return false;
    }

    try {
      const storage = this.clipboardManager.storage;
      const itemId = diagnosis.details?.itemId;
      
      if (itemId) {
        // Remove specific orphaned entry
        if (typeof storage.removeOrphanedItem === 'function') {
          const removed = storage.removeOrphanedItem(itemId);
          if (removed) {
            log.info('agent', 'Removed orphaned index entry: ...', { itemId })
            return true;
          }
        }
      }
      
      // Full index cleanup - remove all entries pointing to missing files
      if (typeof storage.cleanupOrphanedIndexEntries === 'function') {
        const cleaned = storage.cleanupOrphanedIndexEntries();
        log.info('agent', 'Cleaned ... orphaned index entries', { cleaned })
        return cleaned > 0;
      }
      
      // Fallback: manual cleanup if methods don't exist
      log.info('agent', 'Storage cleanup methods not available, attempting manual cleanup')
      return await this._manualIndexCleanup(storage);
      
    } catch (error) {
      log.error('agent', 'Index rebuild failed', { error: error.message || error })
      return false;
    }
  }

  /**
   * Manual index cleanup when storage methods aren't available
   */
  async _manualIndexCleanup(storage) {
    const fs = require('fs');
    const path = require('path');
    
    try {
      if (!storage.index?.items || !storage.itemsDir) {
        return false;
      }
      
      const originalCount = storage.index.items.length;
      
      // Filter out items whose directories don't exist
      storage.index.items = storage.index.items.filter(item => {
        if (item.type === 'file') {
          const itemDir = path.join(storage.itemsDir, item.id);
          const exists = fs.existsSync(itemDir);
          if (!exists) {
            log.info('agent', 'Removing orphaned item from index: ...', { itemId: item.id })
          }
          return exists;
        }
        return true;
      });
      
      const removed = originalCount - storage.index.items.length;
      
      if (removed > 0) {
        // Save the cleaned index
        if (typeof storage.saveIndex === 'function') {
          storage.saveIndex();
        } else if (typeof storage.saveIndexSync === 'function') {
          storage.saveIndexSync(storage.index);
        }
        log.info('agent', 'Manual cleanup removed ... orphaned entries', { removed })
        return true;
      }
      
      return false;
    } catch (error) {
      log.error('agent', 'Manual index cleanup failed', { error: error.message || error })
      return false;
    }
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
      log.error('agent', 'Orphan cleanup failed', { error: error.message || error })
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
      log.info('agent', 'Issue escalated: ...', { error: issue.message })
      
      // Report to external API
      this.reportIssue(issue, 'escalated').catch(err =>
        log.warn('agent', 'Failed to report escalated issue', { error: err.message })
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
      externalAPI: this.getExternalAPIConfig(),
      
      // Broken items registry info
      brokenItemsRegistry: {
        total: this.brokenItemsRegistry.length,
        open: this.brokenItemsRegistry.filter(i => i.status === 'open').length,
        fixed: this.brokenItemsRegistry.filter(i => i.status === 'fixed').length,
        ignored: this.brokenItemsRegistry.filter(i => i.status === 'ignored').length,
        appVersion: app.getVersion(),
        lastKnownVersion: this.lastKnownAppVersion
      }
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
    
    log.info('agent', 'External API configured', { detail: { enabled: this.externalAPIConfig.enabled,
      statusEndpoint: this.externalAPIConfig.statusEndpoint ? '***configured***' : null,
      issueEndpoint: this.externalAPIConfig.issueEndpoint ? '***configured***' : null,
      hasApiKey: !!this.externalAPIConfig.apiKey
    } })
    
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
    
    log.info('agent', 'Status reporting started (every ...s)', { detail: this.externalAPIConfig.reportIntervalMs / 1000 })
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
        log.info('agent', 'External API report sent to ...', { endpoint })
        return result;

      } catch (error) {
        lastError = error;
        log.warn('agent', 'External API attempt ... failed', { detail: attempt + 1 })
        
        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    log.error('agent', 'External API reporting failed after retries', { error: lastError?.message })
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

