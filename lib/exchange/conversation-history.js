/**
 * Conversation History - Tracks conversation turns for agent context.
 *
 * Extracted from exchange-bridge.js. Manages conversation turns,
 * persistence across restarts, session summaries, and active learning.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

// Lazy imports (resolved at call time to avoid circular deps)
let _spacesAPI = null;
function getSpacesAPI() {
  if (!_spacesAPI) {
    const { getSpacesAPI: get } = require('../../spaces-api');
    _spacesAPI = get();
  }
  return _spacesAPI;
}

let _ai = null;
function getAI() {
  if (!_ai) {
    _ai = require('../ai-service');
  }
  return _ai;
}

let _getUserProfile = null;
function getUserProfile() {
  if (!_getUserProfile) {
    _getUserProfile = require('../user-profile-store').getUserProfile;
  }
  return _getUserProfile();
}

// ==================== CONVERSATION HISTORY ====================
let conversationHistory = [];
const CONVERSATION_CONFIG = {
  maxHistoryChars: 4000,
  maxTurns: 20,
  historyTimeoutMs: 5 * 60000,
  persistenceMaxAgeMs: 60 * 60000,
};
let historyTimeoutId = null;

// Injected callback: called when history timeout fires and there are no pending inputs.
// Set via setOnTimeoutClear() by exchange-bridge so clearing triggers summary + clear.
let _onTimeoutClear = null;

/**
 * Add a turn to conversation history
 */
function addToHistory(role, content, agentId = null) {
  if (!content || content.trim() === '') return;

  conversationHistory.push({
    role,
    content: content.trim(),
    timestamp: Date.now(),
    agentId,
  });

  while (conversationHistory.length > CONVERSATION_CONFIG.maxTurns) {
    conversationHistory.shift();
  }

  resetHistoryTimeout();
  writeHistoryToFile();

  log.info('voice', '[ConversationHistory] Added turn, total:', { v0: role, v1: conversationHistory.length });
}

/**
 * Get recent conversation history trimmed to max length
 */
function getRecentHistory() {
  let totalChars = 0;
  const recent = [];

  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const turn = conversationHistory[i];
    const turnLength = turn.content.length + 20;

    if (totalChars + turnLength > CONVERSATION_CONFIG.maxHistoryChars) {
      break;
    }

    recent.unshift(turn);
    totalChars += turnLength;
  }

  return recent;
}

/**
 * Format history for agent context
 */
function formatHistoryForAgent() {
  const recent = getRecentHistory();
  if (recent.length === 0) return '';

  return recent
    .map((turn) => {
      const prefix = turn.role === 'user' ? 'User' : 'Assistant';
      return `${prefix}: ${turn.content}`;
    })
    .join('\n');
}

/**
 * Write conversation history to file in GSX Agent space
 */
async function writeHistoryToFile() {
  try {
    const api = getSpacesAPI();
    const formattedHistory = formatHistoryForAgent();

    if (formattedHistory) {
      const content = `# Conversation History\n\n${formattedHistory}\n\n_Last updated: ${new Date().toISOString()}_`;
      await api.files.write('gsx-agent', 'conversation-history.md', content);
      log.info('voice', '[ConversationHistory] Written to gsx-agent/conversation-history.md');
    }
  } catch (err) {
    log.warn('voice', '[ConversationHistory] Failed to write history file', { data: err.message });
  }
}

async function clearHistoryFile() {
  try {
    const api = getSpacesAPI();
    await api.files.delete('gsx-agent', 'conversation-history.md');
    log.info('voice', '[ConversationHistory] Deleted conversation-history.md');
  } catch (_err) {
    log.info('voice', '[ConversationHistory] No history file to delete');
  }
}

function clearHistory() {
  conversationHistory = [];
  clearHistoryFile();
  log.info('voice', '[ConversationHistory] Cleared');
}

function resetHistoryTimeout(_pendingInputContexts) {
  if (historyTimeoutId) {
    clearTimeout(historyTimeoutId);
  }
  historyTimeoutId = setTimeout(async () => {
    // Check via callback if there are pending inputs
    if (_onTimeoutClear) {
      _onTimeoutClear();
    } else {
      await summarizeAndArchiveSession().catch((e) =>
        log.warn('voice', '[SessionSummary] Error during archive', { data: e.message })
      );
      clearHistory();
    }
  }, CONVERSATION_CONFIG.historyTimeoutMs);
}

// ==================== CONVERSATION STATE PERSISTENCE ====================

async function saveConversationState() {
  if (conversationHistory.length === 0) {
    log.info('voice', '[ConversationState] Nothing to save');
    return;
  }
  try {
    const api = getSpacesAPI();
    const state = {
      savedAt: Date.now(),
      history: conversationHistory,
    };
    await api.files.write('gsx-agent', 'conversation-state.json', JSON.stringify(state));
    log.info('voice', '[ConversationState] Saved turns', { v0: conversationHistory.length });
  } catch (err) {
    log.warn('voice', '[ConversationState] Failed to save', { data: err.message });
  }
}

