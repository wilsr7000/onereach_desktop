/**
 * Intent Classifier
 * 
 * Uses OpenAI GPT-4o-mini for fast, accurate intent classification.
 * Replaces brittle regex matching with natural language understanding.
 */

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Available agents and their capabilities
const AGENT_DEFINITIONS = {
  'time-agent': {
    description: 'Answers time and date questions',
    examples: ['what time is it', 'what day is today', 'what is the date', 'current time', 'what month is it']
  },
  'weather-agent': {
    description: 'Provides weather information for locations',
    examples: ['weather in Denver', 'is it raining', 'temperature outside', 'forecast for tomorrow', 'will it snow']
  },
  'media-agent': {
    description: 'Controls music playback - play, pause, skip, volume',
    examples: ['play music', 'pause', 'stop', 'next song', 'volume up', 'play jazz', 'skip this track']
  },
  'help-agent': {
    description: 'Explains what the assistant can do',
    examples: ['what can you do', 'help', 'list commands', 'capabilities', 'how do I use this']
  },
  'smalltalk-agent': {
    description: 'Handles greetings, goodbyes, thanks, and casual conversation',
    examples: ['hi', 'hello', 'hey', 'goodbye', 'bye', 'thanks', 'thank you', 'how are you', 'good morning']
  }
};

// System commands handled by router (not agents)
const SYSTEM_COMMANDS = {
  'cancel': ['cancel', 'stop', 'nevermind', 'forget it', 'abort'],
  'repeat': ['repeat', 'say that again', 'what did you say', 'pardon'],
  'undo': ['undo', 'undo that', 'take that back', 'revert']
};

/**
 * Classify user intent using OpenAI
 * @param {string} transcript - User's spoken text
 * @returns {Promise<{agentId: string|null, intent: string, confidence: number, entities: object}>}
 */
async function classifyIntent(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return { agentId: null, intent: 'unclear', confidence: 0, entities: {} };
  }

  const text = transcript.trim().toLowerCase();
  
  // Quick check for system commands (still use simple matching for these)
  for (const [command, patterns] of Object.entries(SYSTEM_COMMANDS)) {
    if (patterns.some(p => text === p || text.startsWith(p + ' '))) {
      return { agentId: null, intent: command, confidence: 1.0, entities: {}, isSystemCommand: true };
    }
  }

  try {
    const result = await ai.chat({
      profile: 'fast',
      system: buildSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: transcript
        }
      ],
      temperature: 0,
      maxTokens: 150,
      jsonMode: true,
      feature: 'intent-classifier'
    });
    
    const parsed = typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
    
    return {
      agentId: parsed.agent_id || null,
      intent: parsed.intent || 'unknown',
      confidence: parsed.confidence || 0,
      entities: parsed.entities || {}
    };

  } catch (error) {
    log.error('agent', 'Error', { error: error.message });
    return { agentId: null, intent: 'error', confidence: 0, entities: {}, error: error.message };
  }
}

/**
 * Build system prompt for classification
 */
function buildSystemPrompt() {
  const agentList = Object.entries(AGENT_DEFINITIONS)
    .map(([id, def]) => `- ${id}: ${def.description}\n  Examples: ${def.examples.join(', ')}`)
    .join('\n');

  return `You are an intent classifier for a voice assistant. Classify the user's request and determine which agent should handle it.

Available agents:
${agentList}

Respond with JSON only:
{
  "agent_id": "agent-id or null if no match",
  "intent": "brief description of what user wants",
  "confidence": 0.0-1.0,
  "entities": {"location": "...", "query": "...", etc}
}

Rules:
- If the request clearly matches an agent, set confidence >= 0.8
- If uncertain, set confidence 0.5-0.7
- If no agent can handle it, set agent_id to null and confidence < 0.5
- Extract relevant entities (locations, song names, etc)
- Be concise in intent description`;
}


/**
 * Get agent by ID
 */
function getAgentDefinition(agentId) {
  return AGENT_DEFINITIONS[agentId] || null;
}

module.exports = {
  classifyIntent,
  getAgentDefinition,
  AGENT_DEFINITIONS,
  SYSTEM_COMMANDS
};
