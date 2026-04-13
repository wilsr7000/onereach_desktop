/**
 * Opportunity Evaluator
 *
 * Classifies agent interactions into typed improvement opportunities.
 * Uses ai-service (profile: fast) for semantic evaluation -- never regex.
 *
 * Returns actionable improvement tickets with type, priority, and reasoning.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _ai = null;
function _getAI() {
  if (!_ai) _ai = require('../ai-service');
  return _ai;
}

const VALID_IMPROVEMENT_TYPES = ['prompt', 'ui', 'routing', 'reliability', 'memory', 'multi-turn'];

/**
 * Evaluate an agent's recent interactions and produce improvement tickets.
 *
 * @param {object} agent - Agent definition from store
 * @param {object} windowData - From InteractionCollector.getWindow()
 * @returns {{ improvements: Array, overallHealthScore: number, shouldCreateNewAgent: boolean }}
 */
async function evaluateAgent(agent, windowData) {
  const ai = _getAI();

  const { interactions, failureRate, rephraseRate, uiSpecRate, avgResponseTimeMs } = windowData;

  const recentSummary = interactions
    .slice(-10)
    .map((i) => {
      const status = i.success ? 'OK' : 'FAIL';
      const input = (i.userInput || '').slice(0, 80);
      const msg = (i.message || '').slice(0, 60);
      const err = i.error ? ` err=${i.error.slice(0, 60)}` : '';
      return `[${status}] "${input}" -> "${msg}"${err}`;
    })
    .join('\n');

  const hasUISpec = uiSpecRate > 0;
  const hasMemory = !!agent.memory?.enabled;
  const hasMultiTurn = !!agent.multiTurn;

  try {
    const result = await ai.json(
      `Given these recent interactions for agent "${agent.name}":
${recentSummary}

Agent definition:
- Description: ${(agent.description || '').slice(0, 200)}
- Categories: ${JSON.stringify(agent.categories || [])}
- Has rich UI output: ${hasUISpec}
- Has memory: ${hasMemory}
- Has multi-turn: ${hasMultiTurn}

Current stats: ${Math.round(failureRate * 100)}% failure rate, ${Math.round(rephraseRate * 100)}% rephrase rate, ${Math.round(uiSpecRate * 100)}% with rich UI, avg ${avgResponseTimeMs}ms response time

Evaluate what improvements would have the most impact. Return JSON:
{
  "improvements": [
    {
      "type": "prompt" | "ui" | "routing" | "reliability" | "memory" | "multi-turn",
      "priority": 1-10,
      "reasoning": "why this would help",
      "specificIssue": "what exactly is wrong",
      "exampleInteraction": "the interaction that shows the problem"
    }
  ],
  "overallHealthScore": 0-100,
  "shouldCreateNewAgent": false,
  "newAgentReasoning": null
}`,
      {
        profile: 'fast',
        feature: 'agent-learning-eval',
        maxTokens: 600,
        temperature: 0.3,
      }
    );

    const improvements = (result.improvements || [])
      .filter((imp) => VALID_IMPROVEMENT_TYPES.includes(imp.type))
      .map((imp) => ({
        type: imp.type,
        priority: Math.max(1, Math.min(10, imp.priority || 5)),
        reasoning: imp.reasoning || '',
        specificIssue: imp.specificIssue || '',
        exampleInteraction: imp.exampleInteraction || '',
      }))
      .sort((a, b) => b.priority - a.priority);

    return {
      improvements,
      overallHealthScore: Math.max(0, Math.min(100, result.overallHealthScore || 50)),
      shouldCreateNewAgent: !!result.shouldCreateNewAgent,
      newAgentReasoning: result.newAgentReasoning || null,
    };
  } catch (err) {
    log.warn('agent-learning', 'Evaluation failed', {
      agentId: agent.id,
      error: err.message,
    });
    return {
      improvements: [],
      overallHealthScore: 50,
      shouldCreateNewAgent: false,
      newAgentReasoning: null,
    };
  }
}

/** Override ai-service for testing */
function _setTestDeps(deps) {
  if (deps.ai) _ai = deps.ai;
}

module.exports = { evaluateAgent, VALID_IMPROVEMENT_TYPES, _setTestDeps };
