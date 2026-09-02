/**
 * Third-party conversation capture — the pure engine (2026-09-01).
 *
 * "Go through all 3rd-party agents (Claude, ChatGPT, Grok, Gemini) and
 * make sure conversations are automatically archived to the Space."
 *
 * The full app has done this since v4 (`src/ai-conversation-capture.js`
 * + a CDP network tap in main.js); Lite never got it. This module is
 * that engine ported to strict TypeScript with the SAME storage
 * contract, so a conversation archived by either app lands in the same
 * "<Provider> Conversations" Space, in the same markdown shape.
 *
 * Two halves, deliberately split:
 *   - THIS file: decoders (what a provider's request/response bytes
 *     mean) and the conversation state machine (prompts pair with
 *     replies; a reply saves). Pure — no Electron, no graph — so every
 *     provider quirk is unit-tested against captured fixtures.
 *   - `conversation-tap.ts`: the Electron glue — the DevTools-protocol
 *     network tap on an external-bot tab and the Spaces writes.
 *
 * Why the network, not the DOM: Lite's tab views carry NO preload by
 * design (ADR-038 — third-party pages must never reach window.lite),
 * so the full app's injected fetch interceptor is not an option here.
 * The DevTools protocol observes the same bytes from the main process
 * without giving the page anything.
 *
 * @internal
 */

/** The providers the capture understands. Mirrors the full app's AI_SERVICE_CONFIG. */
export type CaptureProvider = 'ChatGPT' | 'Claude' | 'Gemini' | 'Grok' | 'Perplexity';

/** Per-provider Space identity — byte-identical to the full app's, so both apps share Spaces. */
export const PROVIDER_SPACES: Record<CaptureProvider, { spaceName: string; icon: string; color: string }> = {
  Claude: { icon: '🤖', color: '#ff6b35', spaceName: 'Claude Conversations' },
  ChatGPT: { icon: '💬', color: '#10a37f', spaceName: 'ChatGPT Conversations' },
  Gemini: { icon: '✨', color: '#4285f4', spaceName: 'Gemini Conversations' },
  Perplexity: { icon: '🔍', color: '#8b5cf6', spaceName: 'Perplexity Conversations' },
  Grok: { icon: '🚀', color: '#6b7280', spaceName: 'Grok Conversations' },
};

/** Lite's bot preset id → capture provider. `custom` is never captured. */
export function providerForBotType(botType: string | undefined): CaptureProvider | null {
  switch (botType) {
    case 'chatgpt': return 'ChatGPT';
    case 'claude': return 'Claude';
    case 'gemini': return 'Gemini';
    case 'grok': return 'Grok';
    case 'perplexity': return 'Perplexity';
    default: return null;
  }
}

export const MAX_CONVERSATION_MESSAGES = 200;

export interface CaptureMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface CaptureConversation {
  /** `<Provider>:<externalId>` — the provider's own conversation id when known. */
  key: string;
  provider: CaptureProvider;
  externalId: string | null;
  model: string | null;
  startTime: string;
  lastActivity: number;
  exchangeCount: number;
  messages: CaptureMessage[];
  /** The Space asset this conversation has been written to, once saved. */
  savedItemId: string | null;
}

// ─── Request side: which requests are conversation turns, and the prompt ───

export interface DecodedRequest {
  externalId: string | null;
  prompt: string | null;
  model: string | null;
}

const TELEMETRY = /cspreport|\/csp\/|googletagmanager|google-analytics|\/measurement\/|\/pagead\/|\/ccm\/collect|sentry|telemetry|\/ces\/|statsig|\/rgstr/i;

/**
 * Is this request a conversation turn for the provider? Ported from
 * the full app's per-service URL tests (main.js 14484–14660,
 * preload-external-ai.js).
 */
export function isConversationRequest(provider: CaptureProvider, url: string, method: string): boolean {
  if (method !== 'POST' || TELEMETRY.test(url)) return false;
  switch (provider) {
    case 'ChatGPT':
      return (
        url.includes('/backend-api') &&
        url.includes('/conversation') &&
        !url.includes('/init') &&
        !url.includes('/prepare') &&
        !url.includes('/stream_status') &&
        !url.includes('/textdocs') &&
        !url.includes('conversations?') &&
        !url.includes('/gizmos/') &&
        !url.includes('/autocompletions')
      );
    case 'Claude':
      return url.includes('chat_conversations') && url.includes('/completion');
    case 'Grok':
      return (
        url.includes('/app-chat/conversations/new') ||
        url.includes('/responses') ||
        url.includes('/conversations_v2/')
      );
    case 'Gemini':
      return (
        (url.includes('gemini.google.com') || url.includes('bard.google.com')) &&
        (url.includes('batchexecute') || url.includes('StreamGenerate') || url.includes('/generate') || url.includes('/chat'))
      );
    case 'Perplexity':
      return url.includes('/rest/sse/perplexity_ask') || url.includes('/api/chat');
  }
}

