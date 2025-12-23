/**
 * ZZZDetector.js - Detect Boring/Low-Energy Sections
 * 
 * Features:
 * - Detects monotone delivery, excessive pauses, rambling
 * - Generates auto-edit list (cut, speed up, add B-roll)
 * - Calculates time savings
 * - Severity classification
 */

/**
 * Detection signals and their severity
 */
const ZZZ_SIGNALS = {
  MONOTONE: { severity: 'medium', label: 'Monotone Delivery', editAction: 'speed_up' },
  EXCESSIVE_PAUSE: { severity: 'low', label: 'Long Pause', editAction: 'cut' },
  VERBAL_FILLER: { severity: 'medium', label: 'Verbal Fillers', editAction: 'cut' },
  REPETITION: { severity: 'high', label: 'Repetition', editAction: 'cut' },
  RAMBLING: { severity: 'high', label: 'Rambling', editAction: 'cut' },
  ENERGY_DROP: { severity: 'medium', label: 'Energy Drop', editAction: 'speed_up' },
  STATIC_VISUAL: { severity: 'low', label: 'Static Visual', editAction: 'add_broll' }
};

/**
 * Filler word patterns
 */
const FILLER_PATTERNS = [
  /\bum+\b/gi,
  /\buh+\b/gi,
  /\blike\b/gi,
  /\byou know\b/gi,
  /\bactually\b/gi,
  /\bbasically\b/gi,
  /\bi mean\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bso+\b/gi, // "sooo"
  /\bright\?/gi
];

/**
 * ZZZDetector - Detect boring sections and generate edit decisions
 */
export class ZZZDetector {
  constructor(appContext) {
    this.app = appContext;
    
    // Detection results
    this.zzzSections = [];
    this.autoEditList = null;
    
    // Configuration
    this.windowSize = 10; // Seconds per analysis window
    this.energyThreshold = 40; // Below this = low energy (0-100 scale)
    this.fillerDensityThreshold = 5; // Fillers per 30s
    this.pauseThreshold = 2; // Seconds of silence
    this.repetitionThreshold = 3; // Same phrase repeated
    
    // Analysis state
    this.isAnalyzing = false;
    
    // Event listeners
    this.eventListeners = {};
  }

  /**
   * Analyze video for boring sections
   * @param {string} videoPath - Path to video
   * @param {Array} transcriptSegments - Transcript segments
   * @param {Object} audioAnalysis - Audio analysis data
   * @returns {Promise<Object>} Analysis results
   */
  async analyze(videoPath, transcriptSegments, audioAnalysis = null) {
    this.isAnalyzing = true;
    this.zzzSections = [];
    
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
        const energy = this.calculateEnergy(window, audioAnalysis);
        const signals = this.detectSignals(window, words);
        
        // Check if this window is ZZZ
        if (energy.score < this.energyThreshold || signals.severity === 'high') {
          this.zzzSections.push({
            id: `zzz-${i}`,
            startTime: window.start,
            endTime: window.end,
            duration: window.end - window.start,
            energyScore: energy.score,
            signals: signals.detected,
            severity: signals.severity,
            transcript: window.text,
            suggestedAction: this.suggestAction(energy, signals),
            editDecision: this.generateEditDecision(window, energy, signals)
          });
        }
        
        this.emit('windowAnalyzed', {
          index: i,
          total: windows.length,
          progress: ((i + 1) / windows.length) * 100
        });
      }
      
      // Merge adjacent ZZZ sections
      this.mergeAdjacentSections();
      
      // Generate auto-edit list
      this.autoEditList = this.compileEditList();
      
