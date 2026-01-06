/**
 * QuoteFinder.js - AI-Powered Quote Detection
 * 
 * Features:
 * - Find best quotable moments in content
 * - Topic segmentation and detection
 * - Sound bite extraction for podcasts
 * - Quote ranking by shareability
 */

/**
 * Quote scoring factors
 */
const QUOTE_FACTORS = {
  CONCISENESS: 0.25,    // Short and punchy
  IMPACT: 0.25,         // Strong statement
  MEMORABILITY: 0.20,   // Likely to be remembered
  SHAREABILITY: 0.15,   // Good for social
  STANDALONE: 0.15      // Works out of context
};

/**
 * Quote patterns for detection
 */
const QUOTE_PATTERNS = {
  impactful: [
    /the (key|secret|truth|most important|real|biggest)/i,
    /here's (what|the thing)/i,
    /never forget/i,
    /always remember/i,
    /the moment I realized/i
  ],
  memorable: [
    /if you (only|just) (remember|take away)/i,
    /this (changed|will change)/i,
    /I learned that/i,
    /what (nobody|no one) tells you/i
  ],
  emotional: [
    /I (love|hate|believe|feel)/i,
    /honestly/i,
    /the truth is/i,
    /I have to say/i
  ]
};

/**
 * QuoteFinder - Find and rank quotes
 */
export class QuoteFinder {
  constructor(appContext) {
    this.app = appContext;
    
    // Results
    this.quotes = [];
    this.topics = [];
    
    // Configuration
    this.minQuoteLength = 5;   // Words
    this.maxQuoteLength = 50;  // Words
    this.maxQuotes = 20;
    
    // Analysis state
    this.isAnalyzing = false;
    
    // Event listeners
    this.eventListeners = {};
  }

