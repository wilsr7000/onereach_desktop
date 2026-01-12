/**
 * HookDetector.js - Find Hook-Worthy Moments Throughout Video
 * 
 * Features:
 * - Analyzes entire video for attention-grabbing moments
 * - Multi-factor scoring (curiosity gap, energy, pattern interrupt, emotion)
 * - Ranks all hooks and suggests best opening
 * - Template-aware hook detection
 */

/**
 * Hook scoring factors and their weights
 */
const HOOK_FACTORS = {
  CURIOSITY_GAP: { weight: 0.25, label: 'Curiosity Gap' },
  ENERGY_SPIKE: { weight: 0.20, label: 'Energy Spike' },
  PATTERN_INTERRUPT: { weight: 0.20, label: 'Pattern Interrupt' },
  EMOTIONAL_PEAK: { weight: 0.15, label: 'Emotional Peak' },
  VISUAL_INTEREST: { weight: 0.10, label: 'Visual Interest' },
  BOLDNESS: { weight: 0.10, label: 'Boldness' }
};

/**
 * Keywords and patterns for hook detection
 */
const HOOK_PATTERNS = {
  curiosityGap: [
    /here'?s? (the|what|why|how)/i,
    /what (nobody|no one|most people don'?t)/i,
    /the (secret|truth|real|biggest|one thing)/i,
    /you won'?t believe/i,
    /this (changed|will change)/i,
    /\?$/,  // Questions
    /let me (tell|show|explain)/i
  ],
  patternInterrupt: [
    /wait/i,
    /stop/i,
    /actually/i,
    /but here'?s the thing/i,
    /wrong/i,
    /mistake/i,
    /completely/i,
    /forget (everything|what)/i
  ],
  emotional: [
    /honestly/i,
    /i (love|hate|can'?t stand)/i,
    /amazing/i,
    /terrible/i,
    /passionate/i,
    /\!/,  // Exclamations
    /crazy/i,
    /unbelievable/i
  ],
  boldness: [
    /never/i,
    /always/i,
    /best/i,
    /worst/i,
    /only way/i,
    /guaranteed/i,
    /definitely/i,
    /absolutely/i
  ]
};

/**
 * HookDetector - Find and rank hook-worthy moments
 */
export class HookDetector {
  constructor(appContext) {
    this.app = appContext;
    
    // Analysis state
    this.hooks = [];
    this.currentOpeningScore = null;
    this.isAnalyzing = false;
    
    // Configuration
    this.windowSize = 5; // Seconds per analysis window
    this.hookThreshold = 5; // Minimum score to be considered a hook (out of 10)
    
    // Event listeners
    this.eventListeners = {};
  }

  /**
   * Analyze video for hook-worthy moments
   * @param {string} videoPath - Path to video file
   * @param {Array} transcriptSegments - Transcript segments
   * @param {Object} audioAnalysis - Audio analysis data (optional)
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeVideo(videoPath, transcriptSegments, audioAnalysis = null) {
    this.isAnalyzing = true;
    this.hooks = [];
    
    this.emit('analysisStarted');
    
    try {
      // Get words with timing
      const words = this.expandToWords(transcriptSegments);
      const totalDuration = words.length > 0 ? words[words.length - 1].end : 0;
      
      // Create analysis windows
      const windows = this.createAnalysisWindows(words, totalDuration);
      
      // Analyze each window
      for (let i = 0; i < windows.length; i++) {
        const window = windows[i];
        const score = await this.scoreHookPotential(window, audioAnalysis);
        
        if (score.total >= this.hookThreshold) {
          this.hooks.push({
            id: `hook-${i}`,
            startTime: window.start,
            endTime: window.end,
            transcript: window.text,
            score: score.total,
            breakdown: score.factors,
            classification: this.classifyHook(score),
            thumbnail: null // Can be populated later
          });
        }
        
        this.emit('windowAnalyzed', {
          index: i,
          total: windows.length,
          progress: ((i + 1) / windows.length) * 100
        });
      }
      
      // Sort by score
      this.hooks.sort((a, b) => b.score - a.score);
      
      // Score current opening
      this.currentOpeningScore = await this.scoreCurrentOpening(windows.slice(0, 2));
      
      // Find best opening suggestion
      const bestOpening = this.findBestOpening();
      
      const results = {
        hooks: this.hooks,
        currentOpeningScore: this.currentOpeningScore,
        openingSuggestion: bestOpening,
        totalHooksFound: this.hooks.length,
        analysisComplete: true
      };
      
      this.isAnalyzing = false;
      this.emit('analysisComplete', results);
      
      return results;
      
    } catch (error) {
      this.isAnalyzing = false;
      this.emit('analysisError', { error });
      throw error;
    }
  }

  /**
   * Create analysis windows from words
   * @param {Array} words - Words with timing
   * @param {number} totalDuration - Total video duration
   * @returns {Array} Analysis windows
   */
  createAnalysisWindows(words, totalDuration) {
    const windows = [];
    
    for (let t = 0; t < totalDuration; t += this.windowSize / 2) { // 50% overlap
      const windowStart = t;
      const windowEnd = Math.min(t + this.windowSize, totalDuration);
      
      const windowWords = words.filter(w => w.start >= windowStart && w.end <= windowEnd);
      
      if (windowWords.length > 0) {
        windows.push({
          start: windowStart,
          end: windowEnd,
          words: windowWords,
          text: windowWords.map(w => w.text).join(' ')
        });
      }
    }
    
    return windows;
  }

  /**
   * Score hook potential for a window
   * @param {Object} window - Analysis window
   * @param {Object} audioAnalysis - Audio analysis data
   * @returns {Object} Score with breakdown
   */
  async scoreHookPotential(window, audioAnalysis) {
    const factors = {};
    
    // Score curiosity gap
    factors.curiosityGap = this.scoreCuriosityGap(window.text);
    
    // Score energy spike
    factors.energySpike = this.scoreEnergySpike(window, audioAnalysis);
    
    // Score pattern interrupt
    factors.patternInterrupt = this.scorePatternInterrupt(window.text);
    
    // Score emotional peak
    factors.emotionalPeak = this.scoreEmotionalPeak(window.text);
    
    // Score visual interest (if available)
    factors.visualInterest = await this.scoreVisualInterest(window);
    
    // Score boldness
    factors.boldness = this.scoreBoldness(window.text);
    
    // Calculate weighted total
    let total = 0;
    Object.entries(HOOK_FACTORS).forEach(([key, config]) => {
      const factorKey = key.charAt(0).toLowerCase() + key.slice(1).replace(/_([a-z])/g, (m, c) => c.toUpperCase());
      const score = factors[factorKey] || 0;
      total += score * config.weight;
    });
    
    // Scale to 0-10
    total = Math.min(10, total);
    
    return { total, factors };
  }

  /**
   * Score curiosity gap factor
   * @param {string} text - Text to analyze
   * @returns {number} Score 0-10
   */
  scoreCuriosityGap(text) {
    let score = 0;
    
    HOOK_PATTERNS.curiosityGap.forEach(pattern => {
      if (pattern.test(text)) {
        score += 3;
      }
    });
    
    // Bonus for questions
    const questionCount = (text.match(/\?/g) || []).length;
    score += questionCount * 2;
    
    // Bonus for incomplete thoughts (ellipsis, trailing)
    if (/\.\.\./.test(text)) score += 2;
    
    return Math.min(10, score);
  }

  /**
   * Score energy spike factor
   * @param {Object} window - Analysis window
   * @param {Object} audioAnalysis - Audio analysis data
   * @returns {number} Score 0-10
   */
  scoreEnergySpike(window, audioAnalysis) {
    let score = 5; // Base score
    
    // Check audio analysis if available
    if (audioAnalysis) {
      const windowRMS = this.getAudioRMSForWindow(window, audioAnalysis);
      const averageRMS = audioAnalysis.averageRMS || 0.5;
      
      if (windowRMS > averageRMS * 1.5) {
        score += 3;
      } else if (windowRMS > averageRMS * 1.2) {
        score += 2;
      }
    }
    
    // Text-based energy indicators
    const exclamations = (window.text.match(/!/g) || []).length;
    score += Math.min(2, exclamations);
    
    // Word intensity
    const intensiveWords = /incredible|amazing|fantastic|absolutely|definitely/gi;
    const intensityMatches = window.text.match(intensiveWords) || [];
    score += Math.min(2, intensityMatches.length);
    
    return Math.min(10, score);
  }

  /**
   * Score pattern interrupt factor
   * @param {string} text - Text to analyze
   * @returns {number} Score 0-10
   */
  scorePatternInterrupt(text) {
    let score = 0;
    
    HOOK_PATTERNS.patternInterrupt.forEach(pattern => {
      if (pattern.test(text)) {
        score += 3;
      }
    });
    
    // Contradictions
    if (/but actually|however|on the contrary/i.test(text)) {
      score += 3;
    }
    
    // Surprising starts
    if (/^(wait|stop|no|actually)/i.test(text.trim())) {
      score += 2;
    }
    
    return Math.min(10, score);
  }

  /**
   * Score emotional peak factor
   * @param {string} text - Text to analyze
   * @returns {number} Score 0-10
   */
  scoreEmotionalPeak(text) {
    let score = 0;
    
    HOOK_PATTERNS.emotional.forEach(pattern => {
      if (pattern.test(text)) {
        score += 2;
      }
    });
    
    // Personal stories
    if (/I (remember|felt|realized|discovered|learned)/i.test(text)) {
      score += 2;
    }
    
    // Vulnerability
    if (/scared|nervous|worried|excited|thrilled/i.test(text)) {
      score += 2;
    }
    
    return Math.min(10, score);
  }

  /**
   * Score visual interest factor (async for potential frame analysis)
   * @param {Object} window - Analysis window
   * @returns {Promise<number>} Score 0-10
   */
  async scoreVisualInterest(window) {
    // Without actual frame analysis, use heuristics
    let score = 5; // Base score
    
    // Text mentions of visual elements
    if (/look at|watch|see|show|demonstrate/i.test(window.text)) {
      score += 2;
    }
    
    // Action words suggesting movement
    if (/moving|running|jumping|dancing|gesturing/i.test(window.text)) {
      score += 2;
    }
    
    return Math.min(10, score);
  }

  /**
   * Score boldness factor
   * @param {string} text - Text to analyze
   * @returns {number} Score 0-10
   */
  scoreBoldness(text) {
    let score = 0;
    
    HOOK_PATTERNS.boldness.forEach(pattern => {
      if (pattern.test(text)) {
        score += 2;
      }
    });
    
    // Strong claims
    if (/you (must|need to|should|have to)/i.test(text)) {
      score += 2;
    }
    
    // Definitive statements
    if (/the (only|best|worst|most important)/i.test(text)) {
      score += 2;
    }
    
    return Math.min(10, score);
  }

  /**
   * Get audio RMS for a window
   * @param {Object} window - Analysis window
   * @param {Object} audioAnalysis - Audio analysis data
   * @returns {number} RMS value
   */
  getAudioRMSForWindow(window, audioAnalysis) {
    if (!audioAnalysis || !audioAnalysis.rmsTimeline) {
      return 0.5; // Default mid-value
    }
    
    // Find RMS values within window
    const rmsInWindow = audioAnalysis.rmsTimeline.filter(
      r => r.time >= window.start && r.time <= window.end
    );
    
    if (rmsInWindow.length === 0) return 0.5;
    
    return rmsInWindow.reduce((sum, r) => sum + r.value, 0) / rmsInWindow.length;
  }

  /**
   * Classify hook type based on scores
   * @param {Object} score - Score with factors
   * @returns {string} Hook classification
   */
  classifyHook(score) {
    const factors = score.factors;
    
    if (factors.curiosityGap >= 8) return 'teaser-opening';
    if (factors.emotionalPeak >= 8) return 'emotional-hook';
    if (factors.energySpike >= 8) return 'high-energy-cut';
    if (factors.patternInterrupt >= 8) return 'pattern-interrupt';
    if (factors.boldness >= 8) return 'bold-statement';
    
    return 'strong-moment';
  }

  /**
   * Score current video opening
   * @param {Array} openingWindows - First few analysis windows
   * @returns {Object} Opening score
   */
  async scoreCurrentOpening(openingWindows) {
    if (!openingWindows || openingWindows.length === 0) {
      return { score: 0, issues: ['No opening content found'] };
    }
    
    // Combine first windows
    const combinedText = openingWindows.map(w => w.text).join(' ');
    const combinedWindow = {
      start: openingWindows[0].start,
      end: openingWindows[openingWindows.length - 1].end,
      text: combinedText
    };
    
    const hookScore = await this.scoreHookPotential(combinedWindow);
    
    // Identify issues
    const issues = [];
    
    if (hookScore.factors.curiosityGap < 5) {
      issues.push('Low curiosity - consider opening with a question or mystery');
    }
    if (hookScore.factors.energySpike < 5) {
      issues.push('Low energy - consider starting with more enthusiasm');
    }
    if (/^(hey|hi|hello|welcome)/i.test(combinedText.trim())) {
      issues.push('Generic intro detected - consider jumping straight to value');
    }
    if (hookScore.total < 5) {
      issues.push('Overall weak hook - viewers may not stay past first few seconds');
    }
    
    return {
      score: hookScore.total,
      breakdown: hookScore.factors,
      issues,
      text: combinedText.substring(0, 200),
      recommendation: hookScore.total < 6 ? 'Consider using a different opening' : 'Opening is acceptable'
    };
  }

  /**
   * Find best hook for opening
   * @returns {Object} Best opening suggestion
   */
  findBestOpening() {
    if (this.hooks.length === 0) {
      return null;
    }
    
    // Get top hook
    const topHook = this.hooks[0];
    
    // Check if current opening is already good enough
    if (this.currentOpeningScore && this.currentOpeningScore.score >= 7) {
      return {
        hook: null,
        recommendation: 'Current opening is strong - no change recommended',
        currentScore: this.currentOpeningScore.score,
        bestAvailableScore: topHook.score
      };
    }
    
    return {
      hook: topHook,
      recommendation: `Consider opening with: "${topHook.transcript.substring(0, 100)}..."`,
      currentScore: this.currentOpeningScore?.score || 0,
      bestAvailableScore: topHook.score,
      improvement: topHook.score - (this.currentOpeningScore?.score || 0)
    };
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
      
      if (!text.includes(' ')) {
        if (text.length > 0) {
          words.push({ text, start: startTime, end: endTime });
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
          end: startTime + ((i + 1) * wordDuration)
        });
      });
    });
    
    return words;
  }

  /**
   * Get all detected hooks
   * @returns {Array} Hooks sorted by score
   */
  getHooks() {
    return [...this.hooks];
  }

  /**
   * Get top N hooks
   * @param {number} n - Number of hooks to return
   * @returns {Array} Top hooks
   */
  getTopHooks(n = 5) {
    return this.hooks.slice(0, n);
  }

  /**
   * Get hooks by classification
   * @param {string} classification - Hook classification
   * @returns {Array} Hooks of that type
   */
  getHooksByType(classification) {
    return this.hooks.filter(h => h.classification === classification);
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
   * Reset analyzer state
   */
  reset() {
    this.hooks = [];
    this.currentOpeningScore = null;
    this.isAnalyzing = false;
  }
}

export default HookDetector;











