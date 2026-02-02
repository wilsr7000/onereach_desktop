/**
 * LLM Usage Tracker
 * 
 * Provides real-time session tracking and dashboard notifications.
 * DELEGATES storage to BudgetManager (primary tracker).
 * 
 * Responsibilities:
 * - Session-level usage summaries
 * - Dashboard badge notifications
 * - Real-time cost display
 * 
 * Storage is handled by BudgetManager for single source of truth.
 */

const { calculateCost, formatCost, getPricingForModel } = require('./pricing-config');

class LLMUsageTracker {
  constructor() {
    // In-memory cache for current session only
    this.sessionUsage = {
      claude: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      openai: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    };
    
    // Recent operations cache (last 50 for quick display)
    this.recentOperations = [];
    this.maxRecentOperations = 50;
    
    // Session start time
    this.sessionStart = new Date();
    
    console.log('[LLMUsageTracker] Initialized (delegates to BudgetManager)');
  }

  /**
   * Track a Claude API call
   * Delegates to BudgetManager for storage, keeps session cache for UI
   */
  trackClaudeCall(data) {
    const {
      model = 'claude-sonnet-4-5-20250929',
      inputTokens = 0,
      outputTokens = 0,
      feature = 'other',
      purpose = '',
      success = true,
      duration = 0,
      projectId = null,
      spaceId = null
    } = data;

    // Calculate cost
    const costResult = calculateCost(model, inputTokens, outputTokens);
    
    // Update session totals
    this.sessionUsage.claude.calls++;
    this.sessionUsage.claude.inputTokens += inputTokens;
    this.sessionUsage.claude.outputTokens += outputTokens;
    this.sessionUsage.claude.cost += costResult.totalCost;
    
    // Create operation record
    const operation = {
      id: `op-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      model: costResult.model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost: costResult.totalCost,
      feature,
      purpose,
      success,
      duration
    };
    
    // Add to recent operations
    this.recentOperations.unshift(operation);
    if (this.recentOperations.length > this.maxRecentOperations) {
      this.recentOperations = this.recentOperations.slice(0, this.maxRecentOperations);
    }
    
    // Delegate storage to BudgetManager
    this._delegateToBudgetManager({
      provider: 'anthropic',
      model: costResult.model,
      inputTokens,
      outputTokens,
      projectId: projectId || spaceId,
      spaceId: spaceId || projectId,
      feature,
      operation: purpose || feature,
      success
    });
    
    // Send dashboard notifications
    this._notifyDashboard(operation);
    this._notifyRendererLLMCall(operation);
    
    return operation;
  }

  /**
   * Track an OpenAI API call
   */
  trackOpenAICall(data) {
    const {
      model = 'gpt-4o',
      inputTokens = 0,
      outputTokens = 0,
      feature = 'other',
      purpose = '',
      success = true,
      duration = 0,
      projectId = null,
      spaceId = null
    } = data;

    // Calculate cost
    const costResult = calculateCost(model, inputTokens, outputTokens);
    
    // Update session totals
    this.sessionUsage.openai.calls++;
    this.sessionUsage.openai.inputTokens += inputTokens;
    this.sessionUsage.openai.outputTokens += outputTokens;
    this.sessionUsage.openai.cost += costResult.totalCost;
    
    // Create operation record
    const operation = {
      id: `op-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      provider: 'openai',
      model: costResult.model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost: costResult.totalCost,
      feature,
      purpose,
      success,
      duration
    };
    
    // Add to recent operations
    this.recentOperations.unshift(operation);
    if (this.recentOperations.length > this.maxRecentOperations) {
      this.recentOperations = this.recentOperations.slice(0, this.maxRecentOperations);
    }
    
    // Delegate storage to BudgetManager
    this._delegateToBudgetManager({
      provider: 'openai',
      model: costResult.model,
      inputTokens,
      outputTokens,
      projectId: projectId || spaceId,
      spaceId: spaceId || projectId,
      feature,
      operation: purpose || feature,
      success
    });
    
    // Send notifications
    this._notifyDashboard(operation);
    this._notifyRendererLLMCall(operation);
    
    return operation;
  }