  /**
   * Find best quotes in transcript
   * @param {Array} transcriptSegments - Transcript segments
   * @param {Object} options - Options
   * @returns {Promise<Array>} Quotes ranked by score
   */
  async findBestQuotes(transcriptSegments, options = {}) {
    const { 
      maxQuotes = this.maxQuotes,
      minLength = this.minQuoteLength,
      maxLength = this.maxQuoteLength
    } = options;
    
    this.isAnalyzing = true;
    this.emit('analysisStarted');
    
    try {
      const words = this.expandToWords(transcriptSegments);
      const sentences = this.extractSentences(words);
      
      // Score each sentence/phrase
      const candidates = [];
      
      for (const sentence of sentences) {
        const wordCount = sentence.words.length;
        
        // Skip if too short or too long
        if (wordCount < minLength || wordCount > maxLength) continue;
        
        const score = this.scoreQuote(sentence);
        
        if (score.total >= 5) { // Threshold
          candidates.push({
            text: sentence.text,
            speaker: sentence.speaker,
            startTime: sentence.startTime,
            endTime: sentence.endTime,
            wordCount,
            score: score.total,
            scoreBreakdown: score.factors,
            reason: this.getQuoteReason(score),
            suggestedUse: this.suggestUse(score, wordCount)
          });
        }
      }
      
      // Sort by score and take top N
      this.quotes = candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, maxQuotes);
      
      this.isAnalyzing = false;
      this.emit('analysisComplete', { quotes: this.quotes });
      
      return this.quotes;
      
    } catch (error) {
      this.isAnalyzing = false;
      this.emit('analysisError', { error });
      throw error;
    }
  }

  /**
   * Detect topic changes in transcript
   * @param {Array} transcriptSegments - Transcript segments
   * @returns {Promise<Array>} Topic segments
   */
  async detectTopics(transcriptSegments) {
    this.emit('topicDetectionStarted');
    
    try {
      const words = this.expandToWords(transcriptSegments);
      this.topics = [];
      
      // Simple topic detection based on keywords and speaker changes
      let currentTopic = {
        title: 'Introduction',
        startTime: 0,
        endTime: 0,
        keywords: [],
        speakers: new Set(),
        summary: ''
      };
      
      const TOPIC_KEYWORDS = [
        'so,', 'now,', 'next', 'moving on', 'let\'s talk about',
        'another thing', 'the next', 'one more', 'speaking of',
        'on that note', 'that reminds me', 'actually'
      ];
      
      let lastBreakIdx = 0;
      
      for (let i = 0; i < words.length; i++) {
        const window = words.slice(Math.max(0, i - 3), i + 3).map(w => w.text).join(' ').toLowerCase();
        
        // Check for topic change indicators
        const hasTopicKeyword = TOPIC_KEYWORDS.some(kw => window.includes(kw));
        const speakerChanged = i > 0 && words[i].speaker && words[i].speaker !== words[i - 1].speaker;
        const significantPause = i > 0 && (words[i].start - words[i - 1].end) > 3;
        
        // Check if enough content since last break
        const contentSinceBreak = i - lastBreakIdx;
        
        if ((hasTopicKeyword || significantPause) && contentSinceBreak > 50) {
          // Finalize current topic
          currentTopic.endTime = words[i - 1].end;
          currentTopic.keywords = this.extractKeywords(
            words.slice(lastBreakIdx, i).map(w => w.text).join(' ')
          );
          currentTopic.speakers = Array.from(currentTopic.speakers);
          this.topics.push(currentTopic);
          
          // Start new topic
          lastBreakIdx = i;
          currentTopic = {
            title: this.generateTopicTitle(words.slice(i, Math.min(i + 20, words.length))),
            startTime: words[i].start,
            endTime: 0,
            keywords: [],
            speakers: new Set(),
            summary: ''
          };
        }
        
        // Track speaker
        if (words[i].speaker) {
          currentTopic.speakers.add(words[i].speaker);
        }
      }
      
      // Add final topic
      if (words.length > lastBreakIdx) {
        currentTopic.endTime = words[words.length - 1].end;
        currentTopic.keywords = this.extractKeywords(
          words.slice(lastBreakIdx).map(w => w.text).join(' ')
        );
        currentTopic.speakers = Array.from(currentTopic.speakers);
        this.topics.push(currentTopic);
      }
      
      this.emit('topicDetectionComplete', { topics: this.topics });
      
      return this.topics;
      
    } catch (error) {
      this.emit('topicDetectionError', { error });
      throw error;
    }
  }

  /**
   * Extract sentences from words
   * @param {Array} words - Words with timing
   * @returns {Array} Sentences
   */
  extractSentences(words) {
    const sentences = [];
    let currentSentence = {
      words: [],
      text: '',
      speaker: null,
      startTime: 0,
      endTime: 0
    };
    
    words.forEach((word, idx) => {
      if (currentSentence.words.length === 0) {
        currentSentence.startTime = word.start;
        currentSentence.speaker = word.speaker;
      }
      
      currentSentence.words.push(word);
      currentSentence.endTime = word.end;
      
      // Check for sentence end
      if (/[.!?]$/.test(word.text) || idx === words.length - 1) {
        currentSentence.text = currentSentence.words.map(w => w.text).join(' ');
        sentences.push(currentSentence);
        
        currentSentence = {
          words: [],
          text: '',
          speaker: null,
          startTime: 0,
          endTime: 0
        };
      }
    });
    
    return sentences;
  }

  /**
   * Score a potential quote
   * @param {Object} sentence - Sentence to score
   * @returns {Object} Score with factors
   */
  scoreQuote(sentence) {
    const factors = {};
    const text = sentence.text.toLowerCase();
    
    // Conciseness (shorter is better, up to a point)
    const wordCount = sentence.words.length;
    if (wordCount <= 15) {
      factors.conciseness = 8 + (15 - wordCount) * 0.1;
    } else if (wordCount <= 25) {
      factors.conciseness = 7;
    } else {
      factors.conciseness = Math.max(3, 7 - (wordCount - 25) * 0.1);
    }
    
    // Impact - strong statements
    factors.impact = 5;
    QUOTE_PATTERNS.impactful.forEach(pattern => {
      if (pattern.test(text)) factors.impact += 2;
    });
    factors.impact = Math.min(10, factors.impact);
    
    // Memorability
    factors.memorability = 5;
    QUOTE_PATTERNS.memorable.forEach(pattern => {
      if (pattern.test(text)) factors.memorability += 2;
    });
    
    // Check for concrete numbers or specifics
    if (/\d+/.test(text)) factors.memorability += 1;
    
    factors.memorability = Math.min(10, factors.memorability);
    
    // Shareability
    factors.shareability = 5;
    
    // Emotional content is more shareable
    QUOTE_PATTERNS.emotional.forEach(pattern => {
      if (pattern.test(text)) factors.shareability += 1.5;
    });
    
    // First person is more relatable
    if (/\b(I|we|my|our)\b/i.test(text)) {
      factors.shareability += 1;
    }
    
    factors.shareability = Math.min(10, factors.shareability);
    
    // Standalone - works without context
    factors.standalone = 5;
    
    // Pronouns without antecedent reduce standalone score
    if (/^(he|she|it|they|this|that)\b/i.test(text)) {
      factors.standalone -= 2;
    }
    
    // Complete thought indicators
    if (/\.$/.test(sentence.text.trim())) {
      factors.standalone += 1;
    }
    
    // Self-contained wisdom/advice
    if (/you (should|must|need to|can|will)/i.test(text)) {
      factors.standalone += 1;
    }
    
    factors.standalone = Math.max(0, Math.min(10, factors.standalone));
    
    // Calculate weighted total
    const total = (
      factors.conciseness * QUOTE_FACTORS.CONCISENESS +
      factors.impact * QUOTE_FACTORS.IMPACT +
      factors.memorability * QUOTE_FACTORS.MEMORABILITY +
      factors.shareability * QUOTE_FACTORS.SHAREABILITY +
      factors.standalone * QUOTE_FACTORS.STANDALONE
    );
    
    return { total: Math.round(total * 10) / 10, factors };
  }

  /**
   * Get reason why quote is good
   * @param {Object} score - Score object
   * @returns {string} Reason
   */
  getQuoteReason(score) {
    const reasons = [];
    
    if (score.factors.conciseness >= 8) reasons.push('concise');
    if (score.factors.impact >= 7) reasons.push('impactful');
    if (score.factors.memorability >= 7) reasons.push('memorable');
    if (score.factors.shareability >= 7) reasons.push('shareable');
    if (score.factors.standalone >= 7) reasons.push('standalone');
    
    if (reasons.length === 0) return 'Good quote candidate';
    
    return reasons.slice(0, 2).map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(', ');
  }

  /**
   * Suggest use for quote
   * @param {Object} score - Score object
   * @param {number} wordCount - Word count
   * @returns {string} Suggested use
   */
  suggestUse(score, wordCount) {
    if (wordCount <= 10 && score.factors.shareability >= 7) {
      return 'social_clip';
    }
    if (wordCount <= 15 && score.factors.standalone >= 7) {
      return 'audiogram';
    }
    if (score.factors.impact >= 7) {
      return 'pull_quote';
    }
    if (wordCount <= 20) {
      return 'highlight';
    }
    return 'featured_moment';
  }

  /**
   * Extract keywords from text
   * @param {string} text - Text to analyze
   * @returns {Array} Keywords
   */
  extractKeywords(text) {
    const words = text.toLowerCase().split(/\s+/);
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'and', 'but', 'or',
      'so', 'if', 'then', 'than', 'that', 'this', 'it', 'to', 'of',
      'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
      'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our'
    ]);
    
    const wordFreq = {};
    words.forEach(word => {
      const cleaned = word.replace(/[^\w]/g, '');
      if (cleaned.length > 3 && !stopWords.has(cleaned)) {
        wordFreq[cleaned] = (wordFreq[cleaned] || 0) + 1;
      }
    });
    
    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Generate topic title from words
   * @param {Array} words - First words of topic
   * @returns {string} Topic title
   */
  generateTopicTitle(words) {
    const text = words.map(w => w.text).join(' ');
    
    // Try to find a key phrase
    const patterns = [
      /(?:about|discuss|talk about|cover) (.+?)(?:\.|,|$)/i,
      /(?:topic|subject|question) (?:is|of) (.+?)(?:\.|,|$)/i
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim().substring(0, 50);
      }
    }
    
    // Fall back to first few meaningful words
    return text.split(/\s+/).slice(0, 5).join(' ') + '...';
  }

  /**
   * Expand transcript segments to words
   * @param {Array} segments - Transcript segments
   * @returns {Array} Words with timing
   */
  expandToWords(segments) {
    const words = [];
    
    segments.forEach(segment => {
      const text = (segment.text || segment.word || '').trim();
      const startTime = segment.start || 0;
      const endTime = segment.end || (startTime + 1);
      const speaker = segment.speaker || null;
      
      if (!text.includes(' ')) {
        if (text.length > 0) {
          words.push({ text, start: startTime, end: endTime, speaker });
        }
        return;
      }
      
      const segmentWords = text.split(/\s+/).filter(w => w.length > 0);
      const duration = endTime - startTime;
      const wordDuration = duration / segmentWords.length;
      
      segmentWords.forEach((word, i) => {
        words.push({
          text: word,
          start: startTime + (i * wordDuration),
          end: startTime + ((i + 1) * wordDuration),
          speaker
        });
      });
    });
    
    return words;
  }

  /**
   * Get all quotes
   * @returns {Array} Quotes
   */
  getQuotes() {
    return [...this.quotes];
  }

  /**
   * Get top N quotes
   * @param {number} n - Number of quotes
   * @returns {Array} Top quotes
   */
  getTopQuotes(n = 5) {
    return this.quotes.slice(0, n);
  }

  /**
   * Get quotes by speaker
   * @param {string} speaker - Speaker name
   * @returns {Array} Speaker's quotes
   */
  getQuotesBySpeaker(speaker) {
    return this.quotes.filter(q => q.speaker === speaker);
  }

  /**
   * Get all topics
   * @returns {Array} Topics
   */
  getTopics() {
    return [...this.topics];
  }

  /**
   * Convert quotes to markers
   * @param {Object} markerManager - Marker manager
   */
  convertToMarkers(markerManager) {
    if (!markerManager) return;
    
    this.quotes.forEach(quote => {
      markerManager.addSpotMarker(
        quote.startTime,
        `💬 ${quote.text.substring(0, 30)}...`,
        '#8b5cf6',
        {
          description: quote.text,
          markerType: 'quote',
          score: quote.score,
          suggestedUse: quote.suggestedUse
        }
      );
    });
  }

  // Event emitter methods
  
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }

  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Reset state
   */
  reset() {
    this.quotes = [];
    this.topics = [];
    this.isAnalyzing = false;
  }
}

export default QuoteFinder;







