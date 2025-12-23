/**
 * ContentTemplates.js - Content-Type Templates for Line Script System
 * 
 * Provides 4 presets (Podcast, Product, Promo, Learning) with:
 * - Custom AI prompts for metadata generation
 * - Template-specific marker types
 * - Voice commands for each template
 * - Export format configurations
 */

/**
 * Content Template Definitions
 */
export const CONTENT_TEMPLATES = {
  podcast: {
    id: 'podcast',
    name: 'Podcast / Interview',
    icon: '🎙️',
    description: 'Interview/conversation format with speaker turns, quotes, and topic detection',
    primaryColor: '#8b5cf6', // Purple
    
    // AI prompt customization for metadata generation
    aiPrompts: {
      chunkAnalysis: `Analyze this podcast segment. For each chunk, identify:
        - Current speaker and their role (host/guest)
        - Main topic being discussed
        - Quotable moments (memorable, shareable statements)
        - Energy level (low/medium/high)
        - Conversation dynamics (interview, debate, story-telling, Q&A)
        - Any notable pauses or interruptions
        Return structured JSON with these fields.`,
        
      quoteDetection: `Find the most impactful, shareable quotes in this transcript.
        Look for:
        - Concise, memorable statements (under 20 words ideal)
        - Surprising insights or revelations
        - Emotional moments
        - Strong opinions or hot takes
        - Practical advice or wisdom
        Rate each quote 1-10 on shareability and explain why.`,
        
      topicSegmentation: `Identify distinct topic changes and conversation shifts.
        For each topic segment, provide:
        - Topic title (3-5 words)
        - Brief summary (1-2 sentences)
        - Key speakers involved
        - Start and end times
        - Keywords/tags`,
        
      hookAnalysis: `Analyze this segment for hook potential. Rate:
        - Curiosity gap (does it make viewer want more?)
        - Energy level (engaging opening energy?)
        - Pattern interrupt (unexpected or attention-grabbing?)
        - Emotional hook (does it evoke feeling?)
        Provide an overall hook score 1-10 with explanation.`
    },
    
    // Available marker types for this template
    markerTypes: [
      { id: 'quote', name: 'Quote', icon: '💬', color: '#8b5cf6', description: 'Quotable moment or sound bite' },
      { id: 'topic', name: 'Topic', icon: '📌', color: '#06b6d4', description: 'Topic change or new subject' },
      { id: 'clip', name: 'Clip', icon: '✂️', color: '#22c55e', description: 'Good clip for social media' },
      { id: 'speaker-change', name: 'Speaker', icon: '👤', color: '#f97316', description: 'Speaker transition' },
      { id: 'highlight', name: 'Highlight', icon: '⭐', color: '#eab308', description: 'Notable moment' },
      { id: 'chapter', name: 'Chapter', icon: '📖', color: '#3b82f6', description: 'Chapter marker' }
    ],
    
    // Voice commands specific to this template
    voiceCommands: {
      'quote': { action: 'addQuoteMarker', feedback: '💬 Quote marked', markerType: 'quote' },
      'good bite': { action: 'addQuoteMarker', feedback: '💬 Sound bite', markerType: 'quote' },
      'topic': { action: 'addTopicMarker', feedback: '📌 Topic change', markerType: 'topic' },
      'new topic': { action: 'addTopicMarker', feedback: '📌 New topic', markerType: 'topic' },
      'clip': { action: 'addClipMarker', feedback: '✂️ Clip marked', markerType: 'clip' },
      'social': { action: 'addClipMarker', feedback: '✂️ Social clip', markerType: 'clip' },
      'speaker': { action: 'addSpeakerMarker', feedback: '👤 Speaker change', markerType: 'speaker-change' },
      'highlight': { action: 'addHighlightMarker', feedback: '⭐ Highlighted', markerType: 'highlight' },
      'chapter': { action: 'addChapterMarker', feedback: '📖 Chapter', markerType: 'chapter' },
      // Standard commands
      'mark': { action: 'addPointMarker', feedback: '📍 Marked', markerType: 'spot' },
      'in': { action: 'setInPoint', feedback: '◀ IN' },
      'out': { action: 'setOutPoint', feedback: '▶ OUT' },
      'undo': { action: 'undoLastMarker', feedback: '↩️ Undone' }
    },
    
    // Keyboard shortcuts
    keyboardShortcuts: {
      'q': { action: 'addQuoteMarker', label: 'Q - Quote' },
      't': { action: 'addTopicMarker', label: 'T - Topic' },
      'c': { action: 'addClipMarker', label: 'C - Clip' },
      'm': { action: 'addPointMarker', label: 'M - Mark' },
      'i': { action: 'setInPoint', label: 'I - In Point' },
      'o': { action: 'setOutPoint', label: 'O - Out Point' }
    },
    
    // Export formats available
    exports: [
      { id: 'show-notes', name: 'Show Notes', format: 'markdown', icon: '📝' },
      { id: 'audiogram-timestamps', name: 'Audiogram Timestamps', format: 'json', icon: '🎵' },
      { id: 'transcript-with-speakers', name: 'Transcript with Speakers', format: 'txt', icon: '📄' },
      { id: 'quote-cards', name: 'Quote Cards', format: 'json', icon: '💬' },
      { id: 'youtube-chapters', name: 'YouTube Chapters', format: 'txt', icon: '📺' },
      { id: 'podcast-chapters', name: 'Podcast Chapters', format: 'json', icon: '🎙️' }
    ],
    
    // UI configuration
    ui: {
      showSpeakerLegend: true,
      showQuotePanel: true,
      showTopicTimeline: true,
      showEnergyGraph: true,
      dialogueWidth: 'wide',
      emphasisElements: ['speakers', 'timing', 'topics', 'quotes']
    },
    
    // Rating criteria for this template
    ratingCriteria: [
      { id: 'conversation_flow', name: 'Conversation Flow', weight: 20, 
        prompt: 'How naturally does the conversation flow? Are transitions smooth?' },
      { id: 'guest_engagement', name: 'Guest Engagement', weight: 15,
        prompt: 'How engaged and comfortable does the guest appear?' },
      { id: 'host_questions', name: 'Host Questions', weight: 15,
        prompt: 'Are the questions insightful, well-timed, and driving value?' },
      { id: 'audio_quality', name: 'Audio Quality', weight: 15,
        prompt: 'Is audio clear, balanced between speakers, free of issues?' },
      { id: 'pacing', name: 'Pacing & Length', weight: 15,
        prompt: 'Is the pacing appropriate? Any sections that drag or feel rushed?' },
      { id: 'value_delivery', name: 'Value Delivery', weight: 20,
        prompt: 'Does the episode deliver on its promise? Actionable takeaways?' }
    ]
  },
  
  product: {
    id: 'product',
    name: 'Product Video',
    icon: '📦',
    description: 'Product demos and features with clear callouts and B-roll markers',
    primaryColor: '#22c55e', // Green
    
    aiPrompts: {
      chunkAnalysis: `Analyze this product video segment. Identify:
        - Feature being demonstrated (name and description)
        - Type of shot (demo, testimonial, B-roll, product close-up)
        - Key benefit being communicated
        - Call-to-action presence
        - Visual quality assessment
        - Brand consistency
        Return structured JSON.`,
        
      featureDetection: `List all product features demonstrated in this segment:
        - Feature name
        - Benefit to user
        - How well it's explained (1-10)
        - Suggested improvement
        - Timestamp`,
        
      brollAnalysis: `Identify opportunities for B-roll or cutaway shots:
        - Current shot type
        - Suggested B-roll to add
        - Why it would enhance the video
        - Duration recommendation`,
        
      hookAnalysis: `Rate the hook strength of this opening:
        - First 3 seconds impact (1-10)
        - Problem/solution clarity
        - Value proposition presence
        - Call-to-action urgency`
    },
    
    markerTypes: [
      { id: 'feature', name: 'Feature', icon: '⭐', color: '#22c55e', description: 'Product feature highlight' },
      { id: 'demo', name: 'Demo', icon: '🎬', color: '#3b82f6', description: 'Feature demonstration' },
      { id: 'broll', name: 'B-Roll', icon: '🎥', color: '#8b5cf6', description: 'B-roll opportunity' },
      { id: 'cta', name: 'CTA', icon: '📢', color: '#ef4444', description: 'Call-to-action' },
      { id: 'testimonial', name: 'Testimonial', icon: '💬', color: '#f97316', description: 'Customer testimonial' },
      { id: 'benefit', name: 'Benefit', icon: '✓', color: '#06b6d4', description: 'Key benefit statement' }
    ],
    
    voiceCommands: {
      'feature': { action: 'addFeatureMarker', feedback: '⭐ Feature', markerType: 'feature' },
      'demo': { action: 'addDemoMarker', feedback: '🎬 Demo', markerType: 'demo' },
      'b-roll': { action: 'addBrollMarker', feedback: '🎥 B-roll', markerType: 'broll' },
      'b roll': { action: 'addBrollMarker', feedback: '🎥 B-roll', markerType: 'broll' },
      'call to action': { action: 'addCTAMarker', feedback: '📢 CTA', markerType: 'cta' },
      'cta': { action: 'addCTAMarker', feedback: '📢 CTA', markerType: 'cta' },
      'testimonial': { action: 'addTestimonialMarker', feedback: '💬 Testimonial', markerType: 'testimonial' },
      'benefit': { action: 'addBenefitMarker', feedback: '✓ Benefit', markerType: 'benefit' },
      'mark': { action: 'addPointMarker', feedback: '📍 Marked', markerType: 'spot' },
      'in': { action: 'setInPoint', feedback: '◀ IN' },
      'out': { action: 'setOutPoint', feedback: '▶ OUT' },
      'undo': { action: 'undoLastMarker', feedback: '↩️ Undone' }
    },
    
    keyboardShortcuts: {
      'f': { action: 'addFeatureMarker', label: 'F - Feature' },
      'd': { action: 'addDemoMarker', label: 'D - Demo' },
      'b': { action: 'addBrollMarker', label: 'B - B-Roll' },
      'a': { action: 'addCTAMarker', label: 'A - CTA' },
      'm': { action: 'addPointMarker', label: 'M - Mark' },
      'i': { action: 'setInPoint', label: 'I - In Point' },
      'o': { action: 'setOutPoint', label: 'O - Out Point' }
    },
    
    exports: [
      { id: 'shot-list', name: 'Shot List', format: 'csv', icon: '📋' },
      { id: 'feature-matrix', name: 'Feature Matrix', format: 'json', icon: '📊' },
      { id: 'storyboard', name: 'Storyboard', format: 'html', icon: '🖼️' },
      { id: 'social-cuts', name: 'Social Cut Points', format: 'json', icon: '📱' },
      { id: 'edl', name: 'EDL (Edit Decision List)', format: 'edl', icon: '🎬' }
    ],
    
    ui: {
      showFeatureList: true,
      showBrollBank: true,
      showCTATracker: true,
      dialogueWidth: 'medium',
      emphasisElements: ['features', 'visuals', 'cta', 'branding']
    },
    
    ratingCriteria: [
      { id: 'hook_strength', name: 'Hook Strength', weight: 20,
        prompt: 'How effectively does the opening grab attention?' },
      { id: 'feature_clarity', name: 'Feature Clarity', weight: 20,
        prompt: 'Are features explained clearly with good demonstrations?' },
      { id: 'visual_quality', name: 'Visual Quality', weight: 15,
        prompt: 'Is the visual production quality professional?' },
      { id: 'benefit_focus', name: 'Benefit Focus', weight: 15,
        prompt: 'Does it focus on benefits, not just features?' },
      { id: 'cta_effectiveness', name: 'CTA Effectiveness', weight: 15,
        prompt: 'Is the call-to-action clear and compelling?' },
      { id: 'brand_consistency', name: 'Brand Consistency', weight: 15,
        prompt: 'Does it align with brand voice and visual identity?' }
    ]
  },
  
  promo: {
    id: 'promo',
    name: 'Promo / Commercial',
    icon: '📣',
    description: 'Marketing videos with hooks, beats, and emotional pacing',
    primaryColor: '#f97316', // Orange
    
    aiPrompts: {
      chunkAnalysis: `Analyze this promotional video segment. Identify:
        - Shot type (hook, problem, solution, social proof, CTA)
        - Emotional beat (curiosity, pain, relief, excitement, urgency)
        - Pacing assessment (fast/medium/slow)
        - Brand elements present
        - Visual impact score (1-10)
        Return structured JSON.`,
        
      hookDetection: `Rate the attention-grabbing potential:
        - First 3 seconds hook score (1-10)
        - Pattern interrupt effectiveness
        - Curiosity gap creation
        - Emotional impact
        - Visual stopping power`,
        
      pacingAnalysis: `Analyze the pacing and rhythm:
        - Beat changes per 10 seconds
        - Energy arc (building, peak, resolution)
        - Music sync points
        - Suggested cut points`,
        
      emotionalArc: `Map the emotional journey:
        - Opening emotion
        - Problem/pain point
        - Solution reveal
        - Transformation moment
        - Closing emotion/urgency`
    },
    
    markerTypes: [
      { id: 'hook', name: 'Hook', icon: '🎣', color: '#ef4444', description: 'Attention-grabbing moment' },
      { id: 'beat', name: 'Beat', icon: '💥', color: '#f97316', description: 'Emotional or visual beat' },
      { id: 'transition', name: 'Transition', icon: '➡️', color: '#8b5cf6', description: 'Scene transition' },
      { id: 'cta', name: 'CTA', icon: '📢', color: '#22c55e', description: 'Call-to-action' },
      { id: 'logo', name: 'Logo', icon: '🏷️', color: '#3b82f6', description: 'Logo placement' },
      { id: 'tagline', name: 'Tagline', icon: '💬', color: '#06b6d4', description: 'Tagline or slogan' }
    ],
    
    voiceCommands: {
      'hook': { action: 'addHookMarker', feedback: '🎣 Hook', markerType: 'hook' },
      'beat': { action: 'addBeatMarker', feedback: '💥 Beat', markerType: 'beat' },
      'transition': { action: 'addTransitionMarker', feedback: '➡️ Transition', markerType: 'transition' },
      'call to action': { action: 'addCTAMarker', feedback: '📢 CTA', markerType: 'cta' },
      'cta': { action: 'addCTAMarker', feedback: '📢 CTA', markerType: 'cta' },
      'logo': { action: 'addLogoMarker', feedback: '🏷️ Logo', markerType: 'logo' },
      'tagline': { action: 'addTaglineMarker', feedback: '💬 Tagline', markerType: 'tagline' },
      'mark': { action: 'addPointMarker', feedback: '📍 Marked', markerType: 'spot' },
      'in': { action: 'setInPoint', feedback: '◀ IN' },
      'out': { action: 'setOutPoint', feedback: '▶ OUT' },
      'undo': { action: 'undoLastMarker', feedback: '↩️ Undone' }
    },
    
    keyboardShortcuts: {
      'h': { action: 'addHookMarker', label: 'H - Hook' },
      'b': { action: 'addBeatMarker', label: 'B - Beat' },
      't': { action: 'addTransitionMarker', label: 'T - Transition' },
      'l': { action: 'addLogoMarker', label: 'L - Logo' },
      'm': { action: 'addPointMarker', label: 'M - Mark' },
      'i': { action: 'setInPoint', label: 'I - In Point' },
      'o': { action: 'setOutPoint', label: 'O - Out Point' }
    },
    
    exports: [
      { id: 'edl', name: 'EDL', format: 'edl', icon: '🎬' },
      { id: 'storyboard', name: 'Storyboard', format: 'html', icon: '🖼️' },
      { id: 'timing-sheet', name: 'Timing Sheet', format: 'csv', icon: '⏱️' },
      { id: 'social-versions', name: 'Social Versions', format: 'json', icon: '📱' },
      { id: 'beat-sheet', name: 'Beat Sheet', format: 'json', icon: '💥' }
    ],
    
    ui: {
      showPacingGraph: true,
      showBeatTimeline: true,
      showEmotionalArc: true,
      dialogueWidth: 'narrow',
      emphasisElements: ['visuals', 'hooks', 'cta', 'branding', 'pacing']
    },
    
    ratingCriteria: [
      { id: 'attention_grab', name: 'Attention Grab (0-3s)', weight: 25,
        prompt: 'Does the first 3 seconds stop the scroll?' },
      { id: 'emotional_impact', name: 'Emotional Impact', weight: 20,
        prompt: 'Does it evoke the intended emotion?' },
      { id: 'message_clarity', name: 'Message Clarity', weight: 15,
        prompt: 'Is the core message immediately clear?' },
      { id: 'pacing_energy', name: 'Pacing & Energy', weight: 15,
        prompt: 'Does the pacing maintain energy throughout?' },
      { id: 'memorability', name: 'Memorability', weight: 15,
        prompt: 'Will viewers remember this? Any sticky moments?' },
      { id: 'cta_urgency', name: 'CTA Urgency', weight: 10,
        prompt: 'Does the CTA create urgency to act?' }
    ]
  },
  
  learning: {
    id: 'learning',
    name: 'Learning / Tutorial',
    icon: '📚',
    description: 'Educational content with chapters, key points, and quiz markers',
    primaryColor: '#3b82f6', // Blue
    
    aiPrompts: {
      chunkAnalysis: `Analyze this educational segment. Identify:
        - Main concept being taught
        - Learning objective for this section
        - Key takeaway or point
        - Examples or demonstrations used
        - Potential quiz question opportunities
        - Prerequisite knowledge assumed
        Return structured JSON.`,
        
      chapterDetection: `Identify natural chapter breaks. For each:
        - Chapter title (clear, descriptive)
        - Start timestamp
        - Main topic covered
        - Learning objectives
        - Key concepts introduced`,
        
      keyPointExtraction: `Extract key learning points:
        - Point number
        - The main takeaway
        - Supporting examples
        - Common misconceptions addressed
        - Related concepts`,
        
      quizPointDetection: `Suggest good places for knowledge check questions:
        - Timestamp for quiz
        - Question type (multiple choice, true/false, fill-in)
        - Sample question
        - Why this is a good check point`
    },
    
    markerTypes: [
      { id: 'chapter', name: 'Chapter', icon: '📖', color: '#3b82f6', description: 'Chapter or section start' },
      { id: 'keypoint', name: 'Key Point', icon: '💡', color: '#eab308', description: 'Important learning point' },
      { id: 'quiz', name: 'Quiz', icon: '❓', color: '#ef4444', description: 'Quiz or knowledge check' },
      { id: 'concept', name: 'Concept', icon: '🧠', color: '#8b5cf6', description: 'New concept introduction' },
      { id: 'example', name: 'Example', icon: '📝', color: '#22c55e', description: 'Example or demonstration' },
      { id: 'summary', name: 'Summary', icon: '📋', color: '#06b6d4', description: 'Section summary' }
    ],
    
    voiceCommands: {
      'chapter': { action: 'addChapterMarker', feedback: '📖 Chapter', markerType: 'chapter' },
      'key point': { action: 'addKeyPointMarker', feedback: '💡 Key point', markerType: 'keypoint' },
      'important': { action: 'addKeyPointMarker', feedback: '💡 Important', markerType: 'keypoint' },
      'quiz': { action: 'addQuizMarker', feedback: '❓ Quiz point', markerType: 'quiz' },
      'question': { action: 'addQuizMarker', feedback: '❓ Question', markerType: 'quiz' },
      'concept': { action: 'addConceptMarker', feedback: '🧠 Concept', markerType: 'concept' },
      'example': { action: 'addExampleMarker', feedback: '📝 Example', markerType: 'example' },
      'demo': { action: 'addExampleMarker', feedback: '📝 Demo', markerType: 'example' },
      'summary': { action: 'addSummaryMarker', feedback: '📋 Summary', markerType: 'summary' },
      'mark': { action: 'addPointMarker', feedback: '📍 Marked', markerType: 'spot' },
      'in': { action: 'setInPoint', feedback: '◀ IN' },
      'out': { action: 'setOutPoint', feedback: '▶ OUT' },
      'undo': { action: 'undoLastMarker', feedback: '↩️ Undone' }
    },
    
    keyboardShortcuts: {
      'c': { action: 'addChapterMarker', label: 'C - Chapter' },
      'k': { action: 'addKeyPointMarker', label: 'K - Key Point' },
      'z': { action: 'addQuizMarker', label: 'Z - Quiz' },
      'e': { action: 'addExampleMarker', label: 'E - Example' },
      'm': { action: 'addPointMarker', label: 'M - Mark' },
      'i': { action: 'setInPoint', label: 'I - In Point' },
      'o': { action: 'setOutPoint', label: 'O - Out Point' }
    },
    
    exports: [
      { id: 'youtube-chapters', name: 'YouTube Chapters', format: 'txt', icon: '📺' },
      { id: 'course-outline', name: 'Course Outline', format: 'markdown', icon: '📋' },
      { id: 'study-guide', name: 'Study Guide', format: 'pdf', icon: '📄' },
      { id: 'flashcards', name: 'Flashcards', format: 'json', icon: '🎴' },
      { id: 'quiz-questions', name: 'Quiz Questions', format: 'json', icon: '❓' }
    ],
    
    ui: {
      showChapterNav: true,
      showKeyPointsSummary: true,
      showProgressTracker: true,
      showQuizMarkers: true,
      dialogueWidth: 'medium',
      emphasisElements: ['chapters', 'keyPoints', 'duration', 'concepts']
    },
    
    ratingCriteria: [
      { id: 'clarity', name: 'Explanation Clarity', weight: 25,
        prompt: 'Are concepts explained clearly and accessibly?' },
      { id: 'structure', name: 'Structure & Flow', weight: 20,
        prompt: 'Is the content logically organized with clear progression?' },
      { id: 'engagement', name: 'Engagement', weight: 15,
        prompt: 'Does it maintain interest? Varied delivery?' },
      { id: 'examples', name: 'Examples & Demos', weight: 15,
        prompt: 'Are there good examples that illustrate concepts?' },
      { id: 'retention', name: 'Retention Design', weight: 15,
        prompt: 'Are there summaries, recaps, key takeaways?' },
      { id: 'actionability', name: 'Actionability', weight: 10,
        prompt: 'Can viewers apply what they learned immediately?' }
    ]
  }
};

