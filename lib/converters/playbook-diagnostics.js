/**
 * PlaybookDiagnostics
 *
 * @description Standalone diagnostic module for failed or low-quality Playbook
 *   conversions. Analyzes what went wrong and proposes actionable fixes,
 *   including automated repair suggestions and alternative pipeline routes.
 *
 * @module lib/converters/playbook-diagnostics
 *
 * @example
 *   const { diagnosePlaybook } = require('./playbook-diagnostics');
 *   const { validatePlaybook } = require('./playbook-validator');
 *   const validation = await validatePlaybook(playbook);
 *   const diagnosis = await diagnosePlaybook(playbook, validation, sourceContent, { ai });
 *   // diagnosis => { rootCause, severity, affectedPillars, fixes, alternativePipeline }
 *
 * @dependencies
 *   - lib/ai-service.js (for LLM-driven diagnosis)
 */

'use strict';

// Try to load AI service
let defaultAi;
try {
  defaultAi = require('../ai-service');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();
} catch (e) {
  defaultAi = null;
}

/**
 * Known error patterns and their automated fixes.
 * @private
 */
const KNOWN_FIXES = {
  MISSING_FIELD: {
    description: 'A required field is missing from the playbook',
    action: 'regenerate',
    automated: true,
    confidence: 0.8,
  },
  EMPTY_FIELD: {
    description: 'A required field exists but is empty',
    action: 'regenerate-field',
    automated: true,
    confidence: 0.7,
  },
  WRONG_TYPE: {
    description: 'A field has the wrong data type',
    action: 'coerce-type',
    automated: true,
    confidence: 0.9,
  },
  EMPTY_KEYWORDS: {
    description: 'Keywords array is empty',
    action: 'extract-keywords',
    automated: true,
    confidence: 0.85,
  },
  MISSING_FRAMEWORK: {
    description: 'Framework object is entirely missing',
    action: 'regenerate-framework',
    automated: true,
    confidence: 0.6,
  },
  MISSING_GRAPH_FIELD: {
    description: 'A field needed for graph node creation is missing',
    action: 'add-default',
    automated: true,
    confidence: 0.75,
  },
};

/**
 * Diagnose a playbook based on its validation result and source content.
 *
 * @param {Object} playbook - The playbook that was validated
 * @param {Object} validationResult - Result from validatePlaybook()
 * @param {string} [sourceContent] - Original source content (for context)
 * @param {Object} [options] - Options
 * @param {Object} [options.ai] - AI service instance
 * @returns {Promise<{diagnosis: Object}>}
 */
async function diagnosePlaybook(playbook, validationResult, sourceContent, options = {}) {
  const ai = options.ai || defaultAi;

  // Collect all errors across layers
  const allErrors = collectErrors(validationResult);

  // Determine affected pillars
  const affectedPillars = determineAffectedPillars(allErrors, validationResult);

  // Determine severity
  const severity = determineSeverity(validationResult);

  // Generate fixes from known patterns
  const knownFixes = generateKnownFixes(allErrors);

  // Use LLM for deeper diagnosis if available
  let llmDiagnosis = null;
  if (ai && allErrors.length > 0) {
    llmDiagnosis = await generateLLMDiagnosis(playbook, validationResult, sourceContent, allErrors, ai);
  }

  // Determine root cause
  const rootCause = llmDiagnosis?.rootCause || inferRootCause(allErrors);

  // Merge fixes: known fixes + LLM suggestions
  const fixes = mergeFixes(knownFixes, llmDiagnosis?.fixes || []);

  // Determine alternative pipeline
  const alternativePipeline = llmDiagnosis?.alternativePipeline || suggestAlternativePipeline(allErrors, severity);

  return {
    diagnosis: {
      rootCause,
      severity,
      affectedPillars,
      fixes,
      alternativePipeline,
    },
  };
}

/**
 * Collect all errors from the validation result layers.
 * @private
 */
function collectErrors(validationResult) {
  const errors = [];

  if (validationResult?.layers?.structural?.errors) {
    for (const err of validationResult.layers.structural.errors) {
      errors.push({ ...err, layer: 'structural' });
    }
  }

  if (validationResult?.layers?.graphReadiness?.errors) {
    for (const err of validationResult.layers.graphReadiness.errors) {
      errors.push({ ...err, layer: 'graphReadiness' });
    }
  }

  // Framework quality issues
  const fwQuality = validationResult?.layers?.frameworkQuality;
  if (fwQuality && fwQuality.pillarScores) {
    for (const [pillar, score] of Object.entries(fwQuality.pillarScores)) {
      if (score < 50) {
        errors.push({
          field: `framework.${pillar}`,
          code: 'LOW_QUALITY_SCORE',
          message: `Framework pillar "${pillar}" scored ${score}/100 (below threshold)`,
          layer: 'frameworkQuality',
          score,
        });
      }
    }
  }

  // Content quality issues
  const contentQuality = validationResult?.layers?.contentQuality;
  if (contentQuality && contentQuality.score < 50) {
    errors.push({
      field: 'content',
      code: 'LOW_CONTENT_QUALITY',
      message: `Content quality scored ${contentQuality.score}/100`,
      layer: 'contentQuality',
      score: contentQuality.score,
    });
  }

  return errors;
}

/**
 * Determine which framework pillars are affected.
 * @private
 */
