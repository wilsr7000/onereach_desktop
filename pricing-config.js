/**
 * Unified Pricing Configuration
 *
 * SINGLE SOURCE OF TRUTH for all API pricing across the application.
 * All cost tracking systems MUST import from this file.
 *
 * Pricing is per 1 MILLION tokens (not per 1K).
 *
 * @module pricing-config
 */

// =============================================================================
// PRICING TABLE - Update prices here ONLY
// =============================================================================

const PRICING = {
  // =========== ANTHROPIC CLAUDE MODELS ===========

  // Claude 4.5 (Latest - 2025)
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0, provider: 'anthropic' },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, provider: 'anthropic' },

  // Claude 4 (2025)
  'claude-opus-4-20250514': { input: 15.0, output: 75.0, provider: 'anthropic' },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, provider: 'anthropic' },

  // Claude 3.5 (2024)
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, provider: 'anthropic' },
  'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0, provider: 'anthropic' },

  // Claude 3 (Legacy)
  'claude-3-opus-20240229': { input: 15.0, output: 75.0, provider: 'anthropic' },
  'claude-3-sonnet-20240229': { input: 3.0, output: 15.0, provider: 'anthropic' },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, provider: 'anthropic' },

  // =========== OPENAI MODELS ===========

  // GPT-5 series (2025+)
  'gpt-5.2': { input: 5.0, output: 15.0, provider: 'openai' },
  'gpt-5': { input: 5.0, output: 15.0, provider: 'openai' },

  // GPT-4o series
  'gpt-4o': { input: 2.5, output: 10.0, provider: 'openai' },
  'gpt-4o-mini': { input: 0.15, output: 0.6, provider: 'openai' },
  'gpt-4o-2024-08-06': { input: 2.5, output: 10.0, provider: 'openai' },

  // GPT-4 Turbo
  'gpt-4-turbo': { input: 10.0, output: 30.0, provider: 'openai' },
  'gpt-4-turbo-preview': { input: 10.0, output: 30.0, provider: 'openai' },

  // GPT-4 (Legacy)
  'gpt-4': { input: 30.0, output: 60.0, provider: 'openai' },
  'gpt-4-32k': { input: 60.0, output: 120.0, provider: 'openai' },

  // GPT-3.5
  'gpt-3.5-turbo': { input: 0.5, output: 1.5, provider: 'openai' },
  'gpt-3.5-turbo-16k': { input: 1.0, output: 2.0, provider: 'openai' },

  // =========== VISION MODELS ===========
  'vision-claude': { input: 3.0, output: 15.0, perImage: 0.0048, provider: 'anthropic' },
  'vision-gpt4o': { input: 2.5, output: 10.0, perImage: 0.00255, provider: 'openai' },

  // =========== AUDIO/SPEECH MODELS ===========
  'whisper-1': { perMinute: 0.006, provider: 'openai' },
  'tts-1': { per1KChars: 0.015, provider: 'openai' },
  'tts-1-hd': { per1KChars: 0.03, provider: 'openai' },

  // ElevenLabs
  elevenlabs: { per1KChars: 0.3, provider: 'elevenlabs' },
  'elevenlabs-sfx': { perGeneration: 0.2, provider: 'elevenlabs' },

  // =========== EMBEDDING MODELS ===========
  'text-embedding-3-small': { input: 0.02, output: 0, provider: 'openai' },
  'text-embedding-3-large': { input: 0.13, output: 0, provider: 'openai' },
  'text-embedding-ada-002': { input: 0.1, output: 0, provider: 'openai' },
};

// =============================================================================
// MODEL ALIASES - Map shorthand names to full model IDs
// =============================================================================

