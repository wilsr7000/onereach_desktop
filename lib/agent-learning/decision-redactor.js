/**
 * Decision Redactor
 *
 * Strips/hashes PII from arbitration-decision payloads before they land
 * in the `arbitration-decisions` Space. Phase 1 of the self-learning
 * arbitration loop ships a regex-based redactor for common PII classes;
 * a model-based PII classifier is tracked as a follow-up and only
 * needed if regex misses entities in production.
 *
 * Contract:
 *   - The tuner (Phase 4) and calibrator (Phase 5) work entirely on
 *     structural metadata (bid count, confidences, agent IDs, outcome
 *     scores). Redaction MUST preserve all structural fields.
 *   - The transcript-reviewer (Phase 3) degrades gracefully when raw
 *     content is redacted: pattern-mining steps that need raw text are
 *     skipped, numeric ones still run.
 *
 * Setting key (in settings-manager.js):
 *   arbitrationDecisions.redactedRecording -- defaults true for
 *   regulated tenants, false otherwise. The recorder reads this and
 *   passes the appropriate mode here.
 */

'use strict';

// ============================================================
// PII patterns
// ============================================================
//
// Conservative posture: prefer false positives (over-redaction) to
// false negatives (PII leaking into logs/spaces). The class tokens
// (`<EMAIL>`, `<PHONE>`, etc.) preserve the structural signal so the
// transcript-reviewer can still see "user said something containing an
// email" without needing the email itself.
//
// Order matters: more specific patterns first so they don't get
// chunked by broader ones. URL goes before email (URLs can contain
// `@`); SSN goes before generic numbers; credit cards before phone.

const PATTERNS = [
  // URLs (http/https/www, with or without scheme)
  {
    name: 'URL',
    re: /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
    token: '<URL>',
  },
  // Email addresses
  {
    name: 'EMAIL',
    re: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    token: '<EMAIL>',
  },
  // SSN (XXX-XX-XXXX)
  {
    name: 'SSN',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    token: '<SSN>',
  },
  // Credit card (13-19 digits, optionally with separators)
  {
    name: 'CC',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    token: '<CC>',
  },
  // Phone numbers (US-ish; international would need a fancier rule).
  // No leading \b so we can absorb an opening paren as part of the
  // match -- otherwise "(555) 123-4567" leaves a stranded "(".
  {
    name: 'PHONE',
    re: /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g,
    token: '<PHONE>',
  },
  // Street address (number + word + Street/St/Avenue/Ave/Road/Rd/Blvd/...)
  {
    name: 'ADDRESS',
    re: /\b\d{1,6}\s+[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?/g,
    token: '<ADDRESS>',
  },
  // ISO dates (2026-04-27); softer than English dates but high precision
  {
    name: 'DATE',
    re: /\b\d{4}-\d{2}-\d{2}\b/g,
    token: '<DATE>',
  },
  // Money amounts ($1,234.56 or $1234)
  {
    name: 'MONEY',
    re: /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/g,
    token: '<MONEY>',
  },
];

/**
 * Redact a single string via the regex pattern set.
 *
 * @param {string} text - raw text
 * @returns {{ redacted: string, counts: Record<string, number> }}
 */
function redactString(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { redacted: typeof text === 'string' ? text : '', counts: {} };
  }
  let redacted = text;
  const counts = {};
  for (const { name, re, token } of PATTERNS) {
    let hits = 0;
    redacted = redacted.replace(re, () => {
      hits += 1;
      return token;
    });
    if (hits > 0) counts[name] = hits;
  }
  return { redacted, counts };
}

/**
 * Redact the user-content fields of an arbitration-decision item.
 * Operates on a shallow copy; structural metadata (bid count,
 * confidences, agent IDs, outcome scores) is preserved verbatim.
 *
 * Fields redacted:
 *   - content (the user's task text)
 *   - bids[].reasoning (each agent's bid reasoning -- can echo user input)
 *   - situationContext.flowContext.label / stepLabel (user-facing strings)
 *
 * Fields preserved (deliberately):
 *   - taskId, agentId, agentName, confidence, score, won, busted
 *   - executionMode, decisionPath
 *   - outcome.* numeric scores
 *   - createdAt, updatedAt
 *
 * @param {object} decision - arbitration-decision payload
 * @returns {{ redacted: object, totalCounts: Record<string, number> }}
 */
function redactDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    return { redacted: decision, totalCounts: {} };
  }

  const totalCounts = {};
  const tally = (counts) => {
    for (const [k, v] of Object.entries(counts || {})) {
      totalCounts[k] = (totalCounts[k] || 0) + v;
    }
  };

  const redacted = { ...decision };

  // Redact task content
  if (typeof decision.content === 'string') {
    const r = redactString(decision.content);
    redacted.content = r.redacted;
    tally(r.counts);
  }

  // Redact each bid's reasoning
  if (Array.isArray(decision.bids)) {
    redacted.bids = decision.bids.map((b) => {
      if (!b || typeof b !== 'object') return b;
      if (typeof b.reasoning !== 'string') return { ...b };
      const r = redactString(b.reasoning);
      tally(r.counts);
      return { ...b, reasoning: r.redacted };
    });
  }

  // Redact situation context user-facing strings (defensive; most
  // fields here are window names + flags, but flowContext labels can
  // contain user-authored titles).
  if (decision.situationContext && typeof decision.situationContext === 'object') {
    const sc = { ...decision.situationContext };
    if (sc.flowContext && typeof sc.flowContext === 'object') {
      const fc = { ...sc.flowContext };
      if (typeof fc.label === 'string') {
        const r = redactString(fc.label);
        fc.label = r.redacted;
        tally(r.counts);
      }
      if (typeof fc.stepLabel === 'string') {
        const r = redactString(fc.stepLabel);
        fc.stepLabel = r.redacted;
        tally(r.counts);
      }
      sc.flowContext = fc;
    }
    redacted.situationContext = sc;
  }

  return { redacted, totalCounts };
}

module.exports = {
  redactString,
  redactDecision,
  PATTERNS,
};
