import { describe, it, expect } from 'vitest';
import {
  buildSpaceAssistUserPrompt,
  parseSpaceAssistResult,
  validateSpaceAssistShape,
  extractAssistObject,
  callClaude,
  callOneReachFlow,
  mintFlowAuthHeader,
  type ClaudeMessageCreator,
} from '../../ai/client.js';
import { AiService } from '../../ai/service.js';
import { AiError, AI_ERROR_CODES } from '../../ai/errors.js';
import type { ClaudeConfig, OneReachFlowConfig } from '../../ai/config.js';

const CLAUDE: ClaudeConfig = {
  provider: 'claude',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-4-8',
  baseUrl: 'https://api.anthropic.com',
};

interface StubResult {
  ok: boolean;
  status: number;
  body: string;
}
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Build an injectable fetch stub that records calls. */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => StubResult
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.ok, status: r.status, text: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Fetch stub that always throws (network failure). */
const throwingFetch = (async () => {
  throw new Error('getaddrinfo ENOTFOUND');
}) as unknown as typeof fetch;

/** Fetch that fails the test if it is ever called. */
const noFetch = (async () => {
  throw new Error('fetch should not be called on this path');
}) as unknown as typeof fetch;

function claudeOk(text: string, stopReason = 'end_turn'): ClaudeMessageCreator {
  return async () => ({ content: [{ type: 'text', text }], stop_reason: stopReason });
}
function claudeThrows(err: unknown): ClaudeMessageCreator {
  return async () => {
    throw err;
  };
}
function withStatus(status: number, message = 'err'): Error {
  return Object.assign(new Error(message), { status });
}

function authHeaderOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.['Authorization'];
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject, but it resolved');
}

describe('buildSpaceAssistUserPrompt', () => {
  it('includes the name and purpose', () => {
    const out = buildSpaceAssistUserPrompt({ purpose: 'track vendor risk', name: 'Vendors' });
    expect(out).toContain('Space name: Vendors');
    expect(out).toContain('track vendor risk');
  });
  it('omits the name line when no name is given', () => {
    expect(buildSpaceAssistUserPrompt({ purpose: 'track vendor risk' })).not.toContain('Space name:');
  });
});

