/**
 * Anthropic Provider Adapter
 * 
 * Handles all Anthropic/Claude API communication: chat completions,
 * streaming, JSON mode, and vision.
 * 
 * Part of the centralized AI service layer.
 * Consumers should NOT use this directly — use lib/ai-service.js instead.
 * 
 * @module ai-providers/anthropic-adapter
 */

const https = require('https');
const { URL } = require('url');
const { getLogQueue } = require('../log-event-queue');
const _logQueue = getLogQueue();

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

// Debug logging (controlled by AI_LOG_LEVEL env var)
const _LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };
const _AI_LOG = _LOG_LEVELS[process.env.AI_LOG_LEVEL || 'debug'] ?? _LOG_LEVELS.debug;
function _log(level, msg, data) {
  if (_LOG_LEVELS[level] < _AI_LOG) return;
  const logFn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  const logData = data !== undefined ? (typeof data === 'object' ? data : { value: data }) : undefined;
  _logQueue[logFn]('api', `[Anthropic] ${msg}`, logData);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate token count from text (rough: ~4 chars per token)
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(str.length / 4);
}

/**
 * Parse Anthropic SSE stream.
 * Yields parsed event objects { type, ...data }.
 */
async function* parseAnthropicSSE(response) {
  let buffer = '';
  let currentEvent = null;

  for await (const chunk of response) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7);
      } else if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          data._event = currentEvent;
          yield data;
        } catch {
          // skip malformed JSON
        }
        currentEvent = null;
      }
    }
  }
}

