/**
 * LLM Usage Tracker
 * 
 * Tracks all LLM API calls across the application, including:
 * - Claude API calls
 * - OpenAI API calls
 * 
 * Provides cost estimation, usage breakdown by feature,
 * and historical tracking.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Pricing per 1M tokens (as of 2026)
const PRICING = {
  // Claude models
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-opus-4-5-20250929': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-opus': { input: 15.00, output: 75.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  
  // OpenAI models
  'gpt-5.2': { input: 5.00, output: 15.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  
  // Default fallback
  'default': { input: 3.00, output: 15.00 }
};

class LLMUsageTracker {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'llm-usage');
    this._ensureDataDir();
    
    // In-memory cache for current session
    this.sessionUsage = {
      claude: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      openai: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    };
    
    // Recent operations cache (last 100)
    this.recentOperations = [];
    this.maxRecentOperations = 100;
    
    // Usage by feature
    this.usageByFeature = {};
    
    // Load historical data
    this._loadCurrentMonth();
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  _getMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  _getMonthFilePath(monthKey = null) {
    const key = monthKey || this._getMonthKey();
    return path.join(this.dataDir, `usage-${key}.json`);
  }

  _loadCurrentMonth() {
    try {
      const filePath = this._getMonthFilePath();
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Merge with session
        if (data.claude) {
          this.sessionUsage.claude = { ...this.sessionUsage.claude, ...data.claude };
        }
        if (data.openai) {
          this.sessionUsage.openai = { ...this.sessionUsage.openai, ...data.openai };
        }
        if (data.byFeature) {
          this.usageByFeature = data.byFeature;
        }
        if (data.recentOperations) {
          this.recentOperations = data.recentOperations.slice(0, this.maxRecentOperations);
        }
      }
    } catch (error) {
      console.error('[LLMTracker] Error loading monthly data:', error);
    }
  }

  _saveCurrentMonth() {
    try {
      const filePath = this._getMonthFilePath();
      const data = {
        month: this._getMonthKey(),
        claude: this.sessionUsage.claude,
        openai: this.sessionUsage.openai,
        byFeature: this.usageByFeature,
        recentOperations: this.recentOperations,
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[LLMTracker] Error saving monthly data:', error);
    }
  }

  /**
   * Calculate cost for a given model and token counts
   */
  calculateCost(model, inputTokens, outputTokens) {
    const pricing = PRICING[model] || PRICING['default'];
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    return Math.round((inputCost + outputCost) * 10000) / 10000; // Round to 4 decimals
  }

  /**
   * Track a Claude API call
   */
  trackClaudeCall(data) {
    const {
      model = 'claude-sonnet-4-5-20250929',
      inputTokens = 0,
      outputTokens = 0,
      feature = 'other',
      purpose = '',
      success = true,
      duration = 0
    } = data;

    const cost = this.calculateCost(model, inputTokens, outputTokens);
    
    // Update session totals
    this.sessionUsage.claude.calls++;
    this.sessionUsage.claude.inputTokens += inputTokens;
    this.sessionUsage.claude.outputTokens += outputTokens;
    this.sessionUsage.claude.cost += cost;
    
    // Update by feature
    if (!this.usageByFeature[feature]) {
      this.usageByFeature[feature] = { calls: 0, tokens: 0, cost: 0 };
    }
    this.usageByFeature[feature].calls++;
    this.usageByFeature[feature].tokens += inputTokens + outputTokens;
    this.usageByFeature[feature].cost += cost;
    
    // Add to recent operations
    const operation = {
      id: `op-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      provider: 'claude',
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost,
      feature,
      purpose,
      success,
      duration
    };
    
    this.recentOperations.unshift(operation);
    if (this.recentOperations.length > this.maxRecentOperations) {
      this.recentOperations = this.recentOperations.slice(0, this.maxRecentOperations);
    }
    
    // Save to disk
    this._saveCurrentMonth();
    
    // Notify dashboard API if available
    this._notifyDashboard(operation);
    
    return operation;
  }

  /**
   * Track an OpenAI API call
   */
  trackOpenAICall(data) {
    const {
      model = 'gpt-5.2',
      inputTokens = 0,
      outputTokens = 0,
      feature = 'other',
      purpose = '',
      success = true,
      duration = 0
    } = data;

    const cost = this.calculateCost(model, inputTokens, outputTokens);
    
    // Update session totals
    this.sessionUsage.openai.calls++;
    this.sessionUsage.openai.inputTokens += inputTokens;
    this.sessionUsage.openai.outputTokens += outputTokens;
    this.sessionUsage.openai.cost += cost;
    
    // Update by feature
    if (!this.usageByFeature[feature]) {
      this.usageByFeature[feature] = { calls: 0, tokens: 0, cost: 0 };
    }
    this.usageByFeature[feature].calls++;
    this.usageByFeature[feature].tokens += inputTokens + outputTokens;
    this.usageByFeature[feature].cost += cost;
    
    // Add to recent operations
    const operation = {
      id: `op-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      provider: 'openai',
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost,
      feature,
      purpose,
      success,
      duration
    };
    
    this.recentOperations.unshift(operation);
    if (this.recentOperations.length > this.maxRecentOperations) {
      this.recentOperations = this.recentOperations.slice(0, this.maxRecentOperations);
    }
    
    // Save to disk
    this._saveCurrentMonth();
    
    // Notify dashboard API
    this._notifyDashboard(operation);
    
    return operation;
  }

  /**
   * Notify dashboard of new operation
   */
  _notifyDashboard(operation) {
    try {
      const { getDashboardAPI } = require('./dashboard-api');
      const dashboardAPI = getDashboardAPI();
      dashboardAPI.recordAIOperation(
        operation.purpose || operation.feature,
        operation.model,
        operation.totalTokens,
        operation.cost,
        { provider: operation.provider }
      );
    } catch (error) {
      // Dashboard API might not be initialized yet
    }
  }

  /**
   * Get usage summary
   */
  getUsageSummary(period = 'month') {
    const claude = this.sessionUsage.claude;
    const openai = this.sessionUsage.openai;
    
    // Calculate feature percentages
    const totalCost = claude.cost + openai.cost;
    const byFeature = {};
    
    for (const [feature, data] of Object.entries(this.usageByFeature)) {
      byFeature[feature] = {
        ...data,
        percentage: totalCost > 0 ? Math.round((data.cost / totalCost) * 100) : 0
      };
    }
    
    // Sort by cost descending
    const sortedFeatures = Object.entries(byFeature)
      .sort((a, b) => b[1].cost - a[1].cost)
      .reduce((obj, [key, val]) => {
        obj[key] = val;
        return obj;
      }, {});
    
    return {
      period: this._getMonthKey(),
      claude: {
        calls: claude.calls,
        tokens: claude.inputTokens + claude.outputTokens,
        inputTokens: claude.inputTokens,
        outputTokens: claude.outputTokens,
        cost: Math.round(claude.cost * 100) / 100,
        avgCostPerCall: claude.calls > 0 ? Math.round((claude.cost / claude.calls) * 1000) / 1000 : 0
      },
      openai: {
        calls: openai.calls,
        tokens: openai.inputTokens + openai.outputTokens,
        inputTokens: openai.inputTokens,
        outputTokens: openai.outputTokens,
        cost: Math.round(openai.cost * 100) / 100,
        avgCostPerCall: openai.calls > 0 ? Math.round((openai.cost / openai.calls) * 1000) / 1000 : 0
      },
      total: {
        calls: claude.calls + openai.calls,
        tokens: claude.inputTokens + claude.outputTokens + openai.inputTokens + openai.outputTokens,
        cost: Math.round((claude.cost + openai.cost) * 100) / 100
      },
      byFeature: sortedFeatures,
      recentOperations: this.recentOperations.slice(0, 20)
    };
  }

  /**
   * Get daily breakdown for charts
   */
  getDailyBreakdown(days = 30) {
    // This would aggregate from stored data
    // For now, return current session as single day
    const today = new Date().toISOString().split('T')[0];
    
    return [{
      date: today,
      claude: this.sessionUsage.claude,
      openai: this.sessionUsage.openai
    }];
  }

  /**
   * Get historical data for a specific month
   */
  getMonthlyData(monthKey) {
    try {
      const filePath = this._getMonthFilePath(monthKey);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (error) {
      console.error('[LLMTracker] Error loading monthly data:', error);
    }
    return null;
  }

  /**
   * Reset current month's data
   */
  resetCurrentMonth() {
    this.sessionUsage = {
      claude: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      openai: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    };
    this.usageByFeature = {};
    this.recentOperations = [];
    this._saveCurrentMonth();
  }

  /**
   * Export usage data
   */
  exportData(format = 'json') {
    const data = {
      exportDate: new Date().toISOString(),
      currentMonth: this._getMonthKey(),
      summary: this.getUsageSummary(),
      allOperations: this.recentOperations
    };
    
    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }
    
    return data;
  }
}

// Singleton instance
let instance = null;

function getLLMUsageTracker() {
  if (!instance) {
    instance = new LLMUsageTracker();
  }
  return instance;
}

function resetLLMUsageTracker() {
  instance = null;
}

module.exports = {
  LLMUsageTracker,
  getLLMUsageTracker,
  resetLLMUsageTracker,
  PRICING
};

