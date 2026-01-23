/**
 * AI Agent Generator
 * 
 * Generates voice agent configurations from natural language descriptions
 * using the Claude API. Supports different agent templates for various
 * execution types (terminal, AppleScript, Node.js, etc.)
 */

const claudeCode = require('./claude-code-runner');
const { matchTemplate, buildAgentPrompt, getTemplates, getTemplate } = require('./agent-templates');

/**
 * Default prompt for conversational agents (fallback)
 */
const DEFAULT_AGENT_PROMPT = `Generate a voice agent configuration based on this description.

User's description: "{{description}}"

Create a complete agent configuration with:
1. name: A short, descriptive agent name (2-4 words, no emojis)
2. keywords: An array of 5-10 trigger words/phrases that would invoke this agent (lowercase)
3. prompt: A detailed system prompt for the agent explaining its role, capabilities, and how to respond
4. categories: An array of 2-4 category tags (e.g., "productivity", "writing", "research")
5. executionType: "llm" for conversational, "shell" for terminal, "applescript" for macOS automation, "nodejs" for scripts

Return ONLY valid JSON with no markdown formatting, no code blocks, no explanation.`;

/**
 * Generate an agent configuration from a natural language description
 * @param {string} description - User's description of what the agent should do
 * @param {Object} options - Generation options
 * @param {string} options.templateId - Specific template to use (optional)
 * @returns {Promise<Object>} Agent configuration object
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
  
  // Build the prompt using the template system
  const { template: matchedTemplate, systemPrompt } = buildAgentPrompt(trimmedDescription, template);
  
  console.log('[AgentGenerator] Using template:', matchedTemplate.name, '(' + matchedTemplate.executionType + ')');

  try {
    const fullPrompt = `You are an expert at creating voice agent configurations. You specialize in ${matchedTemplate.name} agents. You return only valid JSON, never markdown or explanations. Your agents are well-designed with clear prompts and relevant keywords.

${systemPrompt}`;

    const result = await claudeCode.complete(fullPrompt);

    if (!result.success) {
      throw new Error(result.error || 'No response from Claude Code');
    }
    
    const response = result.content;

    // Try to parse the response as JSON
    let config;
    try {
      // Remove any potential markdown code blocks
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```\n?$/g, '');
      }
      config = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('[AgentGenerator] Failed to parse response:', response);
      throw new Error('Failed to parse agent configuration from AI response');
    }

    // Validate required fields
    if (!config.name || typeof config.name !== 'string') {
      throw new Error('Generated config missing valid name');
    }
    if (!config.keywords || !Array.isArray(config.keywords) || config.keywords.length === 0) {
      throw new Error('Generated config missing valid keywords');
    }
    if (!config.prompt || typeof config.prompt !== 'string') {
      throw new Error('Generated config missing valid prompt');
    }

    // Normalize the config with template info
    const normalizedConfig = {
      name: config.name.trim(),
      keywords: config.keywords
        .map(k => String(k).toLowerCase().trim())
        .filter(k => k.length > 0),
      prompt: config.prompt.trim(),
      categories: Array.isArray(config.categories) 
        ? config.categories.map(c => String(c).toLowerCase().trim())
        : [matchedTemplate.id],
      executionType: config.executionType || matchedTemplate.executionType,
      capabilities: Array.isArray(config.capabilities) 
        ? config.capabilities 
        : matchedTemplate.capabilities,
      templateId: matchedTemplate.id,
      settings: {
        confidenceThreshold: 0.7,
        maxConcurrent: 5,
      },
    };

    console.log('[AgentGenerator] Generated agent config:', normalizedConfig.name, 
                '(type:', normalizedConfig.executionType + ')');
    return normalizedConfig;

  } catch (error) {
    console.error('[AgentGenerator] Error generating agent:', error);
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
 * Validate an agent configuration
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

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  generateAgentFromDescription,
  validateAgentConfig,
  getAgentTemplates,
  DEFAULT_AGENT_PROMPT,
};
