/**
 * Services Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Core evaluation services for multi-agent assessment
 */

const AgentGenerator = require('./agentGenerator');
const EvalAgent = require('./evalAgent');

// Re-export consolidator from lib for convenience
const { EvaluationConsolidator } = require('../../lib/evaluation/consolidator');

module.exports = {
  AgentGenerator,
  EvalAgent,
  EvaluationConsolidator,
};
