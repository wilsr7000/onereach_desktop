/**
 * PlaybookValidator
 *
 * @description Standalone validation module for Playbook objects. Performs
 *   four layers of validation: structural integrity, framework quality
 *   (LLM-scored), content quality (LLM-scored), and graph readiness.
 *
 * @module lib/converters/playbook-validator
 *
 * @example
 *   const { validatePlaybook } = require('./playbook-validator');
 *   const result = await validatePlaybook(playbookObj, { ai });
 *   // result => { valid, score, layers: { structural, frameworkQuality, contentQuality, graphReadiness } }
 *
 * @dependencies
 *   - lib/ai-service.js (optional — for LLM quality scoring)
 */

'use strict';

// Try to load AI service; may not be available in all environments
let defaultAi;
try {
  defaultAi = require('../ai-service');
  const { getLogQueue } = require('./../log-event-queue');
  const _log = getLogQueue();
} catch (_e) {
  defaultAi = null;
}

/**
 * Required top-level fields and their expected types.
 * @private
 */
const REQUIRED_FIELDS = {
  title: 'string',
  content: 'string',
  keywords: 'array',
  framework: 'object',
};

/**
 * Required framework pillar fields.
 * @private
 */
const FRAMEWORK_PILLARS = {
  'who.primary': { path: ['who', 'primary'], type: 'string' },
  'who.characteristics': { path: ['who', 'characteristics'], type: 'array' },
  'who.context': { path: ['who', 'context'], type: 'string' },
  'why.coreValue': { path: ['why', 'coreValue'], type: 'string' },
  'why.emotionalHook': { path: ['why', 'emotionalHook'], type: 'string' },
  'why.practicalBenefit': { path: ['why', 'practicalBenefit'], type: 'string' },
  'what.primaryAction': { path: ['what', 'primaryAction'], type: 'string' },
  'what.secondaryActions': { path: ['what', 'secondaryActions'], type: 'array' },
  'what.successLooksLike': { path: ['what', 'successLooksLike'], type: 'string' },
  'where.platform': { path: ['where', 'platform'], type: 'string' },
  'where.format': { path: ['where', 'format'], type: 'string' },
};

/**
 * Fields required for graph node readiness.
 * @private
 */
const GRAPH_FIELDS = ['title', 'content', 'keywords', 'status', 'stage'];

/**
 * Validate a Playbook object across four quality layers.
 *
 * @param {Object} playbook - The playbook object to validate
 * @param {Object} [options] - Validation options
 * @param {Object} [options.ai] - AI service instance (for LLM layers)
 * @param {boolean} [options.skipLLM=false] - Skip LLM-based quality checks
 * @returns {Promise<{valid: boolean, score: number, layers: Object}>}
 */
async function validatePlaybook(playbook, options = {}) {
  const ai = options.ai || defaultAi;
  const skipLLM = options.skipLLM === true;

  // Layer 1: Structural validation
  const structural = validateStructural(playbook);

  // Layer 2: Framework quality (LLM)
  let frameworkQuality = { pass: true, score: 100, pillarScores: {} };
  if (!skipLLM && ai && structural.pass) {
    frameworkQuality = await evaluateFrameworkQuality(playbook, ai);
  } else if (skipLLM || !ai) {
    frameworkQuality = { pass: structural.pass, score: structural.pass ? 70 : 0, pillarScores: {} };
  }

  // Layer 3: Content quality (LLM)
  let contentQuality = { pass: true, score: 100 };
  if (!skipLLM && ai && structural.pass) {
    contentQuality = await evaluateContentQuality(playbook, ai);
  } else if (skipLLM || !ai) {
    contentQuality = { pass: structural.pass, score: structural.pass ? 70 : 0 };
  }

  // Layer 4: Graph readiness
  const graphReadiness = validateGraphReadiness(playbook);

  // Aggregate score
  const layerScores = [
    structural.pass ? 100 : 0,
    frameworkQuality.score,
    contentQuality.score,
    graphReadiness.pass ? 100 : 50,
  ];
  const overallScore = Math.round(layerScores.reduce((a, b) => a + b, 0) / layerScores.length);
  const valid = structural.pass && frameworkQuality.pass && contentQuality.pass;

  return {
    valid,
    score: overallScore,
    layers: {
      structural,
      frameworkQuality,
      contentQuality,
      graphReadiness,
    },
  };
}

/**
 * Layer 1: Structural validation.
 * Checks that required fields exist with correct types.
 *
 * @param {Object} playbook
 * @returns {{pass: boolean, errors: Array<{field: string, code: string, message: string}>}}
 */