const MODEL_ALIASES = {
  // Claude shortcuts
  'claude-opus': 'claude-opus-4-5-20251101',
  'claude-sonnet': 'claude-sonnet-4-5-20250929',
  'claude-4-opus': 'claude-opus-4-5-20251101',
  'claude-4-sonnet': 'claude-sonnet-4-5-20250929',
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-sonnet': 'claude-3-sonnet-20240229',
  'claude-3-haiku': 'claude-3-haiku-20240307',
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  opus: 'claude-opus-4-5-20251101',
  sonnet: 'claude-sonnet-4-5-20250929',
  haiku: 'claude-3-haiku-20240307',

  // OpenAI shortcuts
  gpt4: 'gpt-4',
  gpt4o: 'gpt-4o',
  'gpt4-turbo': 'gpt-4-turbo',
  gpt35: 'gpt-3.5-turbo',
  'gpt-3.5': 'gpt-3.5-turbo',

  // Generic
  default: 'claude-sonnet-4-5-20250929',
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Resolve a model name (including aliases) to its full ID
 * @param {string} model - Model name or alias
 * @returns {string} Full model ID
 */
function resolveModelName(model) {
  if (!model || typeof model !== 'string') return MODEL_ALIASES['default'];

  // Direct match
  if (PRICING[model]) return model;

  // Try alias
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];

  // Try lowercase
  const lowerModel = model.toLowerCase();
  if (PRICING[lowerModel]) return lowerModel;
  if (MODEL_ALIASES[lowerModel]) return MODEL_ALIASES[lowerModel];

  // Partial match for Claude models
  if (model.includes('opus')) return 'claude-opus-4-5-20251101';
  if (model.includes('sonnet')) return 'claude-sonnet-4-5-20250929';
  if (model.includes('haiku')) return 'claude-3-haiku-20240307';

  // Default fallback
  return MODEL_ALIASES['default'];
}

/**
 * Get pricing for a model
 * @param {string} model - Model name or alias
 * @returns {object} Pricing object { input, output, provider, ... }
 */
function getPricingForModel(model) {
  const resolvedModel = resolveModelName(model);
  return PRICING[resolvedModel] || PRICING[MODEL_ALIASES['default']];
}

/**
 * Calculate cost for token usage
 * @param {string} model - Model name
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @param {object} options - Additional options { imageCount, audioMinutes, chars }
 * @returns {object} Cost breakdown
 */
function calculateCost(model, inputTokens = 0, outputTokens = 0, options = {}) {
  const pricing = getPricingForModel(model);
  const resolvedModel = resolveModelName(model);

  // Token costs (per 1M tokens)
  const inputCost = pricing.input ? (inputTokens / 1000000) * pricing.input : 0;
  const outputCost = pricing.output ? (outputTokens / 1000000) * pricing.output : 0;

  // Additional costs
  let imageCost = 0;
  let audioCost = 0;
  let charCost = 0;

  if (options.imageCount && pricing.perImage) {
    imageCost = options.imageCount * pricing.perImage;
  }

  if (options.audioMinutes && pricing.perMinute) {
    audioCost = options.audioMinutes * pricing.perMinute;
  }

  if (options.chars && pricing.per1KChars) {
    charCost = (options.chars / 1000) * pricing.per1KChars;
  }

  const totalCost = inputCost + outputCost + imageCost + audioCost + charCost;

  return {
    model: resolvedModel,
    provider: pricing.provider || 'unknown',
    inputTokens,
    outputTokens,
    inputCost: roundCost(inputCost),
    outputCost: roundCost(outputCost),
    imageCost: roundCost(imageCost),
    audioCost: roundCost(audioCost),
    charCost: roundCost(charCost),
    totalCost: roundCost(totalCost),
    pricing: {
      inputPer1M: pricing.input || 0,
      outputPer1M: pricing.output || 0,
    },
  };
}

/**
 * Round cost to 6 decimal places for precision
 * @param {number} cost
 * @returns {number}
 */
function roundCost(cost) {
  return Math.round(cost * 1000000) / 1000000;
}

/**
 * Format cost for display
 * @param {number} cost - Cost in dollars
 * @param {number} decimals - Number of decimal places (default 4)
 * @returns {string} Formatted string like "$0.0234"
 */
function formatCost(cost, decimals = 4) {
  if (cost === 0) return '$0.00';
  if (cost < 0.0001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(decimals)}`;
}

/**
 * Get all available models for a provider
 * @param {string} provider - 'anthropic', 'openai', etc.
 * @returns {string[]} Array of model IDs
 */
function getModelsForProvider(provider) {
  return Object.entries(PRICING)
    .filter(([_, pricing]) => pricing.provider === provider)
    .map(([model, _]) => model);
}

/**
 * Get a summary of current pricing for budget display
 * @returns {object} Pricing summary by provider
 */
function getPricingSummary() {
  const summary = {
    anthropic: {},
    openai: {},
    elevenlabs: {},
  };

  for (const [model, pricing] of Object.entries(PRICING)) {
    if (pricing.provider && summary[pricing.provider]) {
      summary[pricing.provider][model] = {
        input: pricing.input,
        output: pricing.output,
        ...pricing,
      };
    }
  }

  return summary;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  PRICING,
  MODEL_ALIASES,
  resolveModelName,
  getPricingForModel,
  calculateCost,
  roundCost,
  formatCost,
  getModelsForProvider,
  getPricingSummary,
};