/**
 * Get a template by ID
 * @param {string} templateId - Template ID
 * @returns {Object|null} Template configuration
 */
export function getTemplate(templateId) {
  return CONTENT_TEMPLATES[templateId] || null;
}

/**
 * Get all templates as array
 * @returns {Array} Array of template configurations
 */
export function getAllTemplates() {
  return Object.values(CONTENT_TEMPLATES);
}

/**
 * Get template IDs
 * @returns {Array<string>} Array of template IDs
 */
export function getTemplateIds() {
  return Object.keys(CONTENT_TEMPLATES);
}

/**
 * Get marker types for a template
 * @param {string} templateId - Template ID
 * @returns {Array} Array of marker type configurations
 */
export function getMarkerTypes(templateId) {
  const template = getTemplate(templateId);
  return template?.markerTypes || [];
}

/**
 * Get voice commands for a template
 * @param {string} templateId - Template ID
 * @returns {Object} Voice commands configuration
 */
export function getVoiceCommands(templateId) {
  const template = getTemplate(templateId);
  return template?.voiceCommands || {};
}

/**
 * Get keyboard shortcuts for a template
 * @param {string} templateId - Template ID
 * @returns {Object} Keyboard shortcuts configuration
 */
export function getKeyboardShortcuts(templateId) {
  const template = getTemplate(templateId);
  return template?.keyboardShortcuts || {};
}

