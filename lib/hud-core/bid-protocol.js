/**
 * Bid Protocol (HUD Core)
 *
 * Pure schemas, validators, builders, and timeout policy for the
 * agent-bidding wire format. Any consumer that speaks "bidding" --
 * the desktop app's WebSocket exchange, a GSX flow doing HTTP fan-
 * out, a WISER Playbooks task layer, a test harness with in-memory
 * agents -- uses the same `BidRequest` / `BidResponse` shapes and
 * the same auction-close decisions.
 *
 * No host dependencies, no I/O, no transport. This module is about
 * the MESSAGES and the DECISIONS; the transport mechanism (WS / HTTP
 * / in-process) is the consumer's job.
 *
 * The shapes mirror `packages/task-exchange/src/types/index.ts`
 * (which is TypeScript, scoped to the desktop exchange). Keeping a
 * plain-JS mirror here makes the contract importable from Node
 * environments that don't carry the TypeScript build.
 */

'use strict';

// ============================================================
// Constants
// ============================================================

/**
 * Known bid tiers. Agents self-declare which tier their bid came
 * from so the exchange can prefer faster tiers on ties.
 *   keyword  - lexical / regex match, <1ms
 *   cache    - previously-seen signature, <5ms
 *   llm      - fresh LLM evaluation, ~100-500ms
 *   builtin  - deterministic rule inside a built-in agent
 */
const BID_TIERS = Object.freeze({
  KEYWORD: 'keyword',
  CACHE: 'cache',
  LLM: 'llm',
  BUILTIN: 'builtin',
});

const VALID_BID_TIERS = Object.freeze(new Set(Object.values(BID_TIERS)));

/**
 * Confidence tick size (0.05) -- the canonical bid-resolution
 * granularity. Bids finer than this tick get rounded in
 * `normalizeBid` so ranking doesn't thrash on float noise.
 */
const CONFIDENCE_TICK = 0.05;

/**
 * Confidence bounds. Bids below MIN are treated as "no bid"; bids
 * above MAX are clipped.
 */
const CONFIDENCE_MIN = 0.05;
const CONFIDENCE_MAX = 1.0;

/**
 * Default bid-window duration when a consumer doesn't pass its own.
 * Matches the desktop app's `VOICE_CONFIG.bidTimeoutMs` default of
 * 2 seconds.
 */
const DEFAULT_BID_WINDOW_MS = 2_000;

// ============================================================
// Validators
// ============================================================

/**
 * @param {any} obj
 * @returns {boolean}
 */
function isValidBid(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.agentId !== 'string' || !obj.agentId) return false;
  if (typeof obj.agentVersion !== 'string') return false;
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) return false;
  if (obj.confidence < 0 || obj.confidence > 1) return false;
  if (typeof obj.reasoning !== 'string') return false;
  if (typeof obj.estimatedTimeMs !== 'number' || !Number.isFinite(obj.estimatedTimeMs)) return false;
  if (typeof obj.timestamp !== 'number') return false;
  if (!VALID_BID_TIERS.has(obj.tier)) return false;
  // result is optional; if present must be string or null
  if (obj.result !== undefined && obj.result !== null && typeof obj.result !== 'string') {
    return false;
  }
  return true;
}

/**
 * @param {any} obj
 * @returns {boolean}
 */
function isValidBidRequest(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type !== 'bid_request') return false;
  if (typeof obj.auctionId !== 'string' || !obj.auctionId) return false;
  if (!obj.task || typeof obj.task !== 'object') return false;
  if (!obj.context || typeof obj.context !== 'object') return false;
  if (typeof obj.deadline !== 'number' || !Number.isFinite(obj.deadline)) return false;
  return true;
}

/**
 * @param {any} obj
 * @returns {boolean}
 */
function isValidBidResponse(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type !== 'bid_response') return false;
  if (typeof obj.auctionId !== 'string' || !obj.auctionId) return false;
  if (typeof obj.agentId !== 'string' || !obj.agentId) return false;
  if (typeof obj.agentVersion !== 'string') return false;
  // bid is either null (no-bid) or an object with at least the
  // required fields. Agents don't include agentId in the nested
  // bid because the envelope already carries it.
  if (obj.bid === null) return true;
  if (!obj.bid || typeof obj.bid !== 'object') return false;
  const b = obj.bid;
  if (typeof b.confidence !== 'number' || !Number.isFinite(b.confidence)) return false;
  if (b.confidence < 0 || b.confidence > 1) return false;
  if (typeof b.reasoning !== 'string') return false;
  if (typeof b.estimatedTimeMs !== 'number' || !Number.isFinite(b.estimatedTimeMs)) return false;
  if (!VALID_BID_TIERS.has(b.tier)) return false;
  if (b.result !== undefined && b.result !== null && typeof b.result !== 'string') {
    return false;
  }
  return true;
}

// ============================================================
// Builders
// ============================================================

/**
 * @param {object} input
 * @param {string} input.auctionId
 * @param {object} input.task
 * @param {object} input.context
 * @param {number} input.deadline  - epoch ms
 * @returns {{type:'bid_request', auctionId, task, context, deadline}}
 */
function buildBidRequest(input) {
  return {
    type: 'bid_request',
    auctionId: input.auctionId,
    task: input.task,
    context: input.context,
    deadline: input.deadline,
  };
}

