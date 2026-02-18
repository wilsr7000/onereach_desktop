/**
 * Dashboard API
 *
 * Aggregates all app metrics from various sources for the App Health Dashboard.
 * Provides unified access to:
 * - App status (memory, CPU, uptime)
 * - Activity logs and events
 * - Spaces health and metrics
 * - LLM usage and costs
 * - Pipeline health and verification
 * - Agent status and diagnoses
 */

const { app, ipcMain } = require('electron');

class DashboardAPI {
  constructor() {
    this.startTime = Date.now();
    this.activityCache = [];
    this.maxActivityCacheSize = 1000;

    // Metrics tracking
    this.metrics = {
      itemsAddedToday: 0,
      aiOperationsToday: 0,
      errorsToday: 0,
      autoFixesToday: 0,
      lastReset: new Date().toDateString(),
    };

    // Pipeline metrics
    this.pipelineMetrics = {
      runs: [],
      stageSuccessRates: {
        validation: { success: 0, total: 0 },
        storage: { success: 0, total: 0 },
        thumbnail: { success: 0, total: 0 },
        metadata: { success: 0, total: 0 },
      },
    };

    this._resetDailyMetricsIfNeeded();
  }

  /**
   * Reset daily metrics at midnight
   */
  _resetDailyMetricsIfNeeded() {
    const today = new Date().toDateString();
    if (this.metrics.lastReset !== today) {
      this.metrics = {
        itemsAddedToday: 0,
        aiOperationsToday: 0,
        errorsToday: 0,
        autoFixesToday: 0,
        lastReset: today,
      };
    }
  }

  /**
   * Get app status metrics
   */
  getAppStatus() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const uptime = Date.now() - this.startTime;

