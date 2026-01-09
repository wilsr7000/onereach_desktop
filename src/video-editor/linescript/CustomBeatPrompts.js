/**
 * CustomBeatPrompts.js - Template Library of Story Beat Detectors
 * 
 * Pre-made beat detector templates that users can customize:
 * - Emotional Peaks
 * - Humor & Levity
 * - Stats & Data
 * - Aha Moments
 * - Conflict / Tension
 * - Resolution
 * - Pain Points
 * - Social Proof
 * - Custom user-defined beats
 */

/**
 * Beat template categories
 */
export const BEAT_CATEGORIES = {
  EMOTION: 'emotion',
  INFORMATION: 'information',
  NARRATIVE: 'narrative',
  MARKETING: 'marketing',
  CUSTOM: 'custom'
};

/**
 * Pre-made beat detector templates
 */
export const BEAT_TEMPLATE_LIBRARY = {
  // Emotional beats
  emotional_peaks: {
    id: 'emotional_peaks',
    name: 'Emotional Peaks',
    icon: '😢',
    category: BEAT_CATEGORIES.EMOTION,
    description: 'Find moments where the speaker shows genuine emotion',
    prompt: `Find moments where the speaker shows genuine emotion:
      - Vulnerability or personal admission
      - Passion or strong conviction  
      - Joy, laughter, or excitement
      - Frustration or disappointment
      - Surprise or realization`,
    analyzeAudio: true,
    analyzeTranscript: true,
    keywords: ['honestly', 'I felt', 'it hit me', 'I realized', 'the truth is', 'I have to say'],
    audioSignals: ['volume_spike', 'pitch_change', 'pace_change'],
    markerType: 'highlight',
    markerColor: '#ef4444',
    sensitivity: 0.7
  },
  
  humor_levity: {
    id: 'humor_levity',
    name: 'Humor & Levity',
    icon: '😂',
    category: BEAT_CATEGORIES.EMOTION,
    description: 'Find funny moments, jokes, and light-hearted exchanges',
    prompt: `Find funny moments, jokes, and light-hearted exchanges:
      - Intentional jokes or witty remarks
      - Genuine laughter (not nervous laughter)
      - Playful banter
      - Self-deprecating humor
      - Unexpected comedic timing`,
    analyzeAudio: true, // Detect laughter
    analyzeTranscript: true,
    keywords: ['haha', 'lol', 'funny', 'joke', 'laughing', 'kidding'],
    audioSignals: ['laughter_detection'],
    markerType: 'clip',
    markerColor: '#eab308',
    sensitivity: 0.6
  },
  
  // Information beats
  stats_data: {
    id: 'stats_data',
    name: 'Stats & Data',
    icon: '📊',
    category: BEAT_CATEGORIES.INFORMATION,
    description: 'Find moments where statistics, data, or numbers are cited',
    prompt: `Find moments where statistics, data, or numbers are cited:
      - Percentages and statistics
      - Research findings
      - Before/after comparisons with numbers
      - Financial figures
      - Time-based metrics`,
    analyzeAudio: false,
    analyzeTranscript: true,
    keywords: ['percent', '%', 'studies show', 'research', 'data', 'numbers', 'according to', 'found that'],
    patterns: [/\d+%/, /\$\d+/, /\d+ (times|percent|million|billion|thousand)/i],
    markerType: 'keypoint',
    markerColor: '#3b82f6',
    sensitivity: 0.8
  },
  
  aha_moments: {
    id: 'aha_moments',
    name: 'Aha Moments',
    icon: '💡',
    category: BEAT_CATEGORIES.INFORMATION,
    description: 'Find breakthrough or insight moments',
    prompt: `Find breakthrough or insight moments:
      - "The key insight is..."
      - Realizations or epiphanies
      - Connecting dots / pattern recognition
      - Counter-intuitive revelations
      - "What I learned was..."`,
    analyzeAudio: true,
    analyzeTranscript: true,
    keywords: ['realized', 'key is', 'secret is', 'insight', 'discovered', 'turns out', 'the thing is', 'here\'s what'],
    audioSignals: ['emphasis', 'pace_slow'],
    markerType: 'highlight',
    markerColor: '#8b5cf6',
    sensitivity: 0.7
  },
  
  // Narrative beats
  conflict: {
    id: 'conflict',
    name: 'Conflict / Tension',
    icon: '⚔️',
    category: BEAT_CATEGORIES.NARRATIVE,
    description: 'Find moments of conflict, disagreement, or tension',
    prompt: `Find moments of conflict, disagreement, or tension:
      - Opposing viewpoints
      - Problems or challenges faced
      - Obstacles encountered
      - Difficult decisions
      - Setbacks or failures`,
    analyzeAudio: true,
    analyzeTranscript: true,
    keywords: ['but', 'however', 'problem', 'challenge', 'struggle', 'difficult', 'issue', 'conflict', 'disagree'],
    audioSignals: ['tension', 'volume_increase'],
    markerType: 'beat',
    markerColor: '#f97316',
    sensitivity: 0.6
  },
  
  resolution: {
    id: 'resolution',
    name: 'Resolution',
    icon: '✅',
    category: BEAT_CATEGORIES.NARRATIVE,
    description: 'Find resolution or solution moments',
    prompt: `Find resolution or solution moments:
      - How problems were solved
      - Lessons learned
      - Happy endings
      - Breakthroughs after struggle
      - Closure statements`,
    analyzeAudio: true,
    analyzeTranscript: true,
    keywords: ['finally', 'solved', 'solution', 'worked out', 'in the end', 'lesson', 'conclusion', 'result'],
    audioSignals: ['relief', 'positive_tone'],
    markerType: 'highlight',
    markerColor: '#22c55e',
    sensitivity: 0.7
  },
  
  // Marketing beats
  pain_points: {
    id: 'pain_points',
    name: 'Pain Points',
    icon: '😫',
    category: BEAT_CATEGORIES.MARKETING,
    description: 'Find moments where pain points or problems are articulated',
    prompt: `Find moments where pain points or problems are articulated:
      - Frustrations with status quo
      - "The problem with..."
      - Before state descriptions
      - What wasn't working`,
    analyzeAudio: true,
    analyzeTranscript: true,
    keywords: ['problem', 'frustrating', 'annoying', 'difficult', 'struggle', 'pain', 'issue', 'challenge'],
    audioSignals: ['frustration', 'emphasis'],
    markerType: 'beat',
    markerColor: '#ef4444',
    sensitivity: 0.7
  },
  
  social_proof: {
    id: 'social_proof',
    name: 'Social Proof',
    icon: '⭐',
    category: BEAT_CATEGORIES.MARKETING,
    description: 'Find testimonial or social proof moments',
    prompt: `Find testimonial or social proof moments:
      - Customer success stories
      - Results achieved
      - Endorsements
      - "We've helped X people..."
      - Case study mentions`,
    analyzeAudio: false,
    analyzeTranscript: true,
    keywords: ['helped', 'success', 'results', 'testimonial', 'case study', 'client', 'customer', 'review'],
    patterns: [/\d+ (customers|clients|people|users)/i],
    markerType: 'testimonial',
    markerColor: '#eab308',
    sensitivity: 0.8
  },

  // Additional useful beats
  call_to_action: {
    id: 'call_to_action',
    name: 'Call to Action',
    icon: '📢',
    category: BEAT_CATEGORIES.MARKETING,
    description: 'Find moments with calls to action',
    prompt: `Find call-to-action moments:
      - Direct asks or invitations
      - "Click", "Subscribe", "Download"
      - Urgency language
      - Next step suggestions`,
    analyzeAudio: false,
    analyzeTranscript: true,
    keywords: ['click', 'subscribe', 'download', 'sign up', 'join', 'get started', 'try', 'buy', 'link'],
    markerType: 'cta',
    markerColor: '#22c55e',
    sensitivity: 0.9
  },

  question_answer: {
    id: 'question_answer',
    name: 'Questions & Answers',
    icon: '❓',
    category: BEAT_CATEGORIES.INFORMATION,
    description: 'Find question and answer exchanges',
    prompt: `Find Q&A moments:
      - Direct questions asked
      - Rhetorical questions
      - Answers to common questions
      - FAQ-style responses`,
    analyzeAudio: false,
    analyzeTranscript: true,
    keywords: ['what', 'why', 'how', 'when', 'where', 'question', 'answer', '?'],
    patterns: [/\?$/],
    markerType: 'quiz',
    markerColor: '#06b6d4',
    sensitivity: 0.6
  }
};