/**
 * @param {object} input
 * @param {string} input.auctionId
 * @param {string} input.agentId
 * @param {string} input.agentVersion
 * @param {object|null} input.bid
 * @returns {{type:'bid_response', auctionId, agentId, agentVersion, bid}}
 */
function buildBidResponse(input) {
  return {
    type: 'bid_response',
    auctionId: input.auctionId,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    bid: input.bid || null,
  };
}

// ============================================================
// Normalization
// ============================================================

/**
 * Round a confidence to the canonical tick size (0.05). Values
 * outside [0, 1] are clipped.
 * @param {number} value
 * @returns {number}
 */
function quantizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const clipped = Math.max(0, Math.min(1, value));
  return Math.round(clipped / CONFIDENCE_TICK) * CONFIDENCE_TICK;
}

/**
 * Return a defensive copy of `bid` with confidence tick-rounded and
 * missing optional fields defaulted. Invalid bids come back as null.
 * @param {object} bid
 * @returns {object | null}
 */
function normalizeBid(bid) {
  if (!bid || typeof bid !== 'object') return null;
  const copy = {
    agentId: typeof bid.agentId === 'string' ? bid.agentId : 'unknown',
    agentVersion: typeof bid.agentVersion === 'string' ? bid.agentVersion : '1.0.0',
    confidence: quantizeConfidence(Number(bid.confidence) || 0),
    reasoning: typeof bid.reasoning === 'string' ? bid.reasoning : '',
    estimatedTimeMs:
      typeof bid.estimatedTimeMs === 'number' && Number.isFinite(bid.estimatedTimeMs)
        ? bid.estimatedTimeMs
        : 0,
    timestamp:
      typeof bid.timestamp === 'number' && Number.isFinite(bid.timestamp)
        ? bid.timestamp
        : Date.now(),
    tier: VALID_BID_TIERS.has(bid.tier) ? bid.tier : BID_TIERS.LLM,
  };
  if (bid.result !== undefined) {
    copy.result = typeof bid.result === 'string' ? bid.result : null;
  }
  return isValidBid(copy) ? copy : null;
}

// ============================================================
// Timeout policy / auction close
// ============================================================

/**
 * Compute the auction-close deadline.
 * @param {object} [input]
 * @param {number} [input.now]         - default Date.now()
 * @param {number} [input.windowMs]    - default DEFAULT_BID_WINDOW_MS
 * @returns {number} epoch ms
 */
function computeBidDeadline(input = {}) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const windowMs = typeof input.windowMs === 'number' ? input.windowMs : DEFAULT_BID_WINDOW_MS;
  return now + windowMs;
}

/**
 * True when the auction's window has elapsed.
 * @param {object} input
 * @param {number} input.deadline
 * @param {number} [input.now]     - default Date.now()
 * @returns {boolean}
 */
function isBidTimedOut(input) {
  if (!input || typeof input.deadline !== 'number') return false;
  const now = typeof input.now === 'number' ? input.now : Date.now();
  return now >= input.deadline;
}

/**
 * Early-close decision: the auction can close without waiting for
 * the full timeout when every expected responder has replied.
 *
 * Matches the legacy behaviour in
 * `packages/task-exchange/src/exchange/exchange.ts` where
 * `responseCount >= expectedResponses` triggers the early resolve.
 *
 * @param {object} input
 * @param {number} input.received
 * @param {number} input.expected
 * @returns {boolean}
 */
function shouldCloseAuctionEarly(input) {
  if (!input) return false;
  const received = Number(input.received);
  const expected = Number(input.expected);
  if (!Number.isFinite(received) || !Number.isFinite(expected)) return false;
  if (expected <= 0) return true; // nobody was expected -> close immediately
  return received >= expected;
}

/**
 * Stateful timeout policy. Useful for consumers that want the
 * deadline + two decisions stitched together against a controllable
 * clock.
 *
 *   const tp = createTimeoutPolicy({ windowMs: 2_000, now: () => clock });
 *   tp.deadline            // the epoch-ms deadline
 *   tp.isExpired()         // boolean
 *   tp.shouldClose(r, e)   // early-close decision
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs]
 * @param {() => number} [opts.now]
 */
function createTimeoutPolicy(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const windowMs = typeof opts.windowMs === 'number' ? opts.windowMs : DEFAULT_BID_WINDOW_MS;
  const deadline = now() + windowMs;
  return {
    deadline,
    windowMs,
    isExpired() {
      return now() >= deadline;
    },
    shouldClose(received, expected) {
      return shouldCloseAuctionEarly({ received, expected });
    },
    msRemaining() {
      return Math.max(0, deadline - now());
    },
  };
}

module.exports = {
  // Constants
  BID_TIERS,
  VALID_BID_TIERS,
  CONFIDENCE_TICK,
  CONFIDENCE_MIN,
  CONFIDENCE_MAX,
  DEFAULT_BID_WINDOW_MS,
  // Validators
  isValidBid,
  isValidBidRequest,
  isValidBidResponse,
  // Builders
  buildBidRequest,
  buildBidResponse,
  // Normalization
  quantizeConfidence,
  normalizeBid,
  // Timeout
  computeBidDeadline,
  isBidTimedOut,
  shouldCloseAuctionEarly,
  createTimeoutPolicy,
};
