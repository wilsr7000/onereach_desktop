/**
 * Meeting Monitor Agent - Real-time Recording Health & Conversation Monitor
 * 
 * Runs during active recordings. Periodically reads the live-transcript.md file
 * (which includes health metrics and conversation text), evaluates it with an LLM,
 * and emits actionable alerts to the recorder UI.
 * 
 * Detects:
 * - Audio issues mentioned in conversation ("you broke up", "can't hear you")
 * - Video issues mentioned in conversation ("can't see your screen", "screen is frozen")
 * - Technical health problems (audio silence, video track dead, captions disconnected)
 * - General communication confusion that suggests technical problems
 * 
 * Actions:
 * - Shows toast alerts in the recorder with suggestions
 * - Can suggest specific fixes (check mic, reshare screen, adjust volume)
 * - Logs issues for post-meeting review
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');

// Lazy-load SpacesAPI
let spacesAPI = null;
function getSpacesAPI() {
  if (!spacesAPI) {
    try {
      const SpacesAPIClass = require('../../spaces-api');
      spacesAPI = new SpacesAPIClass();
    } catch (e) {
      log.error('agent', 'Failed to load Spaces API', { error: e.message });
    }
  }
  return spacesAPI;
}

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==========================================
// MONITOR STATE (persists across poll cycles)
// ==========================================
let monitorInterval = null;
let lastTranscriptLineCount = 0;
let lastAlertTimestamp = 0;
let alertCooldownMs = 30000;  // Don't spam -- 30s between alerts
let consecutiveSilentChecks = 0;
let monitorSpaceId = null;
let monitorActive = false;
let alertHistory = [];

const MONITOR_POLL_INTERVAL_MS = 10000; // Poll every 10 seconds

const meetingMonitorAgent = {
  id: 'meeting-monitor-agent',
  name: 'Meeting Monitor',
  description: 'Monitors active recordings in real time. Reads the live transcript and health metrics to detect audio/video issues, communication problems, and technical failures. Alerts the user with suggestions to fix problems during meetings.',
  voice: 'onyx',
  acks: ['Monitoring your recording.', 'Keeping an eye on the meeting.'],
  categories: ['monitoring', 'recording', 'meeting', 'health'],
  keywords: [
    'monitor', 'meeting', 'watch recording', 'check audio', 'check video',
    'recording health', 'monitor meeting', 'meeting assistant'
  ],
  executionType: 'system',
  bidExcluded: true,  // This agent is auto-started, not user-triggered via voice

  prompt: `Meeting Monitor Agent runs automatically during recordings. It is NOT triggered by user voice commands.
It monitors the live transcript and health metrics to detect problems.

CONFIDENCE: 0.00 for ALL user requests -- this agent should NEVER win a bid.
It is a background system agent that auto-starts when recording begins.`,

  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('meeting-monitor-agent', { displayName: 'Meeting Monitor' });
      await this.memory.load();
      if (!this.memory.getSectionNames().includes('Alert History')) {
        this.memory.updateSection('Alert History', '*Tracks alerts raised during recordings*');
        await this.memory.save();
      }
    }
    return this.memory;
  },

  /**
   * Execute is a no-op for user requests -- this agent is background-only.
   * The real work happens in startMonitoring / stopMonitoring.
   */
  async execute(task, context = {}) {
    return {
      success: true,
      message: 'The Meeting Monitor runs automatically during recordings. It cannot be triggered manually.'
    };
  },

  // ==========================================
  // PUBLIC: Start/Stop Monitoring
  // ==========================================

  /**
   * Start monitoring a recording session.
   * Called by the recorder when recording begins.
   * @param {string} spaceId - The space where live-transcript.md is written
   */
  async startMonitoring(spaceId) {
    // Ensure memory is loaded before monitoring begins
    if (!this.memory) {
      await this.initialize();
    }

    if (monitorActive) {
      log.info('agent', 'Already monitoring, updating spaceId');
      monitorSpaceId = spaceId;
      return;
    }

    monitorSpaceId = spaceId || 'gsx-agent';
    monitorActive = true;
    lastTranscriptLineCount = 0;
    lastAlertTimestamp = 0;
    consecutiveSilentChecks = 0;
    alertHistory = [];

    log.info('agent', `Starting monitoring for space: ${monitorSpaceId}`);

    // Start polling
    monitorInterval = setInterval(() => {
      this._pollAndEvaluate().catch(err => {
        log.error('agent', 'Poll error', { error: err.message });
      });
    }, MONITOR_POLL_INTERVAL_MS);
  },

  /**
   * Stop monitoring.
   * Called when recording stops.
   */
  stopMonitoring() {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    monitorActive = false;
    log.info('agent', `Stopped monitoring. Alerts raised: ${alertHistory.length}`);

    // Persist alert history to memory
    if (this.memory && alertHistory.length > 0) {
      const summary = alertHistory.map(a =>
        `- [${new Date(a.timestamp).toLocaleTimeString()}] ${a.type}: ${a.message}`
      ).join('\n');
      this.memory.appendToSection('Alert History',
        `\n### Session ${new Date().toISOString().split('T')[0]}\n${summary}`, 30);
      this.memory.save().catch(() => {});
    }
  },

  // ==========================================
  // INTERNAL: Poll and Evaluate
  // ==========================================

  async _pollAndEvaluate() {
    if (!monitorActive) return;

    const api = getSpacesAPI();
    if (!api) return;

    // Read the live transcript file
    let content;
    try {
      content = await api.files.read(monitorSpaceId, 'live-transcript.md');
    } catch (e) {
      return; // File may not exist yet
    }

    if (!content) return;

    // Parse health metrics and transcript from the markdown
    const parsed = this._parseTranscriptFile(content);
    if (!parsed) return;

    // ---- Rule-based fast checks (no LLM needed) ----

    // Check for audio silence
    if (parsed.health.audioSilent === true) {
      consecutiveSilentChecks++;
      if (consecutiveSilentChecks >= 3) {  // 30 seconds of silence
        this._emitAlert({
          type: 'audio-silent',
          severity: 'warning',
          message: 'No audio detected for 30+ seconds. Check your microphone and desktop audio.',
          suggestion: 'Try unmuting your mic or increasing the volume in the Audio Mixing panel.'
        });
        consecutiveSilentChecks = 0; // Reset after alerting
      }
    } else {
      consecutiveSilentChecks = 0;
    }

    // Check for dead video track
    if (parsed.health.videoActive === false && parsed.status === 'Recording') {
      this._emitAlert({
        type: 'video-dead',
        severity: 'warning',
        message: 'Video track appears inactive. Your screen share may have stopped.',
        suggestion: 'Try re-selecting your screen source or restarting the screen share.'
      });
    }

    // Check for captions disconnected mid-recording
    if (parsed.health.captionsConnected === false && parsed.status === 'Recording' && parsed.lineCount > 0) {
      this._emitAlert({
        type: 'captions-disconnected',
        severity: 'info',
        message: 'Live captions disconnected. Transcription paused.',
        suggestion: 'Captions may reconnect automatically, or toggle them off and on.'
      });
    }

    // Check system diagnostics
    if (parsed.health.cpuPercent != null && parsed.health.cpuPercent > 80) {
      this._emitAlert({
        type: 'high-cpu',
        severity: 'warning',
        message: `High CPU usage (${parsed.health.cpuPercent}%). Recording and call quality may degrade.`,
        suggestion: 'Close unused browser tabs or apps to free up CPU. Check Activity Monitor for culprits.'
      });
    }

    if (parsed.health.memoryPercent != null && parsed.health.memoryPercent > 85) {
      this._emitAlert({
        type: 'high-memory',
        severity: 'warning',
        message: `System memory is ${parsed.health.memoryPercent}% used (${parsed.health.memoryFreeMB || '?'} MB free).`,
        suggestion: 'Close unused applications to free memory. Low memory can cause audio/video stuttering.'
      });
    }

    if (parsed.health.onBattery === true) {
      // Only alert once about battery (longer cooldown handles this)
      this._emitAlert({
        type: 'on-battery',
        severity: 'info',
        message: 'Running on battery power. Performance may be throttled.',
        suggestion: 'Plug in your charger for best recording quality during long meetings.'
      });
    }

    if (parsed.health.throttledWindows > 0) {
      this._emitAlert({
        type: 'windows-throttled',
        severity: 'info',
        message: `${parsed.health.throttledWindows} window(s) have been throttled due to high resource usage.`,
        suggestion: 'The app is conserving resources. Close background windows if performance is poor.'
      });
    }

    // ---- LLM-based transcript analysis (for conversational cues) ----

    // Only run LLM check if there are new transcript lines since last check
    if (parsed.transcriptLines.length > lastTranscriptLineCount && parsed.transcriptLines.length > 0) {
      const newLines = parsed.transcriptLines.slice(lastTranscriptLineCount);
      lastTranscriptLineCount = parsed.transcriptLines.length;

      // Only check with LLM if there are enough new lines (at least 2)
      if (newLines.length >= 2) {
        await this._llmEvaluateTranscript(newLines, parsed.health);
      }
    }
  },

  /**
   * Parse the live-transcript.md file into structured data
   */
  _parseTranscriptFile(content) {
    try {
      const lines = content.split('\n');
      const result = {
        status: 'Unknown',
        lineCount: 0,
        health: {},
        transcriptLines: []
      };

      // Extract status from header
      const statusLine = lines.find(l => l.includes('**Status:**'));
      if (statusLine) {
        result.status = statusLine.replace(/.*\*\*Status:\*\*\s*/, '').trim();
      }

      const linesLine = lines.find(l => l.includes('**Lines:**'));
      if (linesLine) {
        result.lineCount = parseInt(linesLine.replace(/.*\*\*Lines:\*\*\s*/, '')) || 0;
      }

      // Parse health table
      const healthRows = lines.filter(l => l.startsWith('|') && !l.includes('Metric') && !l.includes('---'));
      for (const row of healthRows) {
        const cells = row.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          const key = cells[0].toLowerCase();
          const val = cells[1];
          if (key.includes('video active')) result.health.videoActive = val === 'Yes';
          if (key.includes('mic active')) result.health.micActive = val === 'Yes';
          if (key.includes('desktop audio')) result.health.desktopAudio = val === 'Yes';
          if (key.includes('audio silent')) result.health.audioSilent = val.includes('YES');
          if (key.includes('audio level')) result.health.audioLevel = parseFloat(val) || 0;
          if (key.includes('captions connected')) result.health.captionsConnected = val === 'Yes';
          if (key.includes('cpu (app)')) result.health.cpuPercent = parseInt(val) || 0;
          if (key.includes('memory (system)')) {
            const pctMatch = val.match(/(\d+)%/);
            if (pctMatch) result.health.memoryPercent = parseInt(pctMatch[1]);
            const freeMatch = val.match(/(\d+)\s*MB free/);
            if (freeMatch) result.health.memoryFreeMB = parseInt(freeMatch[1]);
          }
          if (key.includes('battery')) result.health.onBattery = val.includes('ON BATTERY');
          if (key.includes('throttled windows')) result.health.throttledWindows = parseInt(val) || 0;
        }
      }

      // Parse transcript lines (format: **[MM:SS]** text)
      const transcriptSection = content.split('## Transcript')[1];
      if (transcriptSection) {
        const tLines = transcriptSection.split('\n').filter(l => l.startsWith('**['));
        result.transcriptLines = tLines.map(l => {
          const match = l.match(/\*\*\[(\d+:\d+)\]\*\*\s*(.*)/);
          return match ? { time: match[1], text: match[2] } : null;
        }).filter(Boolean);
      }

      return result;
    } catch (e) {
      log.error('agent', 'Parse error', { error: e.message });
      return null;
    }
  },

  /**
   * Use LLM to evaluate recent transcript lines for issues
   */
  async _llmEvaluateTranscript(newLines, health) {
    // Build the recent text
    const recentText = newLines.map(l => `[${l.time}] ${l.text}`).join('\n');

    // Build health context
    const healthContext = [
      `Video: ${health.videoActive !== false ? 'active' : 'INACTIVE'}`,
      `Mic: ${health.micActive !== false ? 'active' : 'INACTIVE'}`,
      `Desktop audio: ${health.desktopAudio !== false ? 'active' : 'inactive'}`,
      `Audio silent: ${health.audioSilent ? 'YES' : 'no'}`,
    ].join(', ');

    try {
      const response = await ai.chat({
        profile: 'fast',
        messages: [{
          role: 'user',
          content: `You are monitoring a live recording/meeting. Analyze the following recent transcript lines for signs of technical issues.

HEALTH METRICS: ${healthContext}

RECENT TRANSCRIPT:
${recentText}

Look for any of these issues:
1. AUDIO_PROBLEM: Someone says they can't hear, audio broke up, voice is cutting out, echoing, etc.
2. VIDEO_PROBLEM: Someone says they can't see the screen, screen is frozen, video is lagging, etc.
3. CONNECTION_ISSUE: Someone mentions being disconnected, lag, buffering, poor connection, etc.
4. NO_ISSUE: The conversation is proceeding normally.

Respond with EXACTLY one JSON object (no markdown, no explanation):
{"issue": "NO_ISSUE|AUDIO_PROBLEM|VIDEO_PROBLEM|CONNECTION_ISSUE", "confidence": 0.0-1.0, "evidence": "quoted phrase from transcript", "suggestion": "what to do about it"}

If no issue is detected, respond: {"issue": "NO_ISSUE", "confidence": 1.0, "evidence": "", "suggestion": ""}`
        }],
        maxTokens: 150,
        temperature: 0.1,
        jsonMode: true,
        feature: 'meeting-monitor',
      });

      // Parse response
      const text = response.content || '';
      const jsonMatch = text.match(/\{[^}]+\}/);
      if (!jsonMatch) return;

      const result = JSON.parse(jsonMatch[0]);

      if (result.issue && result.issue !== 'NO_ISSUE' && result.confidence >= 0.7) {
        const typeMap = {
          'AUDIO_PROBLEM': { type: 'audio-issue-detected', severity: 'warning' },
          'VIDEO_PROBLEM': { type: 'video-issue-detected', severity: 'warning' },
          'CONNECTION_ISSUE': { type: 'connection-issue-detected', severity: 'info' }
        };
        const mapped = typeMap[result.issue] || { type: 'issue-detected', severity: 'info' };

        this._emitAlert({
          type: mapped.type,
          severity: mapped.severity,
          message: `Detected in conversation: "${result.evidence}"`,
          suggestion: result.suggestion || 'Check your audio and video settings.'
        });
      }
    } catch (err) {
      // LLM call failed -- not critical, just skip this cycle
      log.warn('agent', 'LLM evaluation failed', { error: err.message });
    }
  },

  /**
   * Emit an alert to the recorder window
   */
  _emitAlert(alert) {
    const now = Date.now();

    // Respect cooldown
    if (now - lastAlertTimestamp < alertCooldownMs) return;

    // Don't repeat the same alert type within cooldown
    const recentSameType = alertHistory.find(
      a => a.type === alert.type && (now - a.timestamp) < alertCooldownMs * 2
    );
    if (recentSameType) return;

    lastAlertTimestamp = now;
    const fullAlert = { ...alert, timestamp: now };
    alertHistory.push(fullAlert);

    log.info('agent', `ALERT [${alert.severity}] ${alert.type}: ${alert.message}`);

    // Send to recorder window
    try {
      const recorder = global.recorder;
      if (recorder && recorder.window && !recorder.window.isDestroyed()) {
        recorder.window.webContents.send('recorder:monitor-alert', fullAlert);
      }
    } catch (e) {
      log.warn('agent', 'Failed to send alert to recorder', { error: e.message });
    }
  },

  cleanup() {
    this.stopMonitoring();
  }
};

module.exports = meetingMonitorAgent;