      const results = {
        sections: this.zzzSections,
        totalZZZTime: this.zzzSections.reduce((sum, s) => sum + s.duration, 0),
        percentageOfVideo: totalDuration > 0 ? 
          (this.zzzSections.reduce((sum, s) => sum + s.duration, 0) / totalDuration) * 100 : 0,
        autoEditList: this.autoEditList,
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
   * Create analysis windows
   * @param {Array} words - Words with timing
   * @param {number} totalDuration - Total duration
   * @returns {Array} Windows
   */
  createAnalysisWindows(words, totalDuration) {
    const windows = [];
    
    for (let t = 0; t < totalDuration; t += this.windowSize) {
      const windowStart = t;
      const windowEnd = Math.min(t + this.windowSize, totalDuration);
      
      const windowWords = words.filter(w => w.start >= windowStart && w.end <= windowEnd);
      
      windows.push({
        start: windowStart,
        end: windowEnd,
        words: windowWords,
        text: windowWords.map(w => w.text).join(' ')
      });
    }
    
    return windows;
  }

  /**
   * Calculate energy score for a window
   * @param {Object} window - Analysis window
   * @param {Object} audioAnalysis - Audio analysis data
   * @returns {Object} Energy assessment
   */
  calculateEnergy(window, audioAnalysis) {
    let score = 50; // Base score
    const factors = [];
    
    // Audio-based energy (if available)
    if (audioAnalysis) {
      const windowRMS = this.getAudioMetricForWindow(window, audioAnalysis, 'rms');
      const avgRMS = audioAnalysis.averageRMS || 0.5;
      
      if (windowRMS < avgRMS * 0.7) {
        score -= 20;
        factors.push('low_volume');
      }
      
      // Pitch variance (monotone detection)
      const pitchVariance = this.getAudioMetricForWindow(window, audioAnalysis, 'pitchVariance');
      if (pitchVariance !== null && pitchVariance < 20) {
        score -= 15;
        factors.push('monotone');
      }
    }
    
    // Text-based energy
    const wordCount = window.words.length;
    const duration = window.end - window.start;
    const wordsPerSecond = wordCount / duration;
    
    // Very slow speech = low energy
    if (wordsPerSecond < 1.5) {
      score -= 15;
      factors.push('slow_speech');
    }
    
    // Check for energy words
    const text = window.text.toLowerCase();
    const energyWords = /exciting|amazing|incredible|fantastic|important|key/gi;
    if (energyWords.test(text)) {
      score += 10;
    }
    
    // Exclamation marks = higher energy
    const exclamations = (window.text.match(/!/g) || []).length;
    score += Math.min(10, exclamations * 3);
    
    return {
      score: Math.max(0, Math.min(100, score)),
      factors
    };
  }

  /**
   * Detect ZZZ signals in a window
   * @param {Object} window - Analysis window
   * @param {Array} allWords - All words for context
   * @returns {Object} Signal detection results
   */
  detectSignals(window, allWords) {
    const detected = [];
    let highestSeverity = 'low';
    
    // Check for excessive filler words
    const fillerCount = this.countFillers(window.text);
    const fillerDensity = (fillerCount / window.words.length) * 30;
    
    if (fillerDensity > this.fillerDensityThreshold) {
      detected.push({
        type: 'VERBAL_FILLER',
        details: `${fillerCount} fillers in ${window.words.length} words`,
        ...ZZZ_SIGNALS.VERBAL_FILLER
      });
      if (ZZZ_SIGNALS.VERBAL_FILLER.severity === 'high') highestSeverity = 'high';
      else if (ZZZ_SIGNALS.VERBAL_FILLER.severity === 'medium' && highestSeverity !== 'high') highestSeverity = 'medium';
    }
    
    // Check for repetition
    const repetitions = this.findRepetitions(window.text);
    if (repetitions.length > 0) {
      detected.push({
        type: 'REPETITION',
        details: `Repeated: ${repetitions.join(', ')}`,
        ...ZZZ_SIGNALS.REPETITION
      });
      highestSeverity = 'high';
    }
    
    // Check for rambling (high word count, low unique information)
    if (this.isRambling(window)) {
      detected.push({
        type: 'RAMBLING',
        details: 'Low information density',
        ...ZZZ_SIGNALS.RAMBLING
      });
      highestSeverity = 'high';
    }
    
    // Check for excessive pauses
    const pauses = this.detectPauses(window.words);
    if (pauses.length > 0) {
      detected.push({
        type: 'EXCESSIVE_PAUSE',
        details: `${pauses.length} pause(s) > ${this.pauseThreshold}s`,
        pauses,
        ...ZZZ_SIGNALS.EXCESSIVE_PAUSE
      });
    }
    
    return {
      detected,
      severity: highestSeverity,
      signalCount: detected.length
    };
  }

  /**
   * Count filler words
   * @param {string} text - Text to analyze
   * @returns {number} Filler count
   */
  countFillers(text) {
    let count = 0;
    FILLER_PATTERNS.forEach(pattern => {
      const matches = text.match(pattern) || [];
      count += matches.length;
    });
    return count;
  }

  /**
   * Find repeated phrases
   * @param {string} text - Text to analyze
   * @returns {Array} Repeated phrases
   */
  findRepetitions(text) {
    const words = text.toLowerCase().split(/\s+/);
    const phrases = {};
    
    // Check 2-4 word phrases
    for (let phraseLen = 2; phraseLen <= 4; phraseLen++) {
      for (let i = 0; i <= words.length - phraseLen; i++) {
        const phrase = words.slice(i, i + phraseLen).join(' ');
        phrases[phrase] = (phrases[phrase] || 0) + 1;
      }
    }
    
    // Return phrases that appear >= threshold times
    return Object.entries(phrases)
      .filter(([phrase, count]) => count >= this.repetitionThreshold && phrase.length > 5)
      .map(([phrase]) => phrase);
  }

  /**
   * Check if window contains rambling
   * @param {Object} window - Analysis window
   * @returns {boolean} Is rambling
   */
  isRambling(window) {
    const words = window.words;
    if (words.length < 20) return false;
    
    // Calculate unique word ratio
    const uniqueWords = new Set(words.map(w => w.text.toLowerCase().replace(/[^\w]/g, '')));
    const uniqueRatio = uniqueWords.size / words.length;
    
    // Low unique ratio with high word count = rambling
    return uniqueRatio < 0.4 && words.length > 30;
  }

  /**
   * Detect pauses in word timing
   * @param {Array} words - Words with timing
   * @returns {Array} Detected pauses
   */
  detectPauses(words) {
    const pauses = [];
    
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap >= this.pauseThreshold) {
        pauses.push({
          start: words[i - 1].end,
          end: words[i].start,
          duration: gap
        });
      }
    }
    