/**
 * Get AI prompts for a template
 * @param {string} templateId - Template ID
 * @returns {Object} AI prompts configuration
 */
export function getAIPrompts(templateId) {
  const template = getTemplate(templateId);
  return template?.aiPrompts || {};
}

/**
 * Get export formats for a template
 * @param {string} templateId - Template ID
 * @returns {Array} Export format configurations
 */
export function getExportFormats(templateId) {
  const template = getTemplate(templateId);
  return template?.exports || [];
}

/**
 * Get rating criteria for a template
 * @param {string} templateId - Template ID
 * @returns {Array} Rating criteria configurations
 */
export function getRatingCriteria(templateId) {
  const template = getTemplate(templateId);
  return template?.ratingCriteria || [];
}

/**
 * Get UI configuration for a template
 * @param {string} templateId - Template ID
 * @returns {Object} UI configuration
 */
export function getUIConfig(templateId) {
  const template = getTemplate(templateId);
  return template?.ui || {};
}

/**
 * Find best matching template based on video metadata
 * @param {Object} videoMetadata - Video metadata object
 * @returns {string} Suggested template ID
 */
export function suggestTemplate(videoMetadata) {
  const { title = '', description = '', tags = [], duration = 0 } = videoMetadata;
  const combined = `${title} ${description} ${tags.join(' ')}`.toLowerCase();
  
  // Podcast indicators
  if (combined.includes('podcast') || combined.includes('interview') || 
      combined.includes('conversation') || combined.includes('episode') ||
      combined.includes('guest') || combined.includes('host')) {
    return 'podcast';
  }
  
  // Learning indicators
  if (combined.includes('tutorial') || combined.includes('learn') || 
      combined.includes('course') || combined.includes('lesson') ||
      combined.includes('how to') || combined.includes('guide') ||
      combined.includes('explain') || combined.includes('teach')) {
    return 'learning';
  }
  
  // Product indicators
  if (combined.includes('product') || combined.includes('demo') || 
      combined.includes('review') || combined.includes('feature') ||
      combined.includes('unbox') || combined.includes('showcase')) {
    return 'product';
  }
  
  // Promo indicators
  if (combined.includes('ad') || combined.includes('commercial') || 
      combined.includes('promo') || combined.includes('trailer') ||
      combined.includes('teaser') || duration < 120) { // Short videos likely promos
    return 'promo';
  }
  
  // Default to podcast (most common)
  return 'podcast';
}

