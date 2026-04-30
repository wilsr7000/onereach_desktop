/**
 * @onereach/hud-core -- Public API
 *
 * Stable surface for the portable pieces of the HUD (heads-up display
 * / agent-routing) pipeline. These are the modules that can run
 * ANYWHERE a JavaScript VM runs: the desktop app today, a GSX-hosted
 * flow step tomorrow, WISER Playbooks' task layer after that, a
 * headless CLI, a cloud function, a test harness.
 *
 * Scope today (Phases 1 + 2 + 3 + 4 + 5 + 6 + 7 of HUD extraction --
 * ALL PHASES SHIPPED):
 *   - Task command router       -- cancel/stop/repeat/undo classifier
 *   - Voter pool                -- agent eligibility filter
 *   - Council adapter           -- bid -> evaluation shape transform
 *   - Identity correction       -- "I don't live in X" / "I'm in Y" detector
 *   - Conversation continuity   -- pick the most recent winning agent
 *                                  within a rolling window (for follow-ups)
 *   - Pending state classifier  -- route answers to open questions /
 *                                  confirmations back to the waiting agent
 *   - Bid protocol              -- schemas/validators/builders for
 *                                  BidRequest/BidResponse + timeout
 *                                  + early-close decision
 *   - Winner selection          -- fast-path + multi-intent override +
 *                                  fallback for choosing the winning bid
 *   - Task decomposer           -- split multi-task utterances into
 *                                  sub-tasks; first module to introduce
 *                                  the `ai` port
 *   - Dedup                     -- detect duplicate / prefix-match
 *                                  submissions from incremental STT
 *   - Result consolidator       -- shape raw agent result into the
 *                                  canonical delivery envelope
 *
 * Consumers outside this app should import ONLY from this barrel;
 * never deep-import into `lib/hud-core/*` or the internal
 * `lib/exchange/*` / `lib/identity-correction.js` paths. That way
 * internal refactors can't break downstream.
 *
 * See docs/hud-core/ports.md for the host-provided dependencies the
 * eventual full extraction will need. See
 * docs/hud-core/extraction-plan.md for what's left.
 */

'use strict';

const taskCommandRouter = require('./task-command-router');
const conversationContinuity = require('./conversation-continuity');
const pendingState = require('./pending-state');
const bidProtocol = require('./bid-protocol');
const winnerSelection = require('./winner-selection');
const taskDecomposer = require('./task-decomposer');
const dedup = require('./dedup');
const resultConsolidator = require('./result-consolidator');
const bidOverlap = require('./bid-overlap');
const voterPool = require('../exchange/voter-pool');
const councilAdapter = require('../exchange/council-adapter');
const identityCorrection = require('../identity-correction');

module.exports = {
  // ---- Task command router (Phase 1; pure) ----
  taskCommandRouter,
  classifyTaskCommand: taskCommandRouter.classifyTaskCommand,
  isCriticalCommand: taskCommandRouter.isCriticalCommand,

  // ---- Conversation continuity (Phase 2; pure + stateful tracker) ----
  conversationContinuity,
  pickContinuityAgent: conversationContinuity.pickContinuityAgent,
  createContinuityTracker: conversationContinuity.createContinuityTracker,

  // ---- Pending state classifier (Phase 2; pure) ----
  pendingState,
  classifyPendingState: pendingState.classifyPendingState,
  shouldRouteToPendingStateHandler: pendingState.shouldRouteToPendingStateHandler,
  normalizeRoutingContext: pendingState.normalizeRoutingContext,

  // ---- Bid protocol (Phase 3; pure) ----
  bidProtocol,
  BID_TIERS: bidProtocol.BID_TIERS,
  DEFAULT_BID_WINDOW_MS: bidProtocol.DEFAULT_BID_WINDOW_MS,
  isValidBid: bidProtocol.isValidBid,
  isValidBidRequest: bidProtocol.isValidBidRequest,
  isValidBidResponse: bidProtocol.isValidBidResponse,
  buildBidRequest: bidProtocol.buildBidRequest,
  buildBidResponse: bidProtocol.buildBidResponse,
  normalizeBid: bidProtocol.normalizeBid,
  quantizeConfidence: bidProtocol.quantizeConfidence,
  computeBidDeadline: bidProtocol.computeBidDeadline,
  isBidTimedOut: bidProtocol.isBidTimedOut,
  shouldCloseAuctionEarly: bidProtocol.shouldCloseAuctionEarly,
  createTimeoutPolicy: bidProtocol.createTimeoutPolicy,

  // ---- Winner selection (Phase 4; pure) ----
  winnerSelection,
  pickWinnerFastPath: winnerSelection.pickWinnerFastPath,
  fallbackSelection: winnerSelection.fallbackSelection,
  applyMultiIntentOverride: winnerSelection.applyMultiIntentOverride,
  hasMultiIntent: winnerSelection.hasMultiIntent,
  validateWinners: winnerSelection.validateWinners,

  // ---- Task decomposer (Phase 5; needs `ai` port) ----
  taskDecomposer,
  createTaskDecomposer: taskDecomposer.createTaskDecomposer,
  shouldSkipDecomposition: taskDecomposer.shouldSkipDecomposition,
  buildDecompositionPrompt: taskDecomposer.buildDecompositionPrompt,
  parseDecompositionResult: taskDecomposer.parseDecompositionResult,

  // ---- Dedup (Phase 6; pure + reference in-memory tracker) ----
  dedup,
  normalizeTranscript: dedup.normalizeTranscript,
  isDuplicateSubmission: dedup.isDuplicateSubmission,
  createDedupTracker: dedup.createDedupTracker,

  // ---- Result consolidator (Phase 7; pure) ----
  resultConsolidator,
  normalizeResult: resultConsolidator.normalizeResult,
  extractDeliveryMessage: resultConsolidator.extractDeliveryMessage,
  extractLearningMessage: resultConsolidator.extractLearningMessage,
  hasPanel: resultConsolidator.hasPanel,
  agentIdToDisplayName: resultConsolidator.agentIdToDisplayName,
  buildDeliveryEnvelope: resultConsolidator.buildDeliveryEnvelope,

  // ---- Bid overlap penalty (Phase 4 self-learning arbitration; pure) ----
  bidOverlap,
  applyOverlapPenalty: bidOverlap.applyOverlapPenalty,
  tokenSetJaccard: bidOverlap.tokenSetJaccard,
  wouldChangeWinner: bidOverlap.wouldChangeWinner,
  DEFAULT_OVERLAP_CONFIG: bidOverlap.DEFAULT_OVERLAP_CONFIG,

  // ---- Voter pool (pre-existing; pure) ----
  voterPool,

  // ---- Council adapter (pre-existing; pure) ----
  councilAdapter,

  // ---- Identity correction (pre-existing; pure-ish) ----
  identityCorrection,
};