describe('parseSpaceAssistResult', () => {
  it('parses plain JSON', () => {
    expect(
      parseSpaceAssistResult(JSON.stringify({ description: 'D', objectives: ['a', 'b', 'c'] }), 'claude')
    ).toEqual({ description: 'D', objectives: ['a', 'b', 'c'] });
  });
  it('parses JSON wrapped in a ```json fence', () => {
    const raw = '```json\n{"description":"D","objectives":["a","b"]}\n```';
    expect(parseSpaceAssistResult(raw, 'claude')).toEqual({ description: 'D', objectives: ['a', 'b'] });
  });
  it('trims fields, drops empty objectives, and caps at 5', () => {
    const r = parseSpaceAssistResult(
      JSON.stringify({ description: '  D  ', objectives: [' a ', '', 'b', 'c', 'd', 'e', 'f'] }),
      'claude'
    );
    expect(r.description).toBe('D');
    expect(r.objectives).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('rejects an empty body', () => {
    expect(() => parseSpaceAssistResult('   ', 'claude')).toThrow(AiError);
  });
  it('rejects non-JSON', () => {
    expect(() => parseSpaceAssistResult('not json at all', 'claude')).toThrow(AiError);
  });
});

describe('validateSpaceAssistShape', () => {
  it('rejects a non-object', () => {
    const e = (() => {
      try {
        validateSpaceAssistShape('nope', 'flow');
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(e).toBeInstanceOf(AiError);
    expect((e as AiError).code).toBe(AI_ERROR_CODES.BAD_RESPONSE);
  });
  it('rejects a missing description', () => {
    expect(() => validateSpaceAssistShape({ objectives: ['a'] }, 'flow')).toThrow(AiError);
  });
  it('rejects when objectives is not an array', () => {
    expect(() => validateSpaceAssistShape({ description: 'D', objectives: 'a' }, 'flow')).toThrow(AiError);
  });
  it('rejects when every objective is blank', () => {
    expect(() => validateSpaceAssistShape({ description: 'D', objectives: ['', '  '] }, 'flow')).toThrow(
      AiError
    );
  });
});

describe('extractAssistObject', () => {
  it('returns a top-level shaped object', () => {
    const o = { description: 'D', objectives: ['a'] };
    expect(extractAssistObject(o)).toBe(o);
  });
  it('digs out a nested object under common wrappers', () => {
    const inner = { description: 'D', objectives: ['a'] };
    expect(extractAssistObject({ value: inner })).toBe(inner);
    expect(extractAssistObject({ data: inner })).toBe(inner);
    expect(extractAssistObject({ result: inner })).toBe(inner);
  });
  it('returns the original when nothing matches', () => {
    const o = { totallyUnrelated: true };
    expect(extractAssistObject(o)).toBe(o);
  });
});

describe('callClaude (SDK seam)', () => {
  it('sends model + system + user prompt and parses the result', async () => {
    let lastParams: Record<string, unknown> | null = null;
    const createMessage: ClaudeMessageCreator = async (params) => {
      lastParams = params as unknown as Record<string, unknown>;
      return {
        content: [
          { type: 'text', text: JSON.stringify({ description: 'Polished', objectives: ['x', 'y', 'z'] }) },
        ],
        stop_reason: 'end_turn',
      };
    };
    const result = await callClaude(
      { purpose: 'p', name: 'N' },
      { model: 'claude-opus-4-8', createMessage }
    );
    expect(result).toEqual({ description: 'Polished', objectives: ['x', 'y', 'z'] });
    expect(lastParams?.['model']).toBe('claude-opus-4-8');
    expect(typeof lastParams?.['system']).toBe('string');
    expect(JSON.stringify(lastParams?.['messages'])).toContain('p');
  });

  it('maps a 401 error -> AUTH_REJECTED', async () => {
    const e = await caught(callClaude({ purpose: 'p' }, { model: 'm', createMessage: claudeThrows(withStatus(401)) }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.AUTH_REJECTED);
  });
  it('maps a 429 error -> RATE_LIMITED', async () => {
    const e = await caught(callClaude({ purpose: 'p' }, { model: 'm', createMessage: claudeThrows(withStatus(429)) }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.RATE_LIMITED);
  });
  it('maps another status -> PROVIDER_ERROR', async () => {
    const e = await caught(callClaude({ purpose: 'p' }, { model: 'm', createMessage: claudeThrows(withStatus(500)) }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.PROVIDER_ERROR);
  });
  it('maps a connection error -> NETWORK', async () => {
    const connErr = Object.assign(new Error('socket hang up'), { name: 'APIConnectionError' });
    const e = await caught(callClaude({ purpose: 'p' }, { model: 'm', createMessage: claudeThrows(connErr) }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.NETWORK);
  });
  it('maps a refusal stop_reason -> PROVIDER_ERROR', async () => {
    const e = await caught(callClaude({ purpose: 'p' }, { model: 'm', createMessage: claudeOk('', 'refusal') }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.PROVIDER_ERROR);
  });
  it('maps non-JSON content -> BAD_RESPONSE', async () => {
    const e = await caught(callClaude({ purpose: 'p' }, { model: 'm', createMessage: claudeOk('not json') }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.BAD_RESPONSE);
  });
});

describe('mintFlowAuthHeader', () => {
  it('mints a FLOW header from the refresh_token flow', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify({ token: 'abc' }) }));
    const header = await mintFlowAuthHeader('acct1', fetchImpl);
    expect(header).toBe('FLOW abc');
    expect(calls[0]!.url).toContain('/http/acct1/refresh_token');
  });
  it('accepts an access_token field', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify({ access_token: 'xyz' }) }));
    expect(await mintFlowAuthHeader('acct1', fetchImpl)).toBe('FLOW xyz');
  });
  it('passes through an already-prefixed token', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify({ token: 'FLOW pre' }) }));
    expect(await mintFlowAuthHeader('acct1', fetchImpl)).toBe('FLOW pre');
  });
  it('maps 401 -> AUTH_REJECTED', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: false, status: 401, body: '' }));
    expect(((await caught(mintFlowAuthHeader('acct1', fetchImpl))) as AiError).code).toBe(
      AI_ERROR_CODES.AUTH_REJECTED
    );
  });
  it('maps a non-JSON body -> BAD_RESPONSE', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: 'oops' }));
    expect(((await caught(mintFlowAuthHeader('acct1', fetchImpl))) as AiError).code).toBe(
      AI_ERROR_CODES.BAD_RESPONSE
    );
  });
  it('maps an empty token -> PROVIDER_ERROR', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify({}) }));
    expect(((await caught(mintFlowAuthHeader('acct1', fetchImpl))) as AiError).code).toBe(
      AI_ERROR_CODES.PROVIDER_ERROR
    );
  });
  it('maps a network failure -> NETWORK', async () => {
    expect(((await caught(mintFlowAuthHeader('acct1', throwingFetch))) as AiError).code).toBe(
      AI_ERROR_CODES.NETWORK
    );
  });
});

