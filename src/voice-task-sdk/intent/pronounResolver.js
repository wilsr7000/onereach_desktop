/**
 * Pronoun Resolver
 * 
 * Resolves pronouns like "it", "that", "this" using recent conversation context.
 * Enables natural followup interactions like "play it" or "what about that one".
 */

// Pronouns that typically refer to recent context
const PRONOUNS = ['it', 'that', 'this', 'that one', 'this one', 'the same', 'them', 'those'];

// Patterns that indicate a followup reference needing resolution
const FOLLOWUP_PATTERNS = [
  /\b(play|open|show|tell me about|what about|how about)\s+(it|that|this|that one)\b/i,
  /\b(do|try|use|get)\s+(that|this|it)\b/i,
  /\bthe same\s+(one|thing)?\b/i,
  /\b(what|where|when|who|how)\s+(is|are|was|were)\s+(it|that|this)\b/i,
  /\bmore about\s+(it|that|this)\b/i,
  /\b(and|but|also)\s+(that|this|it)\b/i,
  /^(it|that|this|that one)$/i,  // Just the pronoun alone
];

const pronounResolver = {
  /**
   * Check if transcript contains pronouns that need resolution
   * @param {string} transcript - User's input
   * @returns {boolean}
   */
  needsResolution(transcript) {
    if (!transcript || typeof transcript !== 'string') return false;
    const lower = transcript.toLowerCase().trim();
    return FOLLOWUP_PATTERNS.some(pattern => pattern.test(lower));
  },
  
  /**
   * Resolve pronouns using recent context
   * @param {string} transcript - User's input
   * @param {Array} recentContext - Recent conversation items [{subject, response, timestamp}]
   * @returns {{ resolved: string, wasResolved: boolean, referencedSubject: string|null }}
   */
  resolve(transcript, recentContext = []) {
    if (!this.needsResolution(transcript)) {
      return { 
        resolved: transcript, 
        wasResolved: false, 
        referencedSubject: null 
      };
    }
    
    // Find the most recent subject to reference
    const recent = recentContext[0];
    if (!recent?.subject) {
      return { 
        resolved: transcript, 
        wasResolved: false, 
        referencedSubject: null 
      };
    }
    
    const subject = recent.subject;
    let resolved = transcript;
    
    // Replace pronouns with the subject
    // Be careful to only replace in appropriate contexts
    for (const pattern of FOLLOWUP_PATTERNS) {
      if (pattern.test(resolved)) {
        // Replace each pronoun with the subject
        for (const pronoun of PRONOUNS) {
          // Use word boundary to avoid partial matches
          const pronounRegex = new RegExp(`\\b${pronoun}\\b`, 'gi');
          if (pronounRegex.test(resolved)) {
            resolved = resolved.replace(pronounRegex, subject);
            break; // Only replace one pronoun type per pass
          }
        }
        break; // Only match one pattern
      }
    }
    
    const wasResolved = resolved !== transcript;
    
    if (wasResolved) {
      console.log(`[PronounResolver] Resolved: "${transcript}" → "${resolved}"`);
    }
    
    return {
      resolved,
      wasResolved,
      referencedSubject: wasResolved ? subject : null
    };
  },
  
  /**
   * Extract the subject from a task for future reference
   * This is what will be stored in recentContext for later pronoun resolution
   * @param {string} transcript - Original user input
   * @returns {string|null} - The subject to store in context
   */
  extractSubject(transcript) {
    if (!transcript || typeof transcript !== 'string') return null;
    
    const lower = transcript.toLowerCase();
    
    // Extract subject from common patterns
    const patterns = [
      // "play [song/artist]"
      /\bplay\s+(.+?)(?:\s+on\s+\w+|\s+in\s+\w+|$)/i,
      // "what's the weather in [city]"
      /weather\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i,
      // "tell me about [topic]"
      /tell me about\s+(.+?)(?:\?|$)/i,
      // "what is [thing]" / "what's [thing]"
      /what(?:'s| is| are)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      // "search for [query]"  
      /search\s+(?:for\s+)?(.+?)(?:\?|$)/i,
      // "find [thing]"
      /find\s+(.+?)(?:\?|$)/i,
      // "open [app/file]"
      /open\s+(.+?)$/i,
      // "set volume to [level]"
      /set\s+(?:the\s+)?volume\s+(?:to\s+)?(\d+)/i,
    ];
    
    for (const pattern of patterns) {
      const match = transcript.match(pattern);
      if (match && match[1]) {
        const subject = match[1].trim();
        // Filter out common non-subjects
        if (subject && !['it', 'that', 'this', 'something', 'anything'].includes(subject.toLowerCase())) {
          return subject;
        }
      }
    }
    
    // Fallback: use the whole transcript for short simple commands
    if (transcript.length < 40 && !this.needsResolution(transcript)) {
      return transcript;
    }
    
    return null;
  },
  
  /**
   * Check if a transcript is just a simple followup (pronoun only or very short)
   * @param {string} transcript
   * @returns {boolean}
   */
  isSimpleFollowup(transcript) {
    if (!transcript) return false;
    const lower = transcript.toLowerCase().trim();
    // Just a pronoun or very short pronoun phrase
    return /^(it|that|this|that one|this one|the same|the same one|same)$/i.test(lower) ||
           /^(and|or|but|also)\s+(that|this|it)$/i.test(lower);
  }
};

module.exports = pronounResolver;