/** Provider conversation id from a URL, when the URL carries one. */
export function conversationIdFromUrl(provider: CaptureProvider, url: string): string | null {
  const patterns: Record<CaptureProvider, RegExp> = {
    Claude: /chat_conversations\/([a-f0-9-]{8,})/i,
    ChatGPT: /\/conversation\/([a-f0-9-]{8,})/i,
    Grok: /conversations\/([a-f0-9-]{8,})/i,
    Gemini: /\/(c_[a-f0-9]{6,})/i,
    Perplexity: /\/([a-f0-9-]{20,})/i,
  };
  const m = url.match(patterns[provider]);
  return m?.[1] ?? null;
}

/** Last user-authored text from a ChatGPT/Claude-style messages array or a flat prompt. */
function promptFromPayload(payload: Record<string, unknown>): string | null {
  const direct = payload['prompt'] ?? payload['message'] ?? payload['query'] ?? payload['text'] ?? payload['input'];
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  const messages = payload['messages'];
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      const author = (msg['author'] as Record<string, unknown> | undefined)?.['role'] ?? msg['role'];
      if (author !== undefined && author !== 'user' && author !== 'human') continue;
      const content = msg['content'];
      if (typeof content === 'string' && content.trim().length > 0) return content;
      const parts = (content as Record<string, unknown> | undefined)?.['parts'];
      if (Array.isArray(parts)) {
        const text = parts.filter((p): p is string => typeof p === 'string').join('\n');
        if (text.trim().length > 0) return text;
      }
      if (Array.isArray(content)) {
        const text = (content as Array<Record<string, unknown>>)
          .filter((b) => b['type'] === 'text')
          .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
          .join('\n');
        if (text.trim().length > 0) return text;
      }
      if (typeof msg['text'] === 'string' && msg['text'].trim().length > 0) return msg['text'];
    }
  }
  return null;
}

/**
 * Gemini posts a `batchexecute` form whose `f.req` is JSON wrapping
 * JSON; the user's text is the first substantial string that is not an
 * id. Same heuristic as the full app.
 */
function geminiPromptFromForm(postData: string): { prompt: string | null; externalId: string | null } {
  try {
    const fReq = new URLSearchParams(postData).get('f.req');
    if (fReq === null) return { prompt: null, externalId: null };
    const outer = JSON.parse(fReq) as unknown;
    const innerJson = Array.isArray(outer) ? (outer[0] as unknown[])?.[0] : null;
    const inner = Array.isArray(innerJson) && typeof innerJson[1] === 'string' ? (JSON.parse(innerJson[1]) as unknown) : innerJson;
    // Two passes on purpose: the prompt is the FIRST prose string, the
    // conversation id can sit anywhere after it — a single early-return
    // walk found the prompt and never saw the id.
    const strings: string[] = [];
    const collect = (node: unknown, depth: number): void => {
      if (depth > 8 || node === null || node === undefined) return;
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) for (const item of node) collect(item, depth + 1);
    };
    collect(inner, 0);
    const isId = (v: string): boolean => /^[a-f0-9-]{30,}$/i.test(v) || /^(c|r|rc)_[a-f0-9]{6,}$/i.test(v);
    const prompt = strings.find((v) => v.length > 0 && v.length < 5000 && !isId(v)) ?? null;
    const externalId = strings.find((v) => /^c_[a-f0-9]{6,}$/i.test(v)) ?? null;
    return { prompt, externalId };
  } catch {
    return { prompt: null, externalId: null };
  }
}

/** Decode a conversation request's body into the user prompt + ids. */
export function decodeRequest(provider: CaptureProvider, url: string, postData: string | undefined): DecodedRequest {
  const fromUrl = conversationIdFromUrl(provider, url);
  if (postData === undefined || postData.length === 0) return { externalId: fromUrl, prompt: null, model: null };
  if (provider === 'Gemini' && (url.includes('batchexecute') || url.includes('StreamGenerate'))) {
    const g = geminiPromptFromForm(postData);
    return { externalId: fromUrl ?? g.externalId, prompt: g.prompt, model: null };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(postData) as Record<string, unknown>;
  } catch {
    return { externalId: fromUrl, prompt: null, model: null };
  }
  const idFromBody =
    (payload['conversation_id'] ?? payload['conversationId'] ?? payload['session_id'] ?? payload['sessionId'] ?? null) as string | null;
  const model = typeof payload['model'] === 'string' ? payload['model'] : null;
  return {
    externalId: fromUrl ?? (typeof idFromBody === 'string' ? idFromBody : null),
    prompt: promptFromPayload(payload),
    model,
  };
}

