/**
 * Utterance Classifier (Phase 3 / pauseDetection)
 *
 * Async helper that asks a fast LLM whether a partial transcript is
 * a complete thought. Consulted by the pause detector only when the
 * turn-taking heuristic returns 'ambiguous' -- so most utterances
 * never pay for an LLM call.
 *
 * Design:
 *   - Deps (ai + logger) are injectable so tests run without Electron,
 *     API keys, or network access.
 *   - Short TTL cache (2s) keyed by exact partial text. Rapid re-checks
 *     on the same text during a single pause skip the LLM call.
 *   - Circuit breaker: N consecutive failures trip the classifier
 *     open, after which `classify()` returns `{ complete: null }`
 *     (unknown). The pause detector treats unknown as "hold".
 *
 * Output contract (stable -- pause-detector depends on it):
 *   {
 *     complete:   boolean | null,     // null = couldn't decide
 *     confidence: number,             // 0..1 (0 when null)
 *     source:     string,             // 'llm' | 'cache' | 'circuit-open' | 'error'
 *     reasoning:  string              // short explanation, may be empty
 *   }
 */

'use strict';

// ==================== DEFAULTS ====================

const DEFAULT_CONFIG = Object.freeze({
  cacheTtlMs: 2000,
  maxTokens: 40,
  // Circuit breaker
  failureThreshold: 3,
  circuitResetMs: 10_000,
});

// ==================== PROMPT ====================

const SYSTEM_PROMPT = `You are a speech completeness classifier for a voice assistant.
Given a short partial transcript that was just spoken, decide whether the speaker is DONE
(the thought is complete and ready to act on) or NOT DONE (they're pausing mid-utterance).

Respond with JSON only:
{
  "complete": true | false,
  "confidence": 0.0-1.0,
  "reasoning": "one short sentence"
}

Rules:
- "complete": the transcript is a grammatical, actionable command or question.
- "not complete": obvious continuation hooks ("...and", "...but"), hanging modifiers,
  fragments without a verb.
- When genuinely uncertain, lean "not complete" with confidence < 0.7 so the
  system waits rather than cutting the user off.`;

// ==================== CLASSIFIER ====================

/**
 * Create an utterance classifier. Returns `{ classify, reset }`.
 *
 * @param {object} [deps]
 * @param {(args:object) => Promise<{content:string}>} [deps.ai]
 *        Mirrors the real lib/ai-service.chat signature -- takes
 *        { profile, system, messages, temperature, maxTokens, jsonMode, feature }.
 * @param {{info:Function,warn:Function,error:Function}} [deps.log]
 * @param {() => number} [deps.now] - test clock override
 * @param {object} [deps.config] - override DEFAULT_CONFIG
 */
function createUtteranceClassifier(deps = {}) {
  const ai = deps.ai || null;
  const log = deps.log || _silentLog();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const config = { ...DEFAULT_CONFIG, ...(deps.config || {}) };

  // ---- state ----
  /** @type {Map<string, {result: object, at: number}>} */
  const cache = new Map();
  const circuit = { failures: 0, lastFailureAt: 0 };

  function _isCircuitOpen() {
    if (circuit.failures < config.failureThreshold) return false;
    if (now() - circuit.lastFailureAt > config.circuitResetMs) {
      circuit.failures = 0;
      return false;
    }
    return true;
  }

  function _cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (now() - entry.at > config.cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return entry.result;
  }

  function _cacheSet(key, result) {
    cache.set(key, { result, at: now() });
    if (cache.size > 64) {
      // Cheap eviction: drop the oldest half.
      const keys = Array.from(cache.keys()).slice(0, Math.floor(cache.size / 2));
      for (const k of keys) cache.delete(k);
    }
  }

  /**
   * Classify a partial transcript.
   * @param {string} partial
   * @returns {Promise<{complete: boolean|null, confidence: number, source: string, reasoning: string}>}
   */
  async function classify(partial) {
    const text = (partial || '').toString().trim();
    if (!text) {
      return { complete: false, confidence: 0, source: 'empty', reasoning: 'empty partial' };
    }

    const cached = _cacheGet(text);
    if (cached) return { ...cached, source: 'cache' };

    if (_isCircuitOpen()) {
      return {
        complete: null,
        confidence: 0,
        source: 'circuit-open',
        reasoning: 'classifier circuit breaker open',
      };
    }

    if (!ai || typeof ai !== 'function') {
      return {
        complete: null,
        confidence: 0,
        source: 'no-ai',
        reasoning: 'no ai service injected',
      };
    }

    try {
      const response = await ai({
        profile: 'fast',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
        temperature: 0,
        maxTokens: config.maxTokens,
        jsonMode: true,
        feature: 'utterance-classifier',
      });

      const raw = response && response.content ? response.content : '';
      const parsed = _parseJson(raw);
      if (!parsed || typeof parsed.complete !== 'boolean') {
        _recordFailure('unparseable LLM response');
        return {
          complete: null,
          confidence: 0,
          source: 'error',
          reasoning: 'unparseable response',
        };
      }

      const result = {
        complete: Boolean(parsed.complete),
        confidence: _clampConfidence(parsed.confidence),
        source: 'llm',
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      };

      circuit.failures = 0; // success resets
      _cacheSet(text, result);
      return result;
    } catch (err) {
      _recordFailure(err.message || 'llm error');
      log.warn('[utterance-classifier] llm error', { error: err.message });
      return {
        complete: null,
        confidence: 0,
        source: 'error',
        reasoning: err.message || 'llm error',
      };
    }
  }

  function _recordFailure(_why) {
    circuit.failures++;
    circuit.lastFailureAt = now();
  }

  function reset() {
    cache.clear();
    circuit.failures = 0;
    circuit.lastFailureAt = 0;
  }

  function getDiagnostics() {
    return {
      cacheSize: cache.size,
      circuitFailures: circuit.failures,
      circuitOpen: _isCircuitOpen(),
    };
  }

  return { classify, reset, getDiagnostics };
}

// ==================== HELPERS ====================

function _parseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  // Strip markdown code fences if present.
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function _clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function _silentLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop };
}

module.exports = {
  createUtteranceClassifier,
  DEFAULT_CONFIG,
  SYSTEM_PROMPT,
};
