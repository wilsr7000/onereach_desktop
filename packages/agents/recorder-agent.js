/**
 * Recorder Agent - Video Capture Assistant
 *
 * Launches WISER Meeting for recording videos from camera or screen.
 * Helps users record content and save it to Spaces.
 *
 * Capabilities:
 * - "Record a video" / "Start recording" - opens the recorder
 * - "Capture my screen" / "Screen recording" - opens recorder with screen mode hint
 * - "Record something for [space name]" - opens recorder with space pre-selected
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Get the Spaces API (lazy load to avoid circular deps)
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

const recorderAgent = {
  id: 'recorder-agent',
  name: 'Video Recorder',
  description:
    'Records meetings and video. Say "start a meeting", "record a video", or "capture my screen" to begin. The go-to agent for starting, recording, or capturing any live session.',
  voice: 'nova',
  acks: ['Opening the recorder.', 'Let me get that ready for you.', 'Starting the capture tool.'],
  categories: ['media', 'video', 'recording', 'capture', 'meeting'],
  keywords: [
    'record',
    'recording',
    'capture',
    'video',
    'screen',
    'webcam',
    'camera',
    'screencast',
    'screen capture',
    'record myself',
    'take a video',
    'record my screen',
    'capture screen',
    'film',
    'shoot video',
    'start a meeting',
    'begin a meeting',
    'start meeting',
    'start the meeting',
    "let's start a meeting",
    'hop on a call',
    'start a call',
    'begin recording',
  ],
  executionType: 'action', // Launches WISER Meeting recorder

  // Prompt for LLM evaluation
  prompt: `Video Recorder Agent launches WISER Meeting to record meetings, video, and screen.

HIGH CONFIDENCE (0.85+) for:
- Starting a meeting: "Start a meeting", "Let's start a meeting", "Begin a meeting", "Start the meeting"
- Starting a call: "Start a call", "Hop on a call", "Begin a call"
- Direct recording: "Record a video", "Start recording", "Record myself", "Begin recording"
- Screen capture: "Capture my screen", "Screen recording", "Record my desktop"
- Camera recording: "Take a video", "Film something", "Record with webcam"
- Recording for a space: "Record a video for my Work space"

CRITICAL: "Start a meeting" means "begin a meeting session NOW" -- this is a recording/capture action, NOT a calendar scheduling action. This agent handles all "start/begin/launch" + meeting/call/session commands.

MEDIUM CONFIDENCE (0.50-0.70) for:
- Ambiguous "capture" requests that might be screenshots instead of video
- General media requests without clear video intent

LOW CONFIDENCE (0.00-0.20) - DO NOT BID on these:
- Playback: "Play a video", "Watch video" (that's for video player)
- Editing: "Edit my video" (that's for video editor)
- Screenshots: "Take a screenshot" (not video)
- Music/audio only: "Record audio" (might want different tool)
- Photos: "Take a photo", "Capture image"
- SCHEDULING a meeting: "Schedule a meeting", "Add a meeting to calendar", "Book a meeting" (that's calendar agent)

This agent opens the recorder window. For scheduling/creating calendar events, the calendar agent is appropriate.`,

  // Memory for tracking user patterns
  memory: null,

  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('recorder-agent', { displayName: 'Video Recorder' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Recording History')) {
      this.memory.updateSection('Recording History', '*Tracks your recording sessions*');
    }

    if (!sections.includes('Preferences')) {
      this.memory.updateSection('Preferences', '*Your preferred recording settings*');
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message, data }
   */
  async execute(task, context = {}) {
    const { onProgress = () => {} } = context;

    try {
      await this.initialize();
      const lower = task.content?.toLowerCase() || '';

      onProgress('Preparing recorder...');

      // Build options for the recorder
      const options = {};

      // Check if user specified a space
      const spaceName = this._extractSpaceName(task.content);
      if (spaceName) {
        const spaceId = await this._findSpaceByName(spaceName);
        if (spaceId) {
          options.spaceId = spaceId;
          options.instructions = `Record video for "${spaceName}"`;
        }
      }

      // For meeting intents without an explicit space, find or create a meetings space
      const isMeetingIntent = /\b(meeting|call|conference|standup|sync|huddle)\b/i.test(lower);
      if (isMeetingIntent && !options.spaceId) {
        const meetingSpaceId = await this._findOrCreateMeetingSpace();
        if (meetingSpaceId) {
          options.spaceId = meetingSpaceId;
        }
      }

      // Check for screen recording hint
      if (lower.includes('screen') || lower.includes('desktop') || lower.includes('window')) {
        options.mode = 'screen';
        if (!options.instructions) {
          options.instructions = 'Screen recording - select a window or your entire screen';
        }
      }

      // Check for camera/webcam hint
      if (
        lower.includes('camera') ||
        lower.includes('webcam') ||
        lower.includes('myself') ||
        lower.includes('selfie')
      ) {
        options.mode = 'camera';
        if (!options.instructions) {
          options.instructions = 'Camera recording - position yourself in frame';
        }
      }

      // Extract any specific instructions from the request
      const userInstructions = this._extractInstructions(task.content);
      if (userInstructions) {
        options.instructions = userInstructions;
      }

      onProgress('Opening recorder...');

      // Open the recorder via IPC
      const result = await this._openRecorder(options);

      if (result.success) {
        // Track in memory
        const timestamp = new Date().toISOString().split('T')[0];
        const mode = options.mode || 'general';
        this.memory.appendToSection('Recording History', `- ${timestamp}: Started ${mode} recording`, 20);
        await this.memory.save();

        // Build response message
        let message = 'Opening the recorder.';
        if (options.mode === 'screen') {
          message = 'Opening the screen recorder. Select what you want to capture, then click record.';
        } else if (options.mode === 'camera') {
          message = 'Opening the camera recorder. Position yourself in frame and click record when ready.';
        } else {
          message = 'Opening the recorder. Choose your video source and click record when ready.';
        }

        if (spaceName) {
          message += ` Your recording will be saved to "${spaceName}".`;
        }

        return {
          success: true,
          message,
          data: {
            action: { type: 'recorder-opened' },
            options,
          },
        };
      } else {
        return {
          success: false,
          message: result.error || 'Sorry, I could not open the recorder right now. Please try again.',
          suggestion: 'You can also open the recorder from the Video Editor using the camera button.',
        };
      }
    } catch (error) {
      log.error('agent', 'Execute error', { error });
      return {
        success: false,
        message: 'Sorry, I had trouble opening the recorder. Please try again.',
      };
    }
  },

  /**
   * Open the recorder via global recorder instance
   * Agents run in the main process context where global.recorder is available
   * @param {Object} options - Recording options
   * @returns {Promise<Object>} - { success, error? }
   */
  async _openRecorder(options = {}) {
    try {
      // Agents run in the main process where global.recorder is available
      if (global.recorder && typeof global.recorder.open === 'function') {
        global.recorder.open(options);
        return { success: true };
      }

      // Fallback: send event via main window if recorder not directly available
      if (global.mainWindow && global.mainWindow.webContents) {
        global.mainWindow.webContents.send('open-recorder', options);
        return { success: true };
      }

      log.error('agent', 'Recorder not available - global.recorder', { recorder: !!global.recorder });
      return { success: false, message: 'Recorder not initialized' };
    } catch (error) {
      log.error('agent', 'Error opening recorder', { error });
      return { success: false, message: error.message };
    }
  },

  /**
   * Extract space name from user request
   * @param {string} text - User's request
   * @returns {string|null} - Space name or null
   */
  _extractSpaceName(text) {
    const patterns = [
      /(?:record|capture|film)\s+(?:a\s+)?(?:video\s+)?(?:for|to|in)\s+(?:my\s+)?["']?([^"']+?)["']?\s+space/i,
      /(?:for|to|in)\s+(?:my\s+)?["']?([^"']+?)["']?\s+space/i,
      /space\s+(?:called|named)\s+["']?([^"']+?)["']?/i,
      /(?:save|add)\s+(?:to|in)\s+["']?([^"']+?)["']?$/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const name = match[1].trim().replace(/['"]/g, '');
        // Skip if it's a common word
        if (name.length > 1 && !['a', 'the', 'my', 'this'].includes(name.toLowerCase())) {
          return name;
        }
      }
    }

    return null;
  },

  /**
   * Find a space by name
   * @param {string} name - Space name to find
   * @returns {Promise<string|null>} - Space ID or null
   */
  async _findSpaceByName(name) {
    const api = getSpacesAPI();
    if (!api) return null;

    try {
      const spaces = await api.list();
      const normalizedName = name.toLowerCase();

      // Try exact match first
      let match = spaces.find((s) => s.name.toLowerCase() === normalizedName);

      // Try partial match
      if (!match) {
        match = spaces.find(
          (s) => s.name.toLowerCase().includes(normalizedName) || normalizedName.includes(s.name.toLowerCase())
        );
      }

      return match?.id || null;
    } catch (error) {
      log.error('agent', 'Error finding space', { error });
      return null;
    }
  },

  /**
   * Find an existing meeting space or create one.
   * Looks for spaces whose name matches common meeting-related terms.
   * @returns {Promise<string|null>} - Space ID or null
   */
  async _findOrCreateMeetingSpace() {
    const api = getSpacesAPI();
    if (!api) return null;

    try {
      const spaces = await api.list();

      // Look for existing meeting-related spaces
      const meetingKeywords = ['meeting', 'meetings', 'wsr', 'wiser'];
      let meetingSpace = spaces.find((s) => meetingKeywords.some((kw) => s.name.toLowerCase().includes(kw)));

      if (meetingSpace) {
        return meetingSpace.id;
      }

      // No meeting space found -- create one
      const created = await api.create('Meetings');
      if (created?.id) {
        log.info('agent', 'Created Meetings space for recorder', { spaceId: created.id });
        return created.id;
      }

      return null;
    } catch (error) {
      log.error('agent', 'Error finding/creating meeting space', { error: error.message });
      return null;
    }
  },

  /**
   * Extract any specific instructions from the request
   * @param {string} text - User's request
   * @returns {string|null} - Instructions or null
   */
  _extractInstructions(text) {
    const patterns = [
      /(?:record|capture)\s+(.+?)\s+(?:video|recording)/i,
      /(?:video|recording)\s+(?:of|about|showing)\s+(.+)/i,
      /(?:record|film|shoot)\s+(?:a\s+)?(.{10,})/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const instructions = match[1].trim();
        // Make sure it's substantial enough to be instructions
        if (instructions.length > 10 && !instructions.match(/^(a\s+)?video$/i)) {
          return `Record: ${instructions}`;
        }
      }
    }

    return null;
  },
};

module.exports = recorderAgent;