describe('callOneReachFlow', () => {
  it('posts the purpose + auth header and accepts a top-level result', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ description: 'D', objectives: ['a', 'b'] }),
    }));
    const result = await callOneReachFlow(
      { purpose: 'p', name: 'N' },
      { url: 'https://flow.example/run', authHeader: 'FLOW tok', fetchImpl }
    );
    expect(result).toEqual({ description: 'D', objectives: ['a', 'b'] });
    expect(calls[0]!.url).toBe('https://flow.example/run');
    expect(authHeaderOf(calls[0]!.init)).toBe('FLOW tok');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ purpose: 'p', name: 'N' });
  });
  it('accepts a result nested under "value"', async () => {
    const { fetchImpl } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ value: { description: 'D', objectives: ['a'] } }),
    }));
    expect(
      await callOneReachFlow({ purpose: 'p' }, { url: 'u', authHeader: 'FLOW t', fetchImpl })
    ).toEqual({ description: 'D', objectives: ['a'] });
  });
  it('maps 403 -> AUTH_REJECTED', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: false, status: 403, body: '' }));
    const e = await caught(callOneReachFlow({ purpose: 'p' }, { url: 'u', authHeader: 'FLOW t', fetchImpl }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.AUTH_REJECTED);
  });
  it('treats a "Token was not accepted" body as AUTH_REJECTED even on 200', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: 'Token was not accepted: wrong keyId' }));
    const e = await caught(callOneReachFlow({ purpose: 'p' }, { url: 'u', authHeader: 'FLOW t', fetchImpl }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.AUTH_REJECTED);
  });
  it('rejects a non-JSON success body -> BAD_RESPONSE', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: '<html>nope</html>' }));
    const e = await caught(callOneReachFlow({ purpose: 'p' }, { url: 'u', authHeader: 'FLOW t', fetchImpl }));
    expect((e as AiError).code).toBe(AI_ERROR_CODES.BAD_RESPONSE);
  });
});

describe('AiService', () => {
  const claudeStub = (): ClaudeMessageCreator =>
    claudeOk(JSON.stringify({ description: 'D', objectives: ['a', 'b', 'c'] }));

  it('reports unconfigured status when no config resolves', async () => {
    const svc = new AiService({ loadConfig: () => null, fetchImpl: noFetch, accountId: () => null });
    await expect(svc.getStatus()).resolves.toEqual({ configured: false, provider: null });
  });

  it('reports the active provider when configured', async () => {
    const svc = new AiService({ loadConfig: () => CLAUDE, fetchImpl: noFetch, accountId: () => null });
    await expect(svc.getStatus()).resolves.toEqual({ configured: true, provider: 'claude' });
  });

  it('throws INVALID_INPUT on a blank purpose', async () => {
    const svc = new AiService({ loadConfig: () => CLAUDE, fetchImpl: noFetch, accountId: () => null });
    expect(((await caught(svc.spaceAssist({ purpose: '   ' }))) as AiError).code).toBe(
      AI_ERROR_CODES.INVALID_INPUT
    );
  });

  it('throws NOT_CONFIGURED when no provider is set', async () => {
    const svc = new AiService({ loadConfig: () => null, fetchImpl: noFetch, accountId: () => null });
    expect(((await caught(svc.spaceAssist({ purpose: 'real purpose' }))) as AiError).code).toBe(
      AI_ERROR_CODES.NOT_CONFIGURED
    );
  });

  it('dispatches to Claude via the SDK message-creator', async () => {
    const svc = new AiService({
      loadConfig: () => CLAUDE,
      fetchImpl: noFetch,
      accountId: () => null,
      makeClaudeMessageCreator: () => claudeStub(),
    });
    await expect(svc.spaceAssist({ purpose: 'real purpose' })).resolves.toEqual({
      description: 'D',
      objectives: ['a', 'b', 'c'],
    });
  });

  it('uses a configured token override for the flow (no mint)', async () => {
    const flow: OneReachFlowConfig = { provider: 'onereach-flow', url: 'https://flow/run', token: 'FLOW override' };
    const { fetchImpl, calls } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ description: 'FD', objectives: ['x'] }),
    }));
    const svc = new AiService({ loadConfig: () => flow, fetchImpl, accountId: () => null });
    await expect(svc.spaceAssist({ purpose: 'p' })).resolves.toEqual({ description: 'FD', objectives: ['x'] });
    expect(calls).toHaveLength(1); // only the flow POST, no refresh_token mint
    expect(authHeaderOf(calls[0]!.init)).toBe('FLOW override');
  });

  it('mints the flow token from the logged-in session when no override', async () => {
    const flow: OneReachFlowConfig = { provider: 'onereach-flow', url: 'https://flow/run' };
    const { fetchImpl, calls } = stubFetch((url) =>
      url.includes('/refresh_token')
        ? { ok: true, status: 200, body: JSON.stringify({ token: 'minted' }) }
        : { ok: true, status: 200, body: JSON.stringify({ description: 'FD', objectives: ['x'] }) }
    );
    const svc = new AiService({ loadConfig: () => flow, fetchImpl, accountId: () => 'acct1' });
    await expect(svc.spaceAssist({ purpose: 'p' })).resolves.toEqual({ description: 'FD', objectives: ['x'] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/refresh_token');
    expect(authHeaderOf(calls[1]!.init)).toBe('FLOW minted');
  });

  it('throws NOT_CONFIGURED for the flow when signed out and no override', async () => {
    const flow: OneReachFlowConfig = { provider: 'onereach-flow', url: 'https://flow/run' };
    const svc = new AiService({ loadConfig: () => flow, fetchImpl: noFetch, accountId: () => null });
    expect(((await caught(svc.spaceAssist({ purpose: 'p' }))) as AiError).code).toBe(
      AI_ERROR_CODES.NOT_CONFIGURED
    );
  });
});

