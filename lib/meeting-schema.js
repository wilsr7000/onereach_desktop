/**
 * Meeting Object Schema
 *
 * Defines the canonical Meeting Object -- the first-class data structure for
 * every WISER Meeting. Stored as a Space item with tags ['wiser-meeting'].
 *
 * Three lifecycle phases:
 *   pre   - template defaults, agenda, AI suggestions, vibe prediction, checkpoints
 *   during - live transcript, AI notes, overlays, participants, recordings
 *   post  - action items, decisions, vibe score, follow-up, summary
 *
 * Embeds iCal (RFC 5545) calendar node for interoperability.
 *
 * @module meeting-schema
 */

const { v4: uuidv4 } = require('uuid');

const SCHEMA_VERSION = '1.0';

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a new Meeting Object with sensible defaults.
 *
 * @param {Object} opts
 * @param {string} opts.spaceId        - Space this meeting belongs to
 * @param {Object} opts.template       - Template object (from meeting-templates.js)
 * @param {string} [opts.title]        - Meeting title (falls back to template name)
 * @param {string} [opts.description]  - Description / agenda text
 * @param {string} [opts.hostName]     - Host display name
 * @param {string} [opts.hostEmail]    - Host email
 * @param {Array}  [opts.attendees]    - Array of { displayName, email, role? }
 * @param {string} [opts.startTime]    - ISO 8601 start time (default: now)
 * @param {number} [opts.duration]     - Duration in minutes (default: template suggestion)
 * @returns {Object} Complete Meeting Object
 */
