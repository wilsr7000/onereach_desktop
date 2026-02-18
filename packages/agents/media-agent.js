/**
 * Media Agent
 *
 * Controls Music and Spotify via AppleScript.
 * Uses self-correcting AppleScript executor that generates, runs, and auto-fixes scripts.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Reasoning-based retry evaluator
const { evaluateFailure, extractIntent } = require('./retry-evaluator');

// Legacy helper for compatibility
const { smartPlay, smartPause, smartSkip, getMediaState, runScript } = require('./applescript-helper');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Progress reporting
let progressReporter;
try {
  progressReporter = require('../../src/voice-task-sdk/events/progressReporter');
} catch (_e) {
  // Progress reporter not available - create stub
  progressReporter = {
    started: () => {},
    report: () => {},
    completed: () => {},
    failed: () => {},
  };
}

// Notification manager for timer handoff
let notificationManager;
try {
  notificationManager = require('../../src/voice-task-sdk/notifications/notificationManager');
} catch (_e) {
  notificationManager = null;
}

const mediaAgent = {
  id: 'media-agent',
  name: 'Media Agent',
  description: 'Controls Music and Spotify via AppleScript with AirPlay support',
  voice: 'ash', // Warm, entertainment-focused - see VOICE-GUIDE.md
  categories: ['media', 'music'],
  keywords: [
    'play',
    'pause',
    'stop',
    'skip',
    'next',
    'previous',
    'volume',
    'music',
    'song',
    'track',
    'airplay',
    'speaker',
    'speakers',
    'homepod',
    'apple tv',
    'output',
    'living room',
    'bedroom',
    'kitchen',
  ],
  executionType: 'action', // Controls Music/Spotify apps via AppleScript

  // Prompt for LLM evaluation
  prompt: `Media Agent controls music playback on Apple Music and Spotify.

HIGH CONFIDENCE (0.85+) for:
- Playback control: "Play", "Pause", "Stop", "Skip", "Next song", "Previous"
- Volume control: "Volume up", "Turn it down", "Mute", "Unmute"
- AirPlay/speakers: "Play on living room", "Switch to HomePod", "AirPlay to bedroom"
- Now playing: "What's playing?", "What song is this?"

MEDIUM CONFIDENCE (0.50-0.70) for:
- Generic music requests: "Play music" (DJ agent might be better for recommendations)

LOW CONFIDENCE (0.00-0.20) - DO NOT BID on these:
- Music recommendations: "Play something relaxing" (DJ agent handles mood-based requests)
- Calendar queries: "What do I have today?"
- Time queries: "What time is it?"
- Non-media commands

This agent controls the Music app and Spotify directly. For music recommendations based on mood, the DJ agent is more appropriate.`,

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message, undoFn?, undoDescription? }
   */
  async execute(task) {
    const lower = task.content.toLowerCase();

    // Determine the media app
    let app = 'Music';
    if (lower.includes('spotify')) {
      app = 'Spotify';
    }

    try {
      // ==================== AIRPLAY COMMANDS ====================
      // Check for AirPlay output commands first
      const airplayResult = await this.handleAirPlayCommand(lower, task.content);
      if (airplayResult) {
        return airplayResult;
      }

      // Pause command
      if (lower.includes('pause') || (lower.includes('stop') && !lower.includes('stop playing'))) {
        const result = await smartPause(app);
        if (result.success) {
          return {
            success: true,
            message: result.message,
            undoFn: async () => smartPlay(app),
            undoDescription: 'resume playback',
          };
        }
        return {
          success: false,
          message: result.message,
          suggestion: result.suggestion,
        };
      }

      // Play command
      if (lower.includes('play')) {
        // Use LLM to understand the intent (extracts search term, genre, artist, AND duration)
        const intent = await extractIntent(task.content);
        log.info('agent', `Extracted intent`, { intent });

        const searchTerm = intent.searchTerm || intent.genre || intent.artist;
        const isGeneric = !searchTerm;
        const durationSeconds = intent.durationSeconds || null;

        if (durationSeconds) {
          log.info('agent', `Detected play duration: ${durationSeconds} seconds`);
        }

        // Report progress - searching
        if (searchTerm) {
          progressReporter.started('media-agent', `Searching for ${searchTerm}...`);
        }

        // Track attempts for reasoning
        const attempts = [];
        const maxAttempts = 4;

        // First attempt
        let result = await smartPlay(app, isGeneric ? null : searchTerm);
        attempts.push({
          action: `search "${searchTerm || 'library'}" in ${app}`,
          result: result.success ? result.message : null,
          error: result.success ? null : result.message,
        });

        // REASONING-BASED RETRY LOOP
        while (!result.success && result.canRetry && attempts.length < maxAttempts) {
          // Report progress - trying alternative
          progressReporter.report('media-agent', `Trying a different approach...`, { type: 'searching' });

          // Ask the LLM what to do next
          const evaluation = await evaluateFailure({
            originalIntent: task.content,
            attemptsMade: attempts,
            availableActions: ['refine_query', 'try_genre', 'try_alternate_app', 'shuffle_library', 'ask_user', 'stop'],
            maxAttempts,
          });

          log.info('agent', `Retry decision: ${evaluation.action} - ${evaluation.reasoning}`);

          if (evaluation.shouldStop || evaluation.action === 'stop') {
            break;
          }

          // Execute the decided action
          let nextResult = null;
          const action = evaluation.action;
          const params = evaluation.params || {};

          if (action === 'refine_query' && params.query) {
            nextResult = await smartPlay(params.app || app, params.query);
            attempts.push({
              action: `search "${params.query}" in ${params.app || app}`,
              result: nextResult.success ? nextResult.message : null,
              error: nextResult.success ? null : nextResult.message,
            });
          } else if (action === 'try_genre' && (params.genre || intent.genre)) {
            const genre = params.genre || intent.genre;
            nextResult = await smartPlay(params.app || app, genre);
            attempts.push({
              action: `search genre "${genre}" in ${params.app || app}`,
              result: nextResult.success ? nextResult.message : null,
              error: nextResult.success ? null : nextResult.message,
            });
          } else if (action === 'try_alternate_app') {
            const altApp = app === 'Music' ? 'Spotify' : 'Music';
            nextResult = await smartPlay(altApp, searchTerm);
            attempts.push({
              action: `search "${searchTerm || 'library'}" in ${altApp}`,
              result: nextResult.success ? nextResult.message : null,
              error: nextResult.success ? null : nextResult.message,
            });
          } else if (action === 'shuffle_library') {
            nextResult = await this.tryShuffleLibrary(params.app || app);
            attempts.push({
              action: `shuffle library in ${params.app || app}`,
              result: nextResult.success ? nextResult.message : null,
              error: nextResult.success ? null : nextResult.message,
            });
          } else if (action === 'ask_user') {
            return {
              success: false,
              needsClarification: true,
              message:
                params.question ||
                `I couldn't find "${searchTerm}". Could you be more specific about what you'd like to hear?`,
              attempts,
            };
          }

          if (nextResult) {
            result = nextResult;
          } else {
            break; // Unknown action
          }
        }

        // Return final result
        if (result.success) {
          progressReporter.completed('media-agent');

          // If duration was specified, set up a timer to stop playback
          if (durationSeconds && notificationManager) {
            const timerId = notificationManager.setTimer(durationSeconds, 'music');
            log.info('agent', `Set music timer for ${durationSeconds}s, id: ${timerId}`);

            // Store timer ID so we can cancel on stop
            this._activeTimer = timerId;

            // Format duration for user message
            const durationDisplay =
              durationSeconds >= 3600
                ? `${Math.round(durationSeconds / 3600)} hour${durationSeconds >= 7200 ? 's' : ''}`
                : durationSeconds >= 60
                  ? `${Math.round(durationSeconds / 60)} minute${durationSeconds >= 120 ? 's' : ''}`
                  : `${durationSeconds} seconds`;

            return {
              success: true,
              message: `${result.message}. I'll remind you in ${durationDisplay}.`,
              attempts: attempts.length,
              // Handoff to notification for the timer
              handoff: {
                targetAgent: 'timer-agent',
                content: `Set a timer for ${durationDisplay}`,
                context: {
                  timerSeconds: durationSeconds,
                  reason: 'music playback',
                  timerId,
                },
              },
            };
          }

          return {
            success: true,
            message: result.message,
            attempts: attempts.length,
          };
        }

        progressReporter.failed('media-agent', 'Could not find matching music');
        return {
          success: false,
          message: `I tried ${attempts.length} different approaches but couldn't play "${intent.searchTerm || 'music'}". ${result.suggestion || ''}`,
          attempts,
        };
      }

      // Skip/Next command
      if (lower.includes('skip') || lower.includes('next')) {
        const result = await smartSkip(app);
        if (!result.success && result.suggestion) {
          return {
            success: false,
            message: `${result.message}. ${result.suggestion}`,
          };
        }
        return { success: result.success, message: result.message };
      }

      // Previous command
      if (lower.includes('previous') || lower.includes('back')) {
        const beforeState = await getMediaState(app);
        if (!beforeState.running || beforeState.state === 'stopped') {
          return {
            success: false,
            message: 'Nothing is playing to go back from. Start playing music first.',
          };
        }
        await runScript(`tell application "${app}" to previous track`);
        return { success: true, message: 'Going back' };
      }

      // Volume commands
      if (lower.includes('volume')) {
        return this.handleVolumeCommand(lower);
      }

      // Mute
      if (lower.includes('mute') && !lower.includes('unmute')) {
        const prevVol = await this.getVolume();
        await this.runAppleScript('set volume with output muted');
        return {
          success: true,
          message: 'Muted',
          undoFn: async () => {
            await this.runAppleScript('set volume without output muted');
            await this.runAppleScript(`set volume output volume ${prevVol}`);
          },
          undoDescription: 'unmute',
        };
      }

      // Unmute
      if (lower.includes('unmute')) {
        await this.runAppleScript('set volume without output muted');
        return { success: true, message: 'Unmuted' };
      }

      return {
        success: false,
        message: "I couldn't understand that media command",
      };
    } catch (error) {
      log.error('agent', 'Error', { error });

      // Try to open the app if it's not running
      if (error.message.includes('not running')) {
        try {
          await execAsync(`open -a "${app}"`, { timeout: 3000 });
          await new Promise((r) => {
            setTimeout(r, 2000);
          });
          return {
            success: true,
            message: `Opening ${app}`,
          };
        } catch (_e) {
          // Fall through to error
        }
      }

      return {
        success: false,
        message: "Music isn't available right now",
      };
    }
  },

  /**
   * Handle volume commands
   * @param {string} lower - Lowercase command text
   * @returns {Object}
   */
  async handleVolumeCommand(lower) {
    const prevVol = await this.getVolume();

    // Volume up
    if (lower.includes('up') || lower.includes('louder') || lower.includes('increase')) {
      const newVol = Math.min(100, prevVol + 10);
      await this.runAppleScript(`set volume output volume ${newVol}`);
      return {
        success: true,
        message: `Volume up to ${newVol}`,
        undoFn: async () => this.runAppleScript(`set volume output volume ${prevVol}`),
        undoDescription: `restore volume to ${prevVol}`,
      };
    }

    // Volume down
    if (lower.includes('down') || lower.includes('quieter') || lower.includes('decrease') || lower.includes('lower')) {
      const newVol = Math.max(0, prevVol - 10);
      await this.runAppleScript(`set volume output volume ${newVol}`);
      return {
        success: true,
        message: `Volume down to ${newVol}`,
        undoFn: async () => this.runAppleScript(`set volume output volume ${prevVol}`),
        undoDescription: `restore volume to ${prevVol}`,
      };
    }

    // Set specific volume
    const volumeMatch = lower.match(/volume\s+(?:to\s+)?(\d+)/);
    if (volumeMatch) {
      const level = Math.min(100, Math.max(0, parseInt(volumeMatch[1])));
      await this.runAppleScript(`set volume output volume ${level}`);
      return {
        success: true,
        message: `Volume set to ${level}`,
        undoFn: async () => this.runAppleScript(`set volume output volume ${prevVol}`),
        undoDescription: `restore volume to ${prevVol}`,
      };
    }

    // Just "volume" - report current level
    return {
      success: true,
      message: `Volume is at ${prevVol}`,
    };
  },

  /**
   * Clean a search query by removing filler words
   * @param {string} query - Raw query like "some jazz" or "a little classical"
   * @returns {string} - Cleaned query like "jazz" or "classical"
   */
  cleanSearchQuery(query) {
    if (!query) return null;

    // Filler words to remove from the start
    const fillerPrefixes = [
      'some',
      'a little',
      'a bit of',
      'any',
      'a',
      'the',
      'my',
      'that',
      'this',
      'our',
      'their',
      'more',
      'good',
      'nice',
      'really',
      'very',
      'super',
      'great',
    ];

    // Filler suffixes to remove
    const fillerSuffixes = ['music', 'songs', 'tunes', 'tracks', 'please', 'now', 'for me', 'for us'];

    let cleaned = query.toLowerCase().trim();

    // Remove prefixes
    for (const prefix of fillerPrefixes) {
      if (cleaned.startsWith(prefix + ' ')) {
        cleaned = cleaned.substring(prefix.length + 1).trim();
      }
    }

    // Remove suffixes
    for (const suffix of fillerSuffixes) {
      if (cleaned.endsWith(' ' + suffix)) {
        cleaned = cleaned.substring(0, cleaned.length - suffix.length - 1).trim();
      }
    }

    return cleaned || null;
  },

  /**
   * Generate refined search queries when the original fails
   * @param {string} cleanedQuery - Already cleaned query
   * @param {string} rawQuery - Original raw query
   * @returns {Promise<string[]>} - Array of alternative queries to try
   */
  async refineSearchQuery(cleanedQuery, rawQuery) {
    const alternatives = [];

    // 1. Try just the genre word if it looks like a genre
    const genres = [
      'jazz',
      'rock',
      'pop',
      'classical',
      'hip hop',
      'rap',
      'country',
      'blues',
      'folk',
      'electronic',
      'dance',
      'r&b',
      'soul',
      'reggae',
      'metal',
      'punk',
      'indie',
      'alternative',
      'ambient',
      'house',
      'techno',
    ];

    const words = cleanedQuery.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (genres.includes(word)) {
        alternatives.push(word);
      }
    }

    // 2. Try each word individually (might be artist or song name)
    if (words.length > 1) {
      for (const word of words) {
        if (word.length > 2 && !['the', 'and', 'for', 'with'].includes(word)) {
          alternatives.push(word);
        }
      }
    }

    // 3. Try first word only (often the artist)
    if (words.length > 1) {
      alternatives.push(words[0]);
    }

    // 4. Use LLM to extract likely search terms
    try {
      if (cleanedQuery.length > 3) {
        const result = await ai.chat({
          profile: 'fast',
          system:
            'Extract the most likely music search term from the user\'s request. Return just the search term, nothing else. For example: "some jazz" → "jazz", "that Beatles song" → "Beatles", "upbeat workout music" → "workout"',
          messages: [{ role: 'user', content: rawQuery }],
          temperature: 0,
          maxTokens: 50,
          feature: 'media-agent',
        });

        const suggestion = result.content?.trim();
        if (suggestion && suggestion !== cleanedQuery && !alternatives.includes(suggestion)) {
          alternatives.unshift(suggestion); // Add as first option
          log.info('agent', `LLM suggested search term: "${suggestion}"`);
        }
      }
    } catch (_e) {
      // Ignore LLM errors - alternatives still has fallback options
    }

    // Remove duplicates and the original query
    return [...new Set(alternatives)].filter((q) => q && q !== cleanedQuery);
  },

  /**
   * Try to shuffle and play the library as a fallback
   * @param {string} app - 'Music' or 'Spotify'
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async tryShuffleLibrary(app) {
    log.info('agent', `Attempting to shuffle ${app} library...`);

    try {
      if (app === 'Music') {
        // Try to play the Songs playlist with shuffle
        await runScript(`
          tell application "Music"
            try
              set shuffle enabled to true
              play playlist "Library"
            on error
              try
                play playlist "Songs"
              on error
                play
              end try
            end try
          end tell
        `);
      } else {
        // Spotify - try to play liked songs
        await runScript(`
          tell application "Spotify"
            set shuffling to true
            play
          end tell
        `);
      }

      // Check if it worked
      await new Promise((r) => {
        setTimeout(r, 1000);
      });
      const state = await getMediaState(app);

      if (state.state === 'playing') {
        return {
          success: true,
          message: state.track
            ? `Shuffling your library. Now playing "${state.track}" by ${state.artist}`
            : `Shuffling your ${app} library`,
        };
      }

      return { success: false, message: 'Shuffle attempt did not start playback' };
    } catch (_e) {
      log.error('agent', 'Shuffle failed', { _e });
      return { success: false, message: 'Could not shuffle library' };
    }
  },

  /**
   * Run an AppleScript command
   * @param {string} script
   * @returns {Promise<string>}
   */
  async runAppleScript(script) {
    const escapedScript = script.replace(/'/g, "'\"'\"'");
    const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 10000 });
    return stdout.trim();
  },

  /**
   * Get current volume level
   * @returns {Promise<number>}
   */
  async getVolume() {
    try {
      const { stdout } = await execAsync(`osascript -e 'output volume of (get volume settings)'`, { timeout: 3000 });
      return parseInt(stdout.trim()) || 50;
    } catch (_e) {
      return 50; // Default
    }
  },

  // ==================== AIRPLAY METHODS ====================

  /**
   * Handle AirPlay-related commands
   * @param {string} lower - Lowercase command text
   * @param {string} original - Original command text
   * @returns {Object|null} - Result or null if not an AirPlay command
   */
  async handleAirPlayCommand(lower, original) {
    // Detect AirPlay intent
    const isAirPlayCommand =
      lower.includes('airplay') ||
      lower.includes('homepod') ||
      lower.includes('apple tv') ||
      lower.includes('speaker') ||
      (lower.includes('play') && lower.includes(' on ')) ||
      (lower.includes('switch') && (lower.includes('to ') || lower.includes('output'))) ||
      lower.includes('output to') ||
      lower.includes('play to');

    if (!isAirPlayCommand) {
      return null;
    }

    log.info('agent', 'Detected AirPlay command', { original });

    // List speakers command
    if (lower.includes('list') || lower.includes('what') || lower.includes('available') || lower.includes('show')) {
      return this.listAirPlayDevices();
    }

    // Turn off AirPlay / play locally
    if (
      lower.includes('computer') ||
      lower.includes('mac') ||
      lower.includes('local') ||
      lower.includes('this device') ||
      lower.includes('turn off airplay') ||
      lower.includes('stop airplay')
    ) {
      return this.setAirPlayDevice('Computer');
    }

    // Extract target device name from command
    const targetDevice = this.extractAirPlayTarget(lower, original);

    if (targetDevice) {
      // Check if this is "play X on Y" (play music AND set output)
      const playMatch = original.match(/play\s+(.+?)\s+(?:on|to)\s+/i);
      if (playMatch && !lower.includes('switch') && !lower.includes('output')) {
        // This is "play jazz on living room" - need to set output AND play music
        const musicQuery = playMatch[1].trim();
        return this.playOnDevice(musicQuery, targetDevice);
      }

      // Just switch output
      return this.setAirPlayDevice(targetDevice);
    }

    // Couldn't determine target - list available devices
    return this.listAirPlayDevices();
  },

  /**
   * Extract the target AirPlay device name from a command
   * @param {string} lower - Lowercase command
   * @param {string} original - Original command (for case preservation)
   * @returns {string|null} - Device name or null
   */
  extractAirPlayTarget(lower, original) {
    // Common room names that might be speaker names
    const roomPatterns = [
      'living room',
      'bedroom',
      'kitchen',
      'office',
      'bathroom',
      'dining room',
      'basement',
      'garage',
      'den',
      'study',
      'nursery',
      'playroom',
      'guest room',
      'master bedroom',
      'kids room',
      'family room',
      'media room',
      'home office',
    ];

    // Try to extract from common patterns
    // "play on [device]", "switch to [device]", "output to [device]"
    const patterns = [
      /(?:play|switch|output|send|stream)\s+(?:music\s+)?(?:on|to)\s+(?:the\s+)?(.+?)(?:\s+speaker)?$/i,
      /(?:on|to)\s+(?:the\s+)?(.+?)(?:\s+speaker)?$/i,
      /(?:use|set)\s+(?:the\s+)?(.+?)(?:\s+as\s+output)?$/i,
    ];

    for (const pattern of patterns) {
      const match = original.match(pattern);
      if (match) {
        let device = match[1].trim();
        // Remove trailing words like "please", "now"
        device = device.replace(/\s+(please|now|thanks)$/i, '').trim();
        if (device.length > 0 && device.length < 50) {
          return device;
        }
      }
    }

    // Check for room names in the command
    for (const room of roomPatterns) {
      if (lower.includes(room)) {
        // Return with proper capitalization
        return room
          .split(' ')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }
    }

    // Check for device types
    if (lower.includes('homepod')) {
      // Try to get specific HomePod name
      const homepodMatch = original.match(/homepod\s+(.+?)(?:\s|$)/i);
      if (homepodMatch) {
        return 'HomePod ' + homepodMatch[1].trim();
      }
      return 'HomePod'; // Generic - will match first HomePod
    }

    if (lower.includes('apple tv')) {
      const atvMatch = original.match(/apple\s+tv\s+(.+?)(?:\s|$)/i);
      if (atvMatch) {
        return 'Apple TV ' + atvMatch[1].trim();
      }
      return 'Apple TV';
    }

    return null;
  },

  /**
   * Get list of available AirPlay devices
   * @returns {Promise<Object>} - { success, message, devices }
   */
  async listAirPlayDevices() {
    try {
      const script = `
        tell application "Music"
          set deviceList to {}
          set airplayDevices to AirPlay devices
          repeat with aDevice in airplayDevices
            set deviceName to name of aDevice
            set deviceSelected to selected of aDevice
            set deviceKind to kind of aDevice as string
            set end of deviceList to deviceName & "|" & deviceSelected & "|" & deviceKind
          end repeat
          return deviceList as string
        end tell
      `;

      const result = await runScript(script);
      // runScript returns {success, output, error} - pass only the output string
      const devices = this.parseAirPlayDevices(result.output || '');

      if (devices.length === 0) {
        return {
          success: true,
          message: 'No AirPlay devices found. Make sure your speakers are on and on the same network.',
        };
      }

      // Format for voice
      const selectedDevice = devices.find((d) => d.selected);
      const deviceNames = devices.map((d) => d.name).join(', ');

      let message = `Available speakers: ${deviceNames}.`;
      if (selectedDevice) {
        message += ` Currently playing on ${selectedDevice.name}.`;
      }

      return {
        success: true,
        message,
        devices,
      };
    } catch (error) {
      log.error('agent', 'Error listing AirPlay devices', { error });
      return {
        success: false,
        message: "I couldn't get the list of AirPlay devices. Make sure Music is running.",
      };
    }
  },

  /**
   * Parse AirPlay device list from AppleScript output
   * @param {string} output - Raw AppleScript output
   * @returns {Array<{name: string, selected: boolean, kind: string}>}
   */
  parseAirPlayDevices(output) {
    if (!output || output.trim() === '') return [];

    const devices = [];
    const entries = output.split(', ');

    for (const entry of entries) {
      const parts = entry.split('|');
      if (parts.length >= 2) {
        devices.push({
          name: parts[0].trim(),
          selected: parts[1].trim().toLowerCase() === 'true',
          kind: parts[2]?.trim() || 'unknown',
        });
      }
    }

    return devices;
  },

  /**
   * Set the AirPlay output device
   * @param {string} targetDevice - Name of device to switch to
   * @returns {Promise<Object>} - { success, message }
   */
  async setAirPlayDevice(targetDevice) {
    log.info('agent', 'Setting AirPlay device to', { targetDevice });

    try {
      // First, get available devices
      const { devices } = await this.listAirPlayDevices();

      if (!devices || devices.length === 0) {
        return {
          success: false,
          message: 'No AirPlay devices available. Make sure your speakers are on.',
        };
      }

      // Find matching device (fuzzy match)
      const normalizedTarget = targetDevice.toLowerCase();
      let matchedDevice = devices.find((d) => d.name.toLowerCase() === normalizedTarget);

      // Try partial match if exact match fails
      if (!matchedDevice) {
        matchedDevice = devices.find(
          (d) => d.name.toLowerCase().includes(normalizedTarget) || normalizedTarget.includes(d.name.toLowerCase())
        );
      }

      // Try word-by-word match
      if (!matchedDevice) {
        const targetWords = normalizedTarget.split(/\s+/);
        matchedDevice = devices.find((d) => {
          const deviceWords = d.name.toLowerCase().split(/\s+/);
          return targetWords.some((tw) => deviceWords.some((dw) => dw.includes(tw) || tw.includes(dw)));
        });
      }

      if (!matchedDevice) {
        const availableNames = devices.map((d) => d.name).join(', ');
        return {
          success: false,
          message: `I couldn't find "${targetDevice}". Available speakers are: ${availableNames}`,
        };
      }

      // Check if already selected
      if (matchedDevice.selected) {
        return {
          success: true,
          message: `Already playing on ${matchedDevice.name}`,
        };
      }

      // Select the device
      const selectScript = `
        tell application "Music"
          set airplayDevices to AirPlay devices
          repeat with aDevice in airplayDevices
            if name of aDevice is "${matchedDevice.name}" then
              set selected of aDevice to true
            else
              set selected of aDevice to false
            end if
          end repeat
        end tell
      `;

      await runScript(selectScript);

      // Small delay to let it switch
      await new Promise((r) => {
        setTimeout(r, 500);
      });

      return {
        success: true,
        message: `Now playing on ${matchedDevice.name}`,
      };
    } catch (error) {
      log.error('agent', 'Error setting AirPlay device', { error });
      return {
        success: false,
        message: `Couldn't switch to ${targetDevice}. ${error.message || ''}`,
      };
    }
  },

  /**
   * Play music on a specific AirPlay device
   * @param {string} musicQuery - What to play (genre, artist, etc.)
   * @param {string} targetDevice - Device to play on
   * @returns {Promise<Object>} - { success, message }
   */
  async playOnDevice(musicQuery, targetDevice) {
    log.info('agent', 'Playing', { musicQuery, on: targetDevice });

    // First, set the output device
    const deviceResult = await this.setAirPlayDevice(targetDevice);
    if (!deviceResult.success) {
      return deviceResult;
    }

    // Then play the music
    const playResult = await smartPlay('Music', musicQuery);

    if (playResult.success) {
      return {
        success: true,
        message: `Playing ${musicQuery} on ${targetDevice}`,
      };
    }

    // Music search failed but output was set
    return {
      success: true,
      message: `Switched to ${targetDevice}. ${playResult.message || "Couldn't find that music."}`,
    };
  },

  /**
   * Get currently selected AirPlay device
   * @returns {Promise<string|null>} - Device name or null
   */
  async getCurrentAirPlayDevice() {
    try {
      const { devices } = await this.listAirPlayDevices();
      const selected = devices?.find((d) => d.selected);
      return selected?.name || null;
    } catch (_e) {
      return null;
    }
  },
};

module.exports = mediaAgent;
