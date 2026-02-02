/**
 * Budget Manager - PRIMARY Cost Tracking System
 * 
 * This is the SINGLE SOURCE OF TRUTH for all API usage costs.
 * All other trackers should forward their data here.
 * 
 * Features:
 * - Per-project cost tracking
 * - Budget limits with hard/soft enforcement
 * - Feature-based cost breakdown
 * - Chat/voice budget query support
 * - Real-time notifications
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { calculateCost, getPricingForModel, getPricingSummary, formatCost } = require('./pricing-config');

// Singleton instance
let instance = null;

// Feature categories for cost breakdown
const FEATURE_CATEGORIES = [
  { id: 'gsx-create', name: 'GSX Create', description: 'Aider-powered code generation' },
  { id: 'chat', name: 'Chat', description: 'Direct AI conversations' },
  { id: 'code-generation', name: 'Code Generation', description: 'AI-assisted code writing' },
  { id: 'code-review', name: 'Code Review', description: 'AI code analysis and suggestions' },
  { id: 'documentation', name: 'Documentation', description: 'Auto-generated docs and comments' },
  { id: 'testing', name: 'Testing', description: 'Test generation and analysis' },
  { id: 'refactoring', name: 'Refactoring', description: 'Code improvements and optimizations' },
  { id: 'transcription', name: 'Transcription', description: 'Audio/video transcription' },
  { id: 'voice', name: 'Voice Generation', description: 'Text-to-speech generation' },
  { id: 'image', name: 'Image Analysis', description: 'Vision model usage' },
  { id: 'other', name: 'Other', description: 'Miscellaneous AI operations' }
];

class BudgetManager {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'budget-data');
    this.dataFile = path.join(this.dataDir, 'budget.json');
    this.backupDir = path.join(this.dataDir, 'backups');
    
    // Callbacks
    this._warningCallback = null;
    this._usageCallback = null;
    
    // Load data
    this.data = this.loadData();
    
    // Start daily cleanup task
    this._startDailyCleanup();
    
    console.log('[BudgetManager] Initialized as PRIMARY cost tracker');
  }
  
  // ==========================================================================
  // DATA PERSISTENCE
  // ==========================================================================
  
  ensureDirectories() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }
  
  loadData() {
    this.ensureDirectories();
    
    const defaultData = {
      version: 2, // Schema version for migrations
      configured: false,
      
      // Budget configuration
      budgetLimits: {
        daily: { limit: 10, alertAt: 8, hardLimit: false },
        weekly: { limit: 50, alertAt: 40, hardLimit: false },
        monthly: { limit: 150, alertAt: 120, hardLimit: false }
      },
      
      // Project-specific budgets
      projectBudgets: {},
      
      // All usage records (primary storage)
      usage: [],
      
      // Aggregated stats (for fast queries)
      stats: {
        totalCost: 0,
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        byProvider: {},
        byFeature: {},
        byProject: {},
        byModel: {},
        dailyCosts: {}
      },
      
      // Registered projects
      projects: {},
      
      // User preferences
      preferences: {
        hardLimitEnabled: false,
        notifyOnWarning: true,
        notifyOnExceed: true,
        autoBackup: true
      },
      
      // Metadata
      lastUpdated: null,
      lastBackup: null
    };
    
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        
        // Migrate if needed
        const migrated = this._migrateData(parsed, defaultData);
        return migrated;
      }
    } catch (error) {
      console.error('[BudgetManager] Error loading data:', error);
    }
    
    return defaultData;
  }
  
  _migrateData(oldData, defaultData) {
    // Merge with defaults to ensure all fields exist
    const data = { ...defaultData, ...oldData };
    
    // Initialize stats if missing
    if (!data.stats) {
      data.stats = defaultData.stats;
      // Rebuild stats from usage
      this._rebuildStats(data);
    }
    
    // Add hardLimit flag if missing
    for (const period of ['daily', 'weekly', 'monthly']) {
      if (data.budgetLimits[period] && data.budgetLimits[period].hardLimit === undefined) {
        data.budgetLimits[period].hardLimit = false;
      }
    }
    
    data.version = 2;
    return data;
  }
  
  _rebuildStats(data) {
    data.stats = {
      totalCost: 0,
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      byProvider: {},
      byFeature: {},
      byProject: {},
      byModel: {},
      dailyCosts: {}
    };
    
    for (const entry of data.usage || []) {
      this._updateStatsFromEntry(data.stats, entry);
    }
  }
  
  _updateStatsFromEntry(stats, entry) {
    const cost = entry.cost || 0;
    const inputTokens = entry.inputTokens || 0;
    const outputTokens = entry.outputTokens || 0;
    const date = entry.timestamp ? entry.timestamp.split('T')[0] : new Date().toISOString().split('T')[0];
    
    // Totals
    stats.totalCost += cost;
    stats.totalCalls += 1;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    
    // By provider
    const provider = entry.provider || 'unknown';
    if (!stats.byProvider[provider]) {
      stats.byProvider[provider] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    stats.byProvider[provider].cost += cost;
    stats.byProvider[provider].calls += 1;
    stats.byProvider[provider].inputTokens += inputTokens;
    stats.byProvider[provider].outputTokens += outputTokens;
    
    // By feature
    const feature = entry.feature || entry.operation || 'other';
    if (!stats.byFeature[feature]) {
      stats.byFeature[feature] = { cost: 0, calls: 0 };
    }
    stats.byFeature[feature].cost += cost;
    stats.byFeature[feature].calls += 1;
    
    // By project
    const projectId = entry.projectId || entry.spaceId || 'unassigned';
    if (!stats.byProject[projectId]) {
      stats.byProject[projectId] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    stats.byProject[projectId].cost += cost;
    stats.byProject[projectId].calls += 1;
    stats.byProject[projectId].inputTokens += inputTokens;
    stats.byProject[projectId].outputTokens += outputTokens;
    
    // By model
    const model = entry.model || 'unknown';
    if (!stats.byModel[model]) {
      stats.byModel[model] = { cost: 0, calls: 0 };
    }
    stats.byModel[model].cost += cost;
    stats.byModel[model].calls += 1;
    
    // Daily costs
    if (!stats.dailyCosts[date]) {
      stats.dailyCosts[date] = { cost: 0, calls: 0 };
    }
    stats.dailyCosts[date].cost += cost;
    stats.dailyCosts[date].calls += 1;
  }
  
  saveData() {
    this.ensureDirectories();
    try {
      this.data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2));
      
      // Auto-backup if enabled
      if (this.data.preferences?.autoBackup) {
        this._autoBackupIfNeeded();
      }
    } catch (error) {
      console.error('[BudgetManager] Error saving data:', error);
    }
  }
  
  _autoBackupIfNeeded() {
    const lastBackup = this.data.lastBackup ? new Date(this.data.lastBackup) : null;
    const now = new Date();
    
    // Backup daily
    if (!lastBackup || (now - lastBackup) > 24 * 60 * 60 * 1000) {
      this.createBackup();
      this.data.lastBackup = now.toISOString();
    }
  }
  
  _startDailyCleanup() {
    // Clean up old usage records (keep last 90 days)
    setInterval(() => {
      this._cleanupOldRecords();
    }, 24 * 60 * 60 * 1000); // Daily
    
    // Run once on startup after a delay
    setTimeout(() => this._cleanupOldRecords(), 60000);
  }
  
  _cleanupOldRecords() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    const cutoffStr = cutoffDate.toISOString();
    
    const originalLength = this.data.usage.length;
    this.data.usage = this.data.usage.filter(u => u.timestamp >= cutoffStr);
    
    if (this.data.usage.length < originalLength) {
      console.log(`[BudgetManager] Cleaned up ${originalLength - this.data.usage.length} old records`);
      this._rebuildStats(this.data);
      this.saveData();
    }
  }
  
  // ==========================================================================
  // CORE TRACKING - Primary entry point for all cost tracking
  // ==========================================================================
  
  /**
   * Track usage - PRIMARY method for recording costs
   * All other trackers should call this method.
   * 
   * @param {object} params - Usage parameters
   * @param {string} params.provider - 'anthropic', 'openai', etc.
   * @param {string} params.model - Model name
   * @param {number} params.inputTokens - Input token count
   * @param {number} params.outputTokens - Output token count
   * @param {string} params.projectId - Project/space ID
   * @param {string} params.feature - Feature category
   * @param {string} params.operation - Operation description
   * @param {object} params.options - Additional options (imageCount, etc.)
   * @returns {object} Recorded entry with cost calculation
   */
  trackUsage(params) {
    const {
      provider = 'unknown',
      model = 'unknown',
      inputTokens = 0,
      outputTokens = 0,
      projectId = null,
      spaceId = null,
      feature = 'other',
      operation = 'api-call',
      options = {},
      success = true
    } = params;
    
    // Calculate cost using unified pricing
    const costResult = calculateCost(model, inputTokens, outputTokens, options);
    
    // Create usage entry
    const entry = {
      id: `usage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      provider: costResult.provider || provider,
      model: costResult.model,
      inputTokens,
      outputTokens,
      cost: costResult.totalCost,
      projectId: projectId || spaceId || null,
      spaceId: spaceId || projectId || null,
      feature,
      operation,
      success,
      costBreakdown: costResult
    };
    
    // Store entry
    this.data.usage.push(entry);
    
    // Update aggregated stats
    this._updateStatsFromEntry(this.data.stats, entry);
    
    // Check budget limits
    const budgetCheck = this.checkBudget(costResult.totalCost);
    
    // Emit notifications
    if (budgetCheck.warnings.length > 0) {
      this._emitWarning(entry, budgetCheck);
    }
    
    // Notify usage callback
    if (this._usageCallback) {
      this._usageCallback(entry, budgetCheck);
    }
    
    // Save
    this.saveData();
    
    console.log(`[BudgetManager] Tracked: ${formatCost(costResult.totalCost)} | ${model} | ${feature}`);
    
    return {
      entry,
      budgetCheck,
      blocked: budgetCheck.blocked
    };
  }
  
  // ==========================================================================
  // BUDGET CHECKING & ENFORCEMENT
  // ==========================================================================
  
  /**
   * Check if a cost would exceed budget limits
   * @param {number} estimatedCost - Cost to check
   * @param {string} projectId - Optional project ID for project-specific limits
   * @returns {object} Budget check result
   */
  checkBudget(estimatedCost, projectId = null) {
    const now = new Date();
    const warnings = [];
    let blocked = false;
    
    // Check daily
    const dailySummary = this.getCostSummary('daily');
    const dailyLimit = this.data.budgetLimits.daily;
    
    if (dailySummary.totalCost + estimatedCost > dailyLimit.limit) {
      warnings.push({ 
        scope: 'daily', 
        severity: 'exceeded',
        message: `Daily budget exceeded: ${formatCost(dailySummary.totalCost)} / ${formatCost(dailyLimit.limit)}`
      });
      if (dailyLimit.hardLimit || this.data.preferences.hardLimitEnabled) {
        blocked = true;
      }
    } else if (dailySummary.totalCost + estimatedCost > dailyLimit.alertAt) {
      warnings.push({ 
        scope: 'daily', 
        severity: 'warning',
        message: `Approaching daily limit: ${formatCost(dailySummary.totalCost)} / ${formatCost(dailyLimit.limit)}`
      });
    }
    
    // Check weekly
    const weeklySummary = this.getCostSummary('weekly');
    const weeklyLimit = this.data.budgetLimits.weekly;
    
    if (weeklySummary.totalCost + estimatedCost > weeklyLimit.limit) {
      warnings.push({ 
        scope: 'weekly', 
        severity: 'exceeded',
        message: `Weekly budget exceeded: ${formatCost(weeklySummary.totalCost)} / ${formatCost(weeklyLimit.limit)}`
      });
      if (weeklyLimit.hardLimit || this.data.preferences.hardLimitEnabled) {
        blocked = true;
      }
    }
    
    // Check monthly
    const monthlySummary = this.getCostSummary('monthly');
    const monthlyLimit = this.data.budgetLimits.monthly;
    
    if (monthlySummary.totalCost + estimatedCost > monthlyLimit.limit) {
      warnings.push({ 
        scope: 'monthly', 
        severity: 'exceeded',
        message: `Monthly budget exceeded: ${formatCost(monthlySummary.totalCost)} / ${formatCost(monthlyLimit.limit)}`
      });
      if (monthlyLimit.hardLimit || this.data.preferences.hardLimitEnabled) {
        blocked = true;
      }
    }
    
    // Check project-specific limit if applicable
    if (projectId && this.data.projectBudgets[projectId]) {
      const projectBudget = this.data.projectBudgets[projectId];
      const projectCost = this.getProjectCosts(projectId).totalCost;
      
      if (projectCost + estimatedCost > projectBudget.limit) {
        warnings.push({ 
          scope: 'project', 
          severity: 'exceeded',
          message: `Project budget exceeded: ${formatCost(projectCost)} / ${formatCost(projectBudget.limit)}`
        });
        if (projectBudget.hardLimit) {
          blocked = true;
        }
      }
    }
    
    return {
      allowed: !blocked,
      blocked,
      warnings,
      summary: {
        daily: dailySummary,
        weekly: weeklySummary,
        monthly: monthlySummary
      },
      estimatedCost,
      timestamp: now.toISOString()
    };
  }
  
  /**
   * Pre-check budget before making an API call (for hard limit enforcement)
   */
  preCheckBudget(provider, model, estimatedInputTokens, estimatedOutputTokens, projectId = null) {
    const costResult = calculateCost(model, estimatedInputTokens, estimatedOutputTokens);
    return this.checkBudget(costResult.totalCost, projectId);
  }
  
  // ==========================================================================
  // BUDGET CONFIGURATION
  // ==========================================================================
  
  setBudgetLimit(scope, limit, alertAt, hardLimit = false) {
    if (scope === 'project') {
      return false; // Use setProjectBudget instead
    }
    
    this.data.budgetLimits[scope] = {
      limit: parseFloat(limit) || 0,
      alertAt: parseFloat(alertAt) || (limit * 0.8),
      hardLimit: !!hardLimit
    };
    
    this.saveData();
    return true;
  }
  
  setProjectBudget(projectId, limit, alertAt = null, hardLimit = false) {
    this.data.projectBudgets[projectId] = {
      limit: parseFloat(limit) || 0,
      alertAt: parseFloat(alertAt) || (limit * 0.8),
      hardLimit: !!hardLimit,
      updatedAt: new Date().toISOString()
    };
    
    this.saveData();
    return true;
  }
  
  setHardLimitEnabled(enabled) {
    this.data.preferences.hardLimitEnabled = !!enabled;
    this.saveData();
    return true;
  }
  
  getAllBudgetLimits() {
    return {
      ...this.data.budgetLimits,
      projectBudgets: this.data.projectBudgets,
      hardLimitEnabled: this.data.preferences.hardLimitEnabled
    };
  }
  
  // ==========================================================================
  // COST SUMMARIES & QUERIES
  // ==========================================================================
  
  getCostSummary(period = 'daily') {
    const now = new Date();
    let startDate;
    
    switch (period) {
      case 'daily':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'weekly':
        const dayOfWeek = now.getDay();
        startDate = new Date(now);
        startDate.setDate(now.getDate() - dayOfWeek);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'monthly':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'yearly':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        startDate = new Date(0);
    }
    
    const startStr = startDate.toISOString();
    const periodUsage = this.data.usage.filter(u => u.timestamp >= startStr);
    
    const totalCost = periodUsage.reduce((sum, u) => sum + (u.cost || 0), 0);
    const limit = this.data.budgetLimits[period]?.limit || 0;
    const alertAt = this.data.budgetLimits[period]?.alertAt || limit * 0.8;
    
    return {
      period,
      totalCost: Math.round(totalCost * 10000) / 10000,
      limit,
      alertAt,
      remaining: Math.max(0, limit - totalCost),
      percentUsed: limit > 0 ? Math.round((totalCost / limit) * 100) : 0,
      usageCount: periodUsage.length,
      startDate: startDate.toISOString()
    };
  }
  
  getProjectCosts(projectId) {
    const projectStats = this.data.stats.byProject[projectId] || { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    const projectBudget = this.data.projectBudgets[projectId];
    
    return {
      projectId,
      totalCost: Math.round(projectStats.cost * 10000) / 10000,
      usageCount: projectStats.calls,
      inputTokens: projectStats.inputTokens,
      outputTokens: projectStats.outputTokens,
      budget: projectBudget || null,
      percentUsed: projectBudget ? Math.round((projectStats.cost / projectBudget.limit) * 100) : null
    };
  }
  
  getAllProjects() {
    const projects = [];
    
    for (const [projectId, projectData] of Object.entries(this.data.projects)) {
      projects.push({
        id: projectId,
        ...projectData,
        ...this.getProjectCosts(projectId)
      });
    }
    
    // Add projects that have usage but aren't registered
    for (const projectId of Object.keys(this.data.stats.byProject)) {
      if (!this.data.projects[projectId] && projectId !== 'unassigned') {
        projects.push({
          id: projectId,
          name: projectId,
          ...this.getProjectCosts(projectId)
        });
      }
    }
    
    return projects.sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0));
  }
  
  getUsageHistory(options = {}) {
    let history = [...this.data.usage];
    
    if (options.startDate) {
      history = history.filter(u => u.timestamp >= options.startDate);
    }
    if (options.endDate) {
      history = history.filter(u => u.timestamp <= options.endDate);
    }
    if (options.provider) {
      history = history.filter(u => u.provider === options.provider);
    }
    if (options.projectId) {
      history = history.filter(u => u.projectId === options.projectId || u.spaceId === options.projectId);
    }
    if (options.feature) {
      history = history.filter(u => u.feature === options.feature);
    }
    if (options.limit) {
      history = history.slice(-options.limit);
    }
    
    return history.reverse(); // Most recent first
  }
  
  getStatsByFeature() {
    return { ...this.data.stats.byFeature };
  }
  
  getStatsByProvider() {
    return { ...this.data.stats.byProvider };
  }
  
  getStatsByModel() {
    return { ...this.data.stats.byModel };
  }
  
  getDailyCosts(days = 30) {
    const result = [];
    const now = new Date();
    
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      result.push({
        date: dateStr,
        cost: this.data.stats.dailyCosts[dateStr]?.cost || 0,
        calls: this.data.stats.dailyCosts[dateStr]?.calls || 0
      });
    }
    
    return result.reverse();
  }
  
  // ==========================================================================
  // BUDGET QUERY FOR CHAT/VOICE
  // ==========================================================================
  
  /**
   * Get budget status as natural language for chat/voice responses
   * @param {string} projectId - Optional project ID
   * @returns {object} Status information with natural language summary
   */
  getBudgetStatus(projectId = null) {
    const daily = this.getCostSummary('daily');
    const weekly = this.getCostSummary('weekly');
    const monthly = this.getCostSummary('monthly');
    
    const parts = [];
    
    // Daily status
    if (daily.percentUsed >= 100) {
      parts.push(`You've exceeded your daily budget of ${formatCost(daily.limit)}, spending ${formatCost(daily.totalCost)}.`);
    } else if (daily.percentUsed >= 80) {
      parts.push(`You're at ${daily.percentUsed}% of your daily budget (${formatCost(daily.totalCost)} of ${formatCost(daily.limit)}).`);
    } else {
      parts.push(`Today you've spent ${formatCost(daily.totalCost)} of your ${formatCost(daily.limit)} daily budget (${daily.percentUsed}%).`);
    }
    
    // Weekly/Monthly summary
    parts.push(`This week: ${formatCost(weekly.totalCost)} of ${formatCost(weekly.limit)}.`);
    parts.push(`This month: ${formatCost(monthly.totalCost)} of ${formatCost(monthly.limit)}.`);
    
    // Project-specific if requested
    let projectSummary = null;
    if (projectId) {
      const projectCosts = this.getProjectCosts(projectId);
      projectSummary = `Project "${projectId}" has used ${formatCost(projectCosts.totalCost)} total.`;
      if (projectCosts.budget) {
        projectSummary += ` Budget: ${formatCost(projectCosts.budget.limit)} (${projectCosts.percentUsed}% used).`;
      }
    }
    
    // Top spending features
    const features = Object.entries(this.data.stats.byFeature)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 3)
      .map(([name, data]) => `${name}: ${formatCost(data.cost)}`);
    
    return {
      daily,
      weekly,
      monthly,
      projectSummary,
      summary: parts.join(' '),
      topFeatures: features,
      naturalLanguage: parts.join(' ') + (projectSummary ? ' ' + projectSummary : ''),
      hardLimitEnabled: this.data.preferences.hardLimitEnabled,
      isOverBudget: daily.percentUsed >= 100 || weekly.percentUsed >= 100 || monthly.percentUsed >= 100
    };
  }
  
  /**
   * Answer a budget question (for chat/voice integration)
   * @param {string} question - Natural language question about budget
   * @param {string} projectId - Optional project context
   * @returns {string} Natural language answer
   */
  answerBudgetQuestion(question, projectId = null) {
    const q = question.toLowerCase();
    const status = this.getBudgetStatus(projectId);
    
    // Specific question patterns
    if (q.includes('how much') && (q.includes('spent') || q.includes('used'))) {
      if (q.includes('today')) {
        return `You've spent ${formatCost(status.daily.totalCost)} today.`;
      }
      if (q.includes('week')) {
        return `You've spent ${formatCost(status.weekly.totalCost)} this week.`;
      }
      if (q.includes('month')) {
        return `You've spent ${formatCost(status.monthly.totalCost)} this month.`;
      }
      return status.summary;
    }
    
    if (q.includes('remaining') || q.includes('left')) {
      return `You have ${formatCost(status.daily.remaining)} left in your daily budget, ${formatCost(status.weekly.remaining)} for the week, and ${formatCost(status.monthly.remaining)} for the month.`;
    }
    
    if (q.includes('limit') || q.includes('budget')) {
      return `Your budget limits are: ${formatCost(status.daily.limit)} daily, ${formatCost(status.weekly.limit)} weekly, and ${formatCost(status.monthly.limit)} monthly. ${status.hardLimitEnabled ? 'Hard limits are enabled - spending will be blocked when exceeded.' : 'Soft limits - you will receive warnings but spending won\'t be blocked.'}`;
    }
    
    if (q.includes('over') || q.includes('exceed')) {
      if (status.isOverBudget) {
        return `Yes, you are currently over budget. ${status.summary}`;
      }
      return `No, you are within budget. ${status.summary}`;
    }
    
    if (q.includes('project') && projectId) {
      return status.projectSummary || `No specific budget data for project "${projectId}".`;
    }
    
    // Default: full summary
    return status.naturalLanguage;
  }
  
  // ==========================================================================
  // NOTIFICATIONS & CALLBACKS
  // ==========================================================================
  
  onWarning(callback) {
    this._warningCallback = callback;
  }
  
  onUsage(callback) {
    this._usageCallback = callback;
  }
  
  _emitWarning(entry, budgetCheck) {
    if (this._warningCallback && typeof this._warningCallback === 'function') {
      this._warningCallback({
        entry,
        budgetCheck,
        timestamp: new Date().toISOString()
      });
    }
    
    // Also broadcast to all windows
    try {
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('budget:warning', {
            warnings: budgetCheck.warnings,
            blocked: budgetCheck.blocked,
            summary: budgetCheck.summary
          });
        }
      }
    } catch (error) {
      // Windows might not be ready
    }
  }
  
  // ==========================================================================
  // PROJECT MANAGEMENT
  // ==========================================================================
  
  registerProject(projectId, name) {
    this.data.projects[projectId] = {
      name,
      createdAt: new Date().toISOString()
    };
    this.saveData();
    return true;
  }
  
  // ==========================================================================
  // BACKUP & RESTORE
  // ==========================================================================
  
  createBackup() {
    this.ensureDirectories();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(this.backupDir, `budget-backup-${timestamp}.json`);
    
    try {
      fs.writeFileSync(backupFile, JSON.stringify(this.data, null, 2));
      console.log(`[BudgetManager] Backup created: ${backupFile}`);
      return { success: true, path: backupFile };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  listBackups() {
    this.ensureDirectories();
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('budget-backup-') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(this.backupDir, f),
          created: fs.statSync(path.join(this.backupDir, f)).mtime
        }))
        .sort((a, b) => b.created - a.created);
      return files;
    } catch (error) {
      return [];
    }
  }
  
  restoreFromBackup(backupPath) {
    try {
      const raw = fs.readFileSync(backupPath, 'utf8');
      this.data = JSON.parse(raw);
      this.saveData();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  // ==========================================================================
  // EXPORT & IMPORT
  // ==========================================================================
  
  exportData() {
    return {
      exportDate: new Date().toISOString(),
      version: this.data.version,
      data: this.data
    };
  }
  
  importData(jsonData) {
    try {
      const imported = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      if (imported.data) {
        // Create backup first
        this.createBackup();
        this.data = { ...this.data, ...imported.data };
        this._rebuildStats(this.data);
        this.saveData();
        return { success: true };
      }
      return { success: false, error: 'Invalid data format' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  resetToDefaults(confirmToken) {
    if (confirmToken !== 'CONFIRM_RESET') {
      return { success: false, error: 'Invalid confirmation token' };
    }
    
    this.createBackup();
    this.data = this.loadData.call({ ensureDirectories: () => {}, dataFile: null });
    this.saveData();
    return { success: true };
  }
  
  // ==========================================================================
  // UTILITY
  // ==========================================================================
  
  isBudgetConfigured() {
    return this.data.configured === true;
  }
  
  markBudgetConfigured() {
    this.data.configured = true;
    this.saveData();
    return true;
  }
  
  getFeatureCategories() {
    return FEATURE_CATEGORIES;
  }
  
  getPricing() {
    return getPricingSummary();
  }
  
  estimateCost(model, inputTokens, outputTokens, options = {}) {
    return calculateCost(model, inputTokens, outputTokens, options);
  }
}

// ==========================================================================
// SINGLETON
// ==========================================================================

function getBudgetManager() {
  if (!instance) {
    instance = new BudgetManager();
  }
  return instance;
}

module.exports = { getBudgetManager, FEATURE_CATEGORIES };