async function restoreConversationState() {
  try {
    const api = getSpacesAPI();
    const raw = await api.files.read('gsx-agent', 'conversation-state.json');
    if (!raw) return;

    const state = JSON.parse(raw);
    if (Date.now() - state.savedAt > CONVERSATION_CONFIG.persistenceMaxAgeMs) {
      log.info('voice', '[ConversationState] Saved state too old, discarding');
      return;
    }

    conversationHistory = state.history || [];
    log.info('voice', '[ConversationState] Restored turns', { v0: conversationHistory.length });

    // Clean up
    await api.files
      .delete('gsx-agent', 'conversation-state.json')
      .catch((err) => console.warn('[conversation-history] delete old state:', err.message));
  } catch (err) {
    log.warn('voice', '[ConversationState] Failed to restore', { data: err.message });
  }
}

// ==================== SESSION SUMMARIES ====================

async function summarizeAndArchiveSession() {
  if (conversationHistory.length < 2) return;

  const formatted = formatHistoryForAgent();
  if (!formatted) return;

  try {
    const apiKey =
      global.settingsManager?.get('openaiApiKey') ||
      global.settingsManager?.get('llmApiKey') ||
      process.env.OPENAI_API_KEY;

    let summary = '';

    if (apiKey) {
      try {
        const ai = getAI();
        const result = await ai.chat({
          profile: 'fast',
          system:
            'Summarize this conversation in one short sentence (max 15 words). Focus on what the user asked about. No quotes.',
          messages: [{ role: 'user', content: formatted }],
          temperature: 0.3,
          maxTokens: 50,
          feature: 'exchange-bridge',
        });
        summary = result.content.trim();
      } catch (err) {
        log.warn('voice', '[SessionSummary] AI call failed', { data: err.message });
      }
    }

    if (!summary) {
      const firstUserTurn = conversationHistory.find((t) => t.role === 'user');
      summary = firstUserTurn ? `Asked: "${firstUserTurn.content.slice(0, 60)}"` : 'Brief conversation';
    }

    const api = getSpacesAPI();
    const timestamp =
      new Date().toISOString().split('T')[0] +
      ' ' +
      new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const entry = `- ${timestamp}: ${summary}`;

    let existing = '';
    try {
      existing = (await api.files.read('gsx-agent', 'session-summaries.md')) || '';
    } catch (err) {
      console.warn('[conversation-history] read session-summaries:', err.message);
    }

    const lines = existing.split('\n').filter((l) => l.startsWith('- '));
    lines.unshift(entry);
    const kept = lines.slice(0, 10);

    const content = `# Session Summaries\n\n${kept.join('\n')}\n\n_Auto-generated for multi-session continuity_\n`;
    await api.files.write('gsx-agent', 'session-summaries.md', content);
    log.info('voice', '[SessionSummary] Archived: ""', { v0: summary });
  } catch (err) {
    log.warn('voice', '[SessionSummary] Failed to summarize', { data: err.message });
  }
}

// ==================== ACTIVE LEARNING PIPELINE ====================

let _lastFactExtractionTime = 0;
const FACT_EXTRACTION_COOLDOWN_MS = 30000;

async function extractAndSaveUserFacts(task, result, agentId) {
  const now = Date.now();
  if (now - _lastFactExtractionTime < FACT_EXTRACTION_COOLDOWN_MS) return;

  const content = task?.content || '';
  if (content.length < 5 || !result?.success) return;

  const apiKey =
    global.settingsManager?.get('openaiApiKey') ||
    global.settingsManager?.get('llmApiKey') ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  _lastFactExtractionTime = now;

  try {
    const profile = getUserProfile();
    if (!profile.isLoaded()) await profile.load();
    const existingFacts = profile.getFacts();

    const existingFactsStr = Object.entries(existingFacts)
      .filter(([_, v]) => v && !v.includes('not yet learned') && !v.startsWith('*'))
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    const message = result.output || result.message || '';

    try {
      const ai = getAI();
      const aiResult = await ai.json(
        `Extract NEW user facts from this interaction. Only include facts clearly stated or strongly implied.
Already known facts: ${existingFactsStr || 'none'}
Do NOT repeat known facts. Return JSON object with key-value pairs, or {} if nothing new.
Keys should be descriptive: "Name", "Home", "Work", "Timezone", "Temperature Units", etc.

User said: "${content}"
Agent (${agentId}) responded: "${message.slice(0, 200)}"`,
        {
          profile: 'fast',
          system: 'You extract user facts from conversations. Return JSON only.',
          temperature: 0.1,
          maxTokens: 150,
          feature: 'exchange-bridge',
        }
      );

      const facts = aiResult || {};
      const newKeys = Object.keys(facts).filter((k) => facts[k] && facts[k].trim());

      if (newKeys.length > 0) {
        profile.updateFacts(facts);
        await profile.save();
        log.info('voice', '[LearningPipeline] Extracted facts:', { v0: newKeys.length, v1: newKeys.join(', ') });
      }
    } catch (_err) {
      // Silently fail - fact extraction is non-critical
    }
  } catch (err) {
    log.warn('voice', '[LearningPipeline] Fact extraction error', { data: err.message });
  }
}

/**
 * Set callback for when history timeout fires.
 * Exchange-bridge sets this to check pendingInputContexts before clearing.
 */
function setOnTimeoutClear(callback) {
  _onTimeoutClear = callback;
}

module.exports = {
  CONVERSATION_CONFIG,
  addToHistory,
  getRecentHistory,
  formatHistoryForAgent,
  clearHistory,
  saveConversationState,
  restoreConversationState,
  summarizeAndArchiveSession,
  extractAndSaveUserFacts,
  setOnTimeoutClear,
};
