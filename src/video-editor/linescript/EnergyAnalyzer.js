/**
 * EnergyAnalyzer.js - Multi-Dimensional Energy Analysis
 * 
 * Analyzes video energy across multiple dimensions:
 * - Audio Energy (volume, dynamics, RMS)
 * - Speech Pace (words per minute)
 * - Emotional Intensity (sentiment, passion)
 * - Visual Motion (frame difference, movement)
 * 
 * Provides pacing insights and suggestions
 */

/**
 * Energy dimension weights
 */
const ENERGY_DIMENSIONS = {
  AUDIO: { weight: 0.30, label: 'Audio Energy' },
  SPEECH_PACE: { weight: 0.25, label: 'Speech Pace' },
  EMOTION: { weight: 0.30, label: 'Emotional Intensity' },
  VISUAL: { weight: 0.15, label: 'Visual Motion' }
};

/**
 * Pacing analysis thresholds
 */
const PACING_THRESHOLDS = {
  LOW_ENERGY: 30,
  HIGH_ENERGY: 70,
  PEAK_THRESHOLD: 80,
  VALLEY_THRESHOLD: 25
};

/**
 * EnergyAnalyzer - Comprehensive energy analysis
 */
export class EnergyAnalyzer {
  constructor(appContext) {
    this.app = appContext;
    
    // Analysis results
    this.timeline = [];
    this.peaks = [];
    this.valleys = [];
    this.pacing = null;
    this.suggestions = [];
    
    // Configuration
    this.windowSize = 5; // Seconds per analysis window
    this.duration = 0;
    
    // Analysis state
    this.isAnalyzing = false;
    
    // Event listeners
    this.eventListeners = {};
  }

  /**
   * Analyze full video energy
   * @param {string} videoPath - Path to video
   * @param {Array} transcriptSegments - Transcript segments
   * @param {Object} audioData - Audio analysis data
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeFullVideo(videoPath, transcriptSegments, audioData = null) {
    this.isAnalyzing = true;
    this.timeline = [];
    
    this.emit('analysisStarted');
    
    try {
      // Get words with timing
      const words = this.expandToWords(transcriptSegments);
      this.duration = words.length > 0 ? words[words.length - 1].end : 0;
      
      // Create analysis windows
      const windowCount = Math.ceil(this.duration / this.windowSize);
      
      for (let i = 0; i < windowCount; i++) {
        const windowStart = i * this.windowSize;
        const windowEnd = Math.min((i + 1) * this.windowSize, this.duration);
        const window = { start: windowStart, end: windowEnd };
        
        // Calculate each energy dimension
        const audioEnergy = this.calculateAudioEnergy(window, audioData);
        const speechPace = this.calculateSpeechPace(window, words);
        const emotionalIntensity = await this.analyzeEmotion(window, words);
        const visualMotion = await this.calculateMotion(window, videoPath);
        
        // Calculate composite score
        const composite = (
          audioEnergy * ENERGY_DIMENSIONS.AUDIO.weight +
          speechPace * ENERGY_DIMENSIONS.SPEECH_PACE.weight +
          emotionalIntensity * ENERGY_DIMENSIONS.EMOTION.weight +
          visualMotion * ENERGY_DIMENSIONS.VISUAL.weight
        );
        
        this.timeline.push({
          time: windowStart,
          audioEnergy,
          speechPace,
          emotionalIntensity,
          visualMotion,
          composite: Math.round(composite * 100) / 100
        });
        
        this.emit('windowAnalyzed', {
          index: i,
          total: windowCount,
          progress: ((i + 1) / windowCount) * 100
        });
      }
      
      // Find peaks and valleys
      this.peaks = this.findPeaks();
      this.valleys = this.findValleys();
      
      // Analyze pacing
      this.pacing = this.analyzePacing();
      
      // Generate suggestions
      this.suggestions = this.generateSuggestions();
      
      const results = {
        timeline: this.timeline,
        peaks: this.peaks,
        valleys: this.valleys,
        pacing: this.pacing,
        suggestions: this.suggestions,
        duration: this.duration,
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
   * Calculate audio energy for a window
   * @param {Object} window - Time window
   * @param {Object} audioData - Audio analysis data
   * @returns {number} Energy score 0-100
   */
  calculateAudioEnergy(window, audioData) {
    if (!audioData || !audioData.rmsTimeline) {
      return 50; // Default mid-value
    }
    
    // Get RMS values in window
    const rmsValues = audioData.rmsTimeline.filter(
      r => r.time >= window.start && r.time <= window.end
    );
    
    if (rmsValues.length === 0) return 50;
    
    // Calculate average RMS
    const avgRMS = rmsValues.reduce((sum, r) => sum + r.value, 0) / rmsValues.length;
    
    // Calculate variance (dynamics)
    const variance = rmsValues.reduce((sum, r) => sum + Math.pow(r.value - avgRMS, 2), 0) / rmsValues.length;
    
    // Combine volume and dynamics
    const volumeScore = Math.min(100, avgRMS * 100);
    const dynamicsScore = Math.min(100, variance * 500);
    
    return (volumeScore * 0.7 + dynamicsScore * 0.3);
  }

