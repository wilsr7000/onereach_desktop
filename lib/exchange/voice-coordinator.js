/**
 * Voice Coordinator - Agent voice personalities, search, and configuration.
 *
 * Extracted from exchange-bridge.js to reduce file size and improve separation
 * of concerns. This module owns all voice-related constants and helpers.
 */

'use strict';

// ==================== AGENT VOICE PERSONALITIES ====================
// Each agent gets a unique voice that matches their personality
// OpenAI Realtime API voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
// See packages/agents/VOICE-GUIDE.md for voice descriptions and selection guide

// Default voice assignments (used if agent doesn't specify voice property)
const DEFAULT_AGENT_VOICES = {
  'dj-agent': 'ash', // Warm, friendly - like a radio DJ
  'smalltalk-agent': 'coral', // Clear, welcoming
  'time-agent': 'sage', // Calm, informative
  'weather-agent': 'verse', // Natural, conversational
  'calendar-query-agent': 'alloy', // Clear, informative
  'calendar-create-agent': 'alloy', // Clear, informative
  'calendar-edit-agent': 'alloy', // Clear, informative
  'calendar-delete-agent': 'alloy', // Clear, informative
  'help-agent': 'alloy', // Neutral, helpful
  'search-agent': 'echo', // Authoritative, knowledgeable
  'spelling-agent': 'sage', // Calm, precise
  'media-agent': 'ash', // Warm, entertainment-focused
  'fallback-agent': 'alloy', // Neutral default
};

// Voice descriptions for reference (searchable)
const VOICE_DESCRIPTIONS = {
  alloy: {
    personality: 'Neutral, balanced, versatile',
    bestFor: 'General purpose, help systems',
    keywords: ['neutral', 'balanced', 'default', 'professional'],
  },
  ash: {
    personality: 'Warm, friendly, personable',
    bestFor: 'Music, entertainment, social',
    keywords: ['warm', 'friendly', 'DJ', 'music', 'entertainment'],
  },
  ballad: {
    personality: 'Expressive, storytelling, dramatic',
    bestFor: 'Creative, narrative content',
    keywords: ['expressive', 'storytelling', 'dramatic', 'creative'],
  },
  coral: {
    personality: 'Clear, professional, articulate',
    bestFor: 'Business, scheduling',
    keywords: ['clear', 'professional', 'business', 'scheduling'],
  },
  echo: {
    personality: 'Deep, authoritative, knowledgeable',
    bestFor: 'Search, education, experts',
    keywords: ['authoritative', 'knowledgeable', 'expert', 'search'],
  },
  sage: {
    personality: 'Calm, wise, measured',
    bestFor: 'Time, spelling, precision',
    keywords: ['calm', 'wise', 'precise', 'time', 'spelling'],
  },
  shimmer: {
    personality: 'Energetic, bright, enthusiastic',
    bestFor: 'Motivation, fitness',
    keywords: ['energetic', 'bright', 'enthusiastic', 'upbeat'],
  },
  verse: {
    personality: 'Natural, conversational, relatable',
    bestFor: 'Weather, casual chat',
    keywords: ['natural', 'conversational', 'casual', 'weather'],
  },
};

/**
 * Get voice for an agent
 * Priority: 1. Agent's voice property, 2. Default mapping, 3. 'alloy'
 * @param {string} agentId - Agent ID
 * @param {Object} agent - Optional agent object with voice property
 * @returns {string} Voice name
 */
function getAgentVoice(agentId, agent = null) {
  // Check if agent has voice property defined
  if (agent?.voice && VOICE_DESCRIPTIONS[agent.voice]) {
    return agent.voice;
  }

  // Try to get agent from registry to check its voice property
  try {
    const { getAgent } = require('../../packages/agents/agent-registry');
    const registryAgent = getAgent(agentId);
    if (registryAgent?.voice && VOICE_DESCRIPTIONS[registryAgent.voice]) {
      return registryAgent.voice;
    }
  } catch (_e) {
    // Registry not available, use defaults
  }

  // Fall back to default mapping or alloy
  return DEFAULT_AGENT_VOICES[agentId] || 'alloy';
}

/**
 * Find best voice for a description/keywords
 * @param {string} query - Description or keywords to match
 * @returns {{ voice: string, score: number, description: Object }[]} Ranked matches
 */
function searchVoices(query) {
  const queryLower = query.toLowerCase();
  const results = [];

  for (const [voice, desc] of Object.entries(VOICE_DESCRIPTIONS)) {
    let score = 0;

    // Check personality match
    if (desc.personality.toLowerCase().includes(queryLower)) score += 3;

    // Check bestFor match
    if (desc.bestFor.toLowerCase().includes(queryLower)) score += 2;

    // Check keywords match
    for (const keyword of desc.keywords) {
      if (keyword.includes(queryLower) || queryLower.includes(keyword)) {
        score += 1;
      }
    }

    if (score > 0) {
      results.push({ voice, score, description: desc });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ==================== VOICE SYSTEM CONFIGURATION ====================
// All configurable timeouts and settings in one place
const VOICE_CONFIG = {
  // LLM Bidding
  bidTimeoutMs: 6000,
  bidCircuitThreshold: 15,
  bidCircuitResetMs: 15000,

  // Auction timing
  auctionDefaultWindowMs: 8000,
  auctionMinWindowMs: 5000,
  auctionMaxWindowMs: 12000,
  instantWinThreshold: 0.85,

  // TTS Cooldown (prevents echo/feedback)
  ttsCooldownMs: 4000,

  // Speech detection
  silenceAfterSpeechMs: 5000,
  noSpeechTimeoutMs: 60000,

  // Deduplication
  dedupWindowMs: 2000,
  functionCallDedupMs: 5000,
};

module.exports = {
  DEFAULT_AGENT_VOICES,
  VOICE_DESCRIPTIONS,
  VOICE_CONFIG,
  getAgentVoice,
  searchVoices,
};
