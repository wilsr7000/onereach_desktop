/**
 * Agentic Player - Main Entry Point
 * A seamless video player that fetches clips in batches from an API
 * @module src/agentic-player
 */

import { loadConfig } from './config.js';
import { SessionManager } from './core/SessionManager.js';
import { PlaybackController } from './core/PlaybackController.js';
import { APIService } from './services/APIService.js';
import { BufferManager } from './services/BufferManager.js';
import { QueueManager } from './services/QueueManager.js';
import { PlayerUI } from './ui/PlayerUI.js';
import { QueueRenderer } from './ui/QueueRenderer.js';

/**
 * Create player instance
 * @returns {Object} Player API
 */
export function createPlayer() {
  // Load configuration
  const config = loadConfig();

  // Initialize services
  const session = new SessionManager();
  const api = new APIService(config);
  const buffer = new BufferManager();
  const queue = new QueueManager();
  const ui = new PlayerUI();

  // Get video element
  const videoElement = document.getElementById('videoPlayer');
  const playback = new PlaybackController(videoElement);

  // Queue renderer
  const queueRenderer = new QueueRenderer(ui.elements.queueList, ui.elements.queueCount);

  // Debug logger
  const debug = (...args) => {
    if (config.debugMode) {
      window.logging.debug('agent', 'Player debug', { args });
    }
  };

  // Log reasoning
  const logReasoning = (clip, text) => {
    if (!ui.elements.showReasoning?.checked) return;

    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';
    entry.innerHTML = `
      ${clip ? `<div class="reasoning-scene">→ ${clip.name}</div>` : ''}
      <div class="reasoning-text">${text}</div>
    `;
    ui.elements.reasoningLog.insertBefore(entry, ui.elements.reasoningLog.firstChild);
  };

  // Fetch clips from API
  const fetchClips = async () => {
    if (!session.isActive || api.fetching || queue.endSignaled) return;

    if (session.isTimeLimitReached()) {
      endSession('Time limit reached');
      return;
    }

    try {
      ui.showThinking(true);
      const payload = session.getApiPayload(queue.length);
      const data = await api.fetchClips(payload);

      if (!data) return;

      // Handle end signal
      if (data.done) {
        queue.signalEnd();
        if (queue.length === 0 && !playback.currentClip) {
          endSession(data.endMessage || data.reasoning || 'Playback complete');
        }
        return;
      }

      // Add clips to queue
      if (data.scenes && data.scenes.length > 0) {
        queue.addClips(data.scenes);

        if (data.reasoning) {
          logReasoning(null, data.reasoning);
        }

        renderQueue();

        // Start playing if not already
        if (!playback.currentClip) {
          playNext();
        }
      }
    } catch (error) {
      logReasoning(null, `Error: ${error.message}`);

      if (queue.length === 0 && !playback.currentClip) {
        endSession(`API Error: ${error.message}`);
      }
    } finally {
      ui.showThinking(false);
    }
  };

  // Play next clip
  const playNext = () => {
    if (!session.isActive) return;

    if (queue.length === 0) {
      if (queue.isComplete()) {
        endSession('Playback complete');
      } else {
        ui.showThinking(true);
        fetchClips();
      }
      return;
    }

    ui.showThinking(false);

    const clip = queue.getNext();
    session.markWatched(clip.id);

    // Check for preloaded video
    const preloaded = buffer.getPreloadedVideo(clip);
    if (preloaded) {
      window.logging.info('agent', 'Player Using preloaded video');
      buffer.transferToMain(videoElement, clip.inTime || 0);
      playback.loadClip(clip, true);
    } else {
      playback.loadClip(clip, false);
      buffer.clearPreloaded();
    }

    // Update UI
    ui.updateNowPlaying(clip, queue.historyLength, queue.length, queue.endSignaled);
    renderQueue();

    // Check prefetch
    checkPrefetch();
  };

  // Check if should prefetch
  const checkPrefetch = () => {
    debug('checkPrefetch:', { queueLength: queue.length, fetching: api.fetching });

    if (queue.shouldPrefetch(config.prefetchWhenRemaining) && !api.fetching) {
      window.logging.info('agent', `Player Queue low (${queue.length}), pre-fetching...`);
      fetchClips();
    }

    // Preload next video
    const nextClip = queue.peekNext();
    if (nextClip && !buffer.isPreloaded(nextClip)) {
      buffer.preloadNextVideo(nextClip).catch((e) => debug('Preload failed:', e));
    }
  };

  // Render queue
  const renderQueue = () => {
    queueRenderer.render(queue.history, queue.queue, playback.currentClip);
  };

  // Setup playback events
  playback.setupEvents();

  playback.onClipEnd = (clip) => {
    if (clip) {
      const duration = (clip.outTime || videoElement.duration) - (clip.inTime || 0);
      session.addWatchedTime(duration);
      window.logging.info('agent', `Player Clip ended. Total: ${ui.formatTime(session.current.timeWatched)}`);
    }
    playNext();
  };

  playback.onTimeUpdate = ({ currentTime, duration, remainingInClip }) => {
    ui.updateProgress(currentTime, duration);
    ui.updatePlayPauseBtn(!videoElement.paused);

    // Check buffer health
    if (remainingInClip !== null) {
      if (remainingInClip <= 3 && queue.length === 0 && !api.fetching && !queue.endSignaled) {
        window.logging.warn('agent', 'Player Buffer low! Emergency fetch..');
        ui.showThinking(true);
        checkPrefetch();
      } else if (remainingInClip <= config.prefetchThreshold) {
        checkPrefetch();
      }
    }
  };

  // Start session
  const startSession = async () => {
    const prompt = ui.promptValue;
    if (!prompt) {
      alert('Please enter a prompt.');
      return;
    }
    if (!config.apiEndpoint) {
      alert('No API endpoint configured.');
      return;
    }

    session.start(prompt, ui.timeLimitValue);
    queue.reset();
    buffer.clearPreloaded();
    api.resetRetries();

    ui.showSessionStarted();
    logReasoning(null, `Session started: "${prompt}"`);
    window.logging.info('agent', `Player Session started: ${session.current.id}`);

    await fetchClips();
  };

  // End session
  const endSession = (reason = 'Session ended') => {
    session.end(reason);
    videoElement.pause();
    queue.reset();
    buffer.clearPreloaded();
    api.resetRetries();

    ui.showSessionEnded();
    logReasoning(null, `Ended: ${reason}`);
    window.logging.info('agent', `Player Session ended: ${reason} (watched ${queue.historyLength} clips)`);
  };

  // Return public API
  return {
    startSession,
    endSession,
    togglePlay: () => playback.togglePlay(),
    toggleMute: () => {
      const muted = playback.toggleMute();
      ui.updateMuteBtn(muted);
    },
    skipClip: () => {
      if (session.isActive) {
        window.logging.info('agent', 'Player Skipping clip..');
        playback.skipClip();
      }
    },
    toggleSection: (el) => el.closest('.sidebar-section')?.classList.toggle('collapsed'),

    // Expose for debugging
    session,
    queue,
    playback,
    config,
  };
}

// Initialize on load
let player;

document.addEventListener('DOMContentLoaded', () => {
  player = createPlayer();
  window.player = player; // Expose globally
  window.logging.info('agent', 'Player Ready');
});

export default createPlayer;