// ─── Response side: the assistant's text out of the provider's stream ────

export interface DecodedResponse {
  externalId: string | null;
  message: string | null;
}

/** ChatGPT: SSE with either `delta_encoding v1` patches or full message frames. */
function decodeChatGpt(body: string): DecodedResponse {
  let externalId: string | null = null;
  let text = '';
  const isDelta = body.includes('delta_encoding') || body.includes('"v1"');
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]' || data.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed['conversation_id'] === 'string') externalId = parsed['conversation_id'];
    if (isDelta && parsed['v'] !== undefined) {
      const path = typeof parsed['p'] === 'string' ? parsed['p'] : '';
      const op = typeof parsed['o'] === 'string' ? parsed['o'] : '';
      const v = parsed['v'];
      if (v === 'delta_encoding') {
        // The stream's handshake frame, not a token (the fixture caught
        // it landing in the transcript as "delta_encodingHere is…").
        continue;
      }
      if (path.includes('/content/parts') && typeof v === 'string') {
        text += v;
      } else if (path === '' && op === 'append' && typeof v === 'string' && v.length > 0) {
        text += v;
      } else if (typeof v === 'object' && v !== null) {
        const msg = (v as Record<string, unknown>)['message'] as Record<string, unknown> | undefined;
        const parts = (msg?.['content'] as Record<string, unknown> | undefined)?.['parts'];
        if (Array.isArray(parts)) {
          const full = parts.filter((p): p is string => typeof p === 'string').join('');
          if (full.length > text.length) text = full;
        }
        if (typeof msg?.['conversation_id'] === 'string') externalId = msg['conversation_id'] as string;
      }
      continue;
    }
    const message = parsed['message'] as Record<string, unknown> | undefined;
    const parts = (message?.['content'] as Record<string, unknown> | undefined)?.['parts'];
    if (Array.isArray(parts)) {
      const author = (message?.['author'] as Record<string, unknown> | undefined)?.['role'];
      if (author === undefined || author === 'assistant') {
        const full = parts.filter((p): p is string => typeof p === 'string').join('');
        if (full.length > text.length) text = full;
      }
    }
    const choice = (parsed['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
    const delta = (choice?.['delta'] as Record<string, unknown> | undefined)?.['content'];
    if (typeof delta === 'string') text += delta;
  }
  return { externalId, message: text.length > 0 ? text : null };
}

/** Claude: Anthropic-style SSE — `content_block_delta.text_delta` joins. */
function decodeClaude(body: string): DecodedResponse {
  let text = '';
  let fallback: string | null = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data.length === 0 || data === '[DONE]') continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const delta = ev['delta'] as Record<string, unknown> | undefined;
    if (ev['type'] === 'content_block_delta' && typeof delta?.['text'] === 'string') {
      text += delta['text'] as string;
      continue;
    }
    if (typeof delta?.['text'] === 'string') {
      text += delta['text'] as string;
      continue;
    }
    // Legacy shape: `completion` carries incremental text.
    if (typeof ev['completion'] === 'string') text += ev['completion'] as string;
    const message = ev['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (typeof content === 'string') fallback = content;
    else if (Array.isArray(content)) {
      const joined = (content as Array<Record<string, unknown>>).map((c) => (typeof c['text'] === 'string' ? c['text'] : '')).join('');
      if (joined.length > 0) fallback = joined;
    }
  }
  const message = text.length > 0 ? text : fallback;
  return { externalId: null, message };
}

/** Grok: newline-delimited JSON; tokens stream, a final frame carries the full message. */
function decodeGrok(body: string): DecodedResponse {
  let externalId: string | null = null;
  let text = '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const result = parsed['result'] as Record<string, unknown> | undefined;
    if (result === undefined) continue;
    const conv = result['conversation'] as Record<string, unknown> | undefined;
    if (typeof conv?.['conversationId'] === 'string') externalId = conv['conversationId'] as string;
    const response = result['response'] as Record<string, unknown> | undefined;
    const modelResponse =
      (response?.['modelResponse'] as Record<string, unknown> | undefined) ?? (result['modelResponse'] as Record<string, unknown> | undefined);
    const full = modelResponse?.['message'] ?? response?.['message'];
    if (typeof full === 'string' && full.length > text.length) text = full;
    const token = response?.['token'] ?? result['token'];
    if (typeof token === 'string' && (typeof full !== 'string')) text += token;
  }
  return { externalId, message: text.length > 0 ? text : null };
}

