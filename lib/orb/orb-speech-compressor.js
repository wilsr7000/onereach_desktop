/**
 * Orb Speech Compressor
 *
 * Strips conversational filler from agent responses before TTS.
 * Machine mode: data first, no greetings, no hedging, no padding.
 *
 * Loaded as a <script> in orb.html after orb-response-router.js.
 * Exposes window.OrbSpeechCompressor namespace.
 */

'use strict';

(function () {
  const LEADING_FILLER = [
    /^(sure|of course|absolutely|certainly|great|alright|okay so|well|hey|hi|hello|hey there)[,!.\s]*/i,
    /^(i'd be happy to|i can help with that|let me|here's what i found|here you go)[,!.\s]*/i,
    /^(i've|i have) (just |)(completed|finished|done|set|saved|created|updated|deleted|sent) (that|this|it)[,.\s]*/i,
    /^(no problem|you got it|right away|on it)[,!.\s]*/i,
  ];

  const TRAILING_FILLER = [
    /[,.\s]*(let me know if you need anything else|is there anything else( i can help with)?|feel free to ask|hope that helps|happy to help)[.!]?\s*$/i,
    /[,.\s]*(would you like me to do anything else|do you want me to|shall i|anything else)[?]?\s*$/i,
    /[,.\s]*(if you have any (more |)questions)[,.]?\s*$/i,
  ];

  const VERBOSE_PATTERNS = [
    { pattern: /^you (currently )?have (\d+)/i, replace: '$2' },
    { pattern: /^there (are|is) (\d+)/i, replace: '$2' },
    { pattern: /^i (found|see) (\d+)/i, replace: '$2' },
    { pattern: /as of (right now|today|currently)/gi, replace: '' },
    { pattern: /\bit (appears|seems|looks like) (that )?/gi, replace: '' },
    { pattern: /\bbasically[,]?\s*/gi, replace: '' },
    { pattern: /\bessentially[,]?\s*/gi, replace: '' },
    { pattern: /\bactually[,]?\s*/gi, replace: '' },
    { pattern: /\bjust (wanted to |)(let you know|mention) (that )?/gi, replace: '' },
  ];

  /**
   * Compress a speech string for machine-mode delivery.
   * @param {string} text - Raw agent response text
   * @returns {string} Compressed text
   */
  function compress(text) {
    if (!text || typeof text !== 'string') return text || '';

    let result = text.trim();

    for (const re of LEADING_FILLER) {
      result = result.replace(re, '');
    }

    for (const re of TRAILING_FILLER) {
      result = result.replace(re, '');
    }

    for (const { pattern, replace } of VERBOSE_PATTERNS) {
      result = result.replace(pattern, replace);
    }

    // Collapse multiple spaces and trim
    result = result.replace(/\s{2,}/g, ' ').trim();

    // Capitalize first letter if it was lost
    if (result.length > 0 && /[a-z]/.test(result[0])) {
      result = result[0].toUpperCase() + result.slice(1);
    }

    return result;
  }

  /**
   * Extract just the first sentence from a longer response (for "brief" mode).
   * @param {string} text
   * @returns {string}
   */
  function headline(text) {
    if (!text) return '';
    const compressed = compress(text);
    const match = compressed.match(/^[^.!?]+[.!?]/);
    return match ? match[0].trim() : compressed;
  }

  window.OrbSpeechCompressor = {
    compress,
    headline,
  };
})();
