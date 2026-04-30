/**
 * Critical Meeting Alarm Agent
 *
 * Background system agent. Polls the calendar every minute, evaluates each
 * upcoming event against the user-editable rules in its own memory .md file,
 * and schedules alarms at the configured lead times before the meeting starts.
 *
 * Not voice-triggerable. Auto-started from main.js after the agent exchange
 * is ready. Rules live in Spaces at gsx-agent/agent-memory/critical-meeting-alarm-agent.md
 * and are re-parsed automatically when the user edits the file.
 *
 * Delivery channels (fanned out at fire time, per-lead-time policy):
 *   - hud    -> command-hud window via `critical-alarms:fire` IPC (alarmCard)
 *   - voice  -> global.agentMessageQueue proactive speech (priority scaled by lead)
 *   - os     -> Electron Notification with urgency='critical'
 *   - sound  -> orb-sound-engine chime (if available; silently skipped otherwise)
 *
 * Persistence: .../userData/critical-alarms/state.json tracks fired alarms
 * and snoozes across app restarts so we never double-fire.
 *
 * See lib/critical-meeting-rules.js for the evaluation engine.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const { getAgentMemory } = require('../../lib/agent-memory-store');
const rules = require('../../lib/critical-meeting-rules');

// Lazy-required so tests don't pull the whole Electron surface.
function _electron() {
  try {
    return require('electron');
  } catch (_) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Module-level state (mirrors meeting-monitor-agent pattern)
// ────────────────────────────────────────────────────────────────────────────

const AGENT_ID = 'critical-meeting-alarm-agent';
const DISPLAY_NAME = 'Critical Meeting Alarm';

const POLL_INTERVAL_MS = 60_000;
const MEMORY_POLL_INTERVAL_MS = 30_000; // check memory mtime every 30s as a cheap change-detector
const STATE_PRUNE_DAYS = 7;

let pollInterval = null;
let memoryPollInterval = null;
let isMonitoring = false;

// alarmKey -> { timeoutHandle, event, leadMinutes, scheduledFor, channels }
const _scheduledAlarms = new Map();

// Dedupe set of alarm keys that already fired this process run.
let _firedAlarms = {}; // { alarmKey: firedAtEpochMs }
let _snoozes = {}; // { eventId: { untilEpochMs } }

let _stateFilePath = null;
let _lastMemoryMtime = 0;

// Exposed to tests to bypass resume / powerMonitor integration.
let _powerMonitorHandlerInstalled = false;

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

function _getStateFilePath() {
  if (_stateFilePath) return _stateFilePath;
  const el = _electron();
  let base = null;
  try {
    base = el?.app?.getPath?.('userData');
  } catch (_) {
    /* no-op */
  }
  if (!base) {
    base = path.join(require('os').tmpdir(), 'gsx-critical-alarms');
  }
  _stateFilePath = path.join(base, 'critical-alarms', 'state.json');
  return _stateFilePath;
}

async function _loadState() {
  try {
    const file = _getStateFilePath();
    if (!fs.existsSync(file)) return;
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    _firedAlarms = parsed?.firedAlarms && typeof parsed.firedAlarms === 'object' ? parsed.firedAlarms : {};
    _snoozes = parsed?.snoozes && typeof parsed.snoozes === 'object' ? parsed.snoozes : {};
    _pruneState();
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] Failed to load state, starting fresh`, { error: err.message });
    _firedAlarms = {};
    _snoozes = {};
  }
}

async function _saveState() {
  try {
    const file = _getStateFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const payload = JSON.stringify({ firedAlarms: _firedAlarms, snoozes: _snoozes }, null, 2);
    await fs.promises.writeFile(file, payload, 'utf8');
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] Failed to save state`, { error: err.message });
  }
}