/** Gemini: `)]}'`-prefixed batchexecute JSON; the reply is the longest prose string. */
function decodeGemini(body: string): DecodedResponse {
  let externalId: string | null = null;
  let text = '';
  // SSE-ish frames first (newer endpoints).
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      if (typeof parsed['conversationId'] === 'string') externalId = parsed['conversationId'];
      const candidates = parsed['candidates'];
      if (Array.isArray(candidates)) {
        for (const c of candidates as Array<Record<string, unknown>>) {
          const parts = (c['content'] as Record<string, unknown> | undefined)?.['parts'];
          if (Array.isArray(parts)) for (const p of parts as Array<Record<string, unknown>>) if (typeof p['text'] === 'string') text += p['text'];
        }
      }
      if (typeof parsed['text'] === 'string') text += parsed['text'];
    } catch {
      /* not JSON */
    }
  }
  if (text.length === 0) {
    // batchexecute framing: `)]}'` then length-prefixed chunks of JSON.
    let json = body.startsWith(")]}'") ? body.slice(4).trim() : body.trim();
    // Chunks come as `<len>\n[...]`; strip leading numeric lengths.
    json = json.replace(/^\d+\s*\n/, '');
    const extract = (node: unknown, depth: number): string | null => {
      if (depth > 12 || node === null || node === undefined) return null;
      if (typeof node === 'string') {
        if (/^c_[a-f0-9]{6,}$/i.test(node)) externalId = externalId ?? node;
        if (node.startsWith('[') || node.startsWith('{')) {
          try {
            return extract(JSON.parse(node) as unknown, depth + 1);
          } catch {
            return null;
          }
        }
        return node.length > 50 ? node : null;
      }
      if (Array.isArray(node)) {
        let best: string | null = null;
        for (const item of node) {
          const found = extract(item, depth + 1);
          if (found !== null && (best === null || found.length > best.length)) best = found;
        }
        return best;
      }
      if (typeof node === 'object') {
        const rec = node as Record<string, unknown>;
        if (typeof rec['message'] === 'string') return rec['message'];
        let best: string | null = null;
        for (const value of Object.values(rec)) {
          const found = extract(value, depth + 1);
          if (found !== null && (best === null || found.length > best.length)) best = found;
        }
        return best;
      }
      return null;
    };
    try {
      const found = extract(JSON.parse(json) as unknown, 0);
      if (found !== null) text = found;
    } catch {
      /* unparseable frame */
    }
  }
  return { externalId, message: text.length > 0 ? text : null };
}

/** Perplexity: SSE frames with `answer` text (best-effort; least-used lane). */
function decodePerplexity(body: string): DecodedResponse {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
      const answer = parsed['answer'] ?? parsed['text'];
      if (typeof answer === 'string' && answer.length > text.length) text = answer;
    } catch {
      /* skip */
    }
  }
  return { externalId: null, message: text.length > 0 ? text : null };
}

/** Decode a finished conversation response body into the assistant's text. */
export function decodeResponse(provider: CaptureProvider, url: string, body: string): DecodedResponse {
  const decoded =
    provider === 'ChatGPT' ? decodeChatGpt(body)
    : provider === 'Claude' ? decodeClaude(body)
    : provider === 'Grok' ? decodeGrok(body)
    : provider === 'Gemini' ? decodeGemini(body)
    : decodePerplexity(body);
  return { externalId: decoded.externalId ?? conversationIdFromUrl(provider, url), message: decoded.message };
}

// ─── The state machine ────────────────────────────────────────────────

/** Sink the engine writes through — the tap supplies the Spaces-backed one. */
export interface ConversationSink {
  save(conversation: CaptureConversation): Promise<string | null>;
}

/**
 * Prompts pair with the next reply on the same provider (or the same
 * external conversation id when the provider exposes one); each reply
 * saves — the archive is always the latest full transcript, updated in
 * place. Ported from the full app's ConversationCapture.
 */
export class ConversationCaptureEngine {
  private readonly active = new Map<string, CaptureConversation>();
  private readonly now: () => number;

  constructor(
    private readonly sink: ConversationSink,
    opts: { now?: () => number } = {}
  ) {
    this.now = opts.now ?? ((): number => Date.now());
  }