function createMeetingObject(opts = {}) {
  const id = `meeting_${Date.now()}_${uuidv4().slice(0, 8)}`;
  const template = opts.template || {};
  const now = new Date().toISOString();
  const startTime = opts.startTime || now;
  const duration = opts.duration || template.suggestedDuration || 30;
  const endTime = new Date(new Date(startTime).getTime() + duration * 60000).toISOString();

  const attendees = (opts.attendees || []).map(a => ({
    cn: a.displayName || a.cn || '',
    email: a.email || '',
    role: a.role || 'REQ-PARTICIPANT',
    partstat: 'NEEDS-ACTION',
    rsvp: true,
  }));

  const contacts = (opts.attendees || []).map(a => ({
    email: a.email || '',
    displayName: a.displayName || a.cn || '',
    role: 'participant',
    pastMeetingCount: a.pastMeetingCount || 0,
    lastMet: a.lastMet || null,
    source: a.source || 'manual',
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    templateId: template.id || null,
    spaceId: opts.spaceId || null,
    status: opts.startTime && opts.startTime !== now ? 'scheduled' : 'active',

    calendar: {
      vcalendar: { version: '2.0', prodid: '-//WISER//Meeting//EN' },
      vevent: {
        uid: `${id}@wiser`,
        dtstart: startTime,
        dtend: endTime,
        summary: opts.title || template.name || 'WISER Meeting',
        description: opts.description || '',
        location: 'WISER Meeting',
        status: 'CONFIRMED',
        organizer: {
          cn: opts.hostName || '',
          email: opts.hostEmail || '',
        },
        attendees,
        rrule: null,
        created: now,
        lastModified: now,
      },
    },

    contacts,

    pre: {
      template: {
        id: template.id || null,
        name: template.name || '',
        category: template.category || 'live',
        suggestedDuration: template.suggestedDuration || 30,
        captureMode: template.captureMode || 'camera',
        cameraOn: template.cameraOn !== false,
        screenShare: template.screenShare || false,
        maxParticipants: template.maxParticipants || 10,
        layout: template.layout || 'side-by-side',
      },
      agenda: opts.agenda || [],
      aiSuggestions: {
        suggestedTemplates: [],
        suggestedAttendees: [],
        suggestedDuration: duration,
        suggestedAgenda: [],
        vibePredict: null,
      },
      briefing: null,
      checkpoints: {
        agendaSet: (opts.agenda || []).length > 0,
        attendeesNotified: false,
        openItemsSurfaced: false,
        techReady: { camera: false, mic: false, screen: false },
        priorRelationship: false,
        calendarConflict: false,
      },
    },

    during: {
      startedAt: null,
      endedAt: null,
      actualDuration: null,
      participants: [],
      captureMode: template.captureMode || 'camera',
      recordings: [],
      transcript: { live: [], segments: [] },
      aiNotes: [],
      overlays: [],
      decisions: [],
      actionItems: [],
      bookmarks: [],
      checkpoints: {
        allAudioWorking: false,
        agendaCovered: false,
        everyoneSpoke: false,
        timeTracked: false,
        actionItemsCaptured: false,
      },
    },

    post: {
      summary: null,
      actionItems: [],
      decisions: [],
      vibeScore: null,
      followUp: {
        nextMeetingSuggested: null,
        openThreads: [],
      },
      transcriptItemId: null,
      recordingItemIds: [],
      checkpoints: {
        allItemsAssigned: false,
        followUpScheduled: false,
        recordingSaved: false,
        summarized: false,
      },
    },
  };
}

// ─── Template → Meeting ────────────────────────────────────────────────────────

/**
 * Create a Meeting Object from a template ID.
 *
 * @param {string} templateId - Template ID (e.g. 'touch-base')
 * @param {Object} opts       - Same as createMeetingObject opts (minus template)
 * @param {Function} getTemplate - Function to resolve template by ID
 * @returns {Object} Meeting Object
 */
function createFromTemplate(templateId, opts = {}, getTemplate) {
  const template = getTemplate ? getTemplate(templateId) : null;
  if (!template) {
    throw new Error(`Unknown meeting template: ${templateId}`);
  }
  return createMeetingObject({ ...opts, template });
}

// ─── Validation ────────────────────────────────────────────────────────────────

const VALID_STATUSES = ['draft', 'scheduled', 'active', 'completed', 'cancelled'];

/**
 * Validate a Meeting Object. Returns { valid, errors }.
 */
function validate(meeting) {
  const errors = [];

  if (!meeting) {
    return { valid: false, errors: ['Meeting object is null or undefined'] };
  }
  if (meeting.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Unknown schema version: ${meeting.schemaVersion} (expected ${SCHEMA_VERSION})`);
  }
  if (!meeting.id) errors.push('Missing meeting id');
  if (!meeting.spaceId) errors.push('Missing spaceId');
  if (!VALID_STATUSES.includes(meeting.status)) {
    errors.push(`Invalid status: ${meeting.status}`);
  }
  if (!meeting.calendar?.vevent?.dtstart) errors.push('Missing calendar start time');
  if (!meeting.pre) errors.push('Missing pre phase');
  if (!meeting.during) errors.push('Missing during phase');
  if (!meeting.post) errors.push('Missing post phase');

  return { valid: errors.length === 0, errors };
}

// ─── Lifecycle Mutations ───────────────────────────────────────────────────────

/** Mark meeting as started. Returns a shallow-mutated copy. */
function startMeeting(meeting) {
  const now = new Date().toISOString();
  return {
    ...meeting,
    status: 'active',
    during: { ...meeting.during, startedAt: now },
    calendar: {
      ...meeting.calendar,
      vevent: { ...meeting.calendar.vevent, lastModified: now },
    },
  };
}

/** Mark meeting as completed. Calculates duration. */
function completeMeeting(meeting, extras = {}) {
  const now = new Date().toISOString();
  const startedAt = meeting.during?.startedAt;
  const actualDuration = startedAt
    ? Math.round((Date.now() - new Date(startedAt).getTime()) / 60000)
    : null;

  return {
    ...meeting,
    status: 'completed',
    during: {
      ...meeting.during,
      endedAt: now,
      actualDuration,
      participants: extras.participants || meeting.during.participants,
    },
    post: {
      ...meeting.post,
      recordingItemIds: extras.recordingItemIds || meeting.post.recordingItemIds,
      transcriptItemId: extras.transcriptItemId || meeting.post.transcriptItemId,
      checkpoints: {
        ...meeting.post.checkpoints,
        recordingSaved: (extras.recordingItemIds || []).length > 0,
      },
    },
    calendar: {
      ...meeting.calendar,
      vevent: { ...meeting.calendar.vevent, lastModified: now },
    },
  };
}

/** Add a participant to the during phase. */
function addParticipant(meeting, participant) {
  const existing = meeting.during.participants || [];
  if (existing.some(p => p.identity === participant.identity)) return meeting;
  return {
    ...meeting,
    during: {
      ...meeting.during,
      participants: [...existing, {
        identity: participant.identity || participant.name || 'Guest',
        joinedAt: new Date().toISOString(),
        leftAt: null,
      }],
    },
  };
}

/** Add an action item to the post phase. */
function addActionItem(meeting, item) {
  return {
    ...meeting,
    post: {
      ...meeting.post,
      actionItems: [...meeting.post.actionItems, {
        text: item.text,
        assignee: item.assignee || null,
        deadline: item.deadline || null,
        status: 'open',
      }],
    },
  };
}

// ─── iCal Export ────────────────────────────────────────────────────────────────

/**
 * Serialize the calendar node to an iCal (.ics) string.
 */
function toICS(meeting) {
  const v = meeting.calendar?.vevent;
  if (!v) return null;

  const foldLine = (s) => s;
  const formatDate = (iso) => iso ? iso.replace(/[-:]/g, '').replace(/\.\d+/, '') : '';

  const attendeeLines = (v.attendees || []).map(a =>
    `ATTENDEE;CN=${a.cn};ROLE=${a.role || 'REQ-PARTICIPANT'};PARTSTAT=${a.partstat || 'NEEDS-ACTION'};RSVP=${a.rsvp ? 'TRUE' : 'FALSE'}:mailto:${a.email}`
  ).join('\r\n');

  return [
    'BEGIN:VCALENDAR',
    `VERSION:${meeting.calendar.vcalendar?.version || '2.0'}`,
    `PRODID:${meeting.calendar.vcalendar?.prodid || '-//WISER//Meeting//EN'}`,
    'BEGIN:VEVENT',
    `UID:${v.uid}`,
    `DTSTART:${formatDate(v.dtstart)}`,
    `DTEND:${formatDate(v.dtend)}`,
    foldLine(`SUMMARY:${v.summary || ''}`),
    foldLine(`DESCRIPTION:${(v.description || '').replace(/\n/g, '\\n')}`),
    `LOCATION:${v.location || ''}`,
    `STATUS:${v.status || 'CONFIRMED'}`,
    v.organizer ? `ORGANIZER;CN=${v.organizer.cn}:mailto:${v.organizer.email}` : '',
    attendeeLines,
    `CREATED:${formatDate(v.created)}`,
    `LAST-MODIFIED:${formatDate(v.lastModified)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

// ─── Space Item Conversion ─────────────────────────────────────────────────────

/**
 * Convert a Meeting Object into a Space item payload for spacesAPI.items.add().
 */
function toSpaceItem(meeting) {
  return {
    type: 'text',
    content: JSON.stringify(meeting, null, 2),
    spaceId: meeting.spaceId,
    source: 'wiser-meeting',
    preview: `${meeting.pre?.template?.name || 'Meeting'}: ${meeting.calendar?.vevent?.summary || meeting.id}`,
    tags: ['wiser-meeting'],
    metadata: {
      title: meeting.calendar?.vevent?.summary || 'Meeting',
      source: 'wiser-meeting',
      meetingId: meeting.id,
      templateId: meeting.templateId,
      status: meeting.status,
    },
  };
}

/**
 * Parse a Space item back into a Meeting Object.
 */
function fromSpaceItem(item) {
  try {
    return JSON.parse(item.content);
  } catch {
    return null;
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  createMeetingObject,
  createFromTemplate,
  validate,
  startMeeting,
  completeMeeting,
  addParticipant,
  addActionItem,
  toICS,
  toSpaceItem,
  fromSpaceItem,
};
