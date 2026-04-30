/**
 * Voice Resolver (Phase 2 / personalityCapChew)
 *
 * Centralizes the "what voice should this agent speak with" decision.
 * Two modes, selected by the personalityCapChew flag:
 *
 *   flag OFF (default): multi-voice cast. Each agent keeps its own
 *                        voice so handoffs feel like a team of
 *                        specialists. This is the existing behavior.
 *
 *   flag ON:             single voice -- Cap Chew. Every agent speaks
 *                        with the same voice so the user hears one
 *                        assistant. Agent identity remains visual/UI.
 *
 * The Cap Chew voice is configurable:
 *   1. CAP_CHEW_VOICE env var   (tests + developer overrides)
 *   2. settingsManager.get('capChewVoice')   (running app)
 *   3. DEFAULT_CAP_CHEW_VOICE   ('coral' -- clear, professional)
 *
 * This module is pure + dependency-free at import time. It looks up
 * the registry lazily only when no explicit agent is passed, matching
 * the original getAgentVoice() behavior.
 */

'use strict';

// OpenAI Realtime voices (alloy, ash, ballad, coral, echo, sage, shimmer, verse).
// See packages/agents/VOICE-GUIDE.md for descriptions.
const VALID_VOICES = Object.freeze(
  new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'])
);

// Default voice for the unified Cap Chew persona. 'coral' = clear,
// professional, articulate -- safe across business, scheduling,
// informational, and conversational contexts.
const DEFAULT_CAP_CHEW_VOICE = 'coral';

// Default voice when no agent-specific voice is declared and no
// personality mode is active.
const DEFAULT_FALLBACK_VOICE = 'alloy';

/**
 * Resolve the Cap Chew voice from env > settings > default.
 * Returns DEFAULT_CAP_CHEW_VOICE if overrides specify an invalid voice.
 * @returns {string}
 */
function getCapChewVoice() {
  const envValue = process.env.CAP_CHEW_VOICE;
  if (envValue && VALID_VOICES.has(envValue)) return envValue;

  try {
    if (global.settingsManager && typeof global.settingsManager.get === 'function') {
      const settingsValue = global.settingsManager.get('capChewVoice');
      if (settingsValue && VALID_VOICES.has(settingsValue)) return settingsValue;
    }
  } catch (_err) {
    // settingsManager may throw during early boot; fall through
  }

  return DEFAULT_CAP_CHEW_VOICE;
}

/**
 * Resolve which voice an agent should speak with.
 *
 * The app ships single Cap Chew voice for every agent, so this
 * always returns the Cap Chew voice (env / settings / default).
 * The agent.voice / defaultAgentVoices / fallbackVoice arguments are
 * preserved as a safety net if the Cap Chew resolver ever fails
 * (returns an invalid voice), but the primary source is always
 * 'cap-chew'.
 *
 * @param {object} [input]
 * @param {string} [input.agentId]
 * @param {object} [input.agent]             - agent record (fallback)
 * @param {Object<string,string>} [input.defaultAgentVoices] - fallback map
 * @param {string} [input.fallbackVoice]     - final fallback
 *
 * @returns {{voice: string, source: string}} source is one of:
 *   'cap-chew' | 'agent-property' | 'default-map' | 'fallback'
 */
function resolveVoice(input = {}) {
  const {
    agentId,
    agent = null,
    defaultAgentVoices = null,
    fallbackVoice = DEFAULT_FALLBACK_VOICE,
  } = input;

  const capChew = getCapChewVoice();
  if (capChew && VALID_VOICES.has(capChew)) {
    return { voice: capChew, source: 'cap-chew' };
  }

  // Safety net: only reached if getCapChewVoice() returns something
  // unexpected. Keeps voice playback working even with a bad config.
  if (agent && typeof agent.voice === 'string' && VALID_VOICES.has(agent.voice)) {
    return { voice: agent.voice, source: 'agent-property' };
  }
  if (defaultAgentVoices && agentId && VALID_VOICES.has(defaultAgentVoices[agentId])) {
    return { voice: defaultAgentVoices[agentId], source: 'default-map' };
  }
  const fallback = VALID_VOICES.has(fallbackVoice) ? fallbackVoice : DEFAULT_FALLBACK_VOICE;
  return { voice: fallback, source: 'fallback' };
}

module.exports = {
  DEFAULT_CAP_CHEW_VOICE,
  DEFAULT_FALLBACK_VOICE,
  VALID_VOICES,
  getCapChewVoice,
  resolveVoice,
};
