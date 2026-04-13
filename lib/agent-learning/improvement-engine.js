/**
 * Improvement Engine
 *
 * Generates specific, targeted agent improvements based on typed tickets
 * from the opportunity evaluator. Each improvement type has its own
 * generation strategy.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _ai = null;
function _getAI() {
  if (!_ai) _ai = require('../ai-service');
  return _ai;
}

/**
 * Generate an improvement patch for the given agent and issue.
 *
 * @param {object} agent - Agent definition from store
 * @param {object} issue - Typed ticket from evaluator { type, priority, reasoning, specificIssue }
 * @param {object} windowData - Recent interactions from collector
 * @returns {object|null} Patch object to apply, or null if generation failed
 */
async function generateImprovement(agent, issue, windowData) {
  switch (issue.type) {
    case 'prompt':
      return improvePrompt(agent, issue, windowData.interactions);
    case 'routing':
      return improveRouting(agent, issue, windowData.interactions);
    case 'reliability':
      return improveReliability(agent, issue, windowData.interactions);
    case 'memory':
      return improveMemory(agent, issue);
    case 'multi-turn':
      return enableMultiTurn(agent, issue);
    case 'ui':
      return null; // delegated to ui-improver.js
    default:
      log.warn('agent-learning', `Unknown improvement type: ${issue.type}`);
      return null;
  }
}

async function improvePrompt(agent, issue, interactions) {
  const ai = _getAI();
  const currentPrompt = agent.prompt || '';

  const failingExamples = interactions
    .filter((i) => !i.success)
    .slice(-5)
    .map((i) => `User: "${(i.userInput || '').slice(0, 100)}" -> Error: "${(i.error || i.message || '').slice(0, 100)}"`)
    .join('\n');

  const successExamples = interactions
    .filter((i) => i.success)
    .slice(-3)
    .map((i) => `User: "${(i.userInput || '').slice(0, 100)}" -> OK: "${(i.message || '').slice(0, 80)}"`)
    .join('\n');

  try {
    const improved = await ai.complete(
      `You are improving a voice agent's system prompt. The agent has been failing at some tasks.

CURRENT PROMPT:
${currentPrompt}

FAILING INTERACTIONS:
${failingExamples || '(none recorded)'}

SUCCESSFUL INTERACTIONS (keep these working):
${successExamples || '(none recorded)'}

ISSUE: ${issue.specificIssue}

Write an improved prompt that:
1. Addresses the specific failures shown above
2. Keeps everything that already works
3. Adds explicit handling for the edge cases that caused failures
4. Is concise -- no longer than needed

Return ONLY the new prompt text, nothing else.`,
      { profile: 'standard', feature: 'agent-learning-prompt', maxTokens: 1000, temperature: 0.4 }
    );

    const newPrompt = (typeof improved === 'string' ? improved : improved?.content || '').trim();
    if (!newPrompt || newPrompt.length < 10) return null;

    return {
      type: 'prompt',
      patch: { prompt: newPrompt },
      description: `Refined prompt to address: ${issue.specificIssue.slice(0, 100)}`,
    };
  } catch (err) {
    log.warn('agent-learning', 'Prompt improvement failed', { error: err.message });
    return null;
  }
}

async function improveRouting(agent, issue, interactions) {
  const ai = _getAI();

  const interactionSummary = interactions
    .slice(-10)
    .map((i) => `[${i.success ? 'OK' : 'FAIL'}] "${(i.userInput || '').slice(0, 80)}"`)
    .join('\n');

  try {
    const result = await ai.json(
      `Agent "${agent.name}" has routing problems -- it gets matched to wrong tasks or misses tasks it should handle.

Current keywords: ${JSON.stringify(agent.keywords || [])}
Current categories: ${JSON.stringify(agent.categories || [])}
Current description: ${(agent.description || '').slice(0, 200)}

Recent interactions (some may be misrouted):
${interactionSummary}

ISSUE: ${issue.specificIssue}

Return JSON with improved values that make the agent's scope clearer:
{
  "keywords": ["improved", "keyword", "list"],
  "categories": ["improved", "categories"],
  "description": "improved description that clearly distinguishes this agent"
}`,
      { profile: 'standard', feature: 'agent-learning-routing', maxTokens: 400, temperature: 0.3 }
    );

    if (!result || !result.description) return null;

    return {
      type: 'routing',
      patch: {
        keywords: Array.isArray(result.keywords) ? result.keywords : agent.keywords,
        categories: Array.isArray(result.categories) ? result.categories : agent.categories,
        description: result.description,
      },
      description: `Tuned routing: ${issue.specificIssue.slice(0, 100)}`,
    };
  } catch (err) {
    log.warn('agent-learning', 'Routing improvement failed', { error: err.message });
    return null;
  }
}

async function improveReliability(agent, issue, interactions) {
  const ai = _getAI();
  const currentPrompt = agent.prompt || '';

  const errorExamples = interactions
    .filter((i) => !i.success && i.error)
    .slice(-5)
    .map((i) => `"${(i.error || '').slice(0, 120)}"`)
    .join('\n');

  try {
    const improved = await ai.complete(
      `You are making a voice agent more reliable. It has been crashing or returning errors.

CURRENT PROMPT:
${currentPrompt}

ERROR PATTERNS:
${errorExamples || '(no specific errors)'}

ISSUE: ${issue.specificIssue}

Write an improved prompt that adds:
1. Explicit error handling instructions
2. Fallback behavior when data is missing
3. Graceful degradation when external services fail
4. Keep the existing functionality intact

Return ONLY the new prompt text, nothing else.`,
      { profile: 'standard', feature: 'agent-learning-prompt', maxTokens: 1000, temperature: 0.3 }
    );

    const newPrompt = (typeof improved === 'string' ? improved : improved?.content || '').trim();
    if (!newPrompt || newPrompt.length < 10) return null;

    return {
      type: 'reliability',
      patch: { prompt: newPrompt },
      description: `Improved reliability: ${issue.specificIssue.slice(0, 100)}`,
    };
  } catch (err) {
    log.warn('agent-learning', 'Reliability improvement failed', { error: err.message });
    return null;
  }
}

async function improveMemory(_agent, _issue) {
  return {
    type: 'memory',
    patch: {
      memory: { enabled: true, sections: ['Learned Preferences', 'User Context'] },
    },
    description: 'Enabled memory with Learned Preferences and User Context sections',
  };
}

async function enableMultiTurn(_agent, _issue) {
  return {
    type: 'multi-turn',
    patch: { multiTurn: true },
    description: 'Enabled multi-turn clarification',
  };
}

/** Override ai-service for testing */
function _setTestDeps(deps) {
  if (deps.ai) _ai = deps.ai;
}

module.exports = { generateImprovement, _setTestDeps };
