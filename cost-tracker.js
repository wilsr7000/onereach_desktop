/**
 * Cost Tracker for GSX Create
 * 
 * Provides per-space cost summaries and tracking.
 * DELEGATES storage to BudgetManager (primary tracker).
 * Uses unified pricing from pricing-config.js.
 * 
 * This tracker provides space-local summaries while BudgetManager
 * handles the global cost database.
 */

const fs = require('fs');
const path = require('path');
const { calculateCost, formatCost, PRICING } = require('./pricing-config');

class CostTracker {
  constructor(spaceFolder) {
    this.spaceFolder = spaceFolder;
    this.spaceId = path.basename(spaceFolder);
    this.costFile = path.join(spaceFolder, '.gsx-costs.json');
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.costFile)) {
        const data = JSON.parse(fs.readFileSync(this.costFile, 'utf8'));
        return this._migrateData(data);
      }
    } catch (error) {
      console.error('[CostTracker] Error loading costs:', error);
    }
    return this.getDefaultData();
  }

  _migrateData(data) {
    // Ensure all fields exist
    return {
      ...this.getDefaultData(),
      ...data
    };
  }

  getDefaultData() {
    return {
      spaceId: this.spaceId,
      created: new Date().toISOString(),
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCalls: 0,
      sessions: [],
      dailyCosts: {},
      modelBreakdown: {}
    };
  }

  save() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.costFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.costFile, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[CostTracker] Error saving costs:', error);
    }
  }

  /**
   * Record an API call
   * Stores locally AND delegates to BudgetManager
   */
  recordCall(callData) {
    const {
      model,
      inputTokens = 0,
      outputTokens = 0,
      type = 'prompt',
      prompt = '',
      imageCount = 0,
      sessionId = null,
      success = true,
      feature = 'gsx-create'
    } = callData;

    // Use unified pricing calculation
    const costResult = calculateCost(model, inputTokens, outputTokens, { imageCount });
    const timestamp = Date.now();
    const date = new Date().toISOString().split('T')[0];

    const record = {
      id: `call_${timestamp}`,
      timestamp,
      date,
      type,
      model: costResult.model,
      inputTokens,
      outputTokens,
      imageCount,
      ...costResult,
      promptPreview: prompt.substring(0, 100),
      sessionId,
      success
    };

    // Update local totals
    this.data.totalCost += costResult.totalCost;
    this.data.totalInputTokens += inputTokens;
    this.data.totalOutputTokens += outputTokens;
    this.data.totalCalls += 1;

    // Update daily costs
    if (!this.data.dailyCosts[date]) {
      this.data.dailyCosts[date] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    this.data.dailyCosts[date].cost += costResult.totalCost;
    this.data.dailyCosts[date].calls += 1;
    this.data.dailyCosts[date].inputTokens += inputTokens;
    this.data.dailyCosts[date].outputTokens += outputTokens;

    // Update model breakdown
    const modelKey = costResult.model;
    if (!this.data.modelBreakdown[modelKey]) {
      this.data.modelBreakdown[modelKey] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    this.data.modelBreakdown[modelKey].cost += costResult.totalCost;
    this.data.modelBreakdown[modelKey].calls += 1;
    this.data.modelBreakdown[modelKey].inputTokens += inputTokens;
    this.data.modelBreakdown[modelKey].outputTokens += outputTokens;

    // Add to sessions (keep last 500 calls)
    this.data.sessions.unshift(record);
    if (this.data.sessions.length > 500) {
      this.data.sessions = this.data.sessions.slice(0, 500);
    }

    // Save local file
    this.save();

    // Delegate to BudgetManager for centralized tracking
    this._delegateToBudgetManager({
      provider: costResult.provider,
      model: costResult.model,
      inputTokens,
      outputTokens,
      projectId: this.spaceId,
      spaceId: this.spaceId,
      feature,
      operation: type,
      success,
      options: { imageCount }
    });

    console.log(`[CostTracker] Recorded: ${formatCost(costResult.totalCost)} (${inputTokens} in, ${outputTokens} out) - Total: ${formatCost(this.data.totalCost)}`);

    return record;
  }

  /**
   * Delegate to BudgetManager for centralized tracking
   */
  _delegateToBudgetManager(params) {
    try {
      const { getBudgetManager } = require('./budget-manager');
      const budgetManager = getBudgetManager();
      budgetManager.trackUsage(params);
    } catch (error) {
      // BudgetManager might not be available in all contexts
      console.warn('[CostTracker] Could not delegate to BudgetManager:', error.message);
    }
  }

  /**
   * Parse Aider's cost message to extract tokens
   */
  parseAiderCostMessage(message) {
    const tokenMatch = message.match(/Tokens:\s*([\d.]+)k?\s*sent,\s*([\d.]+)k?\s*received/i);
    const costMatch = message.match(/Cost:\s*\$([\d.]+)\s*message/i);
    
    if (tokenMatch) {
      let inputTokens = parseFloat(tokenMatch[1]);
      let outputTokens = parseFloat(tokenMatch[2]);
      
      // Handle 'k' suffix
      if (tokenMatch[1].includes('k') || inputTokens > 100) {
        inputTokens = inputTokens * 1000;
      }
      if (tokenMatch[2].includes('k') || outputTokens > 100) {
        outputTokens = outputTokens * 1000;
      }
      
      return {
        inputTokens: Math.round(inputTokens),
        outputTokens: Math.round(outputTokens),
        reportedCost: costMatch ? parseFloat(costMatch[1]) : null
      };
    }
    
    return null;
  }

  /**
   * Get summary statistics for this space
   */
  getSummary() {
    const today = new Date().toISOString().split('T')[0];
    const todayCosts = this.data.dailyCosts[today] || { cost: 0, calls: 0 };
    
    // Get last 7 days
    const last7Days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      last7Days.push({
        date: dateStr,
        ...this.data.dailyCosts[dateStr] || { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 }
      });
    }
    
    return {
      spaceId: this.spaceId,
      totalCost: Math.round(this.data.totalCost * 10000) / 10000,
      totalCostFormatted: formatCost(this.data.totalCost),
      totalCalls: this.data.totalCalls,
      totalInputTokens: this.data.totalInputTokens,
      totalOutputTokens: this.data.totalOutputTokens,
      todayCost: Math.round(todayCosts.cost * 10000) / 10000,
      todayCostFormatted: formatCost(todayCosts.cost),
      todayCalls: todayCosts.calls,
      last7Days,
      modelBreakdown: this.data.modelBreakdown,
      recentCalls: this.data.sessions.slice(0, 20)
    };
  }

  /**
   * Get cost for a specific date range
   */
  getCostByDateRange(startDate, endDate) {
    let totalCost = 0;
    let totalCalls = 0;
    
    Object.entries(this.data.dailyCosts).forEach(([date, data]) => {
      if (date >= startDate && date <= endDate) {
        totalCost += data.cost;
        totalCalls += data.calls;
      }
    });
    
    return { 
      totalCost, 
      totalCostFormatted: formatCost(totalCost),
      totalCalls, 
      startDate, 
      endDate 
    };
  }

  /**
   * Reset costs (with backup)
   */
  resetCosts() {
    const backup = { ...this.data };
    this.data = this.getDefaultData();
    this.save();
    console.log('[CostTracker] Costs reset. Previous total was: ' + formatCost(backup.totalCost));
    return backup;
  }

  /**
   * Calculate cost using unified pricing
   */
  calculateCost(model, inputTokens, outputTokens, options = {}) {
    return calculateCost(model, inputTokens, outputTokens, options);
  }
}

// Singleton instances per space
const instances = new Map();

function getCostTracker(spaceFolder) {
  if (!instances.has(spaceFolder)) {
    instances.set(spaceFolder, new CostTracker(spaceFolder));
  }
  return instances.get(spaceFolder);
}

// Export unified pricing for backward compatibility
module.exports = { CostTracker, getCostTracker, PRICING };