  private keyFor(provider: CaptureProvider, externalId: string | null): string {
    return externalId !== null ? `${provider}:${externalId}` : provider;
  }

  private fresh(provider: CaptureProvider, externalId: string | null, model: string | null): CaptureConversation {
    return {
      key: this.keyFor(provider, externalId),
      provider,
      externalId,
      model,
      startTime: new Date(this.now()).toISOString(),
      lastActivity: this.now(),
      exchangeCount: 0,
      messages: [],
      savedItemId: null,
    };
  }

  /** A user turn went out. */
  prompt(provider: CaptureProvider, req: DecodedRequest): void {
    if (req.prompt === null || req.prompt.trim().length === 0) return;
    const key = this.keyFor(provider, req.externalId);
    let conv = this.active.get(key);
    if (conv === undefined) {
      // A prompt with no id yet may belong to the provider-level pending
      // conversation (first turn before the provider mints an id).
      const pending = req.externalId !== null ? this.active.get(provider) : undefined;
      if (pending !== undefined) {
        this.active.delete(provider);
        pending.key = key;
        pending.externalId = req.externalId;
        conv = pending;
      } else {
        conv = this.fresh(provider, req.externalId, req.model);
      }
      this.active.set(key, conv);
    }
    if (req.model !== null && conv.model === null) conv.model = req.model;
    conv.messages.push({ role: 'user', content: req.prompt, timestamp: new Date(this.now()).toISOString() });
    if (conv.messages.length > MAX_CONVERSATION_MESSAGES) conv.messages = conv.messages.slice(-MAX_CONVERSATION_MESSAGES);
    conv.lastActivity = this.now();
  }

  /** The assistant replied — pair it and save the transcript. */
  async response(provider: CaptureProvider, res: DecodedResponse): Promise<void> {
    if (res.message === null || res.message.trim().length === 0) return;
    const key = this.keyFor(provider, res.externalId);
    let conv = this.active.get(key);
    if (conv === undefined && res.externalId !== null) {
      // The prompt went out before the provider minted an id.
      const pending = this.active.get(provider);
      if (pending !== undefined) {
        this.active.delete(provider);
        pending.key = key;
        pending.externalId = res.externalId;
        conv = pending;
        this.active.set(key, conv);
      }
    }
    if (conv === undefined) {
      conv = this.fresh(provider, res.externalId, null);
      this.active.set(key, conv);
    }
    conv.messages.push({ role: 'assistant', content: res.message, timestamp: new Date(this.now()).toISOString() });
    if (conv.messages.length > MAX_CONVERSATION_MESSAGES) conv.messages = conv.messages.slice(-MAX_CONVERSATION_MESSAGES);
    conv.exchangeCount += 1;
    conv.lastActivity = this.now();
    const saved = await this.sink.save(conv);
    if (saved !== null) conv.savedItemId = saved;
  }

  /** Conversations idle longer than `ttlMs` are forgotten (their archive stays). */
  sweep(ttlMs: number): number {
    let dropped = 0;
    for (const [key, conv] of this.active) {
      if (this.now() - conv.lastActivity > ttlMs) {
        this.active.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** @internal — tests. */
  get activeCount(): number {
    return this.active.size;
  }
}

// ─── The archived shape ───────────────────────────────────────────────

/** Title the archive carries: first prompt, trimmed to a line. */
export function conversationTitle(conv: CaptureConversation): string {
  const first = conv.messages.find((m) => m.role === 'user')?.content ?? '';
  const line = first.replace(/\s+/g, ' ').trim();
  const head = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return head.length > 0 ? head : `${conv.provider} conversation`;
}

/**
 * The markdown body — the SAME shape the full app writes
 * (`_formatConversationMarkdown`), so a transcript reads identically
 * whichever app archived it.
 */
export function conversationMarkdown(conv: CaptureConversation): string {
  const cfg = PROVIDER_SPACES[conv.provider];
  const lines: string[] = [];
  lines.push(`# ${cfg.icon} ${conv.provider} Conversation`, '');
  const meta: string[] = [];
  if (conv.model !== null) meta.push(conv.model);
  meta.push(`${conv.exchangeCount} ${conv.exchangeCount === 1 ? 'exchange' : 'exchanges'}`);
  meta.push(new Date(conv.startTime).toLocaleDateString());
  lines.push(`*${meta.join(' • ')}*`, '', '---', '');
  for (const msg of conv.messages) {
    const t = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lines.push(`**${msg.role === 'user' ? 'You' : conv.provider}** <sub>${t}</sub>`, msg.content, '');
  }
  return lines.join('\n').trim();
}
