/**
 * TranslationPipeline - TEaR Translation Pipeline (Translate, Evaluate, Refine)
 * @module src/video/translation/TranslationPipeline
 */

import { TranslationEvaluator } from './TranslationEvaluator.js';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

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
      qualityThreshold = 9.0
    } = options;

    const { openaiKey, anthropicKey } = this.getApiKeys();

    if (!openaiKey) {
      return { success: false, error: 'OpenAI API key not configured for translation.' };
    }

    const iterations = [];
    let currentTranslation = null;
    let currentEvaluation = null;

    for (let i = 1; i <= maxIterations; i++) {
      console.log(`[TranslationPipeline] Iteration ${i}/${maxIterations}`);

      // Step 1: Translate (or refine)
      if (i === 1) {
        currentTranslation = await this.translateText(sourceText, {
          sourceLanguage,
          targetLanguage,
          sourceDuration,
          videoContext,
          tone
        }, openaiKey);
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
        evaluation: currentEvaluation
      });

      // Check if we've reached quality threshold
      if (currentEvaluation.composite >= qualityThreshold) {
        console.log(`[TranslationPipeline] Quality threshold met at iteration ${i}: ${currentEvaluation.composite}`);
        return {
          success: true,
          translation: currentTranslation,
          finalScore: currentEvaluation.composite,
          iterations: iterations,
          evaluation: currentEvaluation
        };
      }

      // If we've exhausted iterations
      if (i === maxIterations) {
        console.log(`[TranslationPipeline] Max iterations reached. Final score: ${currentEvaluation.composite}`);
        return {
          success: false,
          translation: currentTranslation,
          finalScore: currentEvaluation.composite,
          iterations: iterations,
          evaluation: currentEvaluation,
          warning: `Quality threshold (${qualityThreshold}) not met after ${maxIterations} iterations`
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
  async translateText(sourceText, options, apiKey) {
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

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });

      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            try {
              const errorJson = JSON.parse(data);
              reject(new Error(errorJson.error?.message || `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
            return;
          }
          
          const response = JSON.parse(data);
          const translation = response.choices[0].message.content.trim();
          // Remove quotes if the model added them
          resolve(translation.replace(/^["']|["']$/g, ''));
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
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
  async refineTranslation(sourceText, currentTranslation, improvements, options, apiKey) {
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

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });

      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // Return current translation if refinement fails
            resolve(currentTranslation);
            return;
          }
          
          const response = JSON.parse(data);
          const refined = response.choices[0].message.content.trim();
          resolve(refined.replace(/^["']|["']$/g, ''));
        });
      });

      req.on('error', () => resolve(currentTranslation));
      req.write(postData);
      req.end();
    });
  }
}
