/**
 * ContentTemplates class for managing templates
 */
export class ContentTemplates {
  constructor() {
    this.templates = CONTENT_TEMPLATES;
    this.currentTemplate = 'podcast';
  }
  
  /**
   * Get current template
   * @returns {Object} Current template configuration
   */
  getCurrent() {
    return this.templates[this.currentTemplate];
  }
  
  /**
   * Set current template
   * @param {string} templateId - Template ID to set
   * @returns {boolean} Success
   */
  setCurrent(templateId) {
    if (this.templates[templateId]) {
      this.currentTemplate = templateId;
      return true;
    }
    return false;
  }
  
  /**
   * Get template by ID
   * @param {string} templateId - Template ID
   * @returns {Object|null} Template configuration
   */
  get(templateId) {
    return this.templates[templateId] || null;
  }
  
  /**
   * Get all templates
   * @returns {Object} All templates
   */
  getAll() {
    return this.templates;
  }
  
  /**
   * Get marker type definition
   * @param {string} markerTypeId - Marker type ID
   * @returns {Object|null} Marker type configuration
   */
  getMarkerType(markerTypeId) {
    const template = this.getCurrent();
    return template.markerTypes.find(m => m.id === markerTypeId) || null;
  }
  
  /**
   * Process voice command for current template
   * @param {string} command - Voice command string
   * @returns {Object|null} Command action configuration
   */
  processVoiceCommand(command) {
    const template = this.getCurrent();
    const normalizedCommand = command.toLowerCase().trim();
    return template.voiceCommands[normalizedCommand] || null;
  }
  
  /**
   * Process keyboard shortcut for current template
   * @param {string} key - Key pressed
   * @returns {Object|null} Shortcut action configuration
   */
  processKeyboardShortcut(key) {
    const template = this.getCurrent();
    return template.keyboardShortcuts[key.toLowerCase()] || null;
  }
}

export default ContentTemplates;