  /**
   * Delegate to BudgetManager for persistent storage
   */
  _delegateToBudgetManager(params) {
    try {
      const { getBudgetManager } = require('./budget-manager');
      const budgetManager = getBudgetManager();
      budgetManager.trackUsage(params);
    } catch (error) {
      console.error('[LLMUsageTracker] Failed to delegate to BudgetManager:', error.message);
    }
  }

  /**
   * Notify Dashboard API
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
   * Notify renderer process for badge display
   */
  _notifyRendererLLMCall(operation) {
    try {
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      
      const badgeData = {
        provider: operation.provider,
        model: operation.model,
        feature: operation.feature,
        tokens: operation.totalTokens,
        cost: operation.cost,
        costFormatted: formatCost(operation.cost),
        timestamp: operation.timestamp,
        sessionTotal: this.getSessionTotal()
      };
      
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('llm:call-made', badgeData);
        }
      }
    } catch (error) {
      // Renderer might not be ready
    }
  }

  /**
   * Get session totals
   */
  getSessionTotal() {
    return {
      calls: this.sessionUsage.claude.calls + this.sessionUsage.openai.calls,
      cost: Math.round((this.sessionUsage.claude.cost + this.sessionUsage.openai.cost) * 100) / 100,
      costFormatted: formatCost(this.sessionUsage.claude.cost + this.sessionUsage.openai.cost)
    };
  }

  /**
   * Get usage summary (session-level)
   */
  getUsageSummary() {
    const claude = this.sessionUsage.claude;
    const openai = this.sessionUsage.openai;
    const totalCost = claude.cost + openai.cost;
    
    return {
      period: 'session',
      sessionStart: this.sessionStart.toISOString(),
      claude: {
        calls: claude.calls,
        tokens: claude.inputTokens + claude.outputTokens,
        inputTokens: claude.inputTokens,
        outputTokens: claude.outputTokens,
        cost: Math.round(claude.cost * 100) / 100,
        costFormatted: formatCost(claude.cost)
      },
      openai: {
        calls: openai.calls,
        tokens: openai.inputTokens + openai.outputTokens,
        inputTokens: openai.inputTokens,
        outputTokens: openai.outputTokens,
        cost: Math.round(openai.cost * 100) / 100,
        costFormatted: formatCost(openai.cost)
      },
      total: {
        calls: claude.calls + openai.calls,
        tokens: claude.inputTokens + claude.outputTokens + openai.inputTokens + openai.outputTokens,
        cost: Math.round(totalCost * 100) / 100,
        costFormatted: formatCost(totalCost)
      },
      recentOperations: this.recentOperations.slice(0, 20)
    };
  }

  /**
   * Reset session (not persistent data - that's in BudgetManager)
   */
  resetSession() {
    this.sessionUsage = {
      claude: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      openai: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    };
    this.recentOperations = [];
    this.sessionStart = new Date();
  }

  /**
   * Calculate cost (delegates to pricing-config)
   */
  calculateCost(model, inputTokens, outputTokens) {
    return calculateCost(model, inputTokens, outputTokens).totalCost;
  }

  /**
   * Export session data (for debugging)
   */
  exportData(format = 'json') {
    const data = {
      exportDate: new Date().toISOString(),
      sessionStart: this.sessionStart.toISOString(),
      summary: this.getUsageSummary(),
      allOperations: this.recentOperations
    };
    
    return format === 'json' ? JSON.stringify(data, null, 2) : data;
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
  if (instance) {
    instance.resetSession();
  }
}

module.exports = {
  LLMUsageTracker,
  getLLMUsageTracker,
  resetLLMUsageTracker
};
