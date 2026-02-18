/**
 * AI Agent Generator (v2 - First-Class Agents)
 *
 * Generates fully-featured voice agent configurations from natural language
 * descriptions. Output includes voice personality, memory config, bidding
 * guidance, acknowledgments, and daily briefing config -- matching what
 * built-in agents have.
 *
 * Uses the centralized AI service (ai.chat) instead of Claude Code CLI.
 */

const ai = require('./ai-service');
const { _matchTemplate, buildAgentPrompt, getTemplates, getTemplate, UI_PROMPT_SUFFIX } = require('./agent-templates');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Available voices with their personalities (from voice-coordinator.js)
const VOICE_MAP = {
  alloy: 'Neutral, balanced, versatile -- general purpose',
  ash: 'Warm, friendly, personable -- music, entertainment, social',
  ballad: 'Expressive, storytelling, dramatic -- creative, narrative',
  coral: 'Clear, professional, articulate -- business, scheduling',
  echo: 'Deep, authoritative, knowledgeable -- search, education',
  sage: 'Calm, wise, measured -- time, precision, spelling',
  shimmer: 'Energetic, bright, enthusiastic -- motivation, fitness',
  verse: 'Natural, conversational, relatable -- weather, casual chat',
};

// Typical execution times by type
const EXEC_TIME_BY_TYPE = {
  llm: 3000,
  shell: 5000,
  applescript: 5000,
  nodejs: 5000,
  workflow: 10000,
  browser: 15000,
  system: 5000,
};

/**
 * Generate an agent configuration from a natural language description.
 * Produces a v2 schema config with voice, memory, acks, briefing, and
 * structured bidding guidance in the prompt.
 *
 * @param {string} description - User's description of what the agent should do
 * @param {Object} options - Generation options
 * @param {string} options.templateId - Specific template to use (optional)
 * @param {boolean} options.uiCapable - Whether agent can return UI specs
 * @returns {Promise<Object>} Agent configuration (v2 schema)
 */
