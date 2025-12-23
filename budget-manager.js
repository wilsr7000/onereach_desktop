/**
 * BudgetManager - API cost tracking and budget management
 * Tracks usage across OpenAI, ElevenLabs, and Anthropic APIs
 * Associates costs with video projects
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// Default pricing models (cost per 1K units)
const DEFAULT_PRICING = {
  openai: {
    name: 'OpenAI',
    inputCostPer1K: 0.01,    // $0.01 per 1K input tokens
    outputCostPer1K: 0.03,   // $0.03 per 1K output tokens
    unit: 'tokens'
  },
  elevenlabs: {
    name: 'ElevenLabs',
    costPer1K: 0.30,         // $0.30 per 1K characters
    unit: 'characters'
  },
  anthropic: {
    name: 'Anthropic',
    inputCostPer1K: 0.015,   // $0.015 per 1K input tokens
    outputCostPer1K: 0.075,  // $0.075 per 1K output tokens
    unit: 'tokens'
  }
};

// Default budget settings
const DEFAULT_BUDGETS = {
  global: { limit: 50.00, alertAt: [0.5, 0.75, 0.9] },
  openai: { limit: 20.00, alertAt: [0.75, 0.9] },
  elevenlabs: { limit: 20.00, alertAt: [0.75, 0.9] },
  anthropic: { limit: 10.00, alertAt: [0.75, 0.9] }
};

class BudgetManager {
  constructor() {
    this._dataPath = null;
    this._data = null;
    this._pricing = { ...DEFAULT_PRICING };
  }

  /**
   * Get path to budget data file (lazy init)
   */
  get dataPath() {
    if (!this._dataPath) {
      this._dataPath = path.join(app.getPath('userData'), 'budget-data.json');
    }
    return this._dataPath;
  }

  /**
   * Get budget data (lazy load)
   */
  get data() {
    if (!this._data) {
      this._data = this.loadData();
    }
    return this._data;
  }

  /**
   * Load budget data from disk
   */
  loadData() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        const data = JSON.parse(raw);
        // Ensure required structure exists
        return {
          budgets: data.budgets || { ...DEFAULT_BUDGETS },
          usage: data.usage || [],
          projects: data.projects || {},
          pricing: data.pricing || { ...DEFAULT_PRICING }
        };
      }
    } catch (error) {
      console.error('[BudgetManager] Error loading data:', error);
    }
    
    // Return default structure
    return {
      budgets: { ...DEFAULT_BUDGETS },
      usage: [],
      projects: {},
      pricing: { ...DEFAULT_PRICING }
    };
  }

  /**
   * Save budget data to disk
   */
  saveData() {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this._data, null, 2));
      return true;
    } catch (error) {
      console.error('[BudgetManager] Error saving data:', error);
      return false;
    }
  }

  // ==================== TRACKING ====================

  /**
   * Track API usage and cost
   * @param {string} provider - 'openai' | 'elevenlabs' | 'anthropic'
   * @param {string} projectId - Associated project ID (optional)
   * @param {Object} usage - Usage details
   * @param {string} usage.operation - Operation name
   * @param {number} usage.inputTokens - Input tokens (for OpenAI/Anthropic)
   * @param {number} usage.outputTokens - Output tokens (for OpenAI/Anthropic)
   * @param {number} usage.characters - Characters (for ElevenLabs)
   * @param {number} usage.cost - Pre-calculated cost (optional)
   */
  trackUsage(provider, projectId, usage) {
    const cost = usage.cost || this.calculateCost(provider, usage);
    
    const entry = {
      id: `usage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      provider,
      projectId: projectId || null,
      operation: usage.operation || 'unknown',
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      characters: usage.characters || 0,
      cost
    };

    this.data.usage.push(entry);

    // Update project total if project specified
    if (projectId) {
      if (!this.data.projects[projectId]) {
        this.data.projects[projectId] = { name: projectId, totalCost: 0 };
      }
      this.data.projects[projectId].totalCost += cost;
    }

    this.saveData();
    console.log(`[BudgetManager] Tracked usage: ${provider} - $${cost.toFixed(4)}`);

    return entry;
  }

  /**
   * Calculate cost based on usage
   */
  calculateCost(provider, usage) {
    const pricing = this.data.pricing[provider] || this._pricing[provider];
    if (!pricing) return 0;

    if (provider === 'elevenlabs') {
      const characters = usage.characters || 0;
      return (characters / 1000) * pricing.costPer1K;
    } else {
      // Token-based pricing (OpenAI, Anthropic)
      const inputTokens = usage.inputTokens || 0;
      const outputTokens = usage.outputTokens || 0;
      const inputCost = (inputTokens / 1000) * pricing.inputCostPer1K;
      const outputCost = (outputTokens / 1000) * pricing.outputCostPer1K;
      return inputCost + outputCost;
    }
  }

  // ==================== BUDGETS ====================

  /**
   * Set budget limit
   * @param {string} scope - 'global' | provider name | project ID
   * @param {number} limit - Budget limit in dollars
   * @param {number[]} alertAt - Alert thresholds (0-1)
   */
  setBudgetLimit(scope, limit, alertAt = [0.5, 0.75, 0.9]) {
    this.data.budgets[scope] = { limit, alertAt };
    this.saveData();
    console.log(`[BudgetManager] Set budget for ${scope}: $${limit}`);
    return true;
  }

  /**
   * Get budget limit
   * @param {string} scope - 'global' | provider name | project ID
   */
  getBudgetLimit(scope) {
    return this.data.budgets[scope] || null;
  }

  /**
   * Get all budget limits
   */
  getAllBudgetLimits() {
    return { ...this.data.budgets };
  }

  /**
   * Check if operation is within budget
   * @param {string} provider - Provider name
   * @param {number} estimatedCost - Estimated cost of operation
   * @returns {Object} {allowed, remaining, warning, message}
   */
  checkBudget(provider, estimatedCost) {
    const result = {
      allowed: true,
      remaining: { global: 0, provider: 0 },
      warning: null,
      message: null
    };

    // Check global budget
    const globalBudget = this.data.budgets.global;
    if (globalBudget && globalBudget.limit > 0) {
      const globalSpent = this.getTotalSpent('all');
      const globalRemaining = globalBudget.limit - globalSpent;
      result.remaining.global = globalRemaining;

      if (globalRemaining < estimatedCost) {
        result.allowed = false;
        result.message = `Global budget exceeded. Remaining: $${globalRemaining.toFixed(2)}`;
        return result;
      }

      // Check alerts
      const globalUsedRatio = (globalSpent + estimatedCost) / globalBudget.limit;
      for (const threshold of globalBudget.alertAt || []) {
        if (globalUsedRatio >= threshold) {
          result.warning = `Global budget ${Math.round(threshold * 100)}% used`;
        }
      }
    }

    // Check provider budget
    const providerBudget = this.data.budgets[provider];
    if (providerBudget && providerBudget.limit > 0) {
      const providerSpent = this.getProviderSpent(provider, 'month');
      const providerRemaining = providerBudget.limit - providerSpent;
      result.remaining.provider = providerRemaining;

      if (providerRemaining < estimatedCost) {
        result.allowed = false;
        result.message = `${provider} budget exceeded. Remaining: $${providerRemaining.toFixed(2)}`;
        return result;
      }

      // Check provider alerts
      const providerUsedRatio = (providerSpent + estimatedCost) / providerBudget.limit;
      for (const threshold of providerBudget.alertAt || []) {
        if (providerUsedRatio >= threshold) {
          result.warning = `${provider} budget ${Math.round(threshold * 100)}% used`;
        }
      }
    }

    return result;
  }

  // ==================== ESTIMATION ====================

  /**
   * Estimate cost before making API call
   * @param {string} provider - Provider name
   * @param {Object} params - Parameters for estimation
   */
  estimateCost(provider, params) {
    const pricing = this.data.pricing[provider] || this._pricing[provider];
    if (!pricing) {
      return { cost: 0, error: 'Unknown provider' };
    }

    let estimatedCost = 0;
    let details = {};

    if (provider === 'elevenlabs') {
      const characters = params.text?.length || params.characters || 0;
      estimatedCost = (characters / 1000) * pricing.costPer1K;
      details = { characters, costPer1K: pricing.costPer1K };
    } else {
      // Token-based estimation
      // Rough estimate: 1 token ≈ 4 characters for English
      const inputChars = params.prompt?.length || params.inputChars || 0;
      const estimatedInputTokens = params.inputTokens || Math.ceil(inputChars / 4);
      const estimatedOutputTokens = params.maxTokens || params.outputTokens || 500;
      
      const inputCost = (estimatedInputTokens / 1000) * pricing.inputCostPer1K;
      const outputCost = (estimatedOutputTokens / 1000) * pricing.outputCostPer1K;
      estimatedCost = inputCost + outputCost;
      
      details = {
        estimatedInputTokens,
        estimatedOutputTokens,
        inputCostPer1K: pricing.inputCostPer1K,
        outputCostPer1K: pricing.outputCostPer1K
      };
    }

    // Check budget
    const budgetCheck = this.checkBudget(provider, estimatedCost);

    return {
      cost: estimatedCost,
      formattedCost: `$${estimatedCost.toFixed(4)}`,
      details,
      ...budgetCheck
    };
  }

  // ==================== REPORTING ====================

  /**
   * Get total spent across all providers
   * @param {string} period - 'day' | 'week' | 'month' | 'all'
   */
  getTotalSpent(period = 'all') {
    const filtered = this.filterUsageByPeriod(this.data.usage, period);
    return filtered.reduce((sum, entry) => sum + (entry.cost || 0), 0);
  }

  /**
   * Get spent amount for a provider
   * @param {string} provider - Provider name
   * @param {string} period - 'day' | 'week' | 'month' | 'all'
   */
  getProviderSpent(provider, period = 'all') {
    const filtered = this.filterUsageByPeriod(this.data.usage, period)
      .filter(entry => entry.provider === provider);
    return filtered.reduce((sum, entry) => sum + (entry.cost || 0), 0);
  }

  /**
   * Get cost summary
   * @param {string} period - 'day' | 'week' | 'month' | 'all'
   */
  getCostSummary(period = 'month') {
    const filtered = this.filterUsageByPeriod(this.data.usage, period);
    
    const byProvider = {};
    const byProject = {};
    let total = 0;

    for (const entry of filtered) {
      total += entry.cost || 0;
      
      // By provider
      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = { cost: 0, count: 0 };
      }
      byProvider[entry.provider].cost += entry.cost || 0;
      byProvider[entry.provider].count++;

      // By project
      if (entry.projectId) {
        if (!byProject[entry.projectId]) {
          byProject[entry.projectId] = { 
            cost: 0, 
            count: 0,
            name: this.data.projects[entry.projectId]?.name || entry.projectId
          };
        }
        byProject[entry.projectId].cost += entry.cost || 0;
        byProject[entry.projectId].count++;
      }
    }

    // Get budget status
    const globalBudget = this.data.budgets.global;
    const budgetStatus = {
      limit: globalBudget?.limit || 0,
      spent: total,
      remaining: (globalBudget?.limit || 0) - total,
      percentUsed: globalBudget?.limit ? (total / globalBudget.limit) * 100 : 0
    };

    return {
      period,
      total,
      formattedTotal: `$${total.toFixed(2)}`,
      byProvider,
      byProject,
      budgetStatus,
      entryCount: filtered.length
    };
  }

  /**
   * Get costs for a specific project
   * @param {string} projectId - Project ID
   */
  getProjectCosts(projectId) {
    const entries = this.data.usage.filter(entry => entry.projectId === projectId);
    const total = entries.reduce((sum, entry) => sum + (entry.cost || 0), 0);
    
    const byProvider = {};
    for (const entry of entries) {
      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = { cost: 0, count: 0 };
      }
      byProvider[entry.provider].cost += entry.cost || 0;
      byProvider[entry.provider].count++;
    }

    return {
      projectId,
      name: this.data.projects[projectId]?.name || projectId,
      total,
      formattedTotal: `$${total.toFixed(2)}`,
      byProvider,
      entries
    };
  }

  /**
   * Get usage history
   * @param {Object} options - Filter options
   */
  getUsageHistory(options = {}) {
    let entries = [...this.data.usage];

    if (options.provider) {
      entries = entries.filter(e => e.provider === options.provider);
    }
    if (options.projectId) {
      entries = entries.filter(e => e.projectId === options.projectId);
    }
    if (options.period) {
      entries = this.filterUsageByPeriod(entries, options.period);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply limit
    if (options.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Filter usage entries by time period
   */
  filterUsageByPeriod(entries, period) {
    if (period === 'all') return entries;

    const now = new Date();
    let cutoff;

    switch (period) {
      case 'day':
        cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'week':
        cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      default:
        return entries;
    }

    return entries.filter(entry => new Date(entry.timestamp) >= cutoff);
  }

  // ==================== PROJECT MANAGEMENT ====================

  /**
   * Register a project for tracking
   * @param {string} projectId - Project ID
   * @param {string} name - Project name
   */
  registerProject(projectId, name) {
    if (!this.data.projects[projectId]) {
      this.data.projects[projectId] = { name, totalCost: 0, createdAt: new Date().toISOString() };
      this.saveData();
    } else {
      // Update name if changed
      this.data.projects[projectId].name = name;
      this.saveData();
    }
    return this.data.projects[projectId];
  }

  /**
   * Get all tracked projects
   */
  getAllProjects() {
    return { ...this.data.projects };
  }

  // ==================== PRICING MANAGEMENT ====================

  /**
   * Update pricing for a provider
   * @param {string} provider - Provider name
   * @param {Object} pricing - New pricing configuration
   */
  updatePricing(provider, pricing) {
    this.data.pricing[provider] = { ...this.data.pricing[provider], ...pricing };
    this.saveData();
    return true;
  }

  /**
   * Get pricing for all providers
   */
  getPricing() {
    return { ...this.data.pricing };
  }

  // ==================== DATA MANAGEMENT ====================

  /**
   * Clear usage history
   * @param {Object} options - Clear options
   */
  clearUsageHistory(options = {}) {
    if (options.before) {
      const cutoff = new Date(options.before);
      this.data.usage = this.data.usage.filter(entry => new Date(entry.timestamp) >= cutoff);
    } else if (options.provider) {
      this.data.usage = this.data.usage.filter(entry => entry.provider !== options.provider);
    } else if (options.projectId) {
      this.data.usage = this.data.usage.filter(entry => entry.projectId !== options.projectId);
    } else {
      this.data.usage = [];
    }
    this.saveData();
    return true;
  }

  /**
   * Export usage data
   */
  exportData() {
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * Reset all data to defaults
   */
  resetToDefaults() {
    this._data = {
      budgets: { ...DEFAULT_BUDGETS },
      usage: [],
      projects: {},
      pricing: { ...DEFAULT_PRICING }
    };
    this.saveData();
    return true;
  }
}

// Singleton instance
let budgetManagerInstance = null;

function getBudgetManager() {
  if (!budgetManagerInstance) {
    budgetManagerInstance = new BudgetManager();
  }
  return budgetManagerInstance;
}

module.exports = { BudgetManager, getBudgetManager };


