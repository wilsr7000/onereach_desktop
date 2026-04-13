/**
 * Quality Verifier
 *
 * LLM-as-judge verification for agent improvements. All testing is
 * completely silent -- no TTS, no HUD, no sound, no visible side effects.
 *
 * Two strategies:
 *   A) Pure LLM simulation -- ai.complete() with agent prompt as system
 *   B) Sandboxed execution -- safeExecuteAgent with synthetic task
 *
 * Key invariant: never deploy if any test case degraded.
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
 * Pure LLM simulation -- calls ai.complete() with the agent's prompt
 * as the system message. Never touches exchange, HUD, or TTS.
 */
async function silentSimulate(agentPrompt, userInput) {
  const ai = _getAI();
  try {
    const result = await ai.complete(userInput, {
      system: agentPrompt,
      profile: 'fast',
      feature: 'agent-learning-verify',
      maxTokens: 500,
      temperature: 0.3,
    });
    return typeof result === 'string' ? result : (result?.content || '');
  } catch (err) {
    log.warn('agent-learning', 'silentSimulate failed', { error: err.message });
    return '';
  }
}

/**
 * Sandboxed execution -- calls agent.execute() directly via middleware.
 * Bypasses exchange, TTS, HUD, and sound cues entirely.
 */
async function silentExecute(agent, userInput) {
  try {
    const { safeExecuteAgent } = require('../../packages/agents/agent-middleware');
    const syntheticTask = {
      content: userInput,
      metadata: { _silent: true, _source: 'agent-learning' },
    };
    return await safeExecuteAgent(agent, syntheticTask, { timeoutMs: 15000 });
  } catch (err) {
    log.warn('agent-learning', 'silentExecute failed', { error: err.message });
    return { success: false, message: err.message };
  }
}

/**
 * Compare current vs improved agent on a set of test interactions.
 *
 * @param {object} agent - Current agent object
 * @param {object} improvedFields - Fields that changed (e.g. { prompt: 'new...' })
 * @param {Array} testInteractions - Array of { userInput, expectedBehavior? }
 * @returns {{ shouldDeploy, score, results }}
 */
async function verifyImprovement(agent, improvedFields, testInteractions) {
  const ai = _getAI();
  const results = [];

  const currentPrompt = agent.prompt || '';
  const improvedPrompt = improvedFields.prompt || currentPrompt;

  for (const interaction of testInteractions) {
    try {
      const currentResponse = await silentSimulate(currentPrompt, interaction.userInput);
      const improvedResponse = await silentSimulate(improvedPrompt, interaction.userInput);

      let judgment;
      try {
        judgment = await ai.json(
          `Compare these two agent responses to the user's request.

User request: "${interaction.userInput}"
Expected behavior: ${interaction.expectedBehavior || 'helpful, accurate response'}

Response A (current): "${currentResponse.slice(0, 400)}"
Response B (improved): "${improvedResponse.slice(0, 400)}"

Return JSON:
{
  "winner": "A" or "B" or "tie",
  "qualityA": 1-10,
  "qualityB": 1-10,
  "reasoning": "brief explanation"
}`,
          { profile: 'fast', feature: 'agent-learning-judge', maxTokens: 200, temperature: 0.2 }
        );
      } catch (_) {
        judgment = { winner: 'tie', qualityA: 5, qualityB: 5, reasoning: 'judge error' };
      }

      if (!judgment || !['A', 'B', 'tie'].includes(judgment.winner)) {
        judgment = { winner: 'tie', qualityA: 5, qualityB: 5, reasoning: 'invalid response' };
      }

      results.push({
        userInput: interaction.userInput,
        currentResponse: currentResponse.slice(0, 200),
        improvedResponse: improvedResponse.slice(0, 200),
        ...judgment,
      });
    } catch (err) {
      log.warn('agent-learning', 'Verification round failed', { error: err.message });
      results.push({
        userInput: interaction.userInput,
        winner: 'tie',
        qualityA: 5,
        qualityB: 5,
        reasoning: `error: ${err.message}`,
      });
    }
  }

  const improved = results.filter((r) => r.winner === 'B').length;
  const degraded = results.filter((r) => r.winner === 'A').length;

  const shouldDeploy = improved > degraded && degraded === 0;
  const score = results.length > 0 ? improved / results.length : 0;

  log.info('agent-learning', 'Verification complete', {
    agentId: agent.id,
    improved,
    degraded,
    tied: results.length - improved - degraded,
    shouldDeploy,
    score,
  });

  return { shouldDeploy, score, improved, degraded, results };
}

/** Override ai-service for testing */
function _setTestDeps(deps) {
  if (deps.ai) _ai = deps.ai;
}

module.exports = { silentSimulate, silentExecute, verifyImprovement, _setTestDeps };
