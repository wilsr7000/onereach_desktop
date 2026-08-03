/**
 * Meeting draft - the "easier than Zoom" start flow's working state.
 *
 * One draft at a time (main process singleton): title, target space,
 * participant list. The Meeting Starter agent's tools mutate the draft as
 * the user talks ("add Erika", "call it design sync"), the setup modal
 * mirrors it, and meeting_start consumes it: resolve/create the Space, open
 * the WISER Meeting recorder targeted at that space with the participants
 * in the session instructions (the recorder owns guest links from there).
 *
 * Deps seam: `_setTestDeps({ listSpaces, createSpace, openRecorder, now })`.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _deps = null;

function _setTestDeps(deps) {
  _deps = deps || null;
}

// Lazy spaces API (same pattern as recorder-agent).
let _spacesAPI = null;
function _getSpacesAPI() {
  if (!_spacesAPI) {
    const SpacesAPIClass = require('../../spaces-api');
    _spacesAPI = new SpacesAPIClass();
  }
  return _spacesAPI;
}

async function _listSpaces() {
  if (_deps && _deps.listSpaces) return _deps.listSpaces();
  return _getSpacesAPI().list();
}

async function _createSpace(name) {
  if (_deps && _deps.createSpace) return _deps.createSpace(name);
  return _getSpacesAPI().create(name);
}

function _openRecorder(options) {
  if (_deps && _deps.openRecorder) return _deps.openRecorder(options);
  if (global.recorder && typeof global.recorder.open === 'function') {
    global.recorder.open(options);
    return { success: true };
  }
  if (global.mainWindow && global.mainWindow.webContents) {
    global.mainWindow.webContents.send('open-recorder', options);
    return { success: true };
  }
  return { success: false, error: 'Recorder not initialized' };
}

// ── Draft state ──────────────────────────────────────────────────────────────

const EMPTY_DRAFT = () => ({ title: null, spaceName: null, participants: [] });
let _draft = EMPTY_DRAFT();

function getDraft() {
  return {
    title: _draft.title,
    spaceName: _draft.spaceName,
    participants: [..._draft.participants],
  };
}

function clearDraft() {
  _draft = EMPTY_DRAFT();
  return getDraft();
}

function _normName(n) {
  return String(n || '').trim();
}

/**
 * Mutate the draft. All fields optional; add/remove match case-insensitively
 * on participant name.
 *
 * @param {Object} changes - { title?, spaceName?, add?: [{name,email?}|string], remove?: [string] }
 * @returns {Object} the updated draft
 */
function updateDraft(changes = {}) {
  if (changes.title !== undefined) _draft.title = _normName(changes.title) || null;
  if (changes.spaceName !== undefined) _draft.spaceName = _normName(changes.spaceName) || null;

  for (const raw of changes.add || []) {
    const p = typeof raw === 'string' ? { name: raw } : raw || {};
    const name = _normName(p.name);
    if (!name) continue;
    const exists = _draft.participants.some((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!exists) _draft.participants.push({ name, email: p.email || null });
  }

  for (const raw of changes.remove || []) {
    const name = _normName(typeof raw === 'string' ? raw : raw && raw.name).toLowerCase();
    if (!name) continue;
    _draft.participants = _draft.participants.filter((x) => x.name.toLowerCase() !== name);
  }

  return getDraft();
}

// ── Start ────────────────────────────────────────────────────────────────────

/**
 * Start the meeting from the current draft (or explicit overrides):
 * resolve/create the Space, open the WISER Meeting recorder targeted at it,
 * clear the draft. The recorder window owns the LiveKit room + guest links.
 *
 * @param {Object} [overrides] - { title?, spaceName?, participants? }
 * @returns {Promise<{ started: boolean, spaceId?, spaceName?, participants?, title?, error? }>}
 */
async function startMeeting(overrides = {}) {
  const draft = getDraft();
  const title = _normName(overrides.title) || draft.title || 'Meeting';
  const spaceNameWanted = _normName(overrides.spaceName) || draft.spaceName || null;
  const participants =
    (Array.isArray(overrides.participants) && overrides.participants.length
      ? overrides.participants.map((p) => (typeof p === 'string' ? { name: p, email: null } : p))
      : draft.participants) || [];

  // Resolve the target space: named -> exact/partial match -> create it;
  // unnamed -> existing meeting-ish space -> create "Meetings".
  let spaceId = null;
  let spaceName = null;
  try {
    const spaces = (await _listSpaces()) || [];
    const lower = (s) => String(s || '').toLowerCase();
    if (spaceNameWanted) {
      const match =
        spaces.find((s) => lower(s.name) === lower(spaceNameWanted)) ||
        spaces.find((s) => lower(s.name).includes(lower(spaceNameWanted)) || lower(spaceNameWanted).includes(lower(s.name)));
      if (match) {
        spaceId = match.id;
        spaceName = match.name;
      } else {
        const created = await _createSpace(spaceNameWanted);
        spaceId = created && created.id;
        spaceName = spaceNameWanted;
      }
    } else {
      const meetingish = spaces.find((s) => /meeting|wiser|wsr/i.test(s.name || ''));
      if (meetingish) {
        spaceId = meetingish.id;
        spaceName = meetingish.name;
      } else {
        const created = await _createSpace('Meetings');
        spaceId = created && created.id;
        spaceName = 'Meetings';
      }
    }
  } catch (err) {
    log.warn('meetings', 'Space resolution failed; starting without a space', { error: err.message });
  }

  const names = participants.map((p) => p.name).join(', ');
  const instructions = [
    `Meeting: ${title}`,
    names ? `Participants: ${names}` : 'Participants: (open invite)',
    'Share the join link from the session panel to bring participants in.',
  ].join('\n');

  const opened = _openRecorder({
    spaceId: spaceId || undefined,
    instructions,
    meetingTitle: title,
    participants,
  });

  if (!opened || opened.success !== true) {
    return { started: false, error: (opened && opened.error) || 'Could not open the meeting window' };
  }

  log.info('meetings', 'Meeting started', {
    title,
    spaceId: spaceId || null,
    participantCount: participants.length,
  });

  clearDraft();
  return { started: true, spaceId: spaceId || null, spaceName, participants, title };
}

module.exports = { getDraft, updateDraft, clearDraft, startMeeting, _setTestDeps };
