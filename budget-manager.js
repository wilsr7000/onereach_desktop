/**
 * Budget Manager - Tracks API usage costs and budget limits
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Singleton instance
let instance = null;

class BudgetManager {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'budget-data');
    this.dataFile = path.join(this.dataDir, 'budget.json');
    this.backupDir = path.join(this.dataDir, 'backups');
    
    // Warning callback
    this._warningCallback = null;
    
    // Default pricing per 1K tokens (approximate)
    this.defaultPricing = {
      openai: {
        'gpt-4': { input: 0.03, output: 0.06 },
        'gpt-4-turbo': { input: 0.01, output: 0.03 },
        'gpt-4o': { input: 0.005, output: 0.015 },
        'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
        'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
      },
      anthropic: {
        'claude-3-opus': { input: 0.015, output: 0.075 },
        'claude-3-sonnet': { input: 0.003, output: 0.015 },
        'claude-3-haiku': { input: 0.00025, output: 0.00125 },
        'claude-3.5-sonnet': { input: 0.003, output: 0.015 }
      }
    };
    
    // Default estimate categories
    this.estimateCategories = [
      { id: 'code-generation', name: 'Code Generation', description: 'AI-assisted code writing' },
      { id: 'code-review', name: 'Code Review', description: 'AI code analysis and suggestions' },
      { id: 'documentation', name: 'Documentation', description: 'Auto-generated docs and comments' },
      { id: 'testing', name: 'Testing', description: 'Test generation and analysis' },
      { id: 'refactoring', name: 'Refactoring', description: 'Code improvements and optimizations' },
      { id: 'other', name: 'Other', description: 'Miscellaneous AI operations' }
    ];
    
    this.data = this.loadData();
    console.log('[BudgetManager] Initialized');
  }
  
  // Ensure directories exist
  ensureDirectories() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }
  
  // Load data from disk
  loadData() {
    this.ensureDirectories();
    
    const defaultData = {
      configured: false,
      budgetLimits: {
        daily: { limit: 10, alertAt: 8 },
        weekly: { limit: 50, alertAt: 40 },
        monthly: { limit: 150, alertAt: 120 },
        project: {}
      },
      usage: [],
      projects: {},
      pricing: { ...this.defaultPricing },
      estimates: {}
    };
    
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...defaultData, ...parsed };
      }
    } catch (error) {
      console.error('[BudgetManager] Error loading data:', error);
    }
    
    return defaultData;
  }
  
  // Save data to disk
  saveData() {
    this.ensureDirectories();
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[BudgetManager] Error saving data:', error);
    }
  }
  
  // Get cost summary for a period
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
      default:
        startDate = new Date(0);
    }
    
    const periodUsage = this.data.usage.filter(u => new Date(u.timestamp) >= startDate);
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
  
  // Get all budget limits
  getAllBudgetLimits() {
    return this.data.budgetLimits;
  }
  
  // Set budget limit
  setBudgetLimit(scope, limit, alertAt) {
    if (scope === 'project') {
      // Project-specific limits handled separately
      return false;
    }
    
    this.data.budgetLimits[scope] = {
      limit: parseFloat(limit) || 0,
      alertAt: parseFloat(alertAt) || limit * 0.8
    };
    
    this.saveData();
    return true;
  }
  
  // Get usage history
  getUsageHistory(options = {}) {
    let history = [...this.data.usage];
    
    if (options.startDate) {
      history = history.filter(u => new Date(u.timestamp) >= new Date(options.startDate));
    }
    if (options.endDate) {
      history = history.filter(u => new Date(u.timestamp) <= new Date(options.endDate));
    }
    if (options.provider) {
      history = history.filter(u => u.provider === options.provider);
    }
    if (options.projectId) {
      history = history.filter(u => u.projectId === options.projectId);
    }
    if (options.limit) {
      history = history.slice(-options.limit);
    }
    
    return history;
  }
  
  // Get project costs
  getProjectCosts(projectId) {
    const projectUsage = this.data.usage.filter(u => u.projectId === projectId);
    const totalCost = projectUsage.reduce((sum, u) => sum + (u.cost || 0), 0);
    
    return {
      projectId,
      totalCost: Math.round(totalCost * 10000) / 10000,
      usageCount: projectUsage.length,
      lastUsed: projectUsage.length > 0 ? projectUsage[projectUsage.length - 1].timestamp : null
    };
  }
  
  // Get all projects
  getAllProjects() {
    return Object.entries(this.data.projects).map(([id, data]) => ({
      id,
      ...data,
      ...this.getProjectCosts(id)
    }));
  }
  
  // Clear usage history
  clearUsageHistory(options = {}) {
    if (options.all) {
      this.data.usage = [];
    } else if (options.before) {
      this.data.usage = this.data.usage.filter(u => 
        new Date(u.timestamp) >= new Date(options.before)
      );
    } else if (options.projectId) {
      this.data.usage = this.data.usage.filter(u => u.projectId !== options.projectId);
    }
    
    this.saveData();
    return true;
  }
  
  // Export data
  exportData() {
    return {
      exportDate: new Date().toISOString(),
      data: this.data
    };
  }
  
  // Import data
  importData(jsonData) {
    try {
      const imported = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      if (imported.data) {
        this.data = { ...this.data, ...imported.data };
        this.saveData();
        return { success: true };
      }
      return { success: false, error: 'Invalid data format' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  // Estimate cost
  estimateCost(provider, params) {
    const { model, inputTokens = 0, outputTokens = 0 } = params;
    const pricing = this.data.pricing[provider]?.[model] || { input: 0.01, output: 0.03 };
    
    const inputCost = (inputTokens / 1000) * pricing.input;
    const outputCost = (outputTokens / 1000) * pricing.output;
    
    return {
      inputCost: Math.round(inputCost * 10000) / 10000,
      outputCost: Math.round(outputCost * 10000) / 10000,
      totalCost: Math.round((inputCost + outputCost) * 10000) / 10000,
      model,
      provider
    };
  }
  
  // Check budget
  checkBudget(provider, estimatedCost) {
    const dailySummary = this.getCostSummary('daily');
    const weeklySummary = this.getCostSummary('weekly');
    const monthlySummary = this.getCostSummary('monthly');
    
    const warnings = [];
    
    if (dailySummary.totalCost + estimatedCost > dailySummary.limit) {
      warnings.push({ scope: 'daily', message: 'Would exceed daily budget' });
    } else if (dailySummary.totalCost + estimatedCost > dailySummary.alertAt) {
      warnings.push({ scope: 'daily', message: 'Approaching daily budget limit' });
    }
    
    if (weeklySummary.totalCost + estimatedCost > weeklySummary.limit) {
      warnings.push({ scope: 'weekly', message: 'Would exceed weekly budget' });
    }
    
    if (monthlySummary.totalCost + estimatedCost > monthlySummary.limit) {
      warnings.push({ scope: 'monthly', message: 'Would exceed monthly budget' });
    }
    
    return {
      allowed: warnings.filter(w => w.message.includes('exceed')).length === 0,
      warnings,
      currentDaily: dailySummary.totalCost,
      estimatedCost
    };
  }
  
  // Track usage
  trackUsage(provider, projectId, usage) {
    const entry = {
      id: `usage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      provider,
      projectId,
      model: usage.model || 'unknown',
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cost: usage.cost || 0,
      operation: usage.operation || 'api-call'
    };
    
    this.data.usage.push(entry);
    this.saveData();
    
    return entry;
  }
  
  // Register project
  registerProject(projectId, name) {
    this.data.projects[projectId] = {
      name,
      createdAt: new Date().toISOString()
    };
    this.saveData();
    return true;
  }
  
  // Get pricing
  getPricing() {
    return this.data.pricing;
  }
  
  // Update pricing
  updatePricing(provider, pricing) {
    this.data.pricing[provider] = {
      ...this.data.pricing[provider],
      ...pricing
    };
    this.saveData();
    return true;
  }
  
  // Reset to defaults
  resetToDefaults(confirmToken) {
    if (confirmToken !== 'CONFIRM_RESET') {
      return { success: false, error: 'Invalid confirmation token' };
    }
    
    // Create backup first
    this.createBackup();
    
    // Reset data
    this.data = {
      configured: false,
      budgetLimits: {
        daily: { limit: 10, alertAt: 8 },
        weekly: { limit: 50, alertAt: 40 },
        monthly: { limit: 150, alertAt: 120 },
        project: {}
      },
      usage: [],
      projects: {},
      pricing: { ...this.defaultPricing },
      estimates: {}
    };
    
    this.saveData();
    return { success: true };
  }
  
  // Check if budget is configured
  isBudgetConfigured() {
    return this.data.configured === true;
  }
  
  // Mark budget as configured
  markBudgetConfigured() {
    this.data.configured = true;
    this.saveData();
    return true;
  }
  
  // Get estimates for a project
  getEstimates(projectId) {
    return this.data.estimates[projectId] || {};
  }
  
  // Save estimates for a project
  saveEstimates(projectId, estimates) {
    this.data.estimates[projectId] = estimates;
    this.saveData();
    return true;
  }
  
  // Update a single estimate
  updateEstimate(projectId, category, update) {
    if (!this.data.estimates[projectId]) {
      this.data.estimates[projectId] = {};
    }
    this.data.estimates[projectId][category] = {
      ...this.data.estimates[projectId][category],
      ...update,
      updatedAt: new Date().toISOString()
    };
    this.saveData();
    return true;
  }
  
  // Get total estimated amount
  getTotalEstimated(projectId) {
    const estimates = this.data.estimates[projectId] || {};
    return Object.values(estimates).reduce((sum, e) => sum + (e.amount || 0), 0);
  }
  
  // Get estimate categories
  getEstimateCategories() {
    return this.estimateCategories;
  }
  
  // Create backup
  createBackup() {
    this.ensureDirectories();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(this.backupDir, `budget-backup-${timestamp}.json`);
    
    try {
      fs.writeFileSync(backupFile, JSON.stringify(this.data, null, 2));
      return { success: true, path: backupFile };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  // List backups
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
  
  // Restore from backup
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
  
  // Register a warning callback
  onWarning(callback) {
    this._warningCallback = callback;
  }
  
  // Emit a warning to the registered callback
  emitWarning(warningInfo) {
    if (this._warningCallback && typeof this._warningCallback === 'function') {
      this._warningCallback(warningInfo);
    }
  }
  
  // Check budget with warning emission
  checkBudgetWithWarning(provider, estimatedCost, context = {}) {
    const result = this.checkBudget(provider, estimatedCost);
    
    if (result.warnings && result.warnings.length > 0) {
      this.emitWarning({
        ...result,
        provider,
        context,
        timestamp: new Date().toISOString()
      });
    }
    
    return result;
  }
}

// Get singleton instance
function getBudgetManager() {
  if (!instance) {
    instance = new BudgetManager();
  }
  return instance;
}

module.exports = { getBudgetManager };
