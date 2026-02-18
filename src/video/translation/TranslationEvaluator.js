/**
 * TranslationEvaluator - Evaluate translation quality using multi-dimensional rubric
 * @module src/video/translation/TranslationEvaluator
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ai = require('../../../lib/ai-service');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for evaluating translation quality
 */
export class TranslationEvaluator {
  /**
   * Evaluate translation quality using multi-dimensional rubric
   * @param {string} sourceText - Original source text
   * @param {string} translatedText - Translated text
   * @param {Object} options - Evaluation options
   * @param {string} apiKey - API key (OpenAI or Anthropic)
   * @returns {Promise<Object>} Evaluation result with scores
   */
  async evaluateTranslation(sourceText, translatedText, options, apiKey) {
    const { sourceLanguage, targetLanguage, sourceDuration, videoContext } = options;

    const systemPrompt = `You are a professional translation quality evaluator. Rate the translation on 5 dimensions using a 1-10 scale.

EVALUATION CRITERIA:
1. ACCURACY (25% weight): Does it preserve the exact meaning? Any distortions, additions, or omissions?
2. FLUENCY (25% weight): Does it read naturally in ${targetLanguage}? Is grammar correct? Does it flow well?
3. ADEQUACY (20% weight): Is everything from the source translated? Nothing missing or added?
4. CULTURAL_FIT (15% weight): Are idioms and cultural references adapted appropriately?
5. TIMING_FIT (15% weight): Can this be spoken in a similar duration to the source? Is it concise enough?

SCORING GUIDELINES:
- 9-10: Excellent, professional quality
- 7-8: Good, minor issues only
- 5-6: Acceptable but needs improvement
- 3-4: Poor, significant issues
- 1-2: Unacceptable, major problems

For any score below 9, provide a SPECIFIC, actionable improvement suggestion.

RESPOND IN JSON FORMAT ONLY:
{
  "scores": {
    "accuracy": { "score": 8.5, "feedback": "specific feedback here" },
    "fluency": { "score": 9.0, "feedback": "specific feedback here" },
    "adequacy": { "score": 9.0, "feedback": "specific feedback here" },
    "cultural_fit": { "score": 8.0, "feedback": "specific feedback here" },
    "timing_fit": { "score": 8.5, "feedback": "specific feedback here" }
  },
  "composite": 8.6,
  "improvements": ["specific improvement 1", "specific improvement 2"],
  "pass": false
}`;

    const userPrompt = `Evaluate this translation:

SOURCE (${sourceLanguage}): "${sourceText}"
TRANSLATION (${targetLanguage}): "${translatedText}"

Context: ${videoContext} video
${sourceDuration ? `Source duration: ${sourceDuration}s` : ''}

Evaluate and return JSON:`;

    return new Promise((resolve, _reject) => {
      // Determine if using Claude or GPT
      const isAnthropic = apiKey && apiKey.startsWith('sk-ant-');

      if (isAnthropic) {
        this.evaluateWithAnthropic(systemPrompt, userPrompt, apiKey)
          .then(resolve)
          .catch(() => resolve(this.getDefaultEvaluation()));
      } else {
        this.evaluateWithOpenAI(systemPrompt, userPrompt, apiKey)
          .then(resolve)
          .catch(() => resolve(this.getDefaultEvaluation()));
      }
    });
  }

  /**
   * Evaluate using Anthropic API
   * @private
   */
  async evaluateWithAnthropic(systemPrompt, userPrompt, _apiKey) {
    try {
      const result = await ai.json(`${systemPrompt}\n\n${userPrompt}`, {
        profile: 'standard',
        maxTokens: 1500,
        feature: 'translation-evaluator',
      });

      const evaluation = result || {};

      // Calculate composite if not provided
      if (!evaluation.composite) {
        evaluation.composite = this.calculateComposite(evaluation.scores);
      }

      evaluation.pass = evaluation.composite >= 9.0;
      return evaluation;
    } catch (e) {
      log.error('video', '[TranslationEvaluator] Evaluation request error', { error: e });
      return this.getDefaultEvaluation();
    }
  }

  /**
   * Evaluate using OpenAI API
   * @private
   */
  async evaluateWithOpenAI(systemPrompt, userPrompt, _apiKey) {
    try {
      const result = await ai.json(userPrompt, {
        profile: 'fast',
        system: systemPrompt,
        temperature: 0.3,
        feature: 'translation-evaluator',
      });

      const evaluation = result || {};

      // Calculate composite if not provided
      if (!evaluation.composite) {
        evaluation.composite = this.calculateComposite(evaluation.scores);
      }

      evaluation.pass = evaluation.composite >= 9.0;
      return evaluation;
    } catch (e) {
      log.error('video', '[TranslationEvaluator] Evaluation request error', { error: e });
      return this.getDefaultEvaluation();
    }
  }

  /**
   * Calculate composite score from individual scores
   * @private
   */
  calculateComposite(scores) {
    const weights = {
      accuracy: 0.25,
      fluency: 0.25,
      adequacy: 0.2,
      cultural_fit: 0.15,
      timing_fit: 0.15,
    };

    let composite = 0;
    for (const [key, weight] of Object.entries(weights)) {
      composite += (scores[key]?.score || 7) * weight;
    }
    return Math.round(composite * 10) / 10;
  }

  /**
   * Get default evaluation when API fails
   * @returns {Object} Default evaluation object
   */
  getDefaultEvaluation() {
    return {
      scores: {
        accuracy: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        fluency: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        adequacy: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        cultural_fit: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        timing_fit: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
      },
      composite: 7.5,
      improvements: ['Manual review recommended'],
      pass: false,
    };
  }
}
