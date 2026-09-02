/**
 * Third-party conversation capture (2026-09-01).
 *
 * The engine is pure, so every provider's wire quirks are pinned
 * against captured-shape fixtures here: ChatGPT's delta-encoded SSE and
 * its legacy full-message frames, Claude's Anthropic-style SSE, Grok's
 * NDJSON token/final frames, Gemini's `)]}'` batchexecute framing. The
 * state machine's one tricky path — a prompt that goes out BEFORE the
 * provider mints a conversation id, then a reply that carries it — is
 * pinned too, because getting it wrong splits one conversation into
 * two archives.
 *
 * Source pins at the end keep the glue honest: the tap attaches only to
 * external-bot tabs, stops before the webContents closes, and the
 * per-bot switch actually persists.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConversationCaptureEngine,
  MAX_CONVERSATION_MESSAGES,
  PROVIDER_SPACES,
  conversationMarkdown,
  conversationTitle,
  conversationIdFromUrl,
  decodeRequest,
  decodeResponse,
  isConversationRequest,
  providerForBotType,
  type CaptureConversation,
} from '../../idw/conversation-capture.js';

const read = (...candidates: string[]): string => {
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`not found: ${candidates.join(', ')}`);
  return readFileSync(found, 'utf8');
};

// ── Provider identity ────────────────────────────────────────────────
describe('providers', () => {
  it('maps every bot preset except custom, and shares the full app\'s Space names', () => {
    expect(providerForBotType('chatgpt')).toBe('ChatGPT');
    expect(providerForBotType('claude')).toBe('Claude');
    expect(providerForBotType('gemini')).toBe('Gemini');
    expect(providerForBotType('grok')).toBe('Grok');
    expect(providerForBotType('perplexity')).toBe('Perplexity');
    expect(providerForBotType('custom')).toBeNull();
    expect(providerForBotType(undefined)).toBeNull();
    // Byte-identical to src/ai-conversation-capture.js AI_SERVICE_CONFIG —
    // both apps must converge on ONE Space per provider.
    expect(PROVIDER_SPACES.ChatGPT.spaceName).toBe('ChatGPT Conversations');
    expect(PROVIDER_SPACES.Claude.spaceName).toBe('Claude Conversations');
    expect(PROVIDER_SPACES.Gemini.spaceName).toBe('Gemini Conversations');
    expect(PROVIDER_SPACES.Grok.spaceName).toBe('Grok Conversations');
  });
});

// ── Which requests are turns ─────────────────────────────────────────
describe('isConversationRequest', () => {
  it('ChatGPT: the backend-api conversation POST, not its housekeeping siblings', () => {
    expect(isConversationRequest('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation', 'POST')).toBe(true);
    expect(isConversationRequest('ChatGPT', 'https://chatgpt.com/backend-api/conversation/init', 'POST')).toBe(false);
    expect(isConversationRequest('ChatGPT', 'https://chatgpt.com/backend-api/conversation/prepare', 'POST')).toBe(false);
    expect(isConversationRequest('ChatGPT', 'https://chatgpt.com/backend-api/conversations?offset=0', 'POST')).toBe(false);
    expect(isConversationRequest('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation', 'GET')).toBe(false);
  });

  it('Claude: only the completion call; Grok/Gemini: their conversation endpoints; telemetry never', () => {
    expect(isConversationRequest('Claude', 'https://claude.ai/api/organizations/o/chat_conversations/ab12cd34-0000-4000-8000-000000000000/completion', 'POST')).toBe(true);
    expect(isConversationRequest('Claude', 'https://claude.ai/api/organizations/o/chat_conversations', 'POST')).toBe(false);
    expect(isConversationRequest('Grok', 'https://grok.com/rest/app-chat/conversations/new', 'POST')).toBe(true);
    expect(isConversationRequest('Gemini', 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=x', 'POST')).toBe(true);
    expect(isConversationRequest('Gemini', 'https://gemini.google.com/_/cspreport', 'POST')).toBe(false);
    expect(isConversationRequest('ChatGPT', 'https://chatgpt.com/ces/v1/telemetry/conversation', 'POST')).toBe(false);
  });
});

// ── Request decoding ─────────────────────────────────────────────────
describe('decodeRequest', () => {
  it('ChatGPT: last user message from content.parts, id from the body', () => {
    const body = JSON.stringify({
      action: 'next',
      conversation_id: '11111111-2222-4333-8444-555555555555',
      model: 'gpt-5',
      messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['Plan my Q3 pipeline'] } }],
    });
    const out = decodeRequest('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation', body);
    expect(out.prompt).toBe('Plan my Q3 pipeline');
    expect(out.externalId).toBe('11111111-2222-4333-8444-555555555555');
    expect(out.model).toBe('gpt-5');
  });

  it('Claude: prompt field + id from the URL', () => {
    const url = 'https://claude.ai/api/organizations/o/chat_conversations/ab12cd34-0000-4000-8000-000000000000/completion';
    const out = decodeRequest('Claude', url, JSON.stringify({ prompt: 'Summarize this', model: 'claude-fable-5' }));
    expect(out.prompt).toBe('Summarize this');
    expect(out.externalId).toBe('ab12cd34-0000-4000-8000-000000000000');
    expect(out.model).toBe('claude-fable-5');
  });

  it('Grok: message field; Gemini: the user text inside f.req, ids excluded', () => {
    expect(decodeRequest('Grok', 'https://grok.com/rest/app-chat/conversations/new', JSON.stringify({ message: 'hello grok' })).prompt).toBe('hello grok');
    const inner = JSON.stringify([['what is a digital twin', 0, null, []], ['en'], ['c_abc123def456', 'r_000', 'rc_111']]);
    const fReq = JSON.stringify([[['XqA3Ic', inner, null, 'generic']]]);
    const form = new URLSearchParams({ 'f.req': fReq, at: 'token' }).toString();
    const out = decodeRequest('Gemini', 'https://gemini.google.com/_/BardChatUi/data/batchexecute', form);
    expect(out.prompt).toBe('what is a digital twin');
    expect(out.externalId).toBe('c_abc123def456');
  });

  it('junk bodies decode to nothing, never throw', () => {
    expect(decodeRequest('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation', '{not json').prompt).toBeNull();
    expect(decodeRequest('Gemini', 'https://gemini.google.com/_/BardChatUi/data/batchexecute', 'f.req=%5B%5B').prompt).toBeNull();
    expect(decodeRequest('Claude', 'https://claude.ai/x', undefined).prompt).toBeNull();
  });
});

// ── Response decoding ────────────────────────────────────────────────
describe('decodeResponse', () => {
  it('ChatGPT delta-encoded stream: joins content parts, reads the conversation id', () => {
    const sse = [
      'data: {"type":"message_stream_complete","conversation_id":"11111111-2222-4333-8444-555555555555"}',
      'data: {"v":"delta_encoding","p":"","o":"","c":0}',
      'data: {"p":"/message/content/parts/0","o":"append","v":"Here is "}',
      'data: {"p":"/message/content/parts/0","o":"append","v":"your plan."}',
      'data: [DONE]',
    ].join('\n');
    const out = decodeResponse('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation', sse);
    expect(out.message).toBe('Here is your plan.');
    expect(out.externalId).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('ChatGPT legacy full-message frames: the longest assistant parts win', () => {
    const sse = [
      'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Hel"]}},"conversation_id":"c-1"}',
      'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Hello there"]}},"conversation_id":"c-1"}',
      'data: [DONE]',
    ].join('\n');
    expect(decodeResponse('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation', sse).message).toBe('Hello there');
  });

  it('Claude SSE: text_delta joins', () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sum"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mary."}}',
      'data: {"type":"message_stop"}',
    ].join('\n');
    const url = 'https://claude.ai/api/organizations/o/chat_conversations/ab12cd34-0000-4000-8000-000000000000/completion';
    const out = decodeResponse('Claude', url, sse);
    expect(out.message).toBe('Summary.');
    expect(out.externalId).toBe('ab12cd34-0000-4000-8000-000000000000');
  });

  it('Grok NDJSON: tokens stream, the final modelResponse.message wins', () => {
    const body = [
      JSON.stringify({ result: { conversation: { conversationId: 'g-9' } } }),
      JSON.stringify({ result: { response: { token: 'Gro' } } }),
      JSON.stringify({ result: { response: { token: 'k says hi' } } }),
      JSON.stringify({ result: { response: { modelResponse: { message: 'Grok says hi.' } } } }),
    ].join('\n');
    const out = decodeResponse('Grok', 'https://grok.com/rest/app-chat/conversations/new', body);
    expect(out.message).toBe('Grok says hi.');
    expect(out.externalId).toBe('g-9');
  });

  it('Gemini batchexecute: the prose string out of the nested frame', () => {
    const inner = JSON.stringify([[
      'c_deadbeef12',
      ['A digital twin is a live, queryable model of an organization that agents and people read and write together.'],
      null,
    ]]);
    const body = ")]}'\n\n123\n" + JSON.stringify([['wrb.fr', 'XqA3Ic', inner, null, null, null, 'generic']]);
    const out = decodeResponse('Gemini', 'https://gemini.google.com/_/BardChatUi/data/batchexecute', body);
    expect(out.message).toContain('digital twin is a live');
    expect(out.externalId).toBe('c_deadbeef12');
  });

  it('nothing decodable → null message (the engine then ignores the turn)', () => {
    expect(decodeResponse('ChatGPT', 'https://chatgpt.com/x', 'data: {"nope":1}\n').message).toBeNull();
    expect(decodeResponse('Gemini', 'https://gemini.google.com/x', ")]}'\n[[]]").message).toBeNull();
  });
});

describe('conversationIdFromUrl', () => {
  it('reads each provider\'s id shape and nothing else', () => {
    expect(conversationIdFromUrl('ChatGPT', 'https://chatgpt.com/backend-api/conversation/11111111-2222-4333-8444-555555555555')).toBe('11111111-2222-4333-8444-555555555555');
    expect(conversationIdFromUrl('Gemini', 'https://gemini.google.com/app/c_1a2b3c4d5e')).toBe('c_1a2b3c4d5e');
    expect(conversationIdFromUrl('ChatGPT', 'https://chatgpt.com/backend-api/f/conversation')).toBeNull();
  });
});

// ── The state machine ────────────────────────────────────────────────
class MemorySink {
  saved: CaptureConversation[] = [];
  private seq = 0;
  async save(conv: CaptureConversation): Promise<string> {
    this.saved.push(structuredClone(conv));
    return conv.savedItemId ?? `item-${++this.seq}`;
  }
}

describe('ConversationCaptureEngine', () => {
  it('pairs a prompt with its reply and saves the transcript in place on every reply', async () => {
    const sink = new MemorySink();
    const engine = new ConversationCaptureEngine(sink, { now: () => 1_700_000_000_000 });
    engine.prompt('ChatGPT', { externalId: 'c-1', prompt: 'first?', model: 'gpt-5' });
    await engine.response('ChatGPT', { externalId: 'c-1', message: 'first answer' });
    engine.prompt('ChatGPT', { externalId: 'c-1', prompt: 'second?', model: null });
    await engine.response('ChatGPT', { externalId: 'c-1', message: 'second answer' });
    expect(sink.saved).toHaveLength(2);
    // Same asset both times — an update, not a second archive.
    expect(sink.saved[1]!.savedItemId).toBe('item-1');
    expect(sink.saved[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(sink.saved[1]!.exchangeCount).toBe(2);
    expect(sink.saved[1]!.model).toBe('gpt-5');
  });

  it('a prompt sent before the provider mints an id joins the conversation the reply names', async () => {
    const sink = new MemorySink();
    const engine = new ConversationCaptureEngine(sink);
    engine.prompt('Claude', { externalId: null, prompt: 'hello', model: null }); // first turn: no id yet
    await engine.response('Claude', { externalId: 'late-id', message: 'hi!' });
    expect(sink.saved).toHaveLength(1);
    expect(sink.saved[0]!.externalId).toBe('late-id');
    expect(sink.saved[0]!.messages).toHaveLength(2); // one conversation, not two
    expect(engine.activeCount).toBe(1);
  });

  it('empty prompts and empty replies are ignored', async () => {
    const sink = new MemorySink();
    const engine = new ConversationCaptureEngine(sink);
    engine.prompt('Grok', { externalId: 'g', prompt: '   ', model: null });
    await engine.response('Grok', { externalId: 'g', message: null });
    expect(sink.saved).toHaveLength(0);
    expect(engine.activeCount).toBe(0);
  });

  it('caps the transcript and forgets idle conversations (their archives stay)', async () => {
    const sink = new MemorySink();
    let clock = 0;
    const engine = new ConversationCaptureEngine(sink, { now: () => clock });
    for (let i = 0; i < MAX_CONVERSATION_MESSAGES + 10; i++) {
      engine.prompt('Gemini', { externalId: 'c_1', prompt: `q${i}`, model: null });
    }
    await engine.response('Gemini', { externalId: 'c_1', message: 'a' });
    expect(sink.saved[0]!.messages.length).toBeLessThanOrEqual(MAX_CONVERSATION_MESSAGES);
    clock = 10 * 60 * 60 * 1000;
    expect(engine.sweep(6 * 60 * 60 * 1000)).toBe(1);
    expect(engine.activeCount).toBe(0);
  });
});

// ── The archived shape ───────────────────────────────────────────────
describe('the archive', () => {
  const conv: CaptureConversation = {
    key: 'ChatGPT:c-1',
    provider: 'ChatGPT',
    externalId: 'c-1',
    model: 'gpt-5',
    startTime: '2026-09-01T10:00:00.000Z',
    lastActivity: 0,
    exchangeCount: 1,
    messages: [
      { role: 'user', content: 'Plan my Q3 pipeline for the InfoBip partnership', timestamp: '2026-09-01T10:00:00.000Z' },
      { role: 'assistant', content: 'Here is a plan.', timestamp: '2026-09-01T10:00:05.000Z' },
    ],
    savedItemId: null,
  };

  it('titles from the first prompt, trimmed to a line', () => {
    expect(conversationTitle(conv)).toBe('Plan my Q3 pipeline for the InfoBip partnership');
    const long = { ...conv, messages: [{ ...conv.messages[0]!, content: 'x'.repeat(200) }] };
    expect(conversationTitle(long).length).toBeLessThanOrEqual(80);
    expect(conversationTitle({ ...conv, messages: [] })).toBe('ChatGPT conversation');
  });

  it('renders the full app\'s markdown shape: header, meta line, You/Provider turns', () => {
    const md = conversationMarkdown(conv);
    expect(md.startsWith('# 💬 ChatGPT Conversation')).toBe(true);
    expect(md).toContain('gpt-5 • 1 exchange •');
    expect(md).toContain('**You** <sub>');
    expect(md).toContain('**ChatGPT** <sub>');
    expect(md).toContain('Here is a plan.');
  });
});

// ── The glue, pinned at the source ───────────────────────────────────
describe('the tap wiring', () => {
  const windowSrc = (): string => read('main-window/window.ts', 'lite/main-window/window.ts');

  it('attaches only after chrome parity and only for external-bot entries', () => {
    const s = windowSrc();
    const parityAt = s.indexOf("attachChromeParity(view.webContents, { partition: tab.partition });");
    const tapAt = s.indexOf('attachConversationTap(view.webContents, entry.botType, tab.id)');
    expect(parityAt).toBeGreaterThan(-1);
    expect(tapAt).toBeGreaterThan(parityAt);
    const block = s.slice(parityAt, tapAt);
    expect(block).toContain("entry.kind !== 'external-bot'");
    expect(block).toContain('entry.archiveConversations === false'); // the per-bot switch
  });

  it('stops the tap before the webContents closes', () => {
    const s = windowSrc();
    const stopAt = s.indexOf('attached.stopConversationTap();');
    const closeAt = s.indexOf('attached.view.webContents.close();');
    expect(stopAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(stopAt);
  });

  it('the per-bot switch persists (store allow-list, kind-gated like botType)', () => {
    const s = read('idw/store.ts', 'lite/idw/store.ts');
    expect(s).toContain("'archiveConversations',");
    expect(s).toContain("(key === 'botType' || key === 'archiveConversations')");
  });

  it('the settings row offers the switch and the memory export for real providers only', () => {
    const s = read('settings/sections/idws.ts', 'lite/settings/sections/idws.ts');
    expect(s).toContain('data-action="archive-toggle"');
    expect(s).toContain('data-action="memory-export"');
    expect(s).toContain("entry.botType === 'custom') return ''");
  });

  it('never retains non-conversation traffic', () => {
    const s = read('idw/conversation-tap.ts', 'lite/idw/conversation-tap.ts');
    const at = s.indexOf("if (!isTurn) return;");
    expect(at).toBeGreaterThan(-1);
    // The retain (pending.set) comes only AFTER the turn check.
    expect(s.indexOf('pending.set(requestId', at)).toBeGreaterThan(at);
  });
});
