/**
 * Result Quality - pure classification of a settled agent result.
 *
 * The bug this kills (2026-08 alarm request): app-agent settled with
 * success:true + needsInput ("I couldn't find that app. What would you like
 * me to open?") -- an unresolved dead-end -- and the exchange recorded a
 * reputation SUCCESS (1.0) and CACHED the route (alarm -> app-agent), so
 * every future alarm request would skip the auction and land on the wrong
 * agent. A clarifying question is not a completed outcome: it must never
 * feed the routing cache or count as a reputation win.
 *
 * isResolvedSuccess(result) is the single gate for "this task genuinely
 * completed": success not false, and no unresolved needsInput /
 * needsClarification hanging off it.
 */

'use strict';

function isResolvedSuccess(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return false;
  if (result.needsInput) return false;
  if (result.needsClarification) return false;
  return true;
}

module.exports = { isResolvedSuccess };