// ─── Time bounds on the Claude call path (2026-08-08 review) ─────────────
//
// A main-process `extractAssetMetadata` run hung indefinitely: the SDK
// client was built with no timeout, and nothing above it enforced one.
// The seam now carries an SDK-level per-attempt timeout AND an absolute
// deadline that settles the promise even if the transport wedges.

describe('withClaudeDeadline — the call always settles', () => {
  it('rejects a wedged promise with a NETWORK AiError at the deadline', async () => {
    const { withClaudeDeadline } = await import('../../ai/client.js');
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const wedged = new Promise<never>(() => undefined);
      const guarded = withClaudeDeadline(wedged, 90_000);
      const settled = guarded.then(
        () => 'resolved',
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(90_000);
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(AiError);
      expect((outcome as AiError).code).toBe(AI_ERROR_CODES.NETWORK);
      expect((outcome as AiError).message).toContain('90s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a timely result through untouched', async () => {
    const { withClaudeDeadline } = await import('../../ai/client.js');
    await expect(withClaudeDeadline(Promise.resolve('ok'), 90_000)).resolves.toBe('ok');
  });

  it('propagates the underlying rejection, not the deadline', async () => {
    const { withClaudeDeadline } = await import('../../ai/client.js');
    const boom = new Error('provider exploded');
    await expect(withClaudeDeadline(Promise.reject(boom), 90_000)).rejects.toBe(boom);
  });
});

describe('makeClaudeMessageCreator is time-bounded (source + constants)', () => {
  it('constants sit in the review-mandated 60–90s band, deadline outermost', async () => {
    const mod = await import('../../ai/client.js');
    expect(mod.CLAUDE_ATTEMPT_TIMEOUT_MS).toBe(60_000);
    expect(mod.CLAUDE_DEADLINE_MS).toBe(90_000);
    expect(mod.CLAUDE_DEADLINE_MS).toBeGreaterThan(mod.CLAUDE_ATTEMPT_TIMEOUT_MS);
    expect(mod.CLAUDE_MAX_RETRIES).toBe(1);
  });

  it('the Anthropic client is constructed WITH the timeout (source-level)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const candidates = [path.resolve('ai/client.ts'), path.resolve('lite/ai/client.ts')];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found === undefined) throw new Error(`client.ts not found: ${candidates.join(', ')}`);
    const src = fs.readFileSync(found, 'utf8');
    const ctor = src.slice(src.indexOf('new Anthropic({'));
    expect(ctor).toContain('timeout: CLAUDE_ATTEMPT_TIMEOUT_MS');
    expect(ctor).toContain('maxRetries: CLAUDE_MAX_RETRIES');
    // …and every created message runs under the absolute deadline.
    expect(src).toMatch(/withClaudeDeadline\(\s*client\.messages\.create/);
  });
});

// ─── 2026-08-12: the AI must never write more than the field holds ──────
describe('AI description clamp', () => {
  it('clamps an over-long drafted description below the space cap, at a sentence boundary when possible', () => {
    const sentence = 'This is a complete sentence about the space. ';
    const long = sentence.repeat(120); // ~5400 chars
    const result = parseSpaceAssistResult(
      JSON.stringify({ description: long, objectives: ['a'] }),
      'claude'
    );
    expect(result.description.length).toBeLessThanOrEqual(2800);
    // Sentence-boundary cut: ends with a period, not mid-word.
    expect(result.description.endsWith('.')).toBe(true);
  });

  it('leaves normal-length descriptions untouched', () => {
    const result = parseSpaceAssistResult(
      JSON.stringify({ description: 'Short and sweet.', objectives: ['a'] }),
      'claude'
    );
    expect(result.description).toBe('Short and sweet.');
  });
});
