/**
 * Evaluation Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Handles multi-agent evaluation with epistemic consolidation
 */

const { AgentWeightingManager, WEIGHTING_MODES, CONTEXTUAL_WEIGHTS } = require('./weighting');
const { ProfileManager, EVALUATION_PROFILES } = require('./profiles');
const { EvaluationConsolidator, CONFLICT_THRESHOLD } = require('./consolidator');
const { SuggestionManager, PRIORITY_LEVELS, IMPACT_LEVELS } = require('./suggestions');

module.exports = {
  // Classes
  AgentWeightingManager,
  ProfileManager,
  EvaluationConsolidator,
  SuggestionManager,

  // Constants
  WEIGHTING_MODES,
  CONTEXTUAL_WEIGHTS,
  EVALUATION_PROFILES,
  CONFLICT_THRESHOLD,
  PRIORITY_LEVELS,
  IMPACT_LEVELS,
};
