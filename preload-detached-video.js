/**
 * Preload script for Detached Video Player Window
 * Provides IPC communication between the detached video window and main process
 */

const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

// Detached video logging is extremely noisy during normal use.
// Keep it disabled by default and only enable via env/argv when explicitly debugging.
const DETACHED_VIDEO_DEBUG =
  process?.env?.DETACHED_VIDEO_DEBUG === '1' ||
  (Array.isArray(process?.argv) && process.argv.includes('--detached-video-debug'));

function dlog(...args) {
  if (!DETACHED_VIDEO_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(...args);
}

function normalizeVideoSrc(inputPathOrUrl) {
  if (!inputPathOrUrl || typeof inputPathOrUrl !== 'string') return inputPathOrUrl;
  const trimmed = inputPathOrUrl.trim();
  if (!trimmed) return trimmed;

  // Already a URL (file://, http(s)://, blob:, data:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) return trimmed;

  // Convert raw filesystem path -> file:// URL
  try {
    return pathToFileURL(trimmed).toString();
  } catch (e) {
    dlog('[DetachedVideo Preload] Failed to normalize video src:', e?.message || e);
    return trimmed;
  }
}

// Queue to hold messages received before the renderer is ready
let pendingSource = null;
let pendingPlayback = null;
let rendererReady = false;
let onReadyCallback = null;

// Expose detached video API to renderer
contextBridge.exposeInMainWorld('detachedVideo', {
  // Called by renderer when its API is ready
  signalReady: (api) => {
    dlog('[DetachedVideo Preload] Renderer signaled ready');
    rendererReady = true;
    
    // Process any pending messages
    if (pendingSource && api.setSource) {
      dlog('[DetachedVideo Preload] Processing queued source:', pendingSource);
      api.setSource(pendingSource);
      pendingSource = null;
    }
    
    if (pendingPlayback && api.syncPlayback) {
      dlog('[DetachedVideo Preload] Processing queued playback state');
      api.syncPlayback(pendingPlayback);
      pendingPlayback = null;
    }
    
    // Store callback for future messages
    onReadyCallback = api;
  },

  // Report time updates back to main window (throttled)
  reportTimeUpdate: (() => {
    let lastReportedTime = 0;
    let throttleTimeout = null;
    
    return (currentTime) => {
      // Throttle to max 10 updates per second for smoother teleprompter sync
      if (throttleTimeout) return;
      
      // Only report if time changed (even small changes matter for highlight sync)
      if (Math.abs(currentTime - lastReportedTime) < 0.05) return;
      
      throttleTimeout = setTimeout(() => {
        throttleTimeout = null;
      }, 100); // 100ms = 10 updates per second
      
      lastReportedTime = currentTime;
      ipcRenderer.send('detached-video:time-update', currentTime);
    };
  })(),

  // Report play/pause state changes
  reportPlayState: (playing) => {
    ipcRenderer.send('detached-video:play-state', playing);
  },

  // Toggle always on top
  toggleAlwaysOnTop: (enabled) => {
    ipcRenderer.invoke('detached-video:set-always-on-top', enabled);
  }
});

// Set up listeners for IPC messages from main process
ipcRenderer.on('detached-video:set-source', (event, path) => {
  const normalized = normalizeVideoSrc(path);
  dlog('[DetachedVideo Preload] Received source:', path, '=>', normalized);
  if (rendererReady && onReadyCallback && onReadyCallback.setSource) {
    onReadyCallback.setSource(normalized);
  } else {
    dlog('[DetachedVideo Preload] Queuing source until renderer ready');
    pendingSource = normalized;
  }
});

ipcRenderer.on('detached-video:sync-playback', (event, state) => {
  dlog('[DetachedVideo Preload] Received sync:', state);
  if (rendererReady && onReadyCallback && onReadyCallback.syncPlayback) {
    onReadyCallback.syncPlayback(state);
  } else {
    pendingPlayback = state;
  }
});

ipcRenderer.on('detached-video:set-pinned', (event, pinned) => {
  if (onReadyCallback && onReadyCallback.setPinned) {
    onReadyCallback.setPinned(pinned);
  }
});

// Handle request for current state
ipcRenderer.on('detached-video:get-state', (event) => {
  if (onReadyCallback && onReadyCallback.getState) {
    const state = onReadyCallback.getState();
    ipcRenderer.send('detached-video:state-response', state);
  }
});

// Initialize connection with main process
ipcRenderer.send('detached-video:ready');

dlog('[DetachedVideo Preload] APIs exposed, waiting for renderer to signal ready');