/**
 * CustomBeatPrompts - Manage and run beat detectors
 */
export class CustomBeatPrompts {
  constructor(appContext) {
    this.app = appContext;
    
    // Built-in templates
    this.builtInTemplates = { ...BEAT_TEMPLATE_LIBRARY };
    
    // User custom templates
    this.customTemplates = {};
    
    // Detection results
    this.detectedBeats = [];
    
    // Analysis state
    this.isAnalyzing = false;
    
    // Event listeners
    this.eventListeners = {};
    
    // Load custom templates from storage
    this.loadCustomTemplates();
  }

  /**
   * Get all templates (built-in + custom)
   * @returns {Object} All templates
   */
  getAllTemplates() {
    return { ...this.builtInTemplates, ...this.customTemplates };
  }

  /**
   * Get templates by category
   * @param {string} category - Category name
   * @returns {Array} Templates in category
   */
  getTemplatesByCategory(category) {
    const all = this.getAllTemplates();
    return Object.values(all).filter(t => t.category === category);
  }

  /**
   * Get template by ID
   * @param {string} templateId - Template ID
   * @returns {Object|null} Template
   */
  getTemplate(templateId) {
    return this.getAllTemplates()[templateId] || null;
  }

  /**
   * Create custom template
   * @param {Object} template - Template configuration
   * @returns {Object} Created template
   */
  createCustomTemplate(template) {
    const id = `custom_${Date.now()}`;
    const customTemplate = {
      ...template,
      id,
      category: BEAT_CATEGORIES.CUSTOM,
      isCustom: true,
      createdAt: new Date().toISOString()
    };
    
    this.customTemplates[id] = customTemplate;
    this.saveCustomTemplates();
    
    this.emit('templateCreated', { template: customTemplate });
    
    return customTemplate;
  }