function _pruneState() {
  const cutoff = Date.now() - STATE_PRUNE_DAYS * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(_firedAlarms)) {
    if (typeof v !== 'number' || v < cutoff) delete _firedAlarms[k];
  }
  for (const [k, v] of Object.entries(_snoozes)) {
    if (!v || typeof v.untilEpochMs !== 'number' || v.untilEpochMs < Date.now()) delete _snoozes[k];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Alarm key / scheduling
// ────────────────────────────────────────────────────────────────────────────

function _eventStartMs(event) {
  const s = event?.start?.dateTime || event?.start?.date;
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function _eventId(event) {
  return String(event?.id || event?.iCalUID || '');
}

function _alarmKey(event, leadMinutes) {
  return `${_eventId(event)}::${_eventStartMs(event) || 0}::${leadMinutes}`;
}

function _isSnoozed(event) {
  const snooze = _snoozes[_eventId(event)];
  if (!snooze) return false;
  if (snooze.untilEpochMs < Date.now()) {
    delete _snoozes[_eventId(event)];
    return false;
  }
  return true;
}

function _cancelAllForEvent(event) {
  const eventId = _eventId(event);
  if (!eventId) return 0;
  let cancelled = 0;
  for (const [key, entry] of _scheduledAlarms.entries()) {
    if (key.startsWith(`${eventId}::`)) {
      clearTimeout(entry.timeoutHandle);
      _scheduledAlarms.delete(key);
      cancelled++;
    }
  }
  return cancelled;
}

// ────────────────────────────────────────────────────────────────────────────
// Delivery fan-out
// ────────────────────────────────────────────────────────────────────────────

function _buildAlarmMessage(event, leadMinutes) {
  const title = String(event?.summary || event?.title || 'Upcoming meeting');
  if (leadMinutes <= 1) return `Critical meeting starting now: ${title}.`;
  if (leadMinutes <= 5) return `Critical meeting in ${leadMinutes} minutes: ${title}.`;
  return `Heads up: ${title} starts in ${leadMinutes} minutes.`;
}

function _deliverVoice(event, leadMinutes) {
  try {
    const queue = global.agentMessageQueue;
    if (!queue || typeof queue.enqueue !== 'function') {
      log.info('agent', `[${AGENT_ID}] Voice channel skipped (no agent message queue)`);
      return;
    }
    const priority = leadMinutes <= 1 ? 'urgent' : leadMinutes <= 5 ? 'high' : 'normal';
    queue.enqueue(AGENT_ID, _buildAlarmMessage(event, leadMinutes), priority, {
      maxAgeMs: 2 * 60 * 1000,
      metadata: { eventId: _eventId(event), leadMinutes },
    });
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] Voice delivery failed`, { error: err.message });
  }
}

function _deliverHud(event, leadMinutes, reasons, channels) {
  try {
    const el = _electron();
    if (!el || !el.BrowserWindow) return;
    const payload = {
      id: _alarmKey(event, leadMinutes),
      eventId: _eventId(event),
      title: String(event?.summary || event?.title || 'Meeting'),
      startEpochMs: _eventStartMs(event),
      leadMinutes,
      location: String(event?.location || ''),
      joinLink: _extractJoinLink(event),
      reasons: Array.isArray(reasons) ? reasons.slice(0, 5) : [],
      channels,
      message: _buildAlarmMessage(event, leadMinutes),
    };
    for (const win of el.BrowserWindow.getAllWindows()) {
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('critical-alarms:fire', payload);
        }
      } catch (_) {
        /* non-fatal per-window */
      }
    }
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] HUD delivery failed`, { error: err.message });
  }
}

function _extractJoinLink(event) {
  // Prefer Google Meet hangoutLink, then first conference video entry, then
  // any URL in the description.
  if (event?.hangoutLink) return event.hangoutLink;
  const entry = event?.conferenceData?.entryPoints?.find?.((e) => e.entryPointType === 'video');
  if (entry?.uri) return entry.uri;
  const desc = String(event?.description || '');
  const m = desc.match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}