function validateStructural(playbook) {
  const errors = [];

  if (!playbook || typeof playbook !== 'object') {
    errors.push({ field: 'playbook', code: 'NOT_OBJECT', message: 'Playbook must be an object' });
    return { pass: false, errors };
  }

  // Check top-level fields
  for (const [field, expectedType] of Object.entries(REQUIRED_FIELDS)) {
    const value = playbook[field];
    if (value === undefined || value === null) {
      errors.push({ field, code: 'MISSING_FIELD', message: `Required field "${field}" is missing` });
      continue;
    }
    if (expectedType === 'array' && !Array.isArray(value)) {
      errors.push({ field, code: 'WRONG_TYPE', message: `Field "${field}" should be an array, got ${typeof value}` });
    } else if (expectedType === 'string' && typeof value !== 'string') {
      errors.push({ field, code: 'WRONG_TYPE', message: `Field "${field}" should be a string, got ${typeof value}` });
    } else if (expectedType === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push({ field, code: 'WRONG_TYPE', message: `Field "${field}" should be an object, got ${typeof value}` });
    }
    // Check non-empty for strings
    if (expectedType === 'string' && typeof value === 'string' && value.trim().length === 0) {
      errors.push({ field, code: 'EMPTY_FIELD', message: `Field "${field}" is empty` });
    }
  }

  // Check framework pillars
  const fw = playbook.framework;
  if (fw && typeof fw === 'object') {
    for (const [name, spec] of Object.entries(FRAMEWORK_PILLARS)) {
      let value = fw;
      for (const key of spec.path) {
        value = value?.[key];
      }
      if (value === undefined || value === null) {
        errors.push({
          field: `framework.${name}`,
          code: 'MISSING_FIELD',
          message: `Framework field "${name}" is missing`,
        });
      } else if (spec.type === 'string' && typeof value !== 'string') {
        errors.push({
          field: `framework.${name}`,
          code: 'WRONG_TYPE',
          message: `Framework field "${name}" should be a string`,
        });
      } else if (spec.type === 'array' && !Array.isArray(value)) {
        errors.push({
          field: `framework.${name}`,
          code: 'WRONG_TYPE',
          message: `Framework field "${name}" should be an array`,
        });
      } else if (spec.type === 'string' && typeof value === 'string' && value.trim().length === 0) {
        errors.push({ field: `framework.${name}`, code: 'EMPTY_FIELD', message: `Framework field "${name}" is empty` });
      }
    }
  }

  return { pass: errors.length === 0, errors };
}

/**
 * Layer 2: Framework quality evaluation using LLM.
 * Scores each pillar 0-100.
 *
 * @param {Object} playbook
 * @param {Object} ai - AI service instance
 * @returns {Promise<{pass: boolean, score: number, pillarScores: Object}>}
 */
async function evaluateFrameworkQuality(playbook, ai) {
  try {
    const fw = playbook.framework || {};
    const result = await ai.json(
      `You are evaluating the quality of a content framework.
Rate each pillar 0-100 based on specificity, clarity, and actionability.
A score below 50 means the pillar is too vague or generic.

Framework:
WHO: ${JSON.stringify(fw.who || {})}
WHY: ${JSON.stringify(fw.why || {})}
WHAT: ${JSON.stringify(fw.what || {})}
WHERE: ${JSON.stringify(fw.where || {})}

Content title: "${playbook.title || ''}"

Return JSON:
{
  "who": 0-100,
  "why": 0-100,
  "what": 0-100,
  "where": 0-100,
  "reasoning": "brief evaluation"
}`,
      { profile: 'fast', feature: 'playbook-validator-framework', temperature: 0 }
    );

    if (!result) {
      return { pass: true, score: 70, pillarScores: {} };
    }

    const pillarScores = {
      who: Number(result.who) || 0,
      why: Number(result.why) || 0,
      what: Number(result.what) || 0,
      where: Number(result.where) || 0,
    };

    const avgScore = Math.round(Object.values(pillarScores).reduce((a, b) => a + b, 0) / 4);
    const pass = avgScore >= 50 && Object.values(pillarScores).every((s) => s >= 30);

    return { pass, score: avgScore, pillarScores, reasoning: result.reasoning };
  } catch (err) {
    console.warn('[playbook-validator] Framework quality eval failed:', err.message);
    return { pass: true, score: 70, pillarScores: {} };
  }
}

/**
 * Layer 3: Content quality evaluation using LLM.
 *
 * @param {Object} playbook
 * @param {Object} ai - AI service instance
 * @returns {Promise<{pass: boolean, score: number}>}
 */
async function evaluateContentQuality(playbook, ai) {
  try {
    const contentSample = (playbook.content || '').substring(0, 2000);
    const result = await ai.json(
      `Evaluate the quality of this content for a playbook.
Score 0-100 based on: clarity, structure, completeness, and relevance.

Title: "${playbook.title || ''}"
Content:
${contentSample}

Return JSON: { "score": 0-100, "reasoning": "brief evaluation" }`,
      { profile: 'fast', feature: 'playbook-validator-content', temperature: 0 }
    );

    const score = Number(result?.score) || 70;
    return { pass: score >= 50, score, reasoning: result?.reasoning };
  } catch (err) {
    console.warn('[playbook-validator] Content quality eval failed:', err.message);
    return { pass: true, score: 70 };
  }
}

/**
 * Layer 4: Graph readiness validation.
 * Checks that the playbook has all fields needed to become a graph node.
 *
 * @param {Object} playbook
 * @returns {{pass: boolean, errors: Array<{field: string, code: string, message: string}>}}
 */
function validateGraphReadiness(playbook) {
  const errors = [];

  if (!playbook || typeof playbook !== 'object') {
    errors.push({ field: 'playbook', code: 'NOT_OBJECT', message: 'Playbook must be an object' });
    return { pass: false, errors };
  }

  for (const field of GRAPH_FIELDS) {
    if (playbook[field] === undefined || playbook[field] === null) {
      errors.push({ field, code: 'MISSING_GRAPH_FIELD', message: `Graph node field "${field}" is missing` });
    }
  }

  // Keywords should be non-empty for graph indexing
  if (Array.isArray(playbook.keywords) && playbook.keywords.length === 0) {
    errors.push({
      field: 'keywords',
      code: 'EMPTY_KEYWORDS',
      message: 'Keywords array is empty (needed for graph indexing)',
    });
  }

  // Framework should exist for graph edges
  if (!playbook.framework || typeof playbook.framework !== 'object') {
    errors.push({
      field: 'framework',
      code: 'MISSING_FRAMEWORK',
      message: 'Framework is needed for graph edge creation',
    });
  }

  return { pass: errors.length === 0, errors };
}

module.exports = {
  validatePlaybook,
  validateStructural,
  validateGraphReadiness,
};