  /**
   * Update custom template
   * @param {string} templateId - Template ID
   * @param {Object} updates - Updates to apply
   * @returns {Object|null} Updated template
   */
  updateCustomTemplate(templateId, updates) {
    if (!this.customTemplates[templateId]) return null;
    
    this.customTemplates[templateId] = {
      ...this.customTemplates[templateId],
      ...updates,
      modifiedAt: new Date().toISOString()
    };
    
    this.saveCustomTemplates();
    
    this.emit('templateUpdated', { template: this.customTemplates[templateId] });
    
    return this.customTemplates[templateId];
  }

  /**
   * Delete custom template
   * @param {string} templateId - Template ID
   * @returns {boolean} Success
   */
  deleteCustomTemplate(templateId) {
    if (!this.customTemplates[templateId]) return false;
    
    delete this.customTemplates[templateId];
    this.saveCustomTemplates();
    
    this.emit('templateDeleted', { templateId });
    
    return true;
  }

  /**
   * Copy template for customization
   * @param {string} templateId - Template to copy
   * @param {string} newName - New template name
   * @returns {Object} New template
   */
  copyTemplate(templateId, newName) {
    const source = this.getTemplate(templateId);
    if (!source) return null;
    
    return this.createCustomTemplate({
      ...source,
      name: newName || `${source.name} (Copy)`,
      icon: source.icon
    });
  }