function _deliverOs(event, leadMinutes) {
  try {
    const el = _electron();
    const Notification = el?.Notification;
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;
    const notif = new Notification({
      title: leadMinutes <= 1 ? 'Meeting starting now' : `Meeting in ${leadMinutes} min`,
      body: String(event?.summary || event?.title || 'Upcoming meeting'),
      urgency: leadMinutes <= 1 ? 'critical' : 'normal',
      timeoutType: leadMinutes <= 1 ? 'never' : 'default',
      silent: false,
    });
    const joinLink = _extractJoinLink(event);
    if (joinLink) {
      notif.on('click', () => {
        try {
          el.shell.openExternal(joinLink);
        } catch (_) {
          /* non-fatal */
        }
      });
    }
    notif.show();
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] OS delivery failed`, { error: err.message });
  }
}

function _deliverSound(_event, _leadMinutes) {
  // TODO: hook up orb-sound-engine once a suitable chime method is available.
  // Silently skipped for now -- voice + HUD + OS already fire.
}

async function _fireAlarm(event, leadMinutes, reasons, channels) {
  const key = _alarmKey(event, leadMinutes);
  if (_firedAlarms[key]) {
    log.info('agent', `[${AGENT_ID}] Alarm already fired, skipping`, { key });
    return;
  }
  if (_isSnoozed(event)) {
    log.info('agent', `[${AGENT_ID}] Alarm suppressed (snoozed)`, { eventId: _eventId(event) });
    return;
  }
  _firedAlarms[key] = Date.now();
  _scheduledAlarms.delete(key);

  log.info('agent', `[${AGENT_ID}] FIRING alarm`, {
    event: String(event?.summary || event?.title || ''),
    leadMinutes,
    channels,
  });

  if (channels?.voice) _deliverVoice(event, leadMinutes);
  if (channels?.hud) _deliverHud(event, leadMinutes, reasons, channels);
  if (channels?.os) _deliverOs(event, leadMinutes);
  if (channels?.sound) _deliverSound(event, leadMinutes);

  await _saveState();
}

function _scheduleAlarmAt(event, leadMinutes, fireAtMs, reasons, channels) {
  const key = _alarmKey(event, leadMinutes);
  if (_firedAlarms[key]) return false;
  if (_scheduledAlarms.has(key)) return false;
  const delay = fireAtMs - Date.now();
  if (delay <= 0) {
    _fireAlarm(event, leadMinutes, reasons, channels).catch((err) =>
      log.warn('agent', `[${AGENT_ID}] immediate fire failed`, { error: err.message })
    );
    return true;
  }
  const handle = setTimeout(() => {
    _fireAlarm(event, leadMinutes, reasons, channels).catch((err) =>
      log.warn('agent', `[${AGENT_ID}] delayed fire failed`, { error: err.message })
    );
  }, delay);
  if (handle.unref) handle.unref();
  _scheduledAlarms.set(key, {
    timeoutHandle: handle,
    event,
    leadMinutes,
    scheduledFor: fireAtMs,
    channels,
  });
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Calendar pull
// ────────────────────────────────────────────────────────────────────────────

async function _fetchUpcomingEvents() {
  try {
    const { getEventsForDay } = require('../../lib/calendar-fetch');
    if (typeof getEventsForDay !== 'function') return [];
    const now = new Date();
    const [todayRes, tomorrowRes] = await Promise.all([
      getEventsForDay('today', now).catch(() => ({ events: [] })),
      getEventsForDay('tomorrow', now).catch(() => ({ events: [] })),
    ]);
    const all = [
      ...(Array.isArray(todayRes?.events) ? todayRes.events : []),
      ...(Array.isArray(tomorrowRes?.events) ? tomorrowRes.events : []),
    ];
    return all;
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] Failed to fetch events`, { error: err.message });
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Poll cycle
// ────────────────────────────────────────────────────────────────────────────

