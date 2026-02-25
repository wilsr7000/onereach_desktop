/**
 * Calendar Format Layer — Pure Templating & Rendering
 *
 * Transforms DayAnalysis / enriched events into:
 *   - HUD eventList UI specs
 *   - Spoken summaries for TTS
 *   - Meeting link extraction
 *   - Confirmation messages for mutations
 *
 * All functions are pure (no side effects, no API calls).
 */

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Meeting Link Extraction
// ────────────────────────────────────────────────────────────────────────────

const MEETING_URL_PATTERNS = [
  /https?:\/\/[\w.-]*zoom\.us\/j\/\S+/i,
  /https?:\/\/meet\.google\.com\/\S+/i,
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/\S+/i,
  /https?:\/\/[\w.-]*webex\.com\/\S+/i,
  /https?:\/\/[\w.-]*gotomeeting\.com\/\S+/i,
  /https?:\/\/[\w.-]*chime\.aws\/\S+/i,
  /https?:\/\/[\w.-]*bluejeans\.com\/\S+/i,
];

function _findMeetingUrl(text) {
  if (!text) return null;
  for (const pattern of MEETING_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].replace(/[<>\s"']+$/, '');
  }
  return null;
}

function identifyProvider(url) {
  if (!url) return 'Video Call';
  const u = url.toLowerCase();
  if (u.includes('zoom.us')) return 'Zoom';
  if (u.includes('meet.google.com')) return 'Google Meet';
  if (u.includes('teams.microsoft.com')) return 'Microsoft Teams';
  if (u.includes('webex.com')) return 'Webex';
  if (u.includes('gotomeeting.com')) return 'GoToMeeting';
  if (u.includes('chime.aws')) return 'Amazon Chime';
  if (u.includes('bluejeans.com')) return 'BlueJeans';
  return 'Video Call';
}

/**
 * Extract the best meeting link from a calendar event.
 * Checks hangoutLink → conferenceData → location → description.
 *
 * @param {Object} event - Raw calendar event
 * @returns {{ url: string|null, provider: string|null, label: string|null }}
 */
function extractMeetingLink(event) {
  if (!event) return { url: null, provider: null, label: null };

  // Google Meet
  if (event.hangoutLink) {
    return { url: event.hangoutLink, provider: 'Google Meet', label: 'Join Google Meet' };
  }

  // Conference data entry points
  if (event.conferenceData?.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find((ep) => ep.entryPointType === 'video');
    if (videoEntry?.uri) {
      const provider = identifyProvider(videoEntry.uri);
      return { url: videoEntry.uri, provider, label: `Join ${provider}` };
    }
  }

  // Location field
  if (event.location) {
    const locLink = _findMeetingUrl(event.location);
    if (locLink) {
      const provider = identifyProvider(locLink);
      return { url: locLink, provider, label: `Join ${provider}` };
    }
  }

  // Description field
  if (event.description) {
    const descLink = _findMeetingUrl(event.description);
    if (descLink) {
      const provider = identifyProvider(descLink);
      return { url: descLink, provider, label: `Join ${provider}` };
    }
  }

  return { url: null, provider: null, label: null };
}

// ────────────────────────────────────────────────────────────────────────────
// Importance Scoring
// ────────────────────────────────────────────────────────────────────────────

/**
 * Score event importance 1-5 based on attendees, duration, description, recurrence.
 */
function calcImportance(event) {
  let score = 1;
  const attendees = event.attendees?.length || 0;
  if (attendees >= 6) score += 2;
  else if (attendees >= 3) score += 1;

  const start = new Date(event.start?.dateTime || event.start?.date);
  const end = new Date(event.end?.dateTime || event.end?.date || start);
  const durationMins = (end - start) / 60000;
  if (durationMins >= 60) score += 1;

  if (event.description && event.description.trim().length > 20) score += 1;
  if (event.recurringEventId) score += 0.5;

  return Math.min(5, Math.round(score));
}

// ────────────────────────────────────────────────────────────────────────────
// Time Formatting
// ────────────────────────────────────────────────────────────────────────────

function formatEventTime(event) {
  const dt = event.start?.dateTime || event.start?.date;
  if (!dt) return 'TBD';
  if (!event.start?.dateTime) return 'All Day';
  const d = new Date(dt);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatEventTimeRange(event) {
  const startDt = event.start?.dateTime;
  const endDt = event.end?.dateTime;
  if (!startDt) return formatEventTime(event);
  const s = new Date(startDt);
  const start = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!endDt) return start;
  const e = new Date(endDt);
  const end = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${start} - ${end}`;
}

function formatDateLabel(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ────────────────────────────────────────────────────────────────────────────
// HUD Rendering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a declarative eventList UI spec from raw events.
 * Compatible with renderAgentUI({ type: 'eventList', ... }).
 *
 * @param {Array} events - Raw calendar API event objects
 * @param {string} label - Panel header (e.g., "Today", "This Week")
 * @returns {Object} eventList UI spec
 */
function buildEventsUISpec(events, label) {
  const mapped = (events || []).map((e) => {
    const time = formatEventTime(e);
    const title = e.summary || 'Untitled';
    const importance = calcImportance(e);
    const recurring = !!e.recurringEventId;

    const attendees = (e.attendees || []).map((a) => {
      const email = a.email || '';
      const name = a.displayName || email.split('@')[0] || '?';
      return { initial: name.charAt(0).toUpperCase(), name };
    });

    return { time, title, recurring, importance, attendees, actionValue: `tell me more about ${title}` };
  });

  return { type: 'eventList', title: label || 'Events', events: mapped };
}

/**
 * Build an eventList UI spec from a DayAnalysis object.
 * Uses enriched events that already have temporal status.
 *
 * @param {Object} dayAnalysis - Output of analyzeDay()
 * @param {string} [label] - Override label
 * @returns {Object} eventList UI spec
 */
function buildDayUISpec(dayAnalysis, label) {
  if (!dayAnalysis) return { type: 'eventList', title: label || 'Events', events: [] };

  // current is a single enriched event or null; coerce to array for uniform handling
  const currentArr = dayAnalysis.current ? [dayAnalysis.current] : [];
  const ordered = [...currentArr, ...(dayAnalysis.remaining || []), ...(dayAnalysis.past || [])];

  const mapped = ordered.map((enriched) => {
    const raw = enriched.event;
    const time = formatEventTime(raw);
    const title = raw.summary || 'Untitled';
    const importance = calcImportance(raw);
    const recurring = !!raw.recurringEventId;

    const attendees = (raw.attendees || []).map((a) => {
      const email = a.email || '';
      const name = a.displayName || email.split('@')[0] || '?';
      return { initial: name.charAt(0).toUpperCase(), name };
    });

    const meetingLink = extractMeetingLink(raw);
    const status = enriched.status;

    return {
      time,
      title,
      recurring,
      importance,
      attendees,
      status,
      meetingLink: meetingLink.url ? meetingLink : undefined,
      actionValue: `tell me more about ${title}`,
    };
  });

  return {
    type: 'eventList',
    title: label || dayAnalysis.label || 'Events',
    events: mapped,
    summary: dayAnalysis.summary,
  };
}

/**
 * Build a UI spec from morning brief data.
 */
function buildBriefUISpec(briefData) {
  if (!briefData || !briefData.timeline || briefData.timeline.length === 0) {
    return { type: 'eventList', title: 'Today', events: [] };
  }

  const mapped = briefData.timeline.map((ev) => {
    let importance = 1;
    const guests = ev.guests || [];
    if (guests.length >= 6) importance += 2;
    else if (guests.length >= 3) importance += 1;
    if (ev.duration >= 60) importance += 1;
    if (ev.isRecurring) importance += 0.5;
    importance = Math.min(5, Math.round(importance));

    const attendees = guests.map((g) => {
      const name = typeof g === 'string' ? g : g.displayName || g.email?.split('@')[0] || '?';
      return { initial: name.charAt(0).toUpperCase(), name };
    });

    return {
      time: ev.start || '',
      title: ev.title || 'Untitled',
      recurring: !!ev.isRecurring,
      importance,
      attendees,
      actionValue: `tell me more about ${ev.title || 'this event'}`,
    };
  });

  return { type: 'eventList', title: briefData.dayLabel || 'Today', events: mapped };
}

// ────────────────────────────────────────────────────────────────────────────
// Spoken Summaries (TTS)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Short spoken summary for when a rich HTML panel is shown.
 */
function buildShortSpokenSummary(events, label) {
  const count = events.length;
  const period = (label || 'today').toLowerCase();

  if (count === 0) return `Your calendar is clear ${period}.`;

  if (count === 1) {
    const time = formatEventTime(events[0]);
    return `You have one meeting ${period}: "${events[0].summary}" at ${time}.`;
  }

  if (count <= 3) {
    const names = events.map((e) => `"${e.summary}"`).join(', ');
    return `You have ${count} meetings ${period}: ${names}.`;
  }

  const first = events[0];
  const time = formatEventTime(first);
  return `You have ${count} meetings ${period}, starting with "${first.summary}" at ${time}.`;
}

/**
 * Build a detailed spoken summary from a DayAnalysis.
 *
 * @param {Object} dayAnalysis - Output of analyzeDay()
 * @param {string} [label] - Time period label
 * @returns {string} Spoken summary for TTS
 */
function spokenDaySummary(dayAnalysis, label) {
  if (!dayAnalysis) return `I couldn't load your calendar ${(label || 'today').toLowerCase()}.`;

  const period = (label || dayAnalysis.label || 'today').toLowerCase();
  const total = dayAnalysis.summary.total;

  if (total === 0) return `Your calendar is clear ${period}.`;

  const parts = [];

  // Current meeting (single object or null from analyzeDay)
  if (dayAnalysis.current) {
    parts.push(`You're currently in "${dayAnalysis.current.event.summary}".`);
  }

  // Next meeting
  if (dayAnalysis.next) {
    const next = dayAnalysis.next;
    const time = formatEventTime(next.event);
    if (next.startsInMs > 0 && next.startsInMs < 3600000) {
      const mins = Math.round(next.startsInMs / 60000);
      parts.push(`"${next.event.summary}" starts in ${mins} minute${mins !== 1 ? 's' : ''}.`);
    } else {
      parts.push(`Next up is "${next.event.summary}" at ${time}.`);
    }
  }

  // Remaining count
  const remainingCount = dayAnalysis.remaining.length;
  if (remainingCount > 1) {
    parts.push(`${remainingCount} meetings remaining ${period}.`);
  } else if (remainingCount === 1 && !dayAnalysis.next) {
    parts.push(`One more meeting ${period}.`);
  }

  // Conflicts
  if (dayAnalysis.conflicts.length > 0) {
    parts.push(
      `${dayAnalysis.conflicts.length} scheduling conflict${dayAnalysis.conflicts.length > 1 ? 's' : ''} detected.`
    );
  }

  if (parts.length === 0) {
    return `You have ${total} meeting${total !== 1 ? 's' : ''} ${period}.`;
  }

  return parts.join(' ');
}

// ────────────────────────────────────────────────────────────────────────────
// Mutation Confirmations
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a confirmation message for a created event.
 */
function confirmCreate(params, verified) {
  const eventDate = new Date(`${params.date}T${params.time}`);
  const formattedDate = formatDateLabel(eventDate);
  const formattedTime = eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  let msg = `Done! I've added "${params.title}" to your calendar for ${formattedDate} at ${formattedTime}`;
  if (params.duration && params.duration !== '60m') msg += ` (${params.duration})`;
  if (params.location) msg += ` at ${params.location}`;
  msg += '.';

  if (params.guests && params.guests.length > 0) {
    msg += ` Invitation sent to ${params.guests.length} guest${params.guests.length > 1 ? 's' : ''}.`;
  }

  if (!verified) msg += ' (Verification pending -- the event may take a moment to appear.)';

  return msg;
}

/**
 * Build a confirmation message for a deleted event.
 */
function confirmDelete(eventTitle, verified) {
  let msg = `Done! I've removed "${eventTitle}" from your calendar.`;
  if (!verified) msg += ' (It may take a moment to disappear.)';
  return msg;
}

/**
 * Build a confirmation message for an edited event.
 */
function confirmEdit(oldTitle, newParams, verified) {
  const changes = [];
  if (newParams.title && newParams.title !== oldTitle) changes.push(`renamed to "${newParams.title}"`);
  if (newParams.date) changes.push(`moved to ${formatDateLabel(new Date(newParams.date + 'T12:00:00'))}`);
  if (newParams.time) {
    const t = new Date(`2026-01-01T${newParams.time}`);
    changes.push(`at ${t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
  }
  if (newParams.location) changes.push(`location set to ${newParams.location}`);
  if (newParams.duration) changes.push(`duration changed to ${newParams.duration}`);

  let msg = `Done! I've updated "${oldTitle}"`;
  if (changes.length > 0) msg += `: ${changes.join(', ')}`;
  msg += '.';

  if (!verified) msg += ' (Verification pending.)';

  return msg;
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Meeting links
  extractMeetingLink,
  identifyProvider,
  findMeetingUrl: _findMeetingUrl,

  // Importance
  calcImportance,

  // Time formatting
  formatEventTime,
  formatEventTimeRange,
  formatDateLabel,

  // HUD specs
  buildEventsUISpec,
  buildDayUISpec,
  buildBriefUISpec,

  // Spoken summaries
  buildShortSpokenSummary,
  spokenDaySummary,

  // Mutation confirmations
  confirmCreate,
  confirmDelete,
  confirmEdit,
};