  /**
   * Calculate speech pace for a window
   * @param {Object} window - Time window
   * @param {Array} words - Words with timing
   * @returns {number} Pace score 0-100
   */
  calculateSpeechPace(window, words) {
    const windowWords = words.filter(
      w => w.start >= window.start && w.end <= window.end
    );
    
    const duration = window.end - window.start;
    const wordCount = windowWords.length;
    
    // Words per minute
    const wpm = (wordCount / duration) * 60;
    
    // Optimal range is 120-180 WPM
    // Scale to 0-100 where 150 WPM = 75
    let score;
    if (wpm < 80) {
      score = (wpm / 80) * 40; // Slow speech
    } else if (wpm < 120) {
      score = 40 + ((wpm - 80) / 40) * 20; // Below optimal
    } else if (wpm <= 180) {
      score = 60 + ((wpm - 120) / 60) * 30; // Optimal range
    } else if (wpm <= 220) {
      score = 90 - ((wpm - 180) / 40) * 20; // Above optimal
    } else {
      score = 70 - ((wpm - 220) / 50) * 30; // Too fast
    }
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Analyze emotional intensity for a window
   * @param {Object} window - Time window
   * @param {Array} words - Words with timing
   * @returns {Promise<number>} Intensity score 0-100
   */
  async analyzeEmotion(window, words) {
    const windowWords = words.filter(
      w => w.start >= window.start && w.end <= window.end
    );
    
    const text = windowWords.map(w => w.text).join(' ').toLowerCase();
    
    // Simple emotion detection based on keywords
    let score = 50; // Neutral base
    
    // Positive emotions
    const positiveWords = /love|amazing|great|fantastic|excellent|wonderful|happy|excited|thrilled/gi;
    const positiveMatches = (text.match(positiveWords) || []).length;
    score += positiveMatches * 8;
    
    // Negative emotions
    const negativeWords = /hate|terrible|awful|horrible|angry|frustrated|disappointed|worried/gi;
    const negativeMatches = (text.match(negativeWords) || []).length;
    score += negativeMatches * 8; // Still adds energy
    
    // Intensity modifiers
    const intensifiers = /very|really|so|extremely|incredibly|absolutely|totally/gi;
    const intensifierMatches = (text.match(intensifiers) || []).length;
    score += intensifierMatches * 5;
    
    // Exclamation marks
    const exclamations = (text.match(/!/g) || []).length;
    score += exclamations * 10;
    
    // Personal pronouns (engagement)
    const personal = /\bi\b|\bme\b|\bmy\b|\bwe\b|\bour\b|\byou\b|\byour\b/gi;
    const personalMatches = (text.match(personal) || []).length;
    score += Math.min(15, personalMatches * 3);
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate visual motion for a window
   * @param {Object} window - Time window
   * @param {string} videoPath - Path to video
   * @returns {Promise<number>} Motion score 0-100
   */
  async calculateMotion(window, videoPath) {
    // In a full implementation, this would analyze frame differences
    // For now, return a heuristic-based value
    
    // Without actual frame analysis, use random variation around 50
    // Real implementation would capture frames and calculate differences
    const baseScore = 50;
    const variation = (Math.sin(window.start * 0.5) + 1) * 15; // Some variation
    
    return Math.max(0, Math.min(100, baseScore + variation - 15));
  }

  /**
   * Find energy peaks in timeline
   * @returns {Array} Peak points
   */
  findPeaks() {
    const peaks = [];
    
    for (let i = 1; i < this.timeline.length - 1; i++) {
      const prev = this.timeline[i - 1].composite;
      const curr = this.timeline[i].composite;
      const next = this.timeline[i + 1].composite;
      
      if (curr > prev && curr > next && curr >= PACING_THRESHOLDS.PEAK_THRESHOLD) {
        peaks.push({
          time: this.timeline[i].time,
          score: curr,
          index: i
        });
      }
    }
    
    return peaks;
  }

  /**
   * Find energy valleys in timeline
   * @returns {Array} Valley points
   */
  findValleys() {
    const valleys = [];
    
    for (let i = 1; i < this.timeline.length - 1; i++) {
      const prev = this.timeline[i - 1].composite;
      const curr = this.timeline[i].composite;
      const next = this.timeline[i + 1].composite;
      
      if (curr < prev && curr < next && curr <= PACING_THRESHOLDS.VALLEY_THRESHOLD) {
        valleys.push({
          time: this.timeline[i].time,
          score: curr,
          index: i
        });
      }
    }
    
    return valleys;
  }

  /**
   * Analyze overall pacing
   * @returns {Object} Pacing analysis
   */
  analyzePacing() {
    if (this.timeline.length === 0) {
      return null;
    }
    
    // Calculate overall variation
    const scores = this.timeline.map(t => t.composite);
    const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    
    // Calculate opening energy (first 30 seconds)
    const openingPoints = Math.min(6, this.timeline.length);
    const openingEnergy = this.timeline.slice(0, openingPoints)
      .reduce((sum, t) => sum + t.composite, 0) / openingPoints;
    
    // Find climax point
    const climaxIndex = scores.indexOf(Math.max(...scores));
    const climaxTime = this.timeline[climaxIndex]?.time || 0;
    const climaxPlacement = this.duration > 0 ? climaxTime / this.duration : 0;
    
    // Classify energy arc
    const firstThird = scores.slice(0, Math.floor(scores.length / 3));
    const lastThird = scores.slice(Math.floor(scores.length * 2 / 3));
    const firstAvg = firstThird.reduce((sum, s) => sum + s, 0) / firstThird.length;
    const lastAvg = lastThird.reduce((sum, s) => sum + s, 0) / lastThird.length;
    
    let energyArc;
    if (lastAvg > firstAvg + 10) {
      energyArc = 'building';
    } else if (Math.abs(lastAvg - firstAvg) < 10 && stdDev > 15) {
      energyArc = 'wave';
    } else if (stdDev < 10) {
      energyArc = 'flat';
    } else {
      energyArc = 'variable';
    }
    
    // Calculate valley time
    const valleyTime = this.valleys.reduce((sum, v) => {
      const startIdx = Math.max(0, v.index - 1);
      const endIdx = Math.min(this.timeline.length - 1, v.index + 1);
      return sum + (this.timeline[endIdx].time - this.timeline[startIdx].time);
    }, 0);
    
    return {
      overallVariation: Math.min(100, stdDev * 2), // Scale to 0-100
      openingEnergy: Math.round(openingEnergy),
      climaxPoint: climaxTime,
      climaxPlacement: Math.round(climaxPlacement * 100), // Percentage
      climaxScore: this.timeline[climaxIndex]?.composite || 0,
      energyArc,
      averageEnergy: Math.round(mean),
      peakCount: this.peaks.length,
      valleyCount: this.valleys.length,
      valleyPercentage: this.duration > 0 ? Math.round((valleyTime / this.duration) * 100) : 0
    };
  }

  /**
   * Generate pacing suggestions
   * @returns {Array} Suggestions
   */
  generateSuggestions() {
    const suggestions = [];
    
    if (!this.pacing) return suggestions;
    
    // Opening energy suggestions
    if (this.pacing.openingEnergy < 50) {
      suggestions.push({
        type: 'opening',
        severity: 'warning',
        message: 'Opening energy is weak - consider starting with a stronger hook',
        recommendation: 'Use a high-energy moment as your opening'
      });
    }
    
    // Climax placement
    if (this.pacing.climaxPlacement < 50) {
      suggestions.push({
        type: 'pacing',
        severity: 'info',
        message: 'Climax occurs early in the video',
        recommendation: 'Consider building more towards the end'
      });
    } else if (this.pacing.climaxPlacement > 90) {
      suggestions.push({
        type: 'pacing',
        severity: 'info',
        message: 'Climax occurs very late',
        recommendation: 'Ensure there\'s resolution after the peak'
      });
    }
    
    // Energy arc
    if (this.pacing.energyArc === 'flat') {
      suggestions.push({
        type: 'variation',
        severity: 'warning',
        message: 'Energy is relatively flat throughout',
        recommendation: 'Add peaks and valleys for more engaging pacing'
      });
    }
    
    // Valley percentage
    if (this.pacing.valleyPercentage > 20) {
      suggestions.push({
        type: 'valleys',
        severity: 'warning',
        message: `${this.pacing.valleyPercentage}% of video has low energy`,
        recommendation: 'Consider tightening or adding visuals to low-energy sections'
      });
    }
    
    // Overall variation
    if (this.pacing.overallVariation < 20) {
      suggestions.push({
        type: 'variation',
        severity: 'info',
        message: 'Low energy variation',
        recommendation: 'Vary your delivery for more engagement'
      });
    }
    
    return suggestions;
  }

  /**
   * Get timeline data for visualization
   * @returns {Object} Visualization data
   */
  getVisualizationData() {
    return {
      timeline: this.timeline,
      peaks: this.peaks,
      valleys: this.valleys,
      duration: this.duration,
      dimensions: ENERGY_DIMENSIONS,
      thresholds: PACING_THRESHOLDS
    };
  }

  /**
   * Get energy at specific time
   * @param {number} time - Time in seconds
   * @returns {Object|null} Energy data
   */
  getEnergyAtTime(time) {
    const index = Math.floor(time / this.windowSize);
    return this.timeline[index] || null;
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
    this.timeline = [];
    this.peaks = [];
    this.valleys = [];
    this.pacing = null;
    this.suggestions = [];
    this.duration = 0;
    this.isAnalyzing = false;
  }
}

export default EnergyAnalyzer;