  /**
   * Run beat detection with a template
   * @param {string} templateId - Template to use
   * @param {Array} transcriptSegments - Transcript segments
   * @param {Object} audioAnalysis - Audio analysis data
   * @returns {Promise<Array>} Detected beats
   */
  async runDetection(templateId, transcriptSegments, audioAnalysis = null) {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    
    this.isAnalyzing = true;
    this.emit('detectionStarted', { templateId });
    
    try {
      const words = this.expandToWords(transcriptSegments);
      const beats = [];
      
      // Analyze with transcript keywords
      if (template.analyzeTranscript) {
        const keywordBeats = this.detectByKeywords(words, template);
        beats.push(...keywordBeats);
        
        // Check patterns if defined
        if (template.patterns) {
          const patternBeats = this.detectByPatterns(words, template);
          beats.push(...patternBeats);
        }
      }
      
      // Analyze with audio signals (if available)
      if (template.analyzeAudio && audioAnalysis) {
        const audioBeats = this.detectByAudio(audioAnalysis, template);
        beats.push(...audioBeats);
      }
      
      // Merge nearby beats
      const mergedBeats = this.mergeNearbyBeats(beats, 3); // 3 second threshold
      
      // Apply sensitivity filter
      const filteredBeats = mergedBeats.filter(b => b.confidence >= template.sensitivity);
      
      // Add template info to each beat
      const finalBeats = filteredBeats.map(beat => ({
        ...beat,
        templateId,
        templateName: template.name,
        templateIcon: template.icon,
        markerType: template.markerType,
        markerColor: template.markerColor
      }));
      
      this.detectedBeats = finalBeats;
      this.isAnalyzing = false;
      
      this.emit('detectionComplete', { 
        templateId, 
        beats: finalBeats,
        count: finalBeats.length 
      });
      
      return finalBeats;
      
    } catch (error) {
      this.isAnalyzing = false;
      this.emit('detectionError', { error });
      throw error;
    }
  }

  /**
   * Detect beats by keywords
   * @param {Array} words - Words with timing
   * @param {Object} template - Template configuration
   * @returns {Array} Detected beats
   */
  detectByKeywords(words, template) {
    const beats = [];
    const keywords = template.keywords || [];
    
    for (let i = 0; i < words.length; i++) {
      const windowSize = 10; // Words to check
      const windowEnd = Math.min(i + windowSize, words.length);
      const windowText = words.slice(i, windowEnd).map(w => w.text).join(' ').toLowerCase();
      
      let matchCount = 0;
      let matchedKeywords = [];
      
      keywords.forEach(keyword => {
        const keywordLower = keyword.toLowerCase();
        if (windowText.includes(keywordLower)) {
          matchCount++;
          matchedKeywords.push(keyword);
        }
      });
      
      if (matchCount > 0) {
        const confidence = Math.min(1, matchCount / 3); // 3 matches = max confidence
        
        beats.push({
          startTime: words[i].start,
          endTime: words[Math.min(i + windowSize - 1, words.length - 1)].end,
          text: windowText.substring(0, 200),
          matchedKeywords,
          confidence,
          detectionMethod: 'keywords'
        });
        
        // Skip ahead to avoid duplicate detections
        i += windowSize / 2;
      }
    }
    
    return beats;
  }

