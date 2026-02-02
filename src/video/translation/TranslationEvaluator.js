/**
 * TranslationEvaluator - Evaluate translation quality using multi-dimensional rubric
 * @module src/video/translation/TranslationEvaluator
 */

import https from 'https';

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

    return new Promise((resolve, reject) => {
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
  async evaluateWithAnthropic(systemPrompt, userPrompt, apiKey) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        messages: [
          { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }
        ]
      });

      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error('[TranslationEvaluator] Anthropic API error:', data);
            resolve(this.getDefaultEvaluation());
            return;
          }
          
          try {
            const response = JSON.parse(data);
            const content = response.content[0].text;
            const evaluation = JSON.parse(content);
            
            // Calculate composite if not provided
            if (!evaluation.composite) {
              evaluation.composite = this.calculateComposite(evaluation.scores);
            }
            
            evaluation.pass = evaluation.composite >= 9.0;
            resolve(evaluation);
          } catch (e) {
            console.error('[TranslationEvaluator] Failed to parse evaluation:', e);
            resolve(this.getDefaultEvaluation());
          }
        });
      });

      req.on('error', (e) => {
        console.error('[TranslationEvaluator] Evaluation request error:', e);
        resolve(this.getDefaultEvaluation());
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Evaluate using OpenAI API
   * @private
   */
  async evaluateWithOpenAI(systemPrompt, userPrompt, apiKey) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
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
            console.error('[TranslationEvaluator] OpenAI evaluation error:', data);
            resolve(this.getDefaultEvaluation());
            return;
          }
          
          try {
            const response = JSON.parse(data);
            const content = response.choices[0].message.content;
            const evaluation = JSON.parse(content);
            
            // Calculate composite if not provided
            if (!evaluation.composite) {
              evaluation.composite = this.calculateComposite(evaluation.scores);
            }
            
            evaluation.pass = evaluation.composite >= 9.0;
            resolve(evaluation);
          } catch (e) {
            console.error('[TranslationEvaluator] Failed to parse evaluation:', e);
            resolve(this.getDefaultEvaluation());
          }
        });
      });

      req.on('error', (e) => {
        console.error('[TranslationEvaluator] Evaluation request error:', e);
        resolve(this.getDefaultEvaluation());
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Calculate composite score from individual scores
   * @private
   */
  calculateComposite(scores) {
    const weights = { 
      accuracy: 0.25, 
      fluency: 0.25, 
      adequacy: 0.20, 
      cultural_fit: 0.15, 
      timing_fit: 0.15 
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
        timing_fit: { score: 7.5, feedback: 'Unable to evaluate - please review manually' }
      },
      composite: 7.5,
      improvements: ['Manual review recommended'],
      pass: false
    };
  }
}
















