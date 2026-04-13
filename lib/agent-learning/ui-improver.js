/**
 * UI Improver
 *
 * Analyzes agent output patterns and upgrades agents to return
 * declarative UI specs for richer Command HUD display.
 *
 * Leverages the existing uiCapable path in exchange-bridge.js which
 * parses JSON blocks from agent responses and passes them through
 * renderAgentUI().
 *
 * Supported UI types (from lib/agent-ui-renderer.js):
 *   confirm, select, info, eventList, dayView, actionLog, screenshot, panel
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _ai = null;
function _getAI() {
  if (!_ai) _ai = require('../ai-service');
  return _ai;
}

const UI_PROMPT_SUFFIX = `

When your response contains a list, choices, or structured data, include a JSON block
in your response with a declarative UI spec. Wrap it in triple backticks:

\`\`\`json
{"type": "select", "message": "Title", "options": [{"label": "Option 1", "value": "follow-up text"}]}
\`\`\`

Available types:
- "select": numbered choices (options: [{label, value}])
- "info": read-only card (message: string)
- "confirm": action buttons (message, options: [{label, value, style?}])
- "eventList": calendar-style list (title, events: [{time, title, recurring?, importance?}])
- "actionLog": step-by-step results (message, actions: [{action, success}])
- "panel": compound card (message, actions?, screenshot?)

The spoken response should be the natural-language summary. The JSON block provides the visual card.`;

/**
 * Analyze an agent's recent outputs and generate a UI improvement.
 *
 * @param {object} agent - Agent definition from store
 * @param {object} windowData - From InteractionCollector.getWindow()
 * @returns {object|null} Improvement patch or null
 */
async function generateUIImprovement(agent, windowData) {
  const ai = _getAI();
  const { interactions } = windowData;

  const successfulResponses = interactions
    .filter((i) => i.success && i.message && i.message.length > 50)
    .slice(-5)
    .map((i) => `"${i.message.slice(0, 200)}"`)
    .join('\n\n');

  if (!successfulResponses) return null;

  try {
    const analysis = await ai.json(
      `Analyze these agent responses and determine which UI type would make them more useful as visual cards in a voice assistant HUD.

Agent: "${agent.name}" -- ${(agent.description || '').slice(0, 150)}

Recent successful responses:
${successfulResponses}

Available UI types:
- "select": for lists of options the user can pick from
- "info": for read-only informational messages
- "confirm": for yes/no or action confirmations
- "eventList": for time-based lists (schedules, events)
- "actionLog": for step-by-step progress/results
- "panel": for compound displays with actions

Return JSON:
{
  "shouldAddUI": true/false,
  "recommendedType": "select" | "info" | "confirm" | "eventList" | "actionLog" | "panel",
  "reasoning": "why this UI type fits the agent's output pattern",
  "exampleSpec": { "type": "...", ... }
}`,
      { profile: 'fast', feature: 'agent-learning-ui', maxTokens: 400, temperature: 0.3 }
    );

    if (!analysis || !analysis.shouldAddUI) return null;

    const currentPrompt = agent.prompt || '';
    const alreadyHasUIInstructions = /json.*block|ui.*spec|renderAgentUI/i.test(currentPrompt);

    if (alreadyHasUIInstructions) {
      log.info('agent-learning', 'Agent already has UI instructions, skipping', {
        agentId: agent.id,
      });
      return null;
    }

    return {
      type: 'ui',
      patch: {
        prompt: currentPrompt + UI_PROMPT_SUFFIX,
        uiCapable: true,
      },
      description: `Added ${analysis.recommendedType} UI spec capability: ${analysis.reasoning.slice(0, 100)}`,
      uiType: analysis.recommendedType,
    };
  } catch (err) {
    log.warn('agent-learning', 'UI improvement failed', { error: err.message });
    return null;
  }
}

/** Override ai-service for testing */
function _setTestDeps(deps) {
  if (deps.ai) _ai = deps.ai;
}

module.exports = { generateUIImprovement, UI_PROMPT_SUFFIX, _setTestDeps };