  /**
   * Detect beats by regex patterns
   * @param {Array} words - Words with timing
   * @param {Object} template - Template configuration
   * @returns {Array} Detected beats
   */
  detectByPatterns(words, template) {
    const beats = [];
    const patterns = template.patterns || [];
    const fullText = words.map(w => w.text).join(' ');
    
    patterns.forEach(pattern => {
      let match;
      const regex = new RegExp(pattern, 'gi');
      
      while ((match = regex.exec(fullText)) !== null) {
        // Find word index for this position
        let charCount = 0;
        let startWordIdx = 0;
        
        for (let i = 0; i < words.length; i++) {
          if (charCount >= match.index) {
            startWordIdx = i;
            break;
          }
          charCount += words[i].text.length + 1;
        }
        
        beats.push({
          startTime: words[startWordIdx].start,
          endTime: words[Math.min(startWordIdx + 5, words.length - 1)].end,
          text: match[0],
          matchedPattern: pattern.toString(),
          confidence: 0.9,
          detectionMethod: 'pattern'
        });
      }
    });
    
    return beats;
  }

  /**
   * Detect beats by audio signals
   * @param {Object} audioAnalysis - Audio analysis data
   * @param {Object} template - Template configuration
   * @returns {Array} Detected beats
   */
  detectByAudio(audioAnalysis, template) {
    const beats = [];
    const signals = template.audioSignals || [];
    
    // Check for volume spikes
    if (signals.includes('volume_spike') && audioAnalysis.rmsTimeline) {
      const avgRMS = audioAnalysis.averageRMS || 0.5;
      const spikes = audioAnalysis.rmsTimeline.filter(r => r.value > avgRMS * 1.5);
      
      spikes.forEach(spike => {
        beats.push({
          startTime: spike.time,
          endTime: spike.time + 2,
          text: '[Audio spike detected]',
          confidence: 0.7,
          detectionMethod: 'audio_spike'
        });
      });
    }
    
    // Add more audio signal detection as available
    
    return beats;
  }

  /**
   * Merge nearby beats
   * @param {Array} beats - Beats to merge
   * @param {number} threshold - Time threshold in seconds
   * @returns {Array} Merged beats
   */
  mergeNearbyBeats(beats, threshold) {
    if (beats.length < 2) return beats;
    
    // Sort by start time
    beats.sort((a, b) => a.startTime - b.startTime);
    
    const merged = [];
    let current = beats[0];
    
    for (let i = 1; i < beats.length; i++) {
      const next = beats[i];
      
      if (next.startTime - current.endTime < threshold) {
        // Merge
        current = {
          ...current,
          endTime: Math.max(current.endTime, next.endTime),
          text: current.text,
          confidence: Math.max(current.confidence, next.confidence),
          matchedKeywords: [
            ...(current.matchedKeywords || []),
            ...(next.matchedKeywords || [])
          ].filter((v, i, a) => a.indexOf(v) === i) // Unique
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    
    merged.push(current);
    return merged;
  }

  /**
   * Convert beats to markers
   * @param {Object} markerManager - Marker manager instance
   */
  convertToMarkers(markerManager) {
    if (!markerManager) return;
    
    this.detectedBeats.forEach(beat => {
      markerManager.addSpotMarker(
        beat.startTime,
        `${beat.templateIcon} ${beat.templateName}`,
        beat.markerColor,
        {
          description: beat.text.substring(0, 100),
          markerType: beat.markerType,
          detectedBy: beat.templateId,
          confidence: beat.confidence
        }
      );
    });
    
    this.emit('markersCreated', { count: this.detectedBeats.length });
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
   * Load custom templates from storage
   */
  loadCustomTemplates() {
    try {
      const stored = localStorage.getItem('customBeatTemplates');
      if (stored) {
        this.customTemplates = JSON.parse(stored);
      }
    } catch (e) {
      console.warn('[CustomBeatPrompts] Failed to load custom templates:', e);
    }
  }

  /**
   * Save custom templates to storage
   */
  saveCustomTemplates() {
    try {
      localStorage.setItem('customBeatTemplates', JSON.stringify(this.customTemplates));
    } catch (e) {
      console.warn('[CustomBeatPrompts] Failed to save custom templates:', e);
    }
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
    this.detectedBeats = [];
    this.isAnalyzing = false;
  }
}

export default CustomBeatPrompts;










