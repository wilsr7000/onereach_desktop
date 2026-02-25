/**
 * Daily Brief Agent - Orchestrates multi-agent morning briefings
 *
 * This is a meta-agent: it doesn't own data itself. Instead it discovers
 * all agents that implement getBriefing(), calls them in parallel with
 * per-agent timeouts, and composes the results into a cohesive spoken
 * briefing in a radio-morning-show style.
 *
 * Memory-backed: remembers briefing preferences (sections to
 * include/exclude, style, length) and keeps a rolling history of
 * recent briefings for context continuity.
 *
 * Contributors are auto-discovered via getBriefingAgents() in the registry.
 * Any agent that implements getBriefing() is automatically included.
 * New agents just implement getBriefing() and they appear in the brief.
 *
 * Priority order (set by each contributor):
 *   1 = Time & Date
 *   2 = Weather
 *   3 = Calendar / Schedule
 *   4 = Email
 *   5 = Tasks / Action Items
 *   6+ = Everything else
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getUserProfile } = require('../../lib/user-profile-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Timeouts for briefing collection
// Calendar agent fetches from omnical API which can take 2-3s cold, so allow more time
const PER_AGENT_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 15000;

// Maximum recent briefings to keep in memory
const MAX_BRIEFING_HISTORY = 5;

module.exports = {
  id: 'daily-brief-agent',
  name: 'Daily Brief',
  description:
    'Orchestrates a morning briefing from time, weather, calendar, email, and other agents. Remembers your preferences for style, length, and which sections to include.',
  categories: ['productivity', 'briefing', 'schedule'],
  keywords: [
    'daily brief',
    'morning brief',
    'briefing',
    'rundown',
    'brief me',
    'my day',
    'day look like',
    'run me through today',
    'morning rundown',
    'daily rundown',
    'morning update',
  ],
  executionType: 'action',
  estimatedExecutionMs: 8000,
  dataSources: ['multi-agent-orchestration', 'user-profile'],

  prompt: `Daily Brief Agent orchestrates a comprehensive morning briefing by gathering data from multiple specialized agents (time, weather, calendar, email, etc.) and composing them into a single cohesive spoken update.

HIGH CONFIDENCE (0.95) for:
- "give me my daily brief" / "morning brief" / "daily briefing"
- "brief me" / "run me through today" / "morning rundown"
- "what does my day look like" / "how's my day" / "day at a glance"
- "daily rundown" / "morning update" / "catch me up"
- Any request for a combined overview of time, schedule, weather, and tasks

This agent is the ONLY correct handler for daily/morning briefings.
It gathers live data from time-agent, weather-agent, calendar-query-agent, email-agent, and others.
It remembers your preferred briefing style (concise vs detailed) and which sections matter to you.

LOW CONFIDENCE (0.00) -- do NOT bid on:
- Pure calendar queries: "what meetings do I have" (calendar-query-agent)
- Pure time queries: "what time is it" (time-agent)
- Pure weather queries: "what's the weather" (weather-agent)
- Single-topic requests that don't ask for a combined briefing
- General conversation or smalltalk`,

  // ── Memory ────────────────────────────────────────────────────────────────

  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('daily-brief-agent', { displayName: 'Daily Brief' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  /**
   * Ensure default memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Briefing Preferences')) {
      this.memory.updateSection(
        'Briefing Preferences',
        `- Style: radio-morning-show
- Length: standard (80-150 words)
- Sections: all
- Excluded Sections: none
- Greeting Style: time-of-day appropriate
- Sign-Off: brief forward-looking line`
      );
    }

    if (!sections.includes('Briefing History')) {
      this.memory.updateSection('Briefing History', '*Recent briefings are logged here for context continuity.*');
    }

    if (!sections.includes('Learned Patterns')) {
      this.memory.updateSection(
        'Learned Patterns',
        `*Patterns learned from user feedback*
- Sections user asks about most: (not yet learned)
- Preferred detail level: (not yet learned)
- Common follow-up questions after briefs: (not yet learned)`
      );
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  /**
   * Read briefing preferences from memory
   */
  _getPreferences() {
    if (!this.memory) return {};
    try {
      return this.memory.parseSectionAsKeyValue('Briefing Preferences') || {};
    } catch (_) {
      return {};
    }
  },

  /**
   * Get the user's name from global profile for personalized greeting
   * @param {Function} [_profileGetter] - optional override for getUserProfile (testing)
   */
  async _getUserName(_profileGetter) {
    try {
      const profile = (_profileGetter || getUserProfile)();
      if (!profile.isLoaded()) await profile.load();
      const facts = profile.getFacts('Identity');
      const name = facts['Name'] || facts['First Name'];
      if (name && !name.includes('not yet learned')) return name;
    } catch (err) {
      console.warn('[daily-brief-agent] _getUserName:', err.message);
    }
    return null;
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.

  /**
   * Execute the daily brief pipeline:
   * 1. Initialize memory
   * 2. Discover all briefing-capable agents
   * 3. Call their getBriefing() in parallel with timeouts
   * 4. Compose contributions into radio-show style speech
   * 5. Log briefing to history
   */
  async execute(_task) {
    try {
    // Ensure memory is loaded
    if (!this.memory) {
      await this.initialize();
    }

    const briefStart = Date.now();
    const { getBriefingAgents } = require('./agent-registry');

    // 0. Determine the target date from the user's request
    const requestText = (_task?.content || _task?.text || '').toLowerCase();
    const targetDate = this._resolveTargetDate(requestText);
    const isToday = !targetDate || this._isSameDay(targetDate, new Date());
    const dateLabel = isToday ? 'today' : targetDate.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });

    // 1. Read preferences from memory
    const prefs = this._getPreferences();
    const excludedSections = (prefs['Excluded Sections'] || 'none')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'none');

    // 2. Discover briefing-capable agents (built-in + custom)
    const builtInBriefing = getBriefingAgents().filter((a) => a.id !== this.id);
    let customBriefing = [];
    try {
      const { getCustomBriefingAgents } = require('../../src/voice-task-sdk/exchange-bridge');
      customBriefing = getCustomBriefingAgents();
    } catch (_) {
      /* exchange bridge may not be available */
    }

    const briefingAgents = [...builtInBriefing, ...customBriefing];
    log.info(
      'agent',
      `[DailyBrief] Discovered ${briefingAgents.length} contributors (${builtInBriefing.length} built-in, ${customBriefing.length} custom)`,
      {
        agents: briefingAgents.map((a) => a.id),
      }
    );

    if (briefingAgents.length === 0) {
      const now = new Date();
      const h = now.getHours();
      const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
      const userName = await this._getUserName();
      const greetName = userName ? `, ${userName}` : '';
      return {
        success: true,
        message: `${greeting}${greetName}. No briefing agents are available right now. Your day is clear as far as I can tell.`,
      };
    }

    // 3. Collect contributions in parallel with per-agent timeouts
    const briefingContext = { targetDate, isToday, dateLabel };
    const contributionPromises = briefingAgents.map(async (agent) => {
      const agentTimeout = agent.estimatedExecutionMs
        ? Math.min(agent.estimatedExecutionMs * 2, PER_AGENT_TIMEOUT_MS)
        : PER_AGENT_TIMEOUT_MS;
      try {
        const result = await Promise.race([
          agent.getBriefing(briefingContext),
          new Promise((_, rej) => {
            setTimeout(() => rej(new Error(`${agent.id} timed out`)), agentTimeout);
          }),
        ]);
        if (result && result.content) {
          log.info('agent', `[DailyBrief] ${agent.id} contributed`, { section: result.section });
          return result;
        }
        log.info('agent', `[DailyBrief] ${agent.id} returned no content`, { section: result?.section });
        return null;
      } catch (e) {
        log.info('agent', `[DailyBrief] ${agent.id} skipped`, { reason: e.message });
        return null;
      }
    });

    // Race all contributions against a total timeout
    const settled = await Promise.race([
      Promise.allSettled(contributionPromises),
      new Promise((resolve) => {
        setTimeout(() => {
          log.info('agent', '[DailyBrief] Total timeout reached, using available contributions');
          resolve(contributionPromises.map(() => ({ status: 'rejected', reason: 'total timeout' })));
        }, TOTAL_TIMEOUT_MS);
      }),
    ]);

    let contributions = settled
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));

    // 4. Filter out excluded sections (from preferences)
    if (excludedSections.length > 0) {
      contributions = contributions.filter((c) => !excludedSections.includes((c.section || '').toLowerCase()));
    }

    log.info('agent', `[DailyBrief] ${contributions.length}/${briefingAgents.length} agents contributed`, {
      sections: contributions.map((c) => c.section),
      collectTimeMs: Date.now() - briefStart,
    });

    // 5. Compose into speech via LLM
    const userName = await this._getUserName();
    const fullSpeech = await this._composeBriefing(contributions, prefs, userName, dateLabel);

    log.info('agent', '[DailyBrief] Brief generated', {
      contributorCount: contributions.length,
      sections: contributions.map((c) => c.section),
      totalMs: Date.now() - briefStart,
    });

    // 6. Log this briefing to memory history
    this._logBriefingToHistory(contributions);

    return {
      success: true,
      message: fullSpeech,
      data: {
        type: 'morning_brief',
        contributions: contributions.map((c) => ({ section: c.section, priority: c.priority })),
      },
    };
    } catch (err) {
      log.error('agent', '[DailyBrief] Execute failed', { error: err.message, stack: err.stack });
      return { success: false, message: `I had trouble putting together your briefing: ${err.message}` };
    }
  },

  /**
   * Compose agent contributions into speech.
   * Uses preferences for style and length guidance.
   * Falls back to simple concatenation if the LLM call fails.
   */
  async _composeBriefing(contributions, prefs = {}, userName = null, dateLabel = 'today') {
    if (!contributions || contributions.length === 0) {
      const now = new Date();
      const h = now.getHours();
      const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
      const greetName = userName ? `, ${userName}` : '';
      return `${greeting}${greetName}. I checked in with all my sources but nothing to report right now. Enjoy a quiet day.`;
    }

    // Build the raw sections for the LLM
    const sections = contributions
      .filter((c) => c.content)
      .map((c) => `[${c.section}]\n${c.content}`)
      .join('\n\n');

    // Build style instructions from preferences
    const style = prefs['Style'] || 'radio-morning-show';
    const length = prefs['Length'] || 'standard (80-150 words)';
    const signOff = prefs['Sign-Off'] || 'brief forward-looking line';
    const nameInstruction = userName
      ? `Address the user by name ("${userName}") in the greeting.`
      : 'Use a warm but generic greeting.';

    try {
      const composedText = await ai.complete(
        `You are a radio morning show host delivering a daily briefing. Your style is ${style} -- casual, warm, and organized, like a trusted morning DJ giving listeners their daily rundown.

BRIEFING DATE: The user asked about ${dateLabel}. Frame everything for that day.${dateLabel !== 'today' ? `\n- This is a FORWARD-LOOKING brief. Use future tense ("You have", "There will be") since the events haven't happened yet.` : ''}

STYLE RULES:
- Open with a SINGLE time-of-day greeting (Good morning / Good afternoon / Good evening) based on the "Time of day" field in the Time & Date section. Include the current time and date naturally. Do NOT repeat the greeting.
- ${nameInstruction}
- Deliver each topic as its own clear segment with natural spoken transitions.
  Examples: "Now for the weather...", "Looking at your schedule...", "On the email front...", "And for tasks..."
- Keep each segment concise. Summarize, don't list every detail.
- If there are calendar conflicts or important meetings, make them stand out.
- Close with: ${signOff}
- This will be spoken aloud via TTS. No markdown, no bullet points, no emojis, no special characters.
- Target length: ${length}.
- If a section says data is unavailable, acknowledge it briefly ("Weather's offline today") and move on.
- NEVER invent or guess data. Only use what's provided below.

TIME AWARENESS -- CRITICAL:
- Pay attention to the current time from the Time & Date section. Use it to distinguish past from future.
- Calendar events have a "status" field: "completed" means already happened, "in-progress" means happening now, "upcoming" means in the future.
- For completed events: use past tense ("You had a standup at 9 AM", "Your morning meetings are done").
- For in-progress events: use present tense ("You're currently in a meeting").
- For upcoming events: use future tense ("Your next meeting is at 3 PM", "Coming up you have...").
- NEVER describe a past event as if it's about to happen. If it's 2 PM, don't say "Your first meeting is at 9 AM" -- say "You had a meeting at 9 AM" or just focus on what's ahead.
- If all meetings are done, say so clearly ("All your meetings are wrapped up for today").
- Focus the briefing on what's AHEAD, with a brief recap of what already happened if relevant.

RAW DATA FROM AGENTS:
${sections}

Compose the daily briefing:`,
        { profile: 'standard', maxTokens: 2000, feature: 'daily-brief-compose' }
      );
      if (composedText && composedText.trim().length > 20) {
        return composedText.trim();
      }
    } catch (e) {
      log.info('agent', '[DailyBrief] LLM composition failed, using fallback', { reason: e.message });
    }

    // Fallback: simple concatenation with basic transitions
    const now = new Date();
    const h = now.getHours();
    const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const greetName = userName ? `, ${userName}` : '';
    const body = contributions
      .filter((c) => c.content)
      .map((c) => c.content)
      .join(' ');
    return `${greeting}${greetName}. ${body}`;
  },

  /**
   * Log a summary of this briefing to memory history.
   * Keeps only the last MAX_BRIEFING_HISTORY entries.
   */
  _resolveTargetDate(text) {
    if (!text) return null;
    const now = new Date();
    if (/\btomorrow\b/.test(text)) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayMatch = text.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (dayMatch) {
      const targetDay = dayNames.indexOf(dayMatch[2]);
      const currentDay = now.getDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead <= 0 || dayMatch[1]) daysAhead += 7;
      const d = new Date(now);
      d.setDate(d.getDate() + daysAhead);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    if (/\bnext week\b/.test(text)) {
      const d = new Date(now);
      d.setDate(d.getDate() + (8 - d.getDay()));
      d.setHours(0, 0, 0, 0);
      return d;
    }
    return null;
  },

  _isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  },

  _logBriefingToHistory(contributions) {
    if (!this.memory) return;
    try {
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const sectionList = contributions.map((c) => c.section).join(', ');
      const entry = `- [${dateStr} ${timeStr}] Sections: ${sectionList || 'none'} (${contributions.length} contributors)`;

      // Read current history
      const currentHistory = this.memory.getSection('Briefing History') || '';
      const lines = currentHistory.split('\n').filter((l) => l.startsWith('- ['));

      // Add new entry and trim to max
      lines.unshift(entry);
      const trimmed = lines.slice(0, MAX_BRIEFING_HISTORY);

      this.memory.updateSection('Briefing History', trimmed.join('\n'));
      this.memory.save();
    } catch (_) {
      // Non-fatal
    }
  },
};
