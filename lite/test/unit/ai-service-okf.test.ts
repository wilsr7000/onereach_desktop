/**
 * AiService.convertToOkf unit tests — the service-level OKF path:
 * Claude-only gating, input validation, the URL fetch + SSRF guard, and
 * the text passthrough. The Claude call + fetch are both stubbed, so
 * these run offline.
 */

import { describe, it, expect } from 'vitest';
import { AiService } from '../../ai/service.js';
import { AiError } from '../../ai/errors.js';
import type { ClaudeConfig } from '../../ai/config.js';

const CLAUDE_CFG: ClaudeConfig = {
  provider: 'claude',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-4-8',
  baseUrl: 'https://api.anthropic.com',
};

const OKF_JSON =
  '{"okf":"name: Bot\\ntype: conversational","agentType":"conversational","name":"Bot"}';

/** Build a Response-like object for the fetch stub. */
function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: async () => body } as unknown as Response;
}

function makeService(opts: {
  config?: ClaudeConfig | null;
  fetchImpl?: typeof fetch;
  okfReply?: string;
} = {}): AiService {
  const config = opts.config === undefined ? CLAUDE_CFG : opts.config;
  return new AiService({
    loadConfig: () => config,
    fetchImpl:
      opts.fetchImpl ??
      ((() => {
        throw new Error('fetch should not be called in this test');
      }) as unknown as typeof fetch),
    accountId: () => null,
    makeClaudeMessageCreator: () => async () => ({
      content: [{ type: 'text', text: opts.okfReply ?? OKF_JSON }],
    }),
  });
}

describe('AiService.convertToOkf — gating + validation', () => {
  it('throws AI_NOT_CONFIGURED when no provider is configured', async () => {
    await expect(
      makeService({ config: null }).convertToOkf({ source: 'def', isUrl: false })
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });

  it('throws AI_NOT_CONFIGURED when the provider is not Claude', async () => {
    const flow = { provider: 'onereach-flow', url: 'https://x' } as unknown as ClaudeConfig;
    await expect(
      makeService({ config: flow }).convertToOkf({ source: 'def', isUrl: false })
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });

  it('throws AI_INVALID_INPUT on empty source', async () => {
    await expect(
      makeService().convertToOkf({ source: '   ', isUrl: false })
    ).rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
  });
});

describe('AiService.convertToOkf — text path', () => {
  it('converts pasted text without any fetch', async () => {
    const r = await makeService().convertToOkf({ source: 'rough agent notes', isUrl: false });
    expect(r.agentType).toBe('conversational');
    expect(r.name).toBe('Bot');
    expect(r.okf).toContain('name: Bot');
  });
});

describe('AiService.convertToOkf — URL path + SSRF guard', () => {
  it('fetches an https URL then converts its contents', async () => {
    let fetched: string | null = null;
    const fetchImpl = (async (url: string) => {
      fetched = String(url);
      return fakeResponse('agent definition from the web');
    }) as unknown as typeof fetch;
    const r = await makeService({ fetchImpl }).convertToOkf({
      source: 'https://example.com/agent.okf',
      isUrl: true,
    });
    expect(fetched).toBe('https://example.com/agent.okf');
    expect(r.agentType).toBe('conversational');
  });

  it('rejects non-https URLs (and never fetches)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return fakeResponse('x');
    }) as unknown as typeof fetch;
    await expect(
      makeService({ fetchImpl }).convertToOkf({ source: 'http://example.com', isUrl: true })
    ).rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
    expect(called).toBe(false);
  });

  it('blocks localhost / private / metadata hosts (SSRF) and never fetches', async () => {
    const blocked = [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://foo.local/x',
    ];
    for (const url of blocked) {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return fakeResponse('x');
      }) as unknown as typeof fetch;
      await expect(
        makeService({ fetchImpl }).convertToOkf({ source: url, isUrl: true }),
        url
      ).rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
      expect(called, url).toBe(false);
    }
  });

  it('rejects a malformed URL', async () => {
    await expect(
      makeService().convertToOkf({ source: 'not a url', isUrl: true })
    ).rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
  });

  it('surfaces a non-OK fetch as a provider error', async () => {
    const fetchImpl = (async () => fakeResponse('nope', false, 404)) as unknown as typeof fetch;
    await expect(
      makeService({ fetchImpl }).convertToOkf({ source: 'https://example.com/x', isUrl: true })
    ).rejects.toBeInstanceOf(AiError);
  });
});
