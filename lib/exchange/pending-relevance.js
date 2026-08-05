/**
 * Pending Relevance - is this utterance an ANSWER to the pending question,
 * or a NEW command that must not be hijacked?
 *
 * 2026-08-05 live: a fresh builder-consent pending (a yes/no question with no
 * options) swallowed "What's the weather today?" -- the user asked for
 * weather and got a lecture about agents. The earlier guard only compared
 * against option lists, so option-less consents hijacked everything.
 *
 * Pure decision, one vocabulary:
 *  - options exist  -> route only on word overlap with an option, or an
 *    affirmative/selection ("yes", "the first one", "build it")
 *  - no options (yes/no consent) -> route only short reply-like utterances or
 *    clear affirmatives/negatives; full sentences and questions are commands
 */

'use strict';

const AFFIRMATIVE_RE = /^(yes|yeah|yep|sure|ok|okay|no|nope|not now|never mind|nevermind|please do|do it|go ahead|first|second|third|last|that one|this one|build|skip|cancel|stop)\b/i;
const STOPWORDS = new Set(['the','you','can','for','and','with','that','this','please','what','would','could','about','have','get']);

function isAnswerToPending(f = {}) {
  const text = String(f.text || '').trim();
  if (!text) return { route: false, reason: 'empty' };

  const affirmative = AFFIRMATIVE_RE.test(text);
  if (affirmative) return { route: true, reason: 'affirmative' };

  const words = text.toLowerCase().match(/[a-z]{3,}/g) || [];
  const meaningful = words.filter((w) => !STOPWORDS.has(w));

  const options = Array.isArray(f.options) ? f.options : [];
  if (options.length > 0) {
    const optText = options.map((o) => String(o?.label || o?.text || o).toLowerCase()).join(' ');
    const overlap = meaningful.some((w) => optText.includes(w));
    return overlap
      ? { route: true, reason: 'option-overlap' }
      : { route: false, reason: 'unrelated-to-options' };
  }

  // No options: a yes/no consent. A question is never an answer to it, and a
  // long utterance is a new command.
  if (/\?\s*$/.test(text)) return { route: false, reason: 'question-is-command' };
  if (text.split(/\s+/).length <= 4) return { route: true, reason: 'short-reply' };
  return { route: false, reason: 'long-utterance-is-command' };
}

module.exports = { isAnswerToPending };