async function _pollCycle(agent) {
  if (!isMonitoring) return;
  try {
    const events = await _fetchUpcomingEvents();
    const now = Date.now();
    const horizonMs = 2 * 60 * 60 * 1000; // only schedule up to 2 hours out per cycle

    for (const event of events) {
      const startMs = _eventStartMs(event);
      if (!startMs) continue;
      if (startMs < now - 60_000) continue; // already passed
      if (startMs > now + 24 * 60 * 60 * 1000) continue; // beyond tomorrow window

      const verdict = await rules.evaluate(event, { now, ruleSet: agent._ruleSet });
      if (!verdict.critical) continue;

      for (const lead of verdict.leadTimesMin) {
        const fireAt = startMs - lead * 60_000;
        if (fireAt < now - 60_000) continue; // lead time already past; don't retro-fire
        if (fireAt - now > horizonMs + 60_000) continue; // too far out for this cycle
        const channels = verdict.channelsForLead(lead);
        _scheduleAlarmAt(event, lead, fireAt, verdict.reasons, channels);
      }
    }

    // Prune any scheduled alarms for events that vanished from the calendar
    for (const [key, entry] of _scheduledAlarms.entries()) {
      const still = events.find((e) => _eventId(e) === _eventId(entry.event));
      if (!still) {
        clearTimeout(entry.timeoutHandle);
        _scheduledAlarms.delete(key);
      }
    }
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] Poll cycle error`, { error: err.message });
  }
}

async function _checkMemoryForChanges(agent) {
  try {
    if (!agent?.memory || !agent.memory.isLoaded || !agent.memory.isLoaded()) return;
    // Reload from the live Spaces copy so user edits made outside the agent
    // (in the Spaces UI) are picked up. The memory store does the I/O.
    if (typeof agent.memory.load === 'function') {
      try {
        await agent.memory.load();
      } catch (_) {
        /* use cached */
      }
    }
    const result = await rules.reloadFromMemory(agent.memory);
    if (result.changed) {
      agent._ruleSet = result.ruleSet;
      log.info('agent', `[${AGENT_ID}] Rules reloaded from memory`, {
        vips: agent._ruleSet.vipAttendees.size,
        keywords: agent._ruleSet.keywordTriggers.length,
        rules: agent._ruleSet.freeFormRules.length,
      });
    }
  } catch (err) {
    log.warn('agent', `[${AGENT_ID}] Memory re-parse failed`, { error: err.message });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The agent object
// ────────────────────────────────────────────────────────────────────────────

const criticalMeetingAlarmAgent = {
  id: AGENT_ID,
  name: DISPLAY_NAME,
  description:
    'Watches your calendar and fires alarms before critical meetings. Rules live in this agent\'s memory file in Spaces -- edit it to mark VIPs, keywords, and free-form criticality rules. Not voice-triggerable; auto-starts at boot.',
  voice: 'alloy',
  acks: [],
  categories: ['productivity', 'calendar', 'alarms'],
  keywords: ['alarm', 'critical meeting', 'meeting reminder'],
  executionType: 'system',
  bidExcluded: true,

  prompt:
    'Critical Meeting Alarm runs in the background. It should never win a bid for user requests. It fires alarms before critical meetings according to user-authored rules in its memory file.',

  memory: null,
  _ruleSet: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory(AGENT_ID, { displayName: DISPLAY_NAME });
      try {
        await this.memory.load();
      } catch (err) {
        log.warn('agent', `[${AGENT_ID}] memory load failed`, { error: err.message });
      }
    }
    // Seed missing sections so a freshly-installed agent has the right layout.
    try {
      await rules.seedMemorySections(this.memory);
    } catch (err) {
      log.warn('agent', `[${AGENT_ID}] section seeding failed`, { error: err.message });
    }
    const result = await rules.reloadFromMemory(this.memory, { forceReparse: true });
    this._ruleSet = result.ruleSet;
    await _loadState();
    return this.memory;
  },

  async execute(_task) {
    return {
      success: true,
      message:
        'Critical Meeting Alarm is a background agent. Edit its memory file in Spaces to configure which meetings trigger alarms.',
    };
  },

  /**
   * Daily brief contribution. Lists today's critical meetings so the brief
   * surfaces them even when the user hasn't opened the calendar.
   */
  async getBriefing() {
    try {
      if (!this._ruleSet) await this.initialize();
      const events = await _fetchUpcomingEvents();
      const now = Date.now();
      const critical = [];
      for (const event of events) {
        const startMs = _eventStartMs(event);
        if (!startMs || startMs < now) continue;
        const verdict = await rules.evaluate(event, { now, ruleSet: this._ruleSet });
        if (!verdict.critical) continue;
        critical.push({
          title: String(event?.summary || event?.title || ''),
          startMs,
          reason: verdict.reasons[0] || '',
        });
      }
      if (!critical.length) {
        return { section: 'Critical today', priority: 2, content: null };
      }
      critical.sort((a, b) => a.startMs - b.startMs);
      const lines = critical.slice(0, 5).map((c) => {
        const when = new Date(c.startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `${when}: ${c.title}${c.reason ? ` (${c.reason})` : ''}`;
      });
      return {
        section: 'Critical today',
        priority: 2,
        content:
          critical.length === 1
            ? `One critical meeting: ${lines[0]}.`
            : `${critical.length} critical meetings today:\n- ${lines.join('\n- ')}`,
      };
    } catch (err) {
      log.warn('agent', `[${AGENT_ID}] getBriefing failed`, { error: err.message });
      return { section: 'Critical today', priority: 2, content: null };
    }
  },

  // ==========================================================================
  // PUBLIC: startMonitoring / stopMonitoring / status / snooze / dismiss / test
  // ==========================================================================

  async startMonitoring() {
    if (isMonitoring) return;
    await this.initialize();
    isMonitoring = true;

    // Install a power-monitor handler so we re-evaluate after sleep/resume.
    // Clock drift + our in-memory setTimeout queue would otherwise miss alarms.
    if (!_powerMonitorHandlerInstalled) {
      const el = _electron();
      if (el?.powerMonitor && typeof el.powerMonitor.on === 'function') {
        el.powerMonitor.on('resume', () => {
          log.info('agent', `[${AGENT_ID}] powerMonitor.resume -- re-evaluating`);
          _pollCycle(this).catch(() => {});
        });
        _powerMonitorHandlerInstalled = true;
      }
    }

    // Initial poll to pick up alarms that should fire soon after boot.
    await _pollCycle(this);

    pollInterval = setInterval(() => {
      _pollCycle(this).catch((err) => {
        log.warn('agent', `[${AGENT_ID}] poll tick error`, { error: err.message });
      });
    }, POLL_INTERVAL_MS);
    if (pollInterval.unref) pollInterval.unref();

    memoryPollInterval = setInterval(() => {
      _checkMemoryForChanges(this).catch(() => {});
    }, MEMORY_POLL_INTERVAL_MS);
    if (memoryPollInterval.unref) memoryPollInterval.unref();

    log.info('agent', `[${AGENT_ID}] monitoring started`);
  },

  stopMonitoring() {
    isMonitoring = false;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (memoryPollInterval) {
      clearInterval(memoryPollInterval);
      memoryPollInterval = null;
    }
    for (const entry of _scheduledAlarms.values()) clearTimeout(entry.timeoutHandle);
    _scheduledAlarms.clear();
    log.info('agent', `[${AGENT_ID}] monitoring stopped`);
  },

  /** Returns the current scheduled alarms and the active rule set (for IPC / UI). */
  getStatus() {
    const upcoming = [];
    for (const [key, entry] of _scheduledAlarms.entries()) {
      upcoming.push({
        key,
        eventId: _eventId(entry.event),
        title: String(entry.event?.summary || entry.event?.title || ''),
        scheduledFor: entry.scheduledFor,
        leadMinutes: entry.leadMinutes,
        channels: entry.channels,
        startsAt: _eventStartMs(entry.event),
      });
    }
    upcoming.sort((a, b) => a.scheduledFor - b.scheduledFor);
    return {
      isMonitoring,
      upcomingAlarms: upcoming,
      firedCount: Object.keys(_firedAlarms).length,
      snoozes: { ..._snoozes },
      ruleSet: this._ruleSet
        ? {
            vipAttendees: Array.from(this._ruleSet.vipAttendees),
            keywordTriggers: this._ruleSet.keywordTriggers.slice(),
            exclusions: Array.from(this._ruleSet.exclusions),
            leadTimesMin: this._ruleSet.leadTimesMin.slice(),
            freeFormRuleCount: this._ruleSet.freeFormRules.length,
            settings: { ...this._ruleSet.settings },
          }
        : null,
    };
  },

  /** Snooze all alarms for a given event until `untilEpochMs`. */
  async snooze(eventId, untilEpochMs) {
    if (!eventId || !Number.isFinite(untilEpochMs)) return false;
    _snoozes[eventId] = { untilEpochMs };
    // Remove any already-scheduled alarms for this event; the next poll will
    // re-check and skip because of the snooze entry.
    for (const [key, entry] of _scheduledAlarms.entries()) {
      if (_eventId(entry.event) === eventId) {
        clearTimeout(entry.timeoutHandle);
        _scheduledAlarms.delete(key);
      }
    }
    await _saveState();
    return true;
  },

  /** Dismiss (cancel) all future alarms for an event in this process run. */
  async dismiss(eventId) {
    if (!eventId) return 0;
    let cancelled = 0;
    for (const [key, entry] of _scheduledAlarms.entries()) {
      if (_eventId(entry.event) === eventId) {
        clearTimeout(entry.timeoutHandle);
        _scheduledAlarms.delete(key);
        // Mark as "fired" so the next poll doesn't reschedule.
        _firedAlarms[key] = Date.now();
        cancelled++;
      }
    }
    await _saveState();
    return cancelled;
  },

  /** Re-read the memory file and re-parse rules. Useful after a manual edit. */
  async reloadRules() {
    return _checkMemoryForChanges(this);
  },

  /**
   * Fire a synthetic alarm for testing.
   *
   * @param {object} [eventOverrides]
   * @param {number} [eventOverrides.scheduleInSeconds] -- if >0, schedule the
   *   alarm to fire that many seconds from now (through the real setTimeout
   *   path). If 0 or omitted, fire immediately.
   * @param {string} [eventOverrides.title]
   * @param {object} [eventOverrides.channels] -- override default delivery channels
   */
  async test(eventOverrides = {}) {
    const scheduleInSeconds = Math.max(0, Number(eventOverrides.scheduleInSeconds) || 0);
    const nowMs = Date.now();
    const fireAtMs = nowMs + scheduleInSeconds * 1000;
    // Event start is set a little past the fire time so the "starts in X min"
    // math inside _buildAlarmMessage still reads sensibly for leadMinutes=1.
    const eventStart = new Date(fireAtMs + 60_000).toISOString();
    const event = {
      id: `test-${nowMs}`,
      summary: eventOverrides.title || 'Test alarm',
      start: { dateTime: eventStart },
      attendees: eventOverrides.attendees || [],
      description: eventOverrides.description || '',
      ...eventOverrides,
    };
    const channels =
      eventOverrides.channels && typeof eventOverrides.channels === 'object'
        ? { hud: true, voice: true, os: true, sound: false, ...eventOverrides.channels }
        : { hud: true, voice: true, os: true, sound: false };

    if (scheduleInSeconds > 0) {
      const ok = _scheduleAlarmAt(
        event,
        1,
        fireAtMs,
        [`Manual scheduled test fire (+${scheduleInSeconds}s).`],
        channels
      );
      log.info('agent', `[${AGENT_ID}] Scheduled test alarm`, {
        title: event.summary,
        fireAtMs,
        inSeconds: scheduleInSeconds,
        scheduled: ok,
      });
      return { success: ok, scheduled: event, fireAtMs, inSeconds: scheduleInSeconds };
    }

    await _fireAlarm(event, 1, ['Manual test fire.'], channels);
    return { success: true, fired: event };
  },

  cleanup() {
    this.stopMonitoring();
  },

  // Test-only hooks
  _scheduledAlarms,
  _firedAlarms: () => _firedAlarms,
  _setState: (fired, snooze) => {
    _firedAlarms = fired || {};
    _snoozes = snooze || {};
  },
  _setStateFilePath: (p) => {
    _stateFilePath = p;
  },
  _eventStartMs,
  _eventId,
  _alarmKey,
  _getPollIntervalMs: () => POLL_INTERVAL_MS,
  _pollCycle,
  _fireAlarm,
  _deliverHud,
  _deliverVoice,
  _deliverOs,
};

module.exports = criticalMeetingAlarmAgent;
