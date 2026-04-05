/**
 * Meeting Templates
 *
 * 12 built-in templates + custom template support.
 * Each template is a partial Meeting Object pre section -- it defines the
 * defaults for a type of meeting. Users can also create custom templates
 * from past meetings or from scratch.
 *
 * Templates are NOT stored in Spaces (built-ins are code-defined).
 * Custom templates are stored as Space items with tags ['wiser-template'].
 *
 * @module meeting-templates
 */

// ─── Built-in Templates ────────────────────────────────────────────────────────

const BUILT_IN_TEMPLATES = [

  // ── LIVE ──────────────────────────────────────────────────────────────────

  {
    id: 'quick-touch-base',
    name: 'Quick Touch Base',
    description: 'Fast 1:1 check-in, camera on, get in and out',
    category: 'live',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 2,
    layout: 'side-by-side',
    suggestedDuration: 10,
    durationCategory: 'quick',
    ai: { transcription: true, actionItems: false, summary: false },
    postActions: [],
    source: 'builtin',
  },

  {
    id: 'touch-base',
    name: 'Touch Base',
    description: '1:1 conversation with action items',
    category: 'live',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 2,
    layout: 'side-by-side',
    suggestedDuration: 30,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: true, summary: true },
    postActions: ['summarize', 'extractActionItems'],
    source: 'builtin',
  },

  {
    id: 'same-pager',
    name: 'Same Pager',
    description: 'Alignment meeting -- get everyone on the same page',
    category: 'live',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 6,
    layout: 'grid',
    suggestedDuration: 45,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: true, summary: true },
    postActions: ['summarize', 'extractActionItems', 'extractDecisions'],
    source: 'builtin',
  },

  {
    id: 'co-design',
    name: 'Co-Design Session',
    description: 'Collaborative design with screen sharing',
    category: 'live',
    captureMode: 'both',
    cameraOn: true,
    screenShare: true,
    sessionType: 'live',
    maxParticipants: 6,
    layout: 'presentation',
    suggestedDuration: 60,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: true, summary: true },
    postActions: ['summarize', 'extractActionItems'],
    source: 'builtin',
  },

  {
    id: 'brainstorming',
    name: 'Brainstorming',
    description: 'Creative session -- capture every idea',
    category: 'live',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 8,
    layout: 'grid',
    suggestedDuration: 45,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: false, summary: true },
    postActions: ['summarize'],
    source: 'builtin',
  },

  {
    id: 'marathon',
    name: 'Marathon Meeting',
    description: 'Long session with breaks and segments',
    category: 'live',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 10,
    layout: 'speaker-view',
    suggestedDuration: 120,
    durationCategory: 'marathon',
    ai: { transcription: true, actionItems: true, summary: true },
    postActions: ['summarize', 'extractActionItems', 'extractDecisions'],
    source: 'builtin',
  },

  // ── ASYNC ─────────────────────────────────────────────────────────────────

  {
    id: 'async-record',
    name: 'Async Record',
    description: 'Solo recording -- camera, screen, or both',
    category: 'async',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'solo',
    maxParticipants: 1,
    layout: 'full',
    suggestedDuration: 10,
    durationCategory: 'quick',
    ai: { transcription: true, actionItems: false, summary: true },
    postActions: ['summarize'],
    source: 'builtin',
  },

  {
    id: 'podcast',
    name: 'Podcast',
    description: 'Long-form audio-first conversation',
    category: 'async',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 4,
    layout: 'side-by-side',
    suggestedDuration: 60,
    durationCategory: 'long',
    ai: { transcription: true, actionItems: false, summary: true },
    postActions: ['summarize'],
    source: 'builtin',
  },

  {
    id: 'research',
    name: 'Research Meeting',
    description: 'Interview or research session with deep transcription',
    category: 'async',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 3,
    layout: 'side-by-side',
    suggestedDuration: 45,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: true, summary: true },
    postActions: ['summarize', 'extractActionItems'],
    source: 'builtin',
  },

  // ── BROADCAST ─────────────────────────────────────────────────────────────

  {
    id: 'share-screen',
    name: 'Share Screen',
    description: 'Present your screen to others',
    category: 'broadcast',
    captureMode: 'both',
    cameraOn: true,
    screenShare: true,
    sessionType: 'live',
    maxParticipants: 20,
    layout: 'presentation',
    suggestedDuration: 30,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: false, summary: true },
    postActions: ['summarize'],
    source: 'builtin',
  },

  {
    id: 'large-forum',
    name: 'Large Forum',
    description: 'Town hall or all-hands with many participants',
    category: 'broadcast',
    captureMode: 'camera',
    cameraOn: true,
    screenShare: false,
    sessionType: 'live',
    maxParticipants: 50,
    layout: 'speaker-view',
    suggestedDuration: 60,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: true, summary: true },
    postActions: ['summarize', 'extractActionItems'],
    source: 'builtin',
  },

  {
    id: 'webinar',
    name: 'Webinar',
    description: 'Presenter-led session with audience',
    category: 'broadcast',
    captureMode: 'both',
    cameraOn: true,
    screenShare: true,
    sessionType: 'live',
    maxParticipants: 100,
    layout: 'presentation',
    suggestedDuration: 60,
    durationCategory: 'standard',
    ai: { transcription: true, actionItems: false, summary: true },
    postActions: ['summarize'],
    source: 'builtin',
  },
];

