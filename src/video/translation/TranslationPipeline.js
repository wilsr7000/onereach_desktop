/**
 * TranslationPipeline - TEaR Translation Pipeline (Translate, Evaluate, Refine)
 * @module src/video/translation/TranslationPipeline
 */

import { TranslationEvaluator } from './TranslationEvaluator.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
const ai = require('../../../lib/ai-service');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for multi-LLM translation with quality loop
 */
export class TranslationPipeline {
  constructor() {
    this.evaluator = new TranslationEvaluator();
  }

  /**
   * Get API keys from settings
   * @returns {Object} API keys
   */
  getApiKeys() {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let openaiKey = null;
    let anthropicKey = null;

    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      openaiKey = settings.openaiApiKey;
      anthropicKey = settings.anthropicApiKey || settings.claudeApiKey;
    }

    return { openaiKey, anthropicKey };
  }

  /**
   * TEaR Translation Pipeline - Translate, Evaluate, Refine
   * Uses multi-LLM approach for high-quality translations
   * @param {string} sourceText - Text to translate
   * @param {Object} options - Translation options
   * @returns {Promise<Object>} Translation result with scores
   */
  async translateWithQualityLoop(sourceText, options = {}) {
    const {
      sourceLanguage = 'auto',
      targetLanguage = 'en',
      sourceDuration = null,
      videoContext = 'general',
      tone = 'professional',
      maxIterations = 5,
      qualityThreshold = 9.0,
    } = options;

    const { openaiKey, anthropicKey } = this.getApiKeys();

    if (!openaiKey) {
      return { success: false, error: 'OpenAI API key not configured for translation.' };
    }

    const iterations = [];
    let currentTranslation = null;
    let currentEvaluation = null;

    for (let i = 1; i <= maxIterations; i++) {
      log.info('video', '[TranslationPipeline] Iteration /', { v0: i, v1: maxIterations });

      // Step 1: Translate (or refine)
      if (i === 1) {
        currentTranslation = await this.translateText(
          sourceText,
          {
            sourceLanguage,
            targetLanguage,
            sourceDuration,
            videoContext,
            tone,
          },
          openaiKey
        );
      } else {
        // Refine based on previous feedback
        currentTranslation = await this.refineTranslation(
          sourceText,
          currentTranslation,
          currentEvaluation.improvements,
          { sourceLanguage, targetLanguage, sourceDuration },
          openaiKey
        );
      }

      // Step 2: Evaluate
      currentEvaluation = await this.evaluator.evaluateTranslation(
        sourceText,
        currentTranslation,
        { sourceLanguage, targetLanguage, sourceDuration, videoContext },
        anthropicKey || openaiKey // Use Claude if available, fallback to GPT
      );

      iterations.push({
        iteration: i,
        translation: currentTranslation,
        evaluation: currentEvaluation,
      });

      // Check if we've reached quality threshold
      if (currentEvaluation.composite >= qualityThreshold) {
        log.info('video', '[TranslationPipeline] Quality threshold met at iteration :', {
          v0: i,
          v1: currentEvaluation.composite,
        });
        return {
          success: true,
          translation: currentTranslation,
          finalScore: currentEvaluation.composite,
          iterations: iterations,
          evaluation: currentEvaluation,
        };
      }

      // If we've exhausted iterations
      if (i === maxIterations) {
        log.info('video', '[TranslationPipeline] Max iterations reached. Final score:', {
          v0: currentEvaluation.composite,
        });
        return {
          success: false,
          translation: currentTranslation,
          finalScore: currentEvaluation.composite,
          iterations: iterations,
          evaluation: currentEvaluation,
          warning: `Quality threshold (${qualityThreshold}) not met after ${maxIterations} iterations`,
        };
      }
    }
  }

  /**
   * Translate text using LLM
   * @param {string} sourceText - Text to translate
   * @param {Object} options - Translation options
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<string>} Translated text
   */
  async translateText(sourceText, options, _apiKey) {
    const { sourceLanguage, targetLanguage, sourceDuration, videoContext, tone } = options;

    const systemPrompt = `You are a professional video translator specializing in high-quality dubbing translations.

INSTRUCTIONS:
1. Preserve the EXACT meaning - no additions, omissions, or hallucinations
2. Use natural, fluent ${targetLanguage} phrasing that sounds native
3. Adapt idioms and cultural references appropriately for the target audience
4. Consider timing - the translation should be speakable in approximately ${sourceDuration ? sourceDuration + ' seconds' : 'the same duration as the source'}
5. Maintain the speaker's tone (${tone}) and style
6. If the source is significantly longer when translated, find more concise phrasing WITHOUT losing meaning

Return ONLY the translated text, no explanations or notes.`;

    const userPrompt = `Translate the following text from ${sourceLanguage === 'auto' ? 'the detected language' : sourceLanguage} to ${targetLanguage}.

Context: This is from a ${videoContext} video.
${sourceDuration ? `Source duration: ${sourceDuration} seconds` : ''}

TEXT TO TRANSLATE:
"${sourceText}"

TRANSLATION:`;

    try {
      const result = await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.3,
        maxTokens: 2000,
        feature: 'translation-pipeline',
      });

      const translation = result.content.trim();
      // Remove quotes if the model added them
      return translation.replace(/^["']|["']$/g, '');
    } catch (err) {
      throw new Error(err.message || 'Translation failed');
    }
  }

  /**
   * Refine translation based on feedback
   * @param {string} sourceText - Original source text
   * @param {string} currentTranslation - Current translation
   * @param {Array} improvements - List of improvements needed
   * @param {Object} options - Options
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<string>} Refined translation
   */
  async refineTranslation(sourceText, currentTranslation, improvements, options, _apiKey) {
    const { sourceLanguage, targetLanguage, sourceDuration } = options;

    const systemPrompt = `You are a professional translation editor. Your task is to improve an existing translation based on specific feedback.

RULES:
1. Apply the suggested improvements carefully
2. Maintain the original meaning
3. Keep the same tone and style
4. Ensure the result sounds natural in ${targetLanguage}

Return ONLY the improved translation, no explanations.`;

    const userPrompt = `Improve this translation based on the feedback:

ORIGINAL TEXT (${sourceLanguage}): "${sourceText}"

CURRENT TRANSLATION: "${currentTranslation}"

IMPROVEMENTS NEEDED:
${improvements.map((imp, i) => `${i + 1}. ${imp}`).join('\n')}

${sourceDuration ? `Note: Translation should be speakable in ~${sourceDuration} seconds` : ''}

IMPROVED TRANSLATION:`;

    try {
      const result = await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.3,
        maxTokens: 2000,
        feature: 'translation-pipeline',
      });

      const refined = result.content.trim();
      return refined.replace(/^["']|["']$/g, '');
    } catch (_err) {
      // Return current translation if refinement fails
      return currentTranslation;
    }
  }
}