function determineAffectedPillars(errors, validationResult) {
  const pillars = new Set();

  for (const err of errors) {
    if (err.field?.startsWith('framework.who')) pillars.add('who');
    else if (err.field?.startsWith('framework.why')) pillars.add('why');
    else if (err.field?.startsWith('framework.what')) pillars.add('what');
    else if (err.field?.startsWith('framework.where')) pillars.add('where');
    else if (err.field?.startsWith('framework.when')) pillars.add('when');
  }

  // Check pillar scores
  const pillarScores = validationResult?.layers?.frameworkQuality?.pillarScores || {};
  for (const [pillar, score] of Object.entries(pillarScores)) {
    if (score < 50) pillars.add(pillar);
  }

  return [...pillars];
}

/**
 * Determine overall severity.
 * @private
 */
function determineSeverity(validationResult) {
  if (!validationResult) return 'critical';

  const structuralPass = validationResult.layers?.structural?.pass;
  const score = validationResult.score || 0;

  if (!structuralPass) return 'critical';
  if (score < 30) return 'critical';
  if (score < 50) return 'high';
  if (score < 70) return 'medium';
  return 'low';
}

/**
 * Generate fixes from known error patterns.
 * @private
 */
function generateKnownFixes(errors) {
  const fixes = [];
  const seen = new Set();

  for (const err of errors) {
    const known = KNOWN_FIXES[err.code];
    if (!known) continue;

    const fixId = `${err.code}:${err.field}`;
    if (seen.has(fixId)) continue;
    seen.add(fixId);

    fixes.push({
      id: fixId,
      description: `${known.description} — field: ${err.field}`,
      action: known.action,
      automated: known.automated,
      params: { field: err.field, errorCode: err.code },
      confidence: known.confidence,
    });
  }

  return fixes;
}

/**
 * Use LLM to generate deeper diagnosis.
 * @private
 */
async function generateLLMDiagnosis(playbook, validationResult, sourceContent, errors, ai) {
  try {
    const errorSummary = errors.map(e => `- [${e.layer}] ${e.field}: ${e.message}`).join('\n');
    const contentPreview = sourceContent ? sourceContent.substring(0, 500) : 'N/A';
    const playbookPreview = JSON.stringify(playbook, null, 2).substring(0, 1500);

    const result = await ai.json(
      `You are diagnosing a failed or low-quality playbook conversion.

Validation errors:
${errorSummary}

Overall score: ${validationResult.score}/100

Source content preview:
${contentPreview}

Current playbook state:
${playbookPreview}

Analyze what went wrong and suggest fixes.

Return JSON:
{
  "rootCause": "Brief root cause description",
  "fixes": [
    {
      "id": "fix-id",
      "description": "What to fix",
      "action": "regenerate|edit|coerce|extract",
      "automated": true|false,
      "params": {},
      "confidence": 0.0-1.0
    }
  ],
  "alternativePipeline": "Suggested alternative conversion approach, or null if current approach is salvageable"
}`,
      { profile: 'fast', feature: 'playbook-diagnostics', temperature: 0.2 }
    );

    return result;
  } catch (err) {
    console.warn('[playbook-diagnostics] LLM diagnosis failed:', err.message);
    return null;
  }
}

/**
 * Infer root cause from error patterns without LLM.
 * @private
 */
function inferRootCause(errors) {
  if (errors.length === 0) return 'No errors detected';

  const structuralErrors = errors.filter(e => e.layer === 'structural');
  const qualityErrors = errors.filter(e => e.code === 'LOW_QUALITY_SCORE' || e.code === 'LOW_CONTENT_QUALITY');

  if (structuralErrors.length > 5) {
    return 'Severe structural deficiencies — the LLM likely failed to produce valid JSON or missed multiple required fields';
  }
  if (structuralErrors.some(e => e.code === 'NOT_OBJECT')) {
    return 'Playbook is not a valid object — conversion may have returned raw text instead of structured data';
  }
  if (qualityErrors.length > 0 && structuralErrors.length === 0) {
    return 'Structure is valid but content/framework quality is below threshold — source material may be too thin or ambiguous';
  }
  if (structuralErrors.length > 0) {
    const fields = structuralErrors.map(e => e.field).join(', ');
    return `Missing or invalid fields: ${fields}`;
  }

  return 'Multiple minor issues across validation layers';
}

/**
 * Suggest alternative pipeline without LLM.
 * @private
 */
function suggestAlternativePipeline(errors, severity) {
  if (severity === 'critical') {
    return 'Consider using the "full-analysis" strategy with a more capable AI profile, or pre-processing the source content to improve structure before conversion';
  }
  if (severity === 'high') {
    return 'Try the "template" strategy with a domain hint matching the content type';
  }
  return null;
}

/**
 * Merge known fixes with LLM-suggested fixes, deduplicating.
 * @private
 */
function mergeFixes(knownFixes, llmFixes) {
  const merged = [...knownFixes];
  const existingIds = new Set(merged.map(f => f.id));

  for (const fix of llmFixes) {
    if (!existingIds.has(fix.id)) {
      merged.push(fix);
      existingIds.add(fix.id);
    }
  }

  // Sort by confidence descending
  merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  return merged;
}

module.exports = {
  diagnosePlaybook,
};
