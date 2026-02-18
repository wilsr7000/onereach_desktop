/**
 * Correction Detector
 *
 * Detects when the user is correcting a previous command using LLM.
 * No brittle regex - the LLM understands context and nuance.
 */

const { getCircuit } = require('../../../packages/agents/circuit-breaker');
const ai = require('../../../lib/ai-service');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

// Circuit breaker for OpenAI API calls
const openaiCircuit = getCircuit('openai-correction', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000,
});

function _getOpenAIApiKey() {
  if (global.settingsManager) {
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * Use LLM to detect if user is correcting a previous command
 * @param {string} transcript - What the user said
 * @param {Object} context - { lastRequest, lastResponse }
 * @returns {Promise<Object>} - { isCorrection, correctedIntent, confidence, reasoning }
 */
async function analyzeWithLLM(transcript, context = {}) {
  const systemPrompt = `You determine if the user is correcting a previous misunderstood command.

Context:
- Previous request: "${context.lastRequest || 'unknown'}"
- System response: "${context.lastResponse || 'unknown'}"
- Current input: "${transcript}"

Return JSON:
{
  "isCorrection": true/false,
  "correctedIntent": "the actual command they want" or null,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Guidelines:
- "no I said X" → correction, extract X
- "I meant Y" → correction, extract Y  
- "not that, Z" → correction, extract Z
- "actually X" → correction, extract X
- Simple "no" or "no thanks" → NOT a correction, just a negative response
- "and also X" or "also X" → NOT a correction, it's a followup
- "what about X" → NOT a correction, it's a new question

Examples:
- User said "play jazz", got "playing Jaws", now says "no jazz music" → correction, intent="play jazz music"
- User said "what time is it", got time, now says "and the date" → NOT correction, it's a followup
- User said "play rock", system asked "which artist?", user says "no just any rock" → correction, intent="play any rock music"
- User says "no thanks" → NOT correction, just declining`;

  try {
    const result = await openaiCircuit.execute(async () => {
      return await ai.json(transcript, {
        profile: 'fast',
        system: systemPrompt,
        temperature: 0.1,
        maxTokens: 200,
        feature: 'correction-detector',
      });
    });

    log.info('voice', '[CorrectionDetector] LLM analysis', { data: result.reasoning });

    return {
      isCorrection: result.isCorrection === true,
      correctedIntent: result.correctedIntent || null,
      confidence: result.confidence || 0.5,
      reasoning: result.reasoning || 'LLM analysis',
    };
  } catch (error) {
    log.error('voice', '[CorrectionDetector] LLM error', { error: error.message });
    return { isCorrection: false, reasoning: `LLM error: ${error.message}` };
  }
}

/**
 * Quick check if this could possibly be a correction (to avoid unnecessary LLM calls)
 * Uses simple string checks, not regex
 * @param {string} transcript
 * @returns {boolean}
 */
function mightBeCorrection(transcript) {
  if (!transcript) return false;

  const lower = transcript.toLowerCase().trim();

  // Quick negative - very short responses that are clearly not corrections
  if (
    lower === 'yes' ||
    lower === 'yeah' ||
    lower === 'yep' ||
    lower === 'sure' ||
    lower === 'ok' ||
    lower === 'okay'
  ) {
    return false;
  }

  // Keywords that suggest a correction
  const correctionHints = ['no ', 'no,', 'not ', 'i said', 'i meant', 'actually', 'wait', 'wrong'];

  for (const hint of correctionHints) {
    if (lower.startsWith(hint) || lower.includes(' ' + hint)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect if user is correcting a previous command
 * @param {string} transcript - What the user said
 * @param {Object} context - { lastRequest, lastResponse }
 * @param {boolean} useLLM - Whether to use LLM (default: true if context available)
 * @returns {Promise<Object>}
 */
async function detect(transcript, context = {}, useLLM = true) {
  // Quick check - if it doesn't look like a correction at all, skip LLM
  if (!mightBeCorrection(transcript)) {
    return { isCorrection: false, reasoning: 'Does not appear to be a correction' };
  }

  // Use LLM to properly analyze the correction
  if (useLLM && context.lastRequest) {
    return analyzeWithLLM(transcript, context);
  }

  // No context available - can't determine if it's a correction
  return { isCorrection: false, reasoning: 'No context to compare against' };
}

module.exports = {
  detect,
  analyzeWithLLM,
  mightBeCorrection,
};
