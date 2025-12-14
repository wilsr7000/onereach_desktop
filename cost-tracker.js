/**
 * Cost Tracker for GSX Create
 * Tracks API costs per space/project with detailed breakdowns
 */

const fs = require('fs');
const path = require('path');

// Pricing per 1M tokens (as of late 2024)
const PRICING = {
  // Anthropic Claude models (current)
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-opus-4-5-20250929': { input: 15.00, output: 75.00 },
  
  // Legacy Claude models
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
  'claude-opus-4-5-20250514': { input: 15.00, output: 75.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  
  // OpenAI models
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  
  // Vision API calls (per image + tokens)
  'vision-claude': { perImage: 0.0048, input: 3.00, output: 15.00 },
  'vision-gpt4o': { perImage: 0.00255, input: 2.50, output: 10.00 },
  
  // Default fallback
  'default': { input: 3.00, output: 15.00 }
};

class CostTracker {
  constructor(spaceFolder) {
    this.spaceFolder = spaceFolder;
    this.costFile = path.join(spaceFolder, '.gsx-costs.json');
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.costFile)) {
        return JSON.parse(fs.readFileSync(this.costFile, 'utf8'));
      }
    } catch (error) {
      console.error('[CostTracker] Error loading costs:', error);
    }
    return this.getDefaultData();
  }

  getDefaultData() {
    return {
      spaceId: path.basename(this.spaceFolder),
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
      fs.writeFileSync(this.costFile, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[CostTracker] Error saving costs:', error);
    }
  }

  /**
   * Calculate cost for a given number of tokens
   * @param {string} model - Model name
   * @param {number} inputTokens - Number of input tokens
   * @param {number} outputTokens - Number of output tokens
   * @param {object} options - Additional options (e.g., imageCount for vision)
   * @returns {object} Cost breakdown
   */
  calculateCost(model, inputTokens, outputTokens, options = {}) {
    const pricing = PRICING[model] || PRICING['default'];
    
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    let imageCost = 0;
    
    if (options.imageCount && pricing.perImage) {
      imageCost = options.imageCount * pricing.perImage;
    }
    
    const totalCost = inputCost + outputCost + imageCost;
    
    return {
      inputCost: Math.round(inputCost * 1000000) / 1000000,
      outputCost: Math.round(outputCost * 1000000) / 1000000,
      imageCost: Math.round(imageCost * 1000000) / 1000000,
      totalCost: Math.round(totalCost * 1000000) / 1000000,
      inputTokens,
      outputTokens,
      model,
      pricing: {
        inputPer1M: pricing.input,
        outputPer1M: pricing.output
      }
    };
  }

  /**
   * Record an API call
   * @param {object} callData - Call details
   */
  recordCall(callData) {
    const {
      model,
      inputTokens = 0,
      outputTokens = 0,
      type = 'prompt', // 'prompt', 'vision', 'embedding'
      prompt = '',
      imageCount = 0,
      sessionId = null,
      success = true
    } = callData;

    const cost = this.calculateCost(model, inputTokens, outputTokens, { imageCount });
    const timestamp = Date.now();
    const date = new Date().toISOString().split('T')[0];

    const record = {
      id: `call_${timestamp}`,
      timestamp,
      date,
      type,
      model,
      inputTokens,
      outputTokens,
      imageCount,
      ...cost,
      promptPreview: prompt.substring(0, 100),
      sessionId,
      success
    };

    // Update totals
    this.data.totalCost += cost.totalCost;
    this.data.totalInputTokens += inputTokens;
    this.data.totalOutputTokens += outputTokens;
    this.data.totalCalls += 1;

    // Update daily costs
    if (!this.data.dailyCosts[date]) {
      this.data.dailyCosts[date] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    this.data.dailyCosts[date].cost += cost.totalCost;
    this.data.dailyCosts[date].calls += 1;
    this.data.dailyCosts[date].inputTokens += inputTokens;
    this.data.dailyCosts[date].outputTokens += outputTokens;

    // Update model breakdown
    if (!this.data.modelBreakdown[model]) {
      this.data.modelBreakdown[model] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    this.data.modelBreakdown[model].cost += cost.totalCost;
    this.data.modelBreakdown[model].calls += 1;
    this.data.modelBreakdown[model].inputTokens += inputTokens;
    this.data.modelBreakdown[model].outputTokens += outputTokens;

    // Add to sessions (keep last 500 calls)
    this.data.sessions.unshift(record);
    if (this.data.sessions.length > 500) {
      this.data.sessions = this.data.sessions.slice(0, 500);
    }

    this.save();

    console.log(`[CostTracker] Recorded: $${cost.totalCost.toFixed(6)} (${inputTokens} in, ${outputTokens} out) - Total: $${this.data.totalCost.toFixed(4)}`);

    return record;
  }

  /**
   * Parse Aider's cost message to extract tokens
   * Example: "Tokens: 13k sent, 171 received. Cost: $0.04 message, $0.04 session."
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
   * Get summary statistics
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
      totalCost: Math.round(this.data.totalCost * 10000) / 10000,
      totalCalls: this.data.totalCalls,
      totalInputTokens: this.data.totalInputTokens,
      totalOutputTokens: this.data.totalOutputTokens,
      todayCost: Math.round(todayCosts.cost * 10000) / 10000,
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
    
    return { totalCost, totalCalls, startDate, endDate };
  }

  /**
   * Reset costs (with confirmation)
   */
  resetCosts() {
    const backup = { ...this.data };
    this.data = this.getDefaultData();
    this.save();
    console.log('[CostTracker] Costs reset. Previous total was: $' + backup.totalCost.toFixed(4));
    return backup;
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

module.exports = { CostTracker, getCostTracker, PRICING };

