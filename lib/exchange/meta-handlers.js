/**
 * Meta-task handlers — the concrete meta-agents behind the meta-task kinds
 * (ADR-EX-007). Each is a factory that takes injected deps and returns the
 * handler `runMetaTask` direct-assigns to. Factoring them here (rather than
 * inline in exchange-bridge) makes them testable without the bridge: pass a fake
 * ai / builder / sanity-checker and assert the meta-agent's behaviour.
 *
 * The bodies reproduce the exact inline logic they replace, so wiring them in is
 * behaviour-preserving; the bridge keeps an inline fallback for the case where a
 * handler isn't registered or a call fails.
 */

'use strict';

/**
 * classify-intent (capability-gap variant): a halted request is either a
 * "rephrase" (ambiguous, rewording would match an agent) or a "capability_gap"
 * (no agent covers it). Mirrors the inline halt-handler classifier.
 *
 * @param {{ ai: { json: Function } }} deps
 */
function makeClassifyIntentHandler({ ai }) {
  return async function classifyIntent({ content, agentDescriptions = [], nearMisses = [] }) {
    const nearMissNote =
      nearMisses.length > 0
        ? `\nClosest bids (all below the confidence floor): ${nearMisses
            .map((b) => `${b.agentId} (${(b.confidence ?? 0).toFixed(2)})`)
            .join(', ')}`
        : '';
    const classResult = await ai.json(
      `The user said: "${content}"
No agent was confident enough to handle this. Available agents:
${agentDescriptions.map((a) => `- ${a.name}: ${a.description}`).join('\n')}
${nearMissNote}
Classify: "rephrase" (ambiguous, rephrasing would help) or "capability_gap" (no agent covers this).
Return JSON: { "classification": "rephrase" | "capability_gap", "gapSummary": "one-sentence description of what's missing" }`,
      { profile: 'fast', temperature: 0, maxTokens: 100, feature: 'exchange-bridge' }
    );
    return {
      classification: classResult.classification || 'capability_gap',
      gapSummary: classResult.gapSummary || content,
    };
  };
}

/**
 * evaluate-buildability: run the agent-builder's conversational feasibility
 * assessment (it decides offer-to-build vs decline). Mirrors the inline
 * halt-handler execution, including the 10s timeout.
 *
 * @param {{ getBuilderAgent: () => object, timeoutMs?: number }} deps
 */
function makeEvaluateBuildabilityHandler({ getBuilderAgent, timeoutMs = 10000 }) {
  return async function evaluateBuildability({ content, gapSummary }) {
    const builder = getBuilderAgent();
    if (!builder || typeof builder.execute !== 'function') {
      throw new Error('agent-builder-agent unavailable');
    }
    if (typeof builder.initialize === 'function') await builder.initialize();
    return Promise.race([
      builder.execute({
        content,
        metadata: { capabilityGap: gapSummary, originalRequest: content, source: 'exchange-halt' },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Builder agent timeout')), timeoutMs)),
    ]);
  };
}

/**
 * evaluate-response: the response-sanity guard as a meta-agent. Registered for
 * completeness; the bridge keeps it inline on the per-response hot path to avoid
 * a ledger entry per result.
 *
 * @param {{ checkResponseSanity: Function }} deps
 */
function makeEvaluateResponseHandler({ checkResponseSanity }) {
  return async function evaluateResponse({ message }) {
    return { issue: checkResponseSanity(message) || null };
  };
}

module.exports = {
  makeClassifyIntentHandler,
  makeEvaluateBuildabilityHandler,
  makeEvaluateResponseHandler,
};