    return {
      status: 'running',
      uptime: this._formatUptime(uptime),
      uptimeMs: uptime,
      memory: {
        used: Math.round(memUsage.heapUsed / 1024 / 1024),
        total: Math.round(memUsage.heapTotal / 1024 / 1024),
        formatted: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
        formatted: `${(((cpuUsage.user + cpuUsage.system) / 1000000 / uptime) * 100).toFixed(1)}%`,
      },
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
    };
  }

  /**
   * Format uptime in human readable format
   */
  _formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get today's summary metrics
   */
  getTodaySummary() {
    this._resetDailyMetricsIfNeeded();
    return {
      itemsAdded: this.metrics.itemsAddedToday,
      aiOperations: this.metrics.aiOperationsToday,
      errors: this.metrics.errorsToday,
      autoFixes: this.metrics.autoFixesToday,
      date: new Date().toDateString(),
    };
  }

  /**
   * Record an item addition
   */
  recordItemAdded(itemType, spaceId, details = {}) {
    this._resetDailyMetricsIfNeeded();
    this.metrics.itemsAddedToday++;

    this._addActivity({
      type: 'add',
      itemType,
      spaceId,
      description: details.description || `Added ${itemType}`,
      ...details,
    });
  }

  /**
   * Record an AI operation
   */
  recordAIOperation(operation, model, tokens, cost, details = {}) {
    this._resetDailyMetricsIfNeeded();
    this.metrics.aiOperationsToday++;

    this._addActivity({
      type: 'ai',
      operation,
      model,
      tokens,
      cost,
      description: details.description || `AI: ${operation}`,
      ...details,
    });
  }

  /**
   * Record an error
   */
  recordError(source, message, details = {}) {
    this._resetDailyMetricsIfNeeded();
    this.metrics.errorsToday++;

    this._addActivity({
      type: 'error',
      source,
      description: message,
      level: 'error',
      ...details,
    });
  }

  /**
   * Record an auto-fix
   */
  recordAutoFix(issue, action, result, details = {}) {
    this._resetDailyMetricsIfNeeded();
    this.metrics.autoFixesToday++;

    this._addActivity({
      type: 'fix',
      issue,
      action,
      result,
      description: `Auto-fix: ${action}`,
      ...details,
    });
  }

  /**
   * Add activity to cache
   */
  _addActivity(activity) {
    const entry = {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      ...activity,
    };

    this.activityCache.unshift(entry);

    // Trim cache if too large
    if (this.activityCache.length > this.maxActivityCacheSize) {
      this.activityCache = this.activityCache.slice(0, this.maxActivityCacheSize);
    }

    return entry;
  }

  /**
   * Get recent activity
   */
  getRecentActivity(options = {}) {
    const { limit = 50, type = null, spaceId = null, since = null } = options;

    let filtered = this.activityCache;

    if (type) {
      filtered = filtered.filter((a) => a.type === type);
    }

    if (spaceId) {
      filtered = filtered.filter((a) => a.spaceId === spaceId);
    }

    if (since) {
      const sinceDate = new Date(since);
      filtered = filtered.filter((a) => new Date(a.timestamp) >= sinceDate);
    }

    return filtered.slice(0, limit);
  }

  /**
   * Get spaces health metrics
   */
  async getSpacesHealth(clipboardManager) {
    if (!clipboardManager) {
      return {
        totalSpaces: 0,
        totalItems: 0,
        totalSize: 0,
        spaces: [],
      };
    }

    try {
      const spaces = clipboardManager.getSpaces() || [];
      const spacesWithMetrics = [];
      let totalItems = 0;
      let totalSize = 0;

      for (const space of spaces) {
        const items = clipboardManager.getSpaceItems(space.id) || [];
        const itemCount = items.length;
        totalItems += itemCount;

        // Calculate size (approximate from file sizes)
        let spaceSize = 0;
        for (const item of items) {
          if (item.fileSize) {
            spaceSize += item.fileSize;
          }
        }
        totalSize += spaceSize;

        // Calculate health score based on various factors
        const healthScore = this._calculateSpaceHealth(space, items);

        spacesWithMetrics.push({
          id: space.id,
          name: space.name,
          icon: space.icon || '📁',
          itemCount,
          size: spaceSize,
          sizeFormatted: this._formatBytes(spaceSize),
          lastUsed: space.lastUsed || space.createdAt,
          lastUsedFormatted: this._formatTimeAgo(space.lastUsed || space.createdAt),
          healthScore,
          healthFormatted: `${healthScore}%`,
        });
      }

      // Sort by last used
      spacesWithMetrics.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

      return {
        totalSpaces: spaces.length,
        totalItems,
        totalSize,
        totalSizeFormatted: this._formatBytes(totalSize),
        utilization: Math.min(100, Math.round((totalItems / 1000) * 100)),
        spaces: spacesWithMetrics,
      };
    } catch (error) {
      console.error('[DashboardAPI] Error getting spaces health:', error);
      return {
        totalSpaces: 0,
        totalItems: 0,
        totalSize: 0,
        spaces: [],
        error: error.message,
      };
    }
  }

  /**
   * Calculate space health score
   */
  _calculateSpaceHealth(space, items) {
    let score = 100;

    // Deduct for stale spaces (not used in 7+ days)
    const daysSinceUse = (Date.now() - (space.lastUsed || space.createdAt || Date.now())) / (1000 * 60 * 60 * 24);
    if (daysSinceUse > 30) {
      score -= 30;
    } else if (daysSinceUse > 7) {
      score -= 15;
    }

    // Deduct for items without metadata
    const itemsWithoutMetadata = items.filter((i) => !i.metadata || !i.metadata.title).length;
    const metadataRatio = items.length > 0 ? itemsWithoutMetadata / items.length : 0;
    score -= Math.round(metadataRatio * 20);

    // Deduct for items without thumbnails (for visual types)
    const visualItems = items.filter((i) => ['image', 'video', 'pdf'].includes(i.type) || i.fileType === 'image-file');
    const itemsWithoutThumbnails = visualItems.filter((i) => !i.thumbnail).length;
    const thumbnailRatio = visualItems.length > 0 ? itemsWithoutThumbnails / visualItems.length : 0;
    score -= Math.round(thumbnailRatio * 15);

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Format bytes to human readable
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Format time ago
   */
  _formatTimeAgo(timestamp) {
    if (!timestamp) return 'Never';

    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;

    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Get LLM usage summary
   */
  async getLLMUsage(llmTracker) {
    if (!llmTracker) {
      return {
        claude: { calls: 0, tokens: 0, cost: 0 },
        openai: { calls: 0, tokens: 0, cost: 0 },
        total: { calls: 0, tokens: 0, cost: 0 },
        byFeature: {},
        recentOperations: [],
      };
    }

    try {
      return llmTracker.getUsageSummary();
    } catch (error) {
      console.error('[DashboardAPI] Error getting LLM usage:', error);
      return {
        claude: { calls: 0, tokens: 0, cost: 0 },
        openai: { calls: 0, tokens: 0, cost: 0 },
        total: { calls: 0, tokens: 0, cost: 0 },
        error: error.message,
      };
    }
  }

  /**
   * Get pipeline health metrics
   */
  getPipelineHealth() {
    const rates = {};

    for (const [stage, data] of Object.entries(this.pipelineMetrics.stageSuccessRates)) {
      rates[stage] = data.total > 0 ? Math.round((data.success / data.total) * 1000) / 10 : 100;
    }

    // Get recent pipeline runs
    const recentRuns = this.pipelineMetrics.runs.slice(0, 20);

    return {
      stageSuccessRates: rates,
      recentRuns,
      verification: {
        checksumsValid: true, // Will be populated by pipeline verifier
        indexIntegrity: 'OK',
        orphanedFiles: 0,
      },
    };
  }

  /**
   * Record pipeline stage result
   */
  recordPipelineStage(stage, success, operationId, details = {}) {
    if (this.pipelineMetrics.stageSuccessRates[stage]) {
      this.pipelineMetrics.stageSuccessRates[stage].total++;
      if (success) {
        this.pipelineMetrics.stageSuccessRates[stage].success++;
      }
    }

    // Update or create pipeline run record
    let run = this.pipelineMetrics.runs.find((r) => r.operationId === operationId);
    if (!run) {
      run = {
        operationId,
        asset: details.asset || 'Unknown',
        stages: {},
        startTime: Date.now(),
        status: 'running',
      };
      this.pipelineMetrics.runs.unshift(run);

      // Trim old runs
      if (this.pipelineMetrics.runs.length > 100) {
        this.pipelineMetrics.runs = this.pipelineMetrics.runs.slice(0, 100);
      }
    }

    run.stages[stage] = { success, timestamp: Date.now(), ...details };

    // Check if all stages complete
    const allStages = [
      'validation',
      'identification',
      'checksum',
      'storage',
      'thumbnail',
      'metadata',
      'verify',
      'finalChecksum',
    ];
    const completedStages = Object.keys(run.stages);
    if (completedStages.length >= allStages.length) {
      run.status = Object.values(run.stages).every((s) => s.success) ? 'complete' : 'failed';
      run.endTime = Date.now();
    }
  }

  /**
   * Get application logs
   */
  async getLogs(options = {}) {
    const { level = 'all', source = 'all', search = '', limit = 100 } = options;

    try {
      // Try to read from event logger
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      const logs = await eventDb.getEventLogs({ limit: limit * 2 });

      let filtered = logs;

      if (level !== 'all') {
        filtered = filtered.filter((l) => l.level?.toLowerCase() === level.toLowerCase());
      }

      if (source !== 'all') {
        filtered = filtered.filter((l) => l.source?.includes(source) || l.category?.includes(source));
      }

      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(
          (l) =>
            l.message?.toLowerCase().includes(searchLower) || l.details?.toString().toLowerCase().includes(searchLower)
        );
      }

      return filtered.slice(0, limit).map((log) => ({
        id: log.id,
        timestamp: log.timestamp,
        level: log.level || 'info',
        source: log.source || log.category || 'app',
        message: log.message,
        details: log.details,
      }));
    } catch (error) {
      console.error('[DashboardAPI] Error getting logs:', error);
      return [];
    }
  }

  /**
   * Get agent status
   */
  getAgentStatus(agent) {
    if (!agent) {
      return {
        active: false,
        lastScan: null,
        scansToday: 0,
        issuesDetected: 0,
        fixesApplied: 0,
        escalated: 0,
        recentDiagnoses: [],
        issuesRequiringAttention: [],
      };
    }

    return agent.getStatus();
  }

  /**
   * Calculate overall health score (Apple Health-style)
   */
  getHealthScore(todaySummary, pipelineHealth, agentStatus) {
    // 1. Stability Score (error-free operations)
    const totalOps = (todaySummary?.itemsAdded || 0) + (todaySummary?.aiOperations || 0) + 1;
    const errors = todaySummary?.errors || 0;
    const stabilityScore = Math.max(0, Math.min(100, Math.round(((totalOps - errors) / totalOps) * 100)));

    // 2. Pipeline Score (successful asset processing)
    const rates = pipelineHealth?.stageSuccessRates || {};
    const avgPipelineRate =
      Object.values(rates).length > 0
        ? Object.values(rates).reduce((a, b) => a + b, 0) / Object.values(rates).length
        : 100;
    const pipelineScore = Math.round(avgPipelineRate);

    // 3. Healing Score (issues auto-fixed vs total issues)
    const issuesDetected = agentStatus?.issuesDetected || 0;
    const fixesApplied = agentStatus?.fixesApplied || 0;
    const healingScore = issuesDetected > 0 ? Math.min(100, Math.round((fixesApplied / issuesDetected) * 100)) : 100;

    // Overall health score (weighted average)
    const overallScore = Math.round(stabilityScore * 0.5 + pipelineScore * 0.3 + healingScore * 0.2);

    return {
      stability: stabilityScore,
      pipeline: pipelineScore,
      healing: healingScore,
      overall: overallScore,
      ringsComplete: [stabilityScore >= 100, pipelineScore >= 100, healingScore >= 100].filter(Boolean).length,
      grade:
        overallScore >= 90 ? 'A' : overallScore >= 80 ? 'B' : overallScore >= 70 ? 'C' : overallScore >= 60 ? 'D' : 'F',
    };
  }

  /**
   * Get complete dashboard data
   */
  async getDashboardData(dependencies = {}) {
    const { clipboardManager, llmTracker, agent } = dependencies;

    const todaySummary = this.getTodaySummary();
    const pipelineHealth = this.getPipelineHealth();
    const agentStatus = this.getAgentStatus(agent);

    return {
      appStatus: this.getAppStatus(),
      todaySummary,
      spacesHealth: await this.getSpacesHealth(clipboardManager),
      llmUsage: await this.getLLMUsage(llmTracker),
      pipelineHealth,
      recentActivity: this.getRecentActivity({ limit: 10 }),
      agentStatus,
      healthScore: this.getHealthScore(todaySummary, pipelineHealth, agentStatus),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Set up IPC handlers for dashboard
   */
  setupIPC(dependencies = {}) {
    const { clipboardManager, llmTracker, agent } = dependencies;

    // Get full dashboard data
    ipcMain.handle('dashboard:get-data', async () => {
      return this.getDashboardData(dependencies);
    });

    // Get app status
    ipcMain.handle('dashboard:get-app-status', () => {
      return this.getAppStatus();
    });

    // Get today's summary
    ipcMain.handle('dashboard:get-today-summary', () => {
      return this.getTodaySummary();
    });

    // Get spaces health
    ipcMain.handle('dashboard:get-spaces-health', async () => {
      return this.getSpacesHealth(clipboardManager);
    });

    // Get LLM usage
    ipcMain.handle('dashboard:get-llm-usage', async () => {
      return this.getLLMUsage(llmTracker);
    });

    // Get pipeline health
    ipcMain.handle('dashboard:get-pipeline-health', () => {
      return this.getPipelineHealth();
    });

    // Get health score
    ipcMain.handle('dashboard:get-health-score', () => {
      const todaySummary = this.getTodaySummary();
      const pipelineHealth = this.getPipelineHealth();
      const agentStatus = this.getAgentStatus(agent);
      return this.getHealthScore(todaySummary, pipelineHealth, agentStatus);
    });

    // Get recent activity
    ipcMain.handle('dashboard:get-activity', (event, options) => {
      return this.getRecentActivity(options);
    });

    // Get logs
    ipcMain.handle('dashboard:get-logs', async (event, options) => {
      return this.getLogs(options);
    });

    // Get agent status
    ipcMain.handle('dashboard:get-agent-status', () => {
      return this.getAgentStatus(agent);
    });

    // Agent control
    ipcMain.handle('dashboard:agent-pause', () => {
      if (agent) {
        agent.pause();
        return { success: true };
      }
      return { success: false, error: 'Agent not available' };
    });

    ipcMain.handle('dashboard:agent-resume', () => {
      if (agent) {
        agent.resume();
        return { success: true };
      }
      return { success: false, error: 'Agent not available' };
    });

    ipcMain.handle('dashboard:agent-run-now', async () => {
      if (agent) {
        return agent.runScan();
      }
      return { success: false, error: 'Agent not available' };
    });

    // External API configuration
    ipcMain.handle('dashboard:agent-configure-external-api', (event, config) => {
      if (agent) {
        agent.configureExternalAPI(config);
        return { success: true, config: agent.getExternalAPIConfig() };
      }
      return { success: false, error: 'Agent not available' };
    });

    ipcMain.handle('dashboard:agent-get-external-api-config', () => {
      if (agent) {
        return { success: true, config: agent.getExternalAPIConfig() };
      }
      return { success: false, error: 'Agent not available' };
    });

    ipcMain.handle('dashboard:agent-report-status-now', async () => {
      if (agent) {
        return agent.reportStatus();
      }
      return { success: false, error: 'Agent not available' };
    });

    // Broken Items Registry
    ipcMain.handle('dashboard:get-broken-items', (event, options = {}) => {
      if (agent) {
        return { success: true, ...agent.getBrokenItemsRegistry(options) };
      }
      return { success: false, error: 'Agent not available', items: [] };
    });

    ipcMain.handle('dashboard:get-archived-broken-items', () => {
      if (agent) {
        return { success: true, archives: agent.getArchivedBrokenItems() };
      }
      return { success: false, error: 'Agent not available', archives: [] };
    });

    ipcMain.handle('dashboard:update-broken-item-status', (event, itemId, status, details = {}) => {
      if (agent) {
        const updated = agent.updateBrokenItemStatus(itemId, status, details);
        return { success: updated };
      }
      return { success: false, error: 'Agent not available' };
    });

    ipcMain.handle('dashboard:clear-broken-items', (event, archive = true) => {
      if (agent) {
        return { success: true, ...agent.clearBrokenItemsRegistry(archive) };
      }
      return { success: false, error: 'Agent not available' };
    });

    // Run integrity check
    ipcMain.handle('dashboard:run-integrity-check', async () => {
      try {
        const PipelineVerifier = require('./pipeline-verifier');
        const verifier = new PipelineVerifier(clipboardManager?.storage);
        return verifier.runFullIntegrityCheck();
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Export data
    ipcMain.handle('dashboard:export-data', async (event, format) => {
      const data = await this.getDashboardData(dependencies);

      if (format === 'json') {
        return JSON.stringify(data, null, 2);
      }

      // For other formats, return raw data
      return data;
    });

    console.log('[DashboardAPI] IPC handlers registered');
  }
}

// Singleton instance
let instance = null;

function getDashboardAPI() {
  if (!instance) {
    instance = new DashboardAPI();
  }
  return instance;
}

function resetDashboardAPI() {
  instance = null;
}

module.exports = {
  DashboardAPI,
  getDashboardAPI,
  resetDashboardAPI,
};
