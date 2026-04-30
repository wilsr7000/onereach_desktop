/**
 * Bid Protocol - Unit Tests
 *
 * Run:  npx vitest run test/unit/bid-protocol.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  BID_TIERS,
  VALID_BID_TIERS,
  CONFIDENCE_TICK,
  DEFAULT_BID_WINDOW_MS,
  isValidBid,
  isValidBidRequest,
  isValidBidResponse,
  buildBidRequest,
  buildBidResponse,
  quantizeConfidence,
  normalizeBid,
  computeBidDeadline,
  isBidTimedOut,
  shouldCloseAuctionEarly,
  createTimeoutPolicy,
} = require('../../lib/hud-core/bid-protocol');

// ============================================================
// Constants
// ============================================================

describe('constants', () => {
  it('BID_TIERS has the four canonical tiers', () => {
    expect(BID_TIERS).toMatchObject({
      KEYWORD: 'keyword',
      CACHE: 'cache',
      LLM: 'llm',
      BUILTIN: 'builtin',
    });
  });

  it('VALID_BID_TIERS is frozen and matches BID_TIERS values', () => {
    expect(VALID_BID_TIERS.has('keyword')).toBe(true);
    expect(VALID_BID_TIERS.has('invalid')).toBe(false);
  });

  it('CONFIDENCE_TICK is 0.05 (canonical granularity)', () => {
    expect(CONFIDENCE_TICK).toBe(0.05);
  });

  it('DEFAULT_BID_WINDOW_MS is 2000 (matches desktop default)', () => {
    expect(DEFAULT_BID_WINDOW_MS).toBe(2000);
  });
});

// ============================================================
// isValidBid
// ============================================================

describe('isValidBid', () => {
  const valid = {
    agentId: 'weather-agent',
    agentVersion: '1.0.0',
    confidence: 0.9,
    reasoning: 'strong match',
    estimatedTimeMs: 50,
    timestamp: 1_700_000_000_000,
    tier: 'llm',
  };

  it('accepts a canonical bid', () => {
    expect(isValidBid(valid)).toBe(true);
  });

  it('accepts bid with optional result=string', () => {
    expect(isValidBid({ ...valid, result: 'precomputed' })).toBe(true);
  });

  it('accepts bid with optional result=null', () => {
    expect(isValidBid({ ...valid, result: null })).toBe(true);
  });

  it('rejects null / undefined / non-object', () => {
    expect(isValidBid(null)).toBe(false);
    expect(isValidBid(undefined)).toBe(false);
    expect(isValidBid('string')).toBe(false);
  });

  it('rejects missing agentId', () => {
    expect(isValidBid({ ...valid, agentId: '' })).toBe(false);
  });

  it('rejects non-numeric confidence', () => {
    expect(isValidBid({ ...valid, confidence: 'high' })).toBe(false);
  });

  it('rejects confidence out of [0, 1]', () => {
    expect(isValidBid({ ...valid, confidence: -0.1 })).toBe(false);
    expect(isValidBid({ ...valid, confidence: 1.5 })).toBe(false);
  });

  it('rejects unknown tier', () => {
    expect(isValidBid({ ...valid, tier: 'mystery' })).toBe(false);
  });

  it('rejects missing reasoning', () => {
    expect(isValidBid({ ...valid, reasoning: undefined })).toBe(false);
  });

  it('rejects missing estimatedTimeMs', () => {
    const { estimatedTimeMs: _, ...withoutTime } = valid;
    expect(isValidBid(withoutTime)).toBe(false);
  });

  it('rejects non-string result when provided', () => {
    expect(isValidBid({ ...valid, result: 42 })).toBe(false);
  });
});

// ============================================================
// isValidBidRequest
// ============================================================

describe('isValidBidRequest', () => {
  const valid = {
    type: 'bid_request',
    auctionId: 'auction-1',
    task: { id: 't', content: 'play jazz' },
    context: { queueDepth: 1, conversationHistory: [], conversationText: '', participatingAgents: [] },
    deadline: 1_700_000_000_000,
  };

  it('accepts a canonical request', () => {
    expect(isValidBidRequest(valid)).toBe(true);
  });

  it('rejects wrong type discriminator', () => {
    expect(isValidBidRequest({ ...valid, type: 'bid_response' })).toBe(false);
  });

  it('rejects missing auctionId', () => {
    expect(isValidBidRequest({ ...valid, auctionId: '' })).toBe(false);
  });

  it('rejects non-finite deadline', () => {
    expect(isValidBidRequest({ ...valid, deadline: NaN })).toBe(false);
    expect(isValidBidRequest({ ...valid, deadline: 'soon' })).toBe(false);
  });

  it('rejects missing task / context', () => {
    expect(isValidBidRequest({ ...valid, task: null })).toBe(false);
    expect(isValidBidRequest({ ...valid, context: null })).toBe(false);
  });
});

// ============================================================
// isValidBidResponse
// ============================================================

describe('isValidBidResponse', () => {
  const base = {
    type: 'bid_response',
    auctionId: 'auction-1',
    agentId: 'weather',
    agentVersion: '1.0.0',
  };

  it('accepts a canonical bid response with a bid', () => {
    const r = {
      ...base,
      bid: {
        confidence: 0.9,
        reasoning: 'match',
        estimatedTimeMs: 50,
        tier: 'llm',
      },
    };
    expect(isValidBidResponse(r)).toBe(true);
  });

  it('accepts a no-bid (bid: null)', () => {
    expect(isValidBidResponse({ ...base, bid: null })).toBe(true);
  });

  it('rejects wrong type', () => {
    expect(isValidBidResponse({ ...base, type: 'other', bid: null })).toBe(false);
  });

  it('rejects bid missing required inner fields', () => {
    expect(
      isValidBidResponse({
        ...base,
        bid: { confidence: 0.5, reasoning: 'x', tier: 'llm' }, // no estimatedTimeMs
      })
    ).toBe(false);
  });

  it('rejects bid with unknown tier', () => {
    expect(
      isValidBidResponse({
        ...base,
        bid: { confidence: 0.5, reasoning: '', estimatedTimeMs: 10, tier: 'oops' },
      })
    ).toBe(false);
  });

  it('accepts bid with optional result', () => {
    const r = {
      ...base,
      bid: {
        confidence: 0.9,
        reasoning: '',
        estimatedTimeMs: 10,
        tier: 'builtin',
        result: '3:42pm',
      },
    };
    expect(isValidBidResponse(r)).toBe(true);
  });
});

// ============================================================
// Builders
// ============================================================

describe('buildBidRequest / buildBidResponse', () => {
  it('buildBidRequest produces a canonical shape', () => {
    const r = buildBidRequest({
      auctionId: 'a1',
      task: { id: 't', content: 'x' },
      context: { queueDepth: 0, conversationHistory: [], conversationText: '', participatingAgents: [] },
      deadline: 1_700_000_000_000,
    });
    expect(r).toMatchObject({
      type: 'bid_request',
      auctionId: 'a1',
      deadline: 1_700_000_000_000,
    });
    expect(isValidBidRequest(r)).toBe(true);
  });

  it('buildBidResponse defaults bid to null when omitted', () => {
    const r = buildBidResponse({
      auctionId: 'a1',
      agentId: 'weather',
      agentVersion: '1.0.0',
    });
    expect(r.bid).toBeNull();
    expect(isValidBidResponse(r)).toBe(true);
  });

  it('buildBidResponse preserves a provided bid', () => {
    const r = buildBidResponse({
      auctionId: 'a1',
      agentId: 'weather',
      agentVersion: '1.0.0',
      bid: { confidence: 0.9, reasoning: 'x', estimatedTimeMs: 10, tier: 'llm' },
    });
    expect(isValidBidResponse(r)).toBe(true);
  });
});

// ============================================================
// Normalization
// ============================================================

describe('quantizeConfidence', () => {
  it('rounds to the nearest 0.05 tick', () => {
    expect(quantizeConfidence(0.72)).toBeCloseTo(0.7, 10);
    expect(quantizeConfidence(0.78)).toBeCloseTo(0.8, 10);
    expect(quantizeConfidence(0.975)).toBeCloseTo(1.0, 10);
  });

  it('clips to [0, 1]', () => {
    expect(quantizeConfidence(-0.2)).toBe(0);
    expect(quantizeConfidence(1.4)).toBe(1);
  });

  it('returns 0 for non-numeric / NaN', () => {
    expect(quantizeConfidence(NaN)).toBe(0);
    expect(quantizeConfidence('high')).toBe(0);
    expect(quantizeConfidence(null)).toBe(0);
  });
});

describe('normalizeBid', () => {
  it('produces a valid bid from a minimal input', () => {
    const b = normalizeBid({
      agentId: 'weather',
      confidence: 0.73,
      reasoning: 'match',
    });
    expect(b).toBeTruthy();
    expect(isValidBid(b)).toBe(true);
    expect(b.confidence).toBeCloseTo(0.75, 10);
    expect(b.tier).toBe(BID_TIERS.LLM);
    expect(b.estimatedTimeMs).toBe(0);
    expect(typeof b.timestamp).toBe('number');
  });

  it('returns null for non-objects', () => {
    expect(normalizeBid(null)).toBeNull();
    expect(normalizeBid('bid')).toBeNull();
  });

  it('preserves a provided valid tier', () => {
    const b = normalizeBid({
      agentId: 'a',
      confidence: 0.5,
      reasoning: '',
      tier: 'builtin',
    });
    expect(b.tier).toBe('builtin');
  });

  it('falls back to LLM tier when unknown', () => {
    const b = normalizeBid({
      agentId: 'a',
      confidence: 0.5,
      reasoning: '',
      tier: 'nonsense',
    });
    expect(b.tier).toBe(BID_TIERS.LLM);
  });

  it('preserves the result field when string or null', () => {
    expect(normalizeBid({ agentId: 'a', confidence: 0.5, reasoning: '', result: 'precomputed' }).result).toBe('precomputed');
    expect(normalizeBid({ agentId: 'a', confidence: 0.5, reasoning: '', result: null }).result).toBeNull();
  });
});

// ============================================================
// Timeout policy
// ============================================================

describe('computeBidDeadline', () => {
  it('uses provided now + windowMs', () => {
    expect(computeBidDeadline({ now: 1000, windowMs: 500 })).toBe(1500);
  });

  it('defaults windowMs to DEFAULT_BID_WINDOW_MS', () => {
    expect(computeBidDeadline({ now: 1000 })).toBe(1000 + DEFAULT_BID_WINDOW_MS);
  });
});

describe('isBidTimedOut', () => {
  it('true when now >= deadline', () => {
    expect(isBidTimedOut({ deadline: 1000, now: 1000 })).toBe(true);
    expect(isBidTimedOut({ deadline: 1000, now: 1500 })).toBe(true);
  });

  it('false when now < deadline', () => {
    expect(isBidTimedOut({ deadline: 1000, now: 999 })).toBe(false);
  });

  it('false on malformed input (no crash)', () => {
    expect(isBidTimedOut(null)).toBe(false);
    expect(isBidTimedOut({})).toBe(false);
  });
});

describe('shouldCloseAuctionEarly', () => {
  it('true when received >= expected', () => {
    expect(shouldCloseAuctionEarly({ received: 3, expected: 3 })).toBe(true);
    expect(shouldCloseAuctionEarly({ received: 4, expected: 3 })).toBe(true);
  });

  it('false when received < expected', () => {
    expect(shouldCloseAuctionEarly({ received: 2, expected: 5 })).toBe(false);
  });

  it('true when expected is 0 (nobody to wait for)', () => {
    expect(shouldCloseAuctionEarly({ received: 0, expected: 0 })).toBe(true);
    expect(shouldCloseAuctionEarly({ received: 0, expected: -1 })).toBe(true);
  });

  it('false on malformed input', () => {
    expect(shouldCloseAuctionEarly(null)).toBe(false);
    expect(shouldCloseAuctionEarly({ received: NaN, expected: 3 })).toBe(false);
  });
});

describe('createTimeoutPolicy', () => {
  it('stitches deadline + isExpired + shouldClose against an injected clock', () => {
    let clock = 10_000;
    const tp = createTimeoutPolicy({ windowMs: 1_000, now: () => clock });
    expect(tp.deadline).toBe(11_000);
    expect(tp.isExpired()).toBe(false);
    expect(tp.shouldClose(1, 3)).toBe(false);
    expect(tp.shouldClose(3, 3)).toBe(true);
    clock = 11_000;
    expect(tp.isExpired()).toBe(true);
  });

  it('msRemaining counts down', () => {
    let clock = 0;
    const tp = createTimeoutPolicy({ windowMs: 500, now: () => clock });
    expect(tp.msRemaining()).toBe(500);
    clock = 200;
    expect(tp.msRemaining()).toBe(300);
    clock = 600;
    expect(tp.msRemaining()).toBe(0);
  });
});

// ============================================================
// Legacy equivalence
// ============================================================

describe('legacy equivalence: early-close rule', () => {
  // The pre-extraction exchange.ts early-close check was:
  //   if ((auction.responseCount ?? 0) >= agentIds.size) resolve();
  function legacyEarlyClose(responseCount, expectedSize) {
    return (responseCount ?? 0) >= expectedSize;
  }

  const cases = [
    [0, 0],
    [0, 3],
    [3, 3],
    [5, 3],
    [undefined, 3],
  ];

  for (const [received, expected] of cases) {
    it(`legacy(${received}, ${expected}) === shouldCloseAuctionEarly`, () => {
      const legacy = legacyEarlyClose(received, expected);
      const extracted = shouldCloseAuctionEarly({
        received: received ?? 0,
        expected,
      });
      expect(extracted).toBe(legacy);
    });
  }
});
