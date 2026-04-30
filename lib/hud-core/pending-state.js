/**
 * Pending State Classifier (HUD Core)
 *
 * Thin but load-bearing: decides whether a new user utterance should
 * bypass the agent auction and route directly to the multi-turn
 * state-resolution handler (the "Router"). A turn bypasses the
 * auction when EITHER of these is true:
 *
 *   - An agent previously asked the user a question that is still
 *     open (pendingQuestion).
 *   - An agent is waiting for the user to confirm or reject a
 *     proposed action (pendingConfirmation).
 *
 * In both cases the user's reply is an answer, not a new task, and
 * should never re-enter agent bidding.
 *
 * This module formalises the `RoutingContext` shape so portable
 * consumers (GSX flows, WISER) can speak the same vocabulary as
 * the desktop app without reinventing fields.
 *
 * PURE: no host deps. Callers pass the routing context in; we
 * don't read it from any singleton.
 */

'use strict';

/**
 * @typedef {object} RoutingContext
 * @property {boolean} hasPendingQuestion       - an agent is waiting for an answer
 * @property {boolean} hasPendingConfirmation   - an agent is waiting for yes/no
 * @property {string}  [pendingAgentId]         - the agent that is waiting
 * @property {string}  [pendingField]           - the specific field being asked about
 * @property {string}  [lastSubject]            - subject of the last exchange
 * @property {number}  [contextCount]           - count of recent turns in scope
 */

/**
 * Canonical classifier.
 *
 * @param {RoutingContext} [routingContext]
 * @returns {{
 *   kind: 'question' | 'confirmation' | 'none',
 *   shouldHandleAsPending: boolean,
 *   pendingAgentId?: string,
 *   pendingField?: string,
 * }}
 */
function classifyPendingState(routingContext) {
  const ctx = routingContext || {};

  if (ctx.hasPendingQuestion) {
    return {
      kind: 'question',
      shouldHandleAsPending: true,
      pendingAgentId: ctx.pendingAgentId,
      pendingField: ctx.pendingField,
    };
  }

  if (ctx.hasPendingConfirmation) {
    return {
      kind: 'confirmation',
      shouldHandleAsPending: true,
      pendingAgentId: ctx.pendingAgentId,
    };
  }

  return { kind: 'none', shouldHandleAsPending: false };
}

/**
 * Convenience boolean for callers that don't need the kind label.
 * @param {RoutingContext} [routingContext]
 * @returns {boolean}
 */
function shouldRouteToPendingStateHandler(routingContext) {
  return classifyPendingState(routingContext).shouldHandleAsPending;
}

/**
 * Validate that an object has the shape of a RoutingContext. Useful
 * when a consumer is deserialising from JSON (e.g. a GSX flow
 * receiving state from HTTP). Returns a copy with only the known
 * fields; silently drops unknown ones to keep downstream code from
 * having to re-validate.
 *
 * @param {any} obj
 * @returns {RoutingContext}
 */
function normalizeRoutingContext(obj) {
  if (!obj || typeof obj !== 'object') {
    return { hasPendingQuestion: false, hasPendingConfirmation: false };
  }
  return {
    hasPendingQuestion: Boolean(obj.hasPendingQuestion),
    hasPendingConfirmation: Boolean(obj.hasPendingConfirmation),
    pendingAgentId: typeof obj.pendingAgentId === 'string' ? obj.pendingAgentId : undefined,
    pendingField: typeof obj.pendingField === 'string' ? obj.pendingField : undefined,
    lastSubject: typeof obj.lastSubject === 'string' ? obj.lastSubject : undefined,
    contextCount: Number.isFinite(obj.contextCount) ? obj.contextCount : undefined,
  };
}

module.exports = {
  classifyPendingState,
  shouldRouteToPendingStateHandler,
  normalizeRoutingContext,
};
