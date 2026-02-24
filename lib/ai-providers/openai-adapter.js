/**
 * OpenAI Provider Adapter
 *
 * Handles all OpenAI API communication: chat completions, streaming,
 * JSON mode, vision, embeddings, transcription (Whisper), TTS,
 * and realtime WebSocket.
 *
 * Part of the centralized AI service layer.
 * Consumers should NOT use this directly — use lib/ai-service.js instead.
 *
 * @module ai-providers/openai-adapter
 */

const https = require('https');
const { URL } = require('url');
const { getLogQueue } = require('../log-event-queue');
const _logQueue = getLogQueue();

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

// Debug logging (controlled by AI_LOG_LEVEL env var)
const _LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };
const _AI_LOG = _LOG_LEVELS[process.env.AI_LOG_LEVEL || 'debug'] ?? _LOG_LEVELS.debug;
function _log(level, msg, data) {
  if (_LOG_LEVELS[level] < _AI_LOG) return;
  const logFn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  const logData = data !== undefined ? (typeof data === 'object' ? data : { value: data }) : undefined;
  _logQueue[logFn]('api', `[OpenAI] ${msg}`, logData);
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
 * Parse an SSE stream from a readable response
 * Yields parsed JSON objects from `data:` lines.
 */
async function* parseSSEStream(response) {
  let buffer = '';
  for await (const chunk of response) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'data: [DONE]') return;
      if (trimmed.startsWith('data: ')) {
        try {
          yield JSON.parse(trimmed.slice(6));
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}

/**
 * Make an HTTPS request and return the full response body as parsed JSON.
 * Also returns statusCode and headers for error handling.
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
      res.on('data', (chunk) => {
        data += chunk;
      });
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
        res.on('data', (c) => {
          errBody += c;
        });
        res.on('end', () => {
          const err = new Error(`OpenAI API error: ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.responseBody = errBody;
          // Extract Retry-After header for 429s
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
// OpenAI Adapter
// ---------------------------------------------------------------------------

class OpenAIAdapter {
  constructor() {
    this.provider = 'openai';
  }

  /**
   * Build standard headers for OpenAI API requests.
   */
  _headers(apiKey, extra = {}) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extra,
    };
  }

  // =========================================================================
  // Chat Completion (batch)
  // =========================================================================

  /**
   * Send a chat completion request and return the full response.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey - OpenAI API key
   * @param {string} opts.model - Model name (e.g. 'gpt-4o-mini')
   * @param {Array}  opts.messages - Chat messages array
   * @param {number} [opts.maxTokens=1024] - Max response tokens
   * @param {number} [opts.temperature=0.7] - Sampling temperature
   * @param {boolean} [opts.jsonMode=false] - Use JSON response format
   * @param {string} [opts.system] - System message (prepended to messages)
   * @param {number} [opts.timeout=120000] - Request timeout in ms
   * @returns {Promise<Object>} { content, usage: { promptTokens, completionTokens, totalTokens }, model, provider }
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
    } = opts;

    _log(
      'debug',
      `chat REQUEST model=${model} messages=${messages?.length || 0} maxTokens=${maxTokens} jsonMode=${jsonMode}`
    );

    const body = {
      model,
      messages: this._buildMessages(messages, system),
      max_tokens: maxTokens,
      temperature,
    };

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await makeRequest(
      `${OPENAI_BASE_URL}/chat/completions`,
      { method: 'POST', headers: this._headers(apiKey), timeout },
      body
    );

    if (res.statusCode >= 400) {
      _log('error', `chat FAILED status=${res.statusCode} model=${model}`);
      const err = new Error(`OpenAI API error: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.responseBody = res.body;
      if (res.headers['retry-after']) {
        err.retryAfter = parseInt(res.headers['retry-after'], 10);
      }
      throw err;
    }

    const data = JSON.parse(res.body);
    const choice = data.choices?.[0];

    _log(
      'debug',
      `chat RESPONSE model=${data.model || model} tokens=${data.usage?.prompt_tokens || 0}+${data.usage?.completion_tokens || 0} finish=${choice?.finish_reason}`
    );

    return {
      content: choice?.message?.content || '',
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
      model: data.model || model,
      provider: this.provider,
      finishReason: choice?.finish_reason,
    };
  }

  // =========================================================================
  // Chat Streaming
  // =========================================================================

  /**
   * Stream a chat completion. Returns an async iterable that yields
   * { delta, done, usage?, finishReason? } chunks.
   *
   * After iteration completes, the returned object has a `finalResult`
   * property with { content, usage, model, provider }.
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
    } = opts;

    _log('debug', `chatStream REQUEST model=${model} messages=${messages?.length || 0}`);

    const body = {
      model,
      messages: this._buildMessages(messages, system),
      max_tokens: maxTokens,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await makeStreamRequest(
      `${OPENAI_BASE_URL}/chat/completions`,
      { method: 'POST', headers: this._headers(apiKey), timeout },
      body
    );

    let fullContent = '';
    let chunkCount = 0;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let responseModel = model;
    let finishReason = null;

    for await (const event of parseSSEStream(res)) {
      // Usage comes in the final chunk when stream_options.include_usage is true
      if (event.usage) {
        usage = {
          promptTokens: event.usage.prompt_tokens || 0,
          completionTokens: event.usage.completion_tokens || 0,
          totalTokens: event.usage.total_tokens || 0,
        };
      }

      if (event.model) {
        responseModel = event.model;
      }

      const delta = event.choices?.[0]?.delta?.content || '';
      const reason = event.choices?.[0]?.finish_reason;

      if (reason) finishReason = reason;

      if (delta) {
        fullContent += delta;
        chunkCount++;
        yield { delta, done: false };
      }
    }

    _log(
      'debug',
      `chatStream DONE model=${responseModel} chunks=${chunkCount} tokens=${usage.promptTokens}+${usage.completionTokens} finish=${finishReason}`
    );

    // Yield final chunk with aggregated data
    const finalResult = {
      content: fullContent,
      usage,
      model: responseModel,
      provider: this.provider,
      finishReason,
    };

    yield { delta: '', done: true, finalResult };

    // Attach finalResult to the generator for callers that need it
    this._lastStreamResult = finalResult;
  }

  // =========================================================================
  // Vision
  // =========================================================================

  /**
   * Analyze an image with a vision-capable model.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model - e.g. 'gpt-4o'
   * @param {string} opts.imageData - Base64 data URL or raw base64
   * @param {string} opts.prompt - User prompt for analysis
   * @param {number} [opts.maxTokens=1024]
   * @param {number} [opts.temperature=0.3]
   * @returns {Promise<Object>} Same shape as chat()
   */
  async vision(opts) {
    const { apiKey, model, imageData, prompt, maxTokens = 1024, temperature = 0.3, timeout = 120000 } = opts;

    _log('debug', `vision REQUEST model=${model} promptLen=${prompt?.length || 0} imageLen=${imageData?.length || 0}`);

    // Build image URL
    let imageUrl;
    if (imageData.startsWith('data:')) {
      imageUrl = imageData;
    } else {
      // Assume raw base64, default to png
      imageUrl = `data:image/png;base64,${imageData}`;
    }

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];

    return this.chat({ apiKey, model, messages, maxTokens, temperature, timeout });
  }

  // =========================================================================
  // Embeddings
  // =========================================================================

  /**
   * Generate embeddings for input text.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model - e.g. 'text-embedding-3-small'
   * @param {string|string[]} opts.input - Text(s) to embed
   * @returns {Promise<Object>} { embeddings: number[][], usage: { promptTokens, totalTokens }, model, provider }
   */
  async embed(opts) {
    const { apiKey, model, input, timeout = 60000 } = opts;
    const inputCount = Array.isArray(input) ? input.length : 1;

    _log('debug', `embed REQUEST model=${model} inputCount=${inputCount}`);

    const res = await makeRequest(
      `${OPENAI_BASE_URL}/embeddings`,
      { method: 'POST', headers: this._headers(apiKey), timeout },
      { model, input }
    );

    if (res.statusCode >= 400) {
      _log('error', `embed FAILED status=${res.statusCode}`);
      const err = new Error(`OpenAI Embeddings error: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.responseBody = res.body;
      throw err;
    }

    const data = JSON.parse(res.body);

    _log(
      'debug',
      `embed RESPONSE model=${data.model || model} vectors=${data.data?.length || 0} tokens=${data.usage?.prompt_tokens || 0}`
    );

    return {
      embeddings: data.data.map((d) => d.embedding),
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
      model: data.model || model,
      provider: this.provider,
    };
  }

  // =========================================================================
  // Transcription (Whisper)
  // =========================================================================

  /**
   * Transcribe audio using Whisper.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model - e.g. 'whisper-1'
   * @param {Buffer} opts.audioBuffer - Audio file buffer
   * @param {string} [opts.filename='audio.webm'] - Filename hint
   * @param {string} [opts.language] - ISO language code
   * @param {string} [opts.responseFormat='json'] - 'json', 'verbose_json', 'text', 'srt', 'vtt'
   * @param {string[]} [opts.timestampGranularities] - e.g. ['word'] or ['word', 'segment']
   * @returns {Promise<Object>} { text, duration?, language?, words?, segments?, model, provider }
   *   When responseFormat='verbose_json', the full response is returned including words and segments.
   */
  async transcribe(opts) {
    const {
      apiKey,
      model = 'whisper-1',
      audioBuffer,
      filename = 'audio.webm',
      language,
      responseFormat = 'json',
      timestampGranularities,
      timeout = 120000,
    } = opts;

    const bufSize = audioBuffer?.length || audioBuffer?.byteLength || 0;
    _log(
      'debug',
      `transcribe REQUEST model=${model} fileSize=${(bufSize / 1024).toFixed(1)}KB lang=${language || 'auto'} format=${responseFormat} granularities=${timestampGranularities?.join(',') || 'none'}`
    );

    // Whisper uses multipart/form-data
    const boundary = `----AIServiceBoundary${Date.now()}`;

    // Determine MIME type from filename
    const mimeType = filename.endsWith('.mp3')
      ? 'audio/mpeg'
      : filename.endsWith('.wav')
        ? 'audio/wav'
        : filename.endsWith('.m4a')
          ? 'audio/m4a'
          : 'audio/webm';

    // Build multipart form parts
    const formParts = [];
    formParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`));
    formParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      )
    );
    formParts.push(audioBuffer);
    formParts.push(Buffer.from(`\r\n`));
    if (language) {
      formParts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`)
      );
    }
    formParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\n${responseFormat}\r\n`
      )
    );

    // Add timestamp granularities (e.g. ['word'] for word-level timestamps)
    if (timestampGranularities && Array.isArray(timestampGranularities)) {
      for (const granularity of timestampGranularities) {
        formParts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\n${granularity}\r\n`
          )
        );
      }
    }

    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const bodyBuffer = Buffer.concat(formParts);

    const res = await makeRequest(
      `${OPENAI_BASE_URL}/audio/transcriptions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuffer.length.toString(),
        },
        timeout,
      },
      bodyBuffer
    );

    if (res.statusCode >= 400) {
      _log('error', `transcribe FAILED status=${res.statusCode}`);
      const err = new Error(`OpenAI Transcription error: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.responseBody = res.body;
      throw err;
    }

    // For JSON-based formats, parse and return structured data
    if (responseFormat === 'json' || responseFormat === 'verbose_json') {
      const data = JSON.parse(res.body);
      _log(
        'debug',
        `transcribe RESPONSE textLen=${(data.text || '').length} duration=${data.duration || 0}s words=${data.words?.length || 0} segments=${data.segments?.length || 0}`
      );

      return {
        text: data.text || '',
        duration: data.duration,
        language: data.language,
        // verbose_json includes word-level and segment-level data
        words: data.words || undefined,
        segments: data.segments || undefined,
        model,
        provider: this.provider,
      };
    }

    // For non-JSON formats (text, srt, vtt), return raw text
    _log('debug', `transcribe RESPONSE format=${responseFormat} textLen=${res.body?.length || 0}`);
    return {
      text: res.body,
      model,
      provider: this.provider,
    };
  }

  // =========================================================================
  // TTS (Text-to-Speech)
  // =========================================================================

  /**
   * Generate speech audio from text.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.model='tts-1']
   * @param {string} opts.input - Text to speak
   * @param {string} [opts.voice='alloy'] - Voice name
   * @param {string} [opts.responseFormat='mp3']
   * @returns {Promise<Object>} { audioBuffer, model, provider }
   */
  async tts(opts) {
    const {
      apiKey,
      model = 'tts-1',
      input,
      voice = 'alloy',
      responseFormat = 'mp3',
      speed,
      instructions,
      timeout = 60000,
    } = opts;

    _log(
      'debug',
      `tts REQUEST model=${model} voice=${voice} inputLen=${input?.length || 0} format=${responseFormat} speed=${speed || 'default'}`
    );

    const parsedUrl = new URL(`${OPENAI_BASE_URL}/audio/speech`);

    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: this._headers(apiKey),
      };

      const req = https.request(reqOpts, (res) => {
        if (res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (c) => {
            errBody += c;
          });
          res.on('end', () => {
            const err = new Error(`OpenAI TTS error: ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.responseBody = errBody;
            reject(err);
          });
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const audioBuffer = Buffer.concat(chunks);
          _log('debug', `tts RESPONSE audioSize=${(audioBuffer.length / 1024).toFixed(1)}KB`);
          resolve({
            audioBuffer,
            model,
            provider: this.provider,
          });
        });
      });

      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('TTS request timed out')));
      const body = { model, input, voice, response_format: responseFormat };
      if (speed != null) body.speed = speed;
      if (instructions) body.instructions = instructions;
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // =========================================================================
  // Realtime WebSocket
  // =========================================================================

  /**
   * Create a realtime WebSocket session for voice/audio streaming.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.model='gpt-4o-realtime-preview']
   * @param {Function} opts.onMessage - Called with parsed server events
   * @param {Function} [opts.onError] - Called on errors
   * @param {Function} [opts.onClose] - Called on close
   * @returns {Object} Session object with send(), close()
   */
  createRealtimeSession(opts) {
    const { apiKey, model = 'gpt-4o-realtime-preview', onMessage, onError, onClose } = opts;

    // Lazy-load ws module (it's a dependency via other packages)
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch {
      throw new Error('WebSocket module (ws) is required for realtime API. Install with: npm install ws');
    }

    const url = `${OPENAI_REALTIME_URL}?model=${model}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    const session = {
      ws,
      model,
      provider: 'openai',
      connected: false,

      send(event) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(typeof event === 'string' ? event : JSON.stringify(event));
        }
      },

      close() {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    };

    ws.on('open', () => {
      session.connected = true;
      _log('info', `realtime CONNECTED model=${model}`);
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (onMessage) onMessage(event);
      } catch {
        // skip malformed messages
      }
    });

    ws.on('error', (err) => {
      _log('error', `realtime ERROR: ${err.message}`);
      if (onError) onError(err);
    });

    ws.on('close', (code, reason) => {
      session.connected = false;
      _log('info', `realtime CLOSED code=${code} reason=${reason?.toString() || 'none'}`);
      if (onClose) onClose(code, reason?.toString());
    });

    return session;
  }

  // =========================================================================
  // Image Edit (DALL-E / gpt-image-1)
  // =========================================================================

  /**
   * Edit an image using OpenAI's image edit API.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {Buffer} opts.imageBuffer - Image file buffer (PNG preferred)
   * @param {string} opts.prompt - Edit instructions
   * @param {string} [opts.model='gpt-image-1'] - Model to use
   * @param {string} [opts.size='1024x1024'] - Output size
   * @param {number} [opts.n=1] - Number of images to generate
   * @param {number} [opts.timeout=120000] - Request timeout in ms
   * @returns {Promise<Object>} { images: Array<{b64_json?, url?}>, model, provider }
   */
  async imageEdit(opts) {
    const { apiKey, imageBuffer, prompt, model = 'gpt-image-1', size = '1024x1024', n = 1, timeout = 120000 } = opts;

    _log(
      'debug',
      `imageEdit REQUEST model=${model} size=${size} n=${n} imageSize=${(imageBuffer?.length / 1024).toFixed(1)}KB`
    );

    // Build multipart form data
    const boundary = `----AIServiceBoundary${Date.now()}`;
    const formParts = [];

    // Image file
    formParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
        'utf-8'
      )
    );
    formParts.push(imageBuffer);
    formParts.push(Buffer.from('\r\n', 'utf-8'));

    // Prompt
    formParts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`, 'utf-8')
    );

    // Model
    formParts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`, 'utf-8')
    );

    // Size
    formParts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${size}\r\n`, 'utf-8')
    );

    // N
    formParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n${n}\r\n`, 'utf-8'));

    // Closing boundary
    formParts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));

    const bodyBuffer = Buffer.concat(formParts);

    const res = await makeRequest(
      `${OPENAI_BASE_URL}/images/edits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuffer.length.toString(),
        },
        timeout,
      },
      bodyBuffer
    );

    if (res.statusCode >= 400) {
      _log('error', `imageEdit FAILED status=${res.statusCode}`);
      const err = new Error(`OpenAI Image Edit error: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.responseBody = res.body;
      throw err;
    }

    const data = JSON.parse(res.body);
    _log('debug', `imageEdit RESPONSE images=${data.data?.length || 0}`);

    return {
      images: data.data || [],
      model,
      provider: this.provider,
    };
  }

  // =========================================================================
  // Image Generation (DALL-E)
  // =========================================================================

  /**
   * Generate images using OpenAI's DALL-E API.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.prompt - Image generation prompt
   * @param {string} [opts.model='dall-e-3'] - Model to use
   * @param {number} [opts.n=1] - Number of images
   * @param {string} [opts.size='1024x1024'] - Image size
   * @param {string} [opts.quality='standard'] - Quality: 'standard' or 'hd'
   * @param {string} [opts.responseFormat='b64_json'] - 'b64_json' or 'url'
   * @param {number} [opts.timeout=120000] - Request timeout in ms
   * @returns {Promise<Object>} { images: [{b64_json?, url?, revised_prompt?}], model, provider }
   */
  async imageGenerate(opts) {
    const {
      apiKey,
      prompt,
      model = 'dall-e-3',
      n = 1,
      size = '1024x1024',
      quality = 'standard',
      responseFormat = 'b64_json',
      timeout = 120000,
    } = opts;

    _log(
      'debug',
      `imageGenerate REQUEST model=${model} n=${n} size=${size} quality=${quality} promptLen=${prompt?.length || 0}`
    );

    const body = {
      model,
      prompt,
      n,
      size,
      quality,
      response_format: responseFormat,
    };

    const res = await makeRequest(
      `${OPENAI_BASE_URL}/images/generations`,
      { method: 'POST', headers: this._headers(apiKey), timeout },
      body
    );

    if (res.statusCode >= 400) {
      _log('error', `imageGenerate FAILED status=${res.statusCode}`);
      const err = new Error(`OpenAI Image Generation error: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.responseBody = res.body;
      // Parse specific error message if available
      try {
        const errorData = JSON.parse(res.body);
        if (errorData.error?.message) {
          err.message = errorData.error.message;
        }
      } catch {
        /* keep generic message */
      }
      if (res.headers['retry-after']) {
        err.retryAfter = parseInt(res.headers['retry-after'], 10);
      }
      throw err;
    }

    const data = JSON.parse(res.body);
    _log('debug', `imageGenerate RESPONSE images=${data.data?.length || 0}`);

    return {
      images: (data.data || []).map((img) => ({
        b64_json: img.b64_json || undefined,
        url: img.url || undefined,
        revised_prompt: img.revised_prompt || undefined,
      })),
      model,
      provider: this.provider,
    };
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Build the messages array, optionally prepending a system message.
   */
  _buildMessages(messages, system) {
    if (!system) return messages;
    return [{ role: 'system', content: system }, ...messages];
  }
}

// Singleton
let instance = null;
function getOpenAIAdapter() {
  if (!instance) instance = new OpenAIAdapter();
  return instance;
}

module.exports = { OpenAIAdapter, getOpenAIAdapter, estimateTokens };