// ─── Template Access ───────────────────────────────────────────────────────────

/**
 * Get a built-in template by ID.
 * @param {string} id
 * @returns {Object|null}
 */
function getTemplate(id) {
  return BUILT_IN_TEMPLATES.find(t => t.id === id) || null;
}

/**
 * Get all built-in templates.
 * @returns {Array}
 */
function getAllTemplates() {
  return [...BUILT_IN_TEMPLATES];
}

/**
 * Get templates organized by category.
 * @returns {{ live: Array, async: Array, broadcast: Array }}
 */
function getTemplatesByCategory() {
  const result = { live: [], async: [], broadcast: [] };
  for (const t of BUILT_IN_TEMPLATES) {
    if (result[t.category]) result[t.category].push(t);
  }
  return result;
}

// ─── Custom Templates ──────────────────────────────────────────────────────────

/**
 * Create a custom template from a meeting's settings.
 * Call this post-meeting when the user wants to save their configuration.
 *
 * @param {Object} opts
 * @param {Object} opts.meeting       - The completed Meeting Object
 * @param {string} opts.name          - User-chosen template name
 * @param {string} [opts.description] - User-chosen description
 * @param {string} [opts.scope]       - 'space' (this space only) or 'global'
 * @returns {Object} Custom template object (ready to store as Space item)
 */
function createCustomTemplate(opts = {}) {
  const meeting = opts.meeting || {};
  const pre = meeting.pre?.template || {};

  const template = {
    id: `custom_${Date.now()}`,
    name: opts.name || pre.name || 'Custom Meeting',
    description: opts.description || '',
    category: pre.category || 'live',
    captureMode: pre.captureMode || meeting.during?.captureMode || 'camera',
    cameraOn: pre.cameraOn !== false,
    screenShare: pre.screenShare || false,
    sessionType: pre.sessionType || 'live',
    maxParticipants: pre.maxParticipants || 10,
    layout: pre.layout || 'side-by-side',
    suggestedDuration: meeting.during?.actualDuration || pre.suggestedDuration || 30,
    durationCategory: pre.durationCategory || 'standard',
    ai: pre.ai || { transcription: true, actionItems: true, summary: true },
    postActions: pre.postActions || ['summarize'],
    source: 'user',
    scope: opts.scope || 'space',
    scopeId: opts.scope === 'global' ? null : meeting.spaceId,
    createdFrom: meeting.templateId || null,
    createdAt: new Date().toISOString(),
    lastUsed: null,
    useCount: 0,
  };

  return template;
}

/**
 * Convert a custom template to a Space item payload.
 */
function customTemplateToSpaceItem(template, spaceId) {
  return {
    type: 'text',
    content: JSON.stringify(template, null, 2),
    spaceId: spaceId || template.scopeId,
    source: 'wiser-template',
    preview: `Template: ${template.name}`,
    tags: ['wiser-template'],
    metadata: {
      title: template.name,
      source: 'wiser-template',
      templateId: template.id,
      scope: template.scope,
    },
  };
}

/**
 * Parse a Space item back into a custom template.
 */
function customTemplateFromSpaceItem(item) {
  try {
    return JSON.parse(item.content);
  } catch {
    return null;
  }
}

/**
 * Merge a built-in or custom template with the full list, resolving by ID.
 * Custom templates override built-ins with the same ID.
 *
 * @param {Array} customTemplates - Parsed custom template objects
 * @returns {Array} Merged list (built-ins + customs, no duplicates by ID)
 */
function mergeTemplates(customTemplates = []) {
  const customById = new Map(customTemplates.map(t => [t.id, t]));
  const merged = BUILT_IN_TEMPLATES.filter(t => !customById.has(t.id));
  return [...merged, ...customTemplates];
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  BUILT_IN_TEMPLATES,
  getTemplate,
  getAllTemplates,
  getTemplatesByCategory,
  createCustomTemplate,
  customTemplateToSpaceItem,
  customTemplateFromSpaceItem,
  mergeTemplates,
};