/**
 * Make an HTTPS request and return the full response.
 */
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(options.timeout || 120000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Make an HTTPS request that returns a readable stream (for SSE).
 */
function makeStreamRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => {
          const err = new Error(`Anthropic API error: ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.responseBody = errBody;
          if (res.headers['retry-after']) {
            err.retryAfter = parseInt(res.headers['retry-after'], 10);
          }
          reject(err);
        });
        return;
      }
      resolve(res);
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(options.timeout || 120000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}


// ---------------------------------------------------------------------------
// Anthropic Adapter
// ---------------------------------------------------------------------------

class AnthropicAdapter {
  constructor() {
    this.provider = 'anthropic';
  }

  /**
   * Build standard headers for Anthropic API requests.
   */
  _headers(apiKey, extra = {}) {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...extra,
    };
  }

  // =========================================================================
  // Chat Completion (batch)
  // =========================================================================

  /**
   * Send a messages request and return the full response.
   * 
   * @param {Object} opts
   * @param {string} opts.apiKey - Anthropic API key
   * @param {string} opts.model - Model name (e.g. 'claude-opus-4-6')
   * @param {Array}  opts.messages - Chat messages array [{role, content}]
   * @param {number} [opts.maxTokens=1024] - Max response tokens
   * @param {number} [opts.temperature=0.7] - Sampling temperature
   * @param {boolean} [opts.jsonMode=false] - Request JSON output (via system prompt)
   * @param {string} [opts.system] - System prompt
   * @param {number} [opts.timeout=120000]
   * @param {Object|boolean} [opts.thinking] - Extended thinking config:
   *   - true or { type: 'adaptive' } → adaptive thinking (Opus 4.6+)
   *   - { type: 'enabled', budgetTokens: N } → manual thinking (older models)
   * @param {string} [opts.effort] - Effort level: 'low' | 'medium' | 'high' | 'max'
   * @returns {Promise<Object>} { content, thinking, usage, model, provider, finishReason }
   */
  async chat(opts) {
    const {
      apiKey,
      model,
      messages,
      maxTokens = 1024,
      temperature = 0.7,
      jsonMode = false,
      system = null,
      timeout = 120000,
      thinking = null,
      effort = null,
    } = opts;

    const thinkingConfig = this._resolveThinking(thinking);
    const isThinking = !!thinkingConfig;

    _log('debug', `chat REQUEST model=${model} messages=${messages?.length || 0} maxTokens=${maxTokens} jsonMode=${jsonMode} thinking=${isThinking ? thinkingConfig.type : 'off'} effort=${effort || 'default'}`);

    const body = {
      model,
      max_tokens: maxTokens,
      messages: this._convertMessages(messages),
    };

    // When thinking is enabled, temperature must be 1 (Anthropic requirement)
    if (isThinking) {
      body.temperature = 1;
      body.thinking = thinkingConfig;
    } else {
      body.temperature = temperature;
    }

    // Effort parameter (Opus 4.5+ only)
    if (effort) {
      body.output_config = { effort };
    }

    // Anthropic uses a top-level system field, not a system message in the array
    let systemPrompt = system || '';
    if (jsonMode) {
      const jsonInstruction = 'You must respond with valid JSON only. No markdown, no explanations, just JSON.';
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${jsonInstruction}` : jsonInstruction;
    }
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const res = await makeRequest(
      `${ANTHROPIC_BASE_URL}/messages`,
      { method: 'POST', headers: this._headers(apiKey), timeout },
      body
    );

    if (res.statusCode >= 400) {
      _log('error', `chat FAILED status=${res.statusCode} model=${model}`, { responseBody: res.body?.slice(0, 500) });
      const err = new Error(`Anthropic API error: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.responseBody = res.body;
      if (res.headers['retry-after']) {
        err.retryAfter = parseInt(res.headers['retry-after'], 10);
      }
      throw err;
    }

    const data = JSON.parse(res.body);
    const textBlock = data.content?.find(b => b.type === 'text');
    const thinkingBlock = data.content?.find(b => b.type === 'thinking');

    if (thinkingBlock) {
      _log('debug', `chat THINKING model=${data.model || model} thinkingLen=${thinkingBlock.thinking?.length || 0}`);
    }

    _log('debug', `chat RESPONSE model=${data.model || model} tokens=${data.usage?.input_tokens || 0}+${data.usage?.output_tokens || 0} finish=${data.stop_reason}`);

    return {
      content: textBlock?.text || '',
      thinking: thinkingBlock?.thinking || null,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
      model: data.model || model,
      provider: this.provider,
      finishReason: data.stop_reason,
    };
  }

  // =========================================================================
  // Chat Streaming
  // =========================================================================

  /**
   * Stream a messages request. Returns an async iterable that yields
   * { delta, done, usage?, finishReason? } chunks.
   * Thinking deltas are emitted as { thinkingDelta, done: false }.
   */
  async *chatStream(opts) {
    const {
      apiKey,
      model,
      messages,
      maxTokens = 1024,
      temperature = 0.7,
      jsonMode = false,
      system = null,
      timeout = 120000,
      thinking = null,
      effort = null,
    } = opts;

    const thinkingConfig = this._resolveThinking(thinking);
    const isThinking = !!thinkingConfig;

    _log('debug', `chatStream REQUEST model=${model} messages=${messages?.length || 0} thinking=${isThinking ? thinkingConfig.type : 'off'}`);

    const body = {
      model,
      max_tokens: maxTokens,
      messages: this._convertMessages(messages),
      stream: true,
    };

    // When thinking is enabled, temperature must be 1
    if (isThinking) {
      body.temperature = 1;
      body.thinking = thinkingConfig;
    } else {
      body.temperature = temperature;
    }

    if (effort) {
      body.output_config = { effort };
    }

    let systemPrompt = system || '';
    if (jsonMode) {
      const jsonInstruction = 'You must respond with valid JSON only. No markdown, no explanations, just JSON.';
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${jsonInstruction}` : jsonInstruction;
    }
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const res = await makeStreamRequest(
      `${ANTHROPIC_BASE_URL}/messages`,
      { method: 'POST', headers: this._headers(apiKey), timeout },
      body
    );

    let fullContent = '';
    let fullThinking = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let responseModel = model;
    let finishReason = null;

    for await (const event of parseAnthropicSSE(res)) {
      switch (event._event || event.type) {
        case 'message_start':
          if (event.message?.model) responseModel = event.message.model;
          if (event.message?.usage) {
            usage.promptTokens = event.message.usage.input_tokens || 0;
          }
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta') {
            const delta = event.delta.text || '';
            fullContent += delta;
            yield { delta, done: false };
          } else if (event.delta?.type === 'thinking_delta') {
            // Accumulate thinking text but don't yield as main delta
            fullThinking += event.delta.thinking || '';
          }
          // signature_delta events are silently ignored
          break;

        case 'message_delta':
          if (event.usage) {
            usage.completionTokens = event.usage.output_tokens || 0;
            usage.totalTokens = usage.promptTokens + usage.completionTokens;
          }
          if (event.delta?.stop_reason) {
            finishReason = event.delta.stop_reason;
          }
          break;

        case 'message_stop':
          // Final event
          break;
      }
    }

    const finalResult = {
      content: fullContent,
      thinking: fullThinking || null,
      usage,
      model: responseModel,
      provider: this.provider,
      finishReason,
    };

    _log('debug', `chatStream DONE model=${responseModel} tokens=${usage.promptTokens}+${usage.completionTokens} thinking=${fullThinking ? 'yes' : 'no'} finish=${finishReason}`);

    yield { delta: '', done: true, finalResult };
    this._lastStreamResult = finalResult;
  }

  // =========================================================================
  // Vision
  // =========================================================================

  /**
   * Analyze an image with Claude vision.
   * 
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {string} opts.imageData - Base64 data URL or raw base64
   * @param {string} opts.prompt - User prompt
   * @param {number} [opts.maxTokens=1024]
   * @param {number} [opts.temperature=0.3]
   * @returns {Promise<Object>} Same shape as chat()
   */
  async vision(opts) {
    const { apiKey, model, imageData, prompt, maxTokens = 1024, temperature = 0.3, system, timeout = 120000 } = opts;

    _log('debug', `vision REQUEST model=${model} promptLen=${prompt?.length || 0} imageLen=${typeof imageData === 'string' ? imageData.length : 'buffer'}`);

    // Parse image data
    let mediaType = 'image/png';
    let base64Data = imageData;

    if (imageData.startsWith('data:')) {
      const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        mediaType = matches[1];
        base64Data = matches[2];
      }
    }

    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        },
      ],
    }];

    return this.chat({ apiKey, model, messages, maxTokens, temperature, system, timeout });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Resolve the thinking option into an Anthropic API-compatible object.
   *
   * Accepted input shapes:
   *   true                              → { type: 'adaptive' }
   *   { type: 'adaptive' }              → pass-through
   *   { type: 'enabled', budgetTokens } → { type: 'enabled', budget_tokens }
   *   falsy                             → null  (thinking disabled)
   *
   * @param {Object|boolean|null} thinking
   * @returns {Object|null}
   */
  _resolveThinking(thinking) {
    if (!thinking) return null;
    if (thinking === true) return { type: 'adaptive' };
    if (thinking.type === 'adaptive') return { type: 'adaptive' };
    if (thinking.type === 'enabled') {
      const budget = thinking.budgetTokens || thinking.budget_tokens || 10000;
      return { type: 'enabled', budget_tokens: budget };
    }
    _log('warn', `Unknown thinking config, defaulting to adaptive`, { thinking });
    return { type: 'adaptive' };
  }

  /**
   * Convert messages to Anthropic format.
   * Strips out 'system' role messages (those go in the top-level `system` field).
   * Ensures alternating user/assistant pattern.
   */
  _convertMessages(messages) {
    // Filter out system messages (handled separately via the system field)
    const filtered = messages.filter(m => m.role !== 'system');
    
    // Anthropic requires messages to alternate user/assistant
    // and start with a user message
    const result = [];
    for (const msg of filtered) {
      const role = msg.role === 'user' ? 'user' : 'assistant';
      
      // Merge consecutive same-role messages
      if (result.length > 0 && result[result.length - 1].role === role) {
        const last = result[result.length - 1];
        if (typeof last.content === 'string' && typeof msg.content === 'string') {
          last.content += '\n\n' + msg.content;
        } else {
          // Keep as-is for complex content (arrays with images, etc.)
          result.push({ role, content: msg.content });
        }
      } else {
        result.push({ role, content: msg.content });
      }
    }

    // Anthropic API requires at least one user message.
    // Some callers (e.g. unified-bidder) put all content in the system prompt
    // and pass messages: []. Inject a minimal user message so the call succeeds.
    if (result.length === 0) {
      result.push({ role: 'user', content: 'Please respond according to your instructions.' });
    }

    return result;
  }
}

// Singleton
let instance = null;
function getAnthropicAdapter() {
  if (!instance) instance = new AnthropicAdapter();
  return instance;
}

module.exports = { AnthropicAdapter, getAnthropicAdapter, estimateTokens };