    return pauses;
  }

  /**
   * Suggest action for a ZZZ section
   * @param {Object} energy - Energy assessment
   * @param {Object} signals - Detected signals
   * @returns {string} Suggested action
   */
  suggestAction(energy, signals) {
    // Priority: high severity signals first
    const highSeverity = signals.detected.find(s => s.severity === 'high');
    if (highSeverity) {
      return highSeverity.editAction;
    }
    
    // Very low energy = speed up
    if (energy.score < 30) {
      return 'speed_up';
    }
    
    // Static visual = add b-roll
    const staticVisual = signals.detected.find(s => s.type === 'STATIC_VISUAL');
    if (staticVisual) {
      return 'add_broll';
    }
    
    // Default for medium issues
    return 'speed_up';
  }

  /**
   * Generate edit decision for a ZZZ section
   * @param {Object} window - Analysis window
   * @param {Object} energy - Energy assessment
   * @param {Object} signals - Detected signals
   * @returns {Object} Edit decision
   */
  generateEditDecision(window, energy, signals) {
    const action = this.suggestAction(energy, signals);
    const duration = window.end - window.start;
    
    switch (action) {
      case 'cut':
        return {
          action: 'cut',
          inPoint: window.start,
          outPoint: window.end,
          reason: this.getEditReason(signals),
          timeSaved: duration,
          confidence: signals.severity === 'high' ? 0.9 : 0.7
        };
        
      case 'speed_up':
        const speedFactor = energy.score < 30 ? 1.5 : 1.25;
        return {
          action: 'speed_up',
          inPoint: window.start,
          outPoint: window.end,
          speed: speedFactor,
          reason: `Low energy section (${energy.score}/100)`,
          timeSaved: duration * (1 - 1/speedFactor),
          confidence: 0.8
        };
        
      case 'add_broll':
        return {
          action: 'add_broll',
          inPoint: window.start,
          outPoint: window.end,
          reason: 'Static visual, maintain audio',
          timeSaved: 0,
          confidence: 0.6
        };
        
      default:
        return {
          action: 'review',
          inPoint: window.start,
          outPoint: window.end,
          reason: 'Needs manual review',
          timeSaved: 0,
          confidence: 0.5
        };
    }
  }

  /**
   * Get edit reason from signals
   * @param {Object} signals - Detected signals
   * @returns {string} Reason string
   */
  getEditReason(signals) {
    if (signals.detected.length === 0) {
      return 'Low energy section';
    }
    
    return signals.detected.map(s => s.label).join(', ');
  }

  /**
   * Merge adjacent ZZZ sections
   */
  mergeAdjacentSections() {
    if (this.zzzSections.length < 2) return;
    
    const merged = [];
    let current = this.zzzSections[0];
    
    for (let i = 1; i < this.zzzSections.length; i++) {
      const next = this.zzzSections[i];
      const gap = next.startTime - current.endTime;
      
      // Merge if gap is small and same action
      if (gap < 3 && current.suggestedAction === next.suggestedAction) {
        current = {
          ...current,
          endTime: next.endTime,
          duration: next.endTime - current.startTime,
          signals: [...current.signals, ...next.signals],
          editDecision: {
            ...current.editDecision,
            outPoint: next.endTime,
            timeSaved: current.editDecision.timeSaved + next.editDecision.timeSaved
          }
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    
    merged.push(current);
    this.zzzSections = merged;
  }

  /**
   * Compile complete edit list
   * @returns {Object} Edit list
   */
  compileEditList() {
    const edits = this.zzzSections.map(s => s.editDecision);
    
    const cuts = edits.filter(e => e.action === 'cut');
    const speedUps = edits.filter(e => e.action === 'speed_up');
    const brollNeeded = edits.filter(e => e.action === 'add_broll');
    
    const totalTimeSaved = edits.reduce((sum, e) => sum + (e.timeSaved || 0), 0);
    
    return {
      edits,
      totalTimeSaved,
      summary: {
        cuts: cuts.length,
        speedUps: speedUps.length,
        brollNeeded: brollNeeded.length
      },
      breakdown: {
        cutTime: cuts.reduce((sum, e) => sum + (e.timeSaved || 0), 0),
        speedUpTime: speedUps.reduce((sum, e) => sum + (e.timeSaved || 0), 0)
      }
    };
  }

  /**
   * Get audio metric for window
   * @param {Object} window - Analysis window
   * @param {Object} audioAnalysis - Audio analysis
   * @param {string} metric - Metric name
   * @returns {number|null} Metric value
   */
  getAudioMetricForWindow(window, audioAnalysis, metric) {
    const timeline = audioAnalysis[`${metric}Timeline`];
    if (!timeline) return null;
    
    const windowData = timeline.filter(
      d => d.time >= window.start && d.time <= window.end
    );
    
    if (windowData.length === 0) return null;
    
    return windowData.reduce((sum, d) => sum + d.value, 0) / windowData.length;
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
   * Get all ZZZ sections
   * @returns {Array} ZZZ sections
   */
  getSections() {
    return [...this.zzzSections];
  }

  /**
   * Get auto-edit list
   * @returns {Object} Edit list
   */
  getEditList() {
    return this.autoEditList;
  }

  /**
   * Apply edit list to timeline (integration point)
   * @param {Function} applyCallback - Callback to apply edits
   */
  applyEditList(applyCallback) {
    if (!this.autoEditList || !applyCallback) return;
    
    this.autoEditList.edits.forEach(edit => {
      applyCallback(edit);
    });
    
    this.emit('editsApplied', this.autoEditList);
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
   * Reset detector state
   */
  reset() {
    this.zzzSections = [];
    this.autoEditList = null;
    this.isAnalyzing = false;
  }
}

export default ZZZDetector;