async function generateAgentFromDescription(description, options = {}) {
  if (!description || typeof description !== 'string') {
    throw new Error('Description is required and must be a string');
  }

  const trimmedDescription = description.trim();
  if (trimmedDescription.length < 10) {
    throw new Error('Description must be at least 10 characters');
  }

  // Get template - either specified or auto-matched
  let template = null;
  if (options.templateId) {
    template = getTemplate(options.templateId);
  }

  const { template: matchedTemplate } = buildAgentPrompt(trimmedDescription, template);

  log.info('agent', 'Generating v2 agent config', {
    template: matchedTemplate.name,
    type: matchedTemplate.executionType,
  });

  const voiceList = Object.entries(VOICE_MAP)
    .map(([name, desc]) => `  "${name}": ${desc}`)
    .join('\n');

  const generationPrompt = `You are an expert voice-agent architect. Generate a COMPLETE agent configuration for:

"${trimmedDescription}"

Agent type: ${matchedTemplate.name} (executionType: "${matchedTemplate.executionType}")

Template guidance:
${matchedTemplate.systemPromptTemplate}

Return a JSON object with ALL of these fields:

{
  "name": "Short Name (2-4 words, no emojis)",
  "keywords": ["keyword1", "keyword2", ...],  // 5-10 trigger words/phrases (lowercase)
  "categories": ["cat1", "cat2"],  // 2-4 category tags (lowercase)
  "executionType": "${matchedTemplate.executionType}",
  "prompt": "A detailed system prompt. MUST include two sections at the end:\\n\\nHIGH CONFIDENCE (0.85+) for:\\n- list what this agent should handle\\n\\nLOW CONFIDENCE (0.00) -- do NOT bid on:\\n- list what other agents should handle",
  "voice": "one-of: alloy|ash|ballad|coral|echo|sage|shimmer|verse",
  "acks": ["Working on it.", "Let me check."],  // 2-3 short acknowledgment phrases
  "memory": { "enabled": true/false, "sections": ["Learned Preferences"] },
  "briefing": { "enabled": true/false, "priority": 5, "section": "Section Name", "prompt": "What to include in the daily brief" },
  "multiTurn": true/false
}

Available voices:
${voiceList}

Rules:
- "voice": Pick the voice whose personality best matches this agent's role.
- "acks": Short phrases the orb speaks WHILE the agent is working (1-3 seconds max).
- "memory.enabled": true if the agent benefits from remembering user preferences.
- "briefing.enabled": true ONLY if the agent provides daily-relevant information (weather, tasks, schedule -- NOT for action agents like shell/applescript).
- "multiTurn": true if the agent sometimes needs to ask clarifying questions.
- The "prompt" MUST end with HIGH CONFIDENCE / LOW CONFIDENCE bidding guidance (this is critical for the routing system).

Return ONLY valid JSON. No markdown fences, no explanation.`;

  try {
    const result = await ai.chat({
      profile: 'standard',
      system:
        'You are an expert agent configuration generator. You return only valid JSON, never markdown or explanations.',
      messages: [{ role: 'user', content: generationPrompt }],
      maxTokens: 2048,
      temperature: 0.5,
      jsonMode: true,
      feature: 'agent-generator',
    });

    const response = (result.content || '').trim();

    // Parse JSON (strip fences if model slipped them in)
    let config;
    try {
      let jsonStr = response;
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```\n?$/g, '');
      }
      config = JSON.parse(jsonStr);
    } catch (_parseError) {
      log.error('agent', 'Failed to parse agent config response', { response });
      throw new Error('Failed to parse agent configuration from AI response');
    }

    // ── Validate required fields ─────────────────────────────────────
    if (!config.name || typeof config.name !== 'string') {
      throw new Error('Generated config missing valid name');
    }
    if (!config.keywords || !Array.isArray(config.keywords) || config.keywords.length === 0) {
      throw new Error('Generated config missing valid keywords');
    }
    if (!config.prompt || typeof config.prompt !== 'string') {
      throw new Error('Generated config missing valid prompt');
    }

    // ── Normalize & enrich ───────────────────────────────────────────
    const isUiCapable = options.uiCapable === true;
    let finalPrompt = config.prompt.trim();
    if (isUiCapable) finalPrompt += UI_PROMPT_SUFFIX;

    const voiceName = config.voice && VOICE_MAP[config.voice] ? config.voice : 'alloy';
    const execType = config.executionType || matchedTemplate.executionType;

    const normalizedConfig = {
      name: config.name.trim(),
      keywords: config.keywords.map((k) => String(k).toLowerCase().trim()).filter((k) => k.length > 0),
      prompt: finalPrompt,
      categories: Array.isArray(config.categories)
        ? config.categories.map((c) => String(c).toLowerCase().trim())
        : [matchedTemplate.id],
      executionType: execType,
      capabilities: Array.isArray(config.capabilities) ? config.capabilities : matchedTemplate.capabilities,
      templateId: matchedTemplate.id,
      uiCapable: isUiCapable,

      // ── v2 first-class fields ──────────────────────────────────────
      voice: voiceName,
      acks:
        Array.isArray(config.acks) && config.acks.length > 0
          ? config.acks.slice(0, 3)
          : ['Working on it.', 'One moment.'],
      estimatedExecutionMs: EXEC_TIME_BY_TYPE[execType] || 5000,
      dataSources: Array.isArray(config.dataSources) ? config.dataSources : [],
      memory: {
        enabled: config.memory?.enabled === true,
        sections:
          Array.isArray(config.memory?.sections) && config.memory.sections.length > 0
            ? config.memory.sections
            : ['Learned Preferences'],
      },
      briefing: {
        enabled: config.briefing?.enabled === true,
        priority: typeof config.briefing?.priority === 'number' ? config.briefing.priority : 5,
        section: config.briefing?.section || config.name?.trim() || '',
        prompt: config.briefing?.prompt || '',
      },
      multiTurn: config.multiTurn === true,
      settings: {
        confidenceThreshold: 0.7,
        maxConcurrent: 5,
      },
    };

    log.info('agent', 'Generated v2 agent config', {
      name: normalizedConfig.name,
      type: normalizedConfig.executionType,
      voice: normalizedConfig.voice,
      memory: normalizedConfig.memory.enabled,
      briefing: normalizedConfig.briefing.enabled,
    });
    return normalizedConfig;
  } catch (error) {
    log.error('agent', 'Error generating agent', { error: error.message });
    throw error;
  }
}

/**
 * Get available agent templates
 * @returns {Object[]} Array of templates
 */
function getAgentTemplates() {
  return getTemplates();
}

/**
 * Get available voices with descriptions
 * @returns {Object} Map of voice name to description
 */
function getAvailableVoices() {
  return { ...VOICE_MAP };
}

/**
 * Validate an agent configuration (v2 schema)
 * @param {Object} config - Agent configuration to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAgentConfig(config) {
  const errors = [];

  if (!config.name || typeof config.name !== 'string' || config.name.trim().length === 0) {
    errors.push('Agent name is required');
  }

  if (!config.keywords || !Array.isArray(config.keywords) || config.keywords.length === 0) {
    errors.push('At least one keyword is required');
  }

  if (!config.prompt || typeof config.prompt !== 'string' || config.prompt.trim().length < 20) {
    errors.push('Agent prompt must be at least 20 characters');
  }

  // v2 validations
  if (config.voice && !VOICE_MAP[config.voice]) {
    errors.push(`Unknown voice "${config.voice}". Valid: ${Object.keys(VOICE_MAP).join(', ')}`);
  }

  if (config.briefing?.enabled && !config.briefing?.section) {
    errors.push('Briefing section name is required when briefing is enabled');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  generateAgentFromDescription,
  validateAgentConfig,
  getAgentTemplates,
  getAvailableVoices,
  VOICE_MAP,
};
