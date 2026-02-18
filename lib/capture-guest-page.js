/**
 * Capture Guest Page
 *
 * Builds a permanent, self-contained HTML page for joining WISER Meetings.
 * Published once to GSX Files — the URL never changes.
 *
 * At join time, the page fetches the token pool from GSX KeyValue
 * using the room name. The host stores tokens there when creating a meeting.
 *
 * Supports ?room=xyz query param to pre-fill the room name.
 *
 * @param {Object} [options]
 * @param {string} [options.kvUrl] - GSX KeyValue API endpoint URL
 */

// Bump this version whenever the guest page code changes to force re-publish
const GUEST_PAGE_VERSION = 6;

function buildGuestPageHTML(options = {}) {
  const kvUrl = options.kvUrl || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>WISER Meeting - Join Session</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d0d0d;
    --bg-panel: #161618;
    --bg-elevated: #1c1c1f;
    --border: #2a2a2e;
    --border-light: #3a3a3f;
    --text: #e8e8ed;
    --text-muted: #8e8e93;
    --accent: #4d7cff;
    --accent-green: #00c878;
    --accent-red: #ff4d6a;
    --radius: 10px;
    --radius-sm: 6px;
  }

  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    overflow: hidden;
  }

  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .header-title {
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-title svg { width: 18px; height: 18px; }

  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .badge-connected {
    background: rgba(0, 200, 120, 0.15);
    color: var(--accent-green);
    display: none;
  }

  .badge-recording {
    background: rgba(255, 77, 106, 0.15);
    color: var(--accent-red);
    display: none;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Join Panel */
  .join-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 20px;
  }

  .join-panel.hidden { display: none; }

  .join-icon {
    width: 64px;
    height: 64px;
    color: var(--accent);
    opacity: 0.8;
  }

  .join-icon svg { width: 100%; height: 100%; }

  .join-title {
    font-size: 20px;
    font-weight: 600;
  }

  .join-subtitle {
    font-size: 13px;
    color: var(--text-muted);
    text-align: center;
    max-width: 320px;
  }

  .join-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    max-width: 320px;
  }

  .join-input {
    width: 100%;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 18px;
    font-family: inherit;
    text-align: center;
    letter-spacing: 2px;
    text-transform: lowercase;
    transition: border-color 0.2s;
  }

  .join-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .join-input::placeholder {
    letter-spacing: 0;
    text-transform: none;
    color: var(--text-muted);
    font-size: 14px;
  }

  .btn {
    padding: 14px 24px;
    border: none;
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-primary {
    background: var(--accent);
    color: #fff;
  }

  .btn-primary:hover { filter: brightness(1.1); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Ready state: pulsing glow to draw attention on mobile */
  .btn-ready {
    animation: btn-pulse 2s ease-in-out infinite;
    font-size: 16px;
    padding: 16px 28px;
  }

  @keyframes btn-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5); }
    50% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); }
  }

  .btn-danger {
    background: rgba(255, 77, 106, 0.15);
    color: var(--accent-red);
    border: 1px solid rgba(255, 77, 106, 0.3);
  }

  .join-error {
    font-size: 12px;
    color: var(--accent-red);
    text-align: center;
    min-height: 16px;
    line-height: 1.4;
  }

  .join-step {
    font-size: 12px;
    color: var(--accent);
    text-align: center;
    min-height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .join-step .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(77, 124, 255, 0.2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .btn-primary .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    display: inline-block;
    vertical-align: middle;
    margin-right: 6px;
  }

  .join-error-help {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .retry-btn {
    display: inline-block;
    margin-top: 10px;
    padding: 8px 20px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;
  }

  .retry-btn:hover {
    background: var(--border);
  }

  /* Session View */
  .session-view {
    flex: 1;
    display: none;
    flex-direction: column;
  }

  .session-view.active {
    display: flex;
  }

  /* Dynamic video grid — adapts to participant count */
  .video-grid {
    flex: 1;
    display: grid;
    gap: 4px;
    padding: 4px;
    min-height: 0;
    /* Default: responsive auto-fill for any participant count */
    grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
    grid-auto-rows: 1fr;
  }

  /* 2 participants: side by side on desktop, stacked on mobile */
  .video-grid.grid-2 {
    grid-template-columns: 1fr 1fr;
  }

  /* 3-4 participants: 2x2 grid */
  .video-grid.grid-3,
  .video-grid.grid-4 {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
  }

  /* 5-6: 3 columns */
  .video-grid.grid-5,
  .video-grid.grid-6 {
    grid-template-columns: 1fr 1fr 1fr;
  }

  @media (max-width: 600px) {
    .video-grid.grid-2 {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
    }
    .video-grid.grid-3,
    .video-grid.grid-4 {
      grid-template-columns: 1fr 1fr;
    }

    /* PiP self-view on mobile: local video floats over full-screen remote */
    .video-grid.pip-mode {
      display: block;
      position: relative;
    }

    .video-grid.pip-mode .video-cell {
      position: absolute;
      inset: 0;
      border-radius: 0;
    }

    .video-grid.pip-mode .video-cell.pip-self {
      position: absolute;
      inset: auto;
      bottom: 12px;
      right: 12px;
      width: 110px;
      height: 150px;
      border-radius: 12px;
      border: 2px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      z-index: 10;
      touch-action: none;
      cursor: grab;
      transition: box-shadow 0.2s;
    }

    .video-grid.pip-mode .video-cell.pip-self:active {
      cursor: grabbing;
      box-shadow: 0 6px 28px rgba(0, 0, 0, 0.7);
    }

    .video-grid.pip-mode .video-cell.pip-self video {
      transform: scaleX(-1);
    }

    .video-grid.pip-mode .video-cell.pip-self .video-label {
      display: none;
    }
  }

  .video-cell {
    position: relative;
    background: var(--bg-panel);
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition: box-shadow 0.3s ease;
  }

  .video-cell video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Active speaker glow */
  .video-cell.speaking {
    box-shadow: 0 0 12px rgba(77, 124, 255, 0.5),
                inset 0 0 0 2px rgba(77, 124, 255, 0.6);
  }

  .video-label {
    position: absolute;
    bottom: 8px;
    left: 8px;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
  }

  .video-label.remote {
    color: var(--accent);
  }

  /* Controls Bar */
  .controls-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .rec-indicator {
    display: none;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent-red);
  }

  .rec-indicator.active { display: flex; }

  .rec-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-red);
    animation: pulse 1s ease-in-out infinite;
  }

  .duration {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  /* Circular control buttons (mic, camera, settings) */
  .ctrl-btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;
    padding: 0;
  }

  .ctrl-btn svg {
    width: 20px;
    height: 20px;
  }

  .ctrl-btn:hover {
    background: var(--border);
  }

  .ctrl-btn.off {
    background: rgba(255, 59, 78, 0.15);
    border-color: rgba(255, 59, 78, 0.3);
    color: var(--accent-red);
  }

  .ctrl-btn.off:hover {
    background: rgba(255, 59, 78, 0.25);
  }

  /* Separator between control groups */
  .ctrl-sep {
    width: 1px;
    height: 24px;
    background: var(--border);
    flex-shrink: 0;
  }

  /* Device Settings Panel (slide-up) */
  .device-panel {
    display: none;
    padding: 12px 16px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .device-panel.visible {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .device-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .device-row svg {
    width: 16px;
    height: 16px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .device-select {
    flex: 1;
    padding: 8px 28px 8px 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    min-width: 0;
  }

  .device-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* Transfer Overlay */
  .transfer-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(12px);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .transfer-overlay.active { display: flex; }

  .transfer-content {
    text-align: center;
    max-width: 360px;
    padding: 24px;
  }

  .transfer-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 20px;
  }

  .progress-bar {
    width: 100%;
    height: 6px;
    background: var(--bg-elevated);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 12px;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-green));
    border-radius: 3px;
    width: 0%;
    transition: width 0.2s;
  }

  .transfer-status {
    font-size: 12px;
    color: var(--text-muted);
  }

  .transfer-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 16px;
  }

  .transfer-actions .btn {
    padding: 10px 20px;
    font-size: 13px;
  }

  .transfer-actions .btn-download {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
  }

  .transfer-actions .btn-retry {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
  }

  /* Status Toast */
  .status-toast {
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    padding: 10px 20px;
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    opacity: 0;
    transition: all 0.3s;
    z-index: 50;
    pointer-events: none;
  }

  .status-toast.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  .status-toast.error { border-color: var(--accent-red); color: var(--accent-red); }
  .status-toast.success { border-color: var(--accent-green); color: var(--accent-green); }

  /* Permission prompt */
  .perm-prompt {
    text-align: center;
    padding: 32px;
  }

  .perm-prompt p {
    color: var(--text-muted);
    font-size: 13px;
    margin-top: 8px;
  }

  /* Blur toggle button */
  .blur-btn {
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;
    display: none;
  }

  .blur-btn.supported { display: inline-block; }

  .blur-btn.active {
    background: rgba(77, 124, 255, 0.15);
    border-color: rgba(77, 124, 255, 0.3);
    color: #4d7cff;
  }

  .blur-btn:hover { filter: brightness(1.1); }
</style>
<script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"><\/script>
<script type="module">
  import { BackgroundProcessor, supportsBackgroundProcessors } from 'https://esm.run/@livekit/track-processors';
  window._BgProcessor = BackgroundProcessor;
  window._supportsBg = supportsBackgroundProcessors;
  // Show the blur button if browser supports it
  try {
    if (supportsBackgroundProcessors()) {
      const btn = document.getElementById('blurBtn');
      if (btn) btn.classList.add('supported');
    }
  } catch {}
<\/script>
</head>
<body>
<div class="app">
  <!-- Header -->
  <div class="header">
    <div class="header-title">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      WISER Meeting
    </div>
    <div>
      <span class="badge badge-connected" id="badgeConnected">Connected</span>
      <span class="badge badge-recording" id="badgeRecording">REC</span>
    </div>
  </div>

  <!-- Join Panel -->
  <div class="join-panel" id="joinPanel">
    <div class="join-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    </div>
    <div class="join-title">Join WISER Meeting</div>
    <div class="join-subtitle">Enter your name and the room name to join.</div>
    <div class="join-form">
      <input type="text" class="join-input" id="nameInput" placeholder="Your name"
             autocomplete="name" autocapitalize="words" spellcheck="false"
             style="text-transform:none; letter-spacing:0; margin-bottom:10px;">
      <input type="text" class="join-input" id="codeInput" placeholder="Room name"
             autocomplete="off" autocapitalize="none" spellcheck="false">
      <button class="btn btn-primary" id="joinBtn" onclick="guest.join()">Join Meeting</button>
      <div class="join-step" id="joinStep" style="display: none;"></div>
      <div class="join-error" id="joinError"></div>
    </div>
  </div>

  <!-- Session View (shown after connected) -->
  <div class="session-view" id="sessionView">
    <div class="video-grid" id="videoGrid">
      <!-- Participant cells created dynamically -->
    </div>
    <div class="device-panel" id="devicePanel">
      <div class="device-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
        <select class="device-select" id="micSelect" onchange="guest.switchMic(this.value)">
          <option value="">Default Microphone</option>
        </select>
      </div>
      <div class="device-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        <select class="device-select" id="camSelect" onchange="guest.switchCamera(this.value)">
          <option value="">Default Camera</option>
        </select>
      </div>
    </div>
    <div class="controls-bar">
      <div class="rec-indicator" id="recIndicator">
        <div class="rec-dot"></div>
        <span>REC</span>
      </div>
      <div class="duration" id="duration">00:00</div>
      <div class="ctrl-sep"></div>
      <button class="ctrl-btn" id="micBtn" onclick="guest.toggleMic()" title="Mute/Unmute">
        <svg id="micIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </button>
      <button class="ctrl-btn" id="camBtn" onclick="guest.toggleCamera()" title="Camera On/Off">
        <svg id="camIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M23 7l-7 5 7 5V7z"/>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
      </button>
      <button class="ctrl-btn" id="settingsBtn" onclick="guest.toggleDevicePanel()" title="Audio/Video Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <div class="ctrl-sep"></div>
      <button class="blur-btn" id="blurBtn" onclick="guest.toggleBlur()">Blur BG</button>
      <button class="btn btn-danger" id="leaveBtn" onclick="guest.leave()">Leave</button>
    </div>
  </div>

  <!-- Transfer Overlay -->
  <div class="transfer-overlay" id="transferOverlay">
    <div class="transfer-content">
      <div class="transfer-title" id="transferTitle">Sending recording to host...</div>
      <div class="progress-bar">
        <div class="progress-fill" id="transferFill"></div>
      </div>
      <div class="transfer-status" id="transferStatus">Preparing...</div>
      <div class="transfer-actions" id="transferActions" style="display:none">
        <button class="btn btn-download" onclick="guest.downloadRecording()">Download Recording</button>
        <button class="btn btn-retry" id="retryBtn" onclick="guest.retrySendRecording()" style="display:none">Retry Transfer</button>
      </div>
    </div>
  </div>

  <!-- Status Toast -->
  <div class="status-toast" id="statusToast"></div>
</div>

<script>
// KV endpoint embedded at publish time — tokens fetched at join time
const KV_URL = '${kvUrl}';
const KV_COLLECTION = 'wiser:meeting:tokens';

const guest = {
  // Config
  CHUNK_SIZE: 16384,
  MAX_TOKEN_RETRIES: 5,

  // State
  room: null,          // LiveKit Room instance
  localStream: null,   // getUserMedia stream (for MediaRecorder)
  mediaRecorder: null,
  recordedChunks: [],
  recordedBlob: null,
  isRecording: false,
  recordingStartTime: null,
  durationInterval: null,
  sessionCode: null,
  _displayName: '',    // Guest's display name
  _tokenPool: [],      // Fetched from KV at join time
  _livekitUrl: '',     // Fetched from KV at join time
  _tokenIndex: -1,     // Current index in pool
  _tokenRetries: 0,    // How many tokens we've tried

  // Transfer resilience
  _transferFailed: false,        // True if last transfer failed
  _transferComplete: false,      // True if transfer succeeded
  _idbKey: null,                 // IndexedDB key for persisted blob

  // Multi-participant state
  _participants: new Map(),       // sid -> { cell, identity }
  _localSid: 'local',            // key for own tile

  // ================================================
  // INIT
  // ================================================

  init() {
    const nameInput = document.getElementById('nameInput');
    const codeInput = document.getElementById('codeInput');
    const joinBtn = document.getElementById('joinBtn');

    if (!KV_URL) {
      codeInput.style.display = 'none';
      nameInput.style.display = 'none';
      joinBtn.style.display = 'none';
      document.getElementById('joinError').innerHTML =
        'This page is not configured.<div class="join-error-help">Ask the host to share a valid meeting link.</div>';
      return;
    }

    // Check for query params to pre-fill fields
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const nameParam = params.get('name');
    if (roomParam) {
      codeInput.value = roomParam;
    }
    if (nameParam) {
      nameInput.value = nameParam;
    }
    // If both pre-filled, make join button prominent
    if (roomParam && nameParam) {
      joinBtn.classList.add('btn-ready');
      joinBtn.textContent = 'Tap to Join';
    }

    // Restore name from localStorage if previously entered
    const savedName = localStorage.getItem('wiser-guest-name');
    if (savedName && !nameInput.value) {
      nameInput.value = savedName;
    }

    // Focus the first empty field
    if (!nameInput.value) {
      nameInput.focus();
    } else if (!codeInput.value) {
      codeInput.focus();
    }

    const submitOnEnter = (e) => { if (e.key === 'Enter') this.join(); };
    nameInput.addEventListener('keydown', submitOnEnter);
    codeInput.addEventListener('keydown', submitOnEnter);

    // Warn before closing if there is an unsent recording
    window.addEventListener('beforeunload', (e) => {
      if (this.recordedBlob && !this._transferComplete) {
        e.preventDefault();
        e.returnValue = 'You have an unsent recording. Are you sure you want to leave?';
        return e.returnValue;
      }
    });

    // Check for a recovered recording from a previous session (IndexedDB)
    this._checkRecovery();
  },

  async _checkRecovery() {
    try {
      const blob = await this._loadFromIndexedDB();
      if (blob && blob.size > 1000) {
        console.log('[Guest] Found recovered recording in IndexedDB:', this.formatBytes(blob.size));
        this.recordedBlob = blob;
        document.getElementById('transferOverlay').classList.add('active');
        document.getElementById('transferTitle').textContent = 'Recovered recording found';
        document.getElementById('transferStatus').textContent =
          'A recording (' + this.formatBytes(blob.size) + ') was saved from a previous session.';
        document.getElementById('transferFill').style.width = '100%';
        this._showTransferActions(true, false);
      }
    } catch (err) {
      console.warn('[Guest] Recovery check failed:', err.message);
    }
  },

  // ================================================
  // JOIN FLOW (LiveKit)
  // ================================================

  setStep(text) {
    const el = document.getElementById('joinStep');
    if (text) {
      el.innerHTML = '<div class="spinner"></div>' + text;
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  },

  setError(message, helpText) {
    const el = document.getElementById('joinError');
    el.innerHTML = message + (helpText ? '<div class="join-error-help">' + helpText + '</div>' : '');
    this.setStep('');
  },

  setButtonLoading(loading) {
    const btn = document.getElementById('joinBtn');
    btn.classList.remove('btn-ready');
    if (loading) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Connecting...';
    } else {
      btn.disabled = false;
      btn.textContent = 'Join Session';
    }
  },

  // Pick the next token from the pool (wraps around)
  _nextToken() {
    if (this._tokenPool.length === 0) return null;
    this._tokenIndex = (this._tokenIndex + 1) % this._tokenPool.length;
    return this._tokenPool[this._tokenIndex];
  },

  async join() {
    const displayName = (document.getElementById('nameInput').value || '').trim();
    if (!displayName) {
      this.setError('Please enter your name.');
      document.getElementById('nameInput').focus();
      return;
    }

    const roomName = (document.getElementById('codeInput').value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!roomName) {
      this.setError('Please enter a room name.');
      document.getElementById('codeInput').focus();
      return;
    }

    // Save name for future visits
    try { localStorage.setItem('wiser-guest-name', displayName); } catch {}
    this._displayName = displayName;

    this.setButtonLoading(true);
    document.getElementById('joinError').innerHTML = '';
    this.sessionCode = roomName;

    try {
      // Step 1: Fetch token pool from KV
      this.setStep('Looking up meeting room...');
      const kvKey = 'wiser-room:' + roomName;
      const kvResp = await fetch(KV_URL + '?id=' + encodeURIComponent(KV_COLLECTION) + '&key=' + encodeURIComponent(kvKey));
      if (!kvResp.ok) throw { userMessage: 'Could not reach the meeting server.', helpText: 'Check your internet connection.' };
      const kvData = await kvResp.json();
      if (kvData.Status === 'No data found.' || !kvData.value) {
        throw { userMessage: 'No active meeting found for "' + roomName + '".', helpText: 'Check the room name or ask the host if the meeting has started.' };
      }
      const meetingData = typeof kvData.value === 'string' ? JSON.parse(kvData.value) : kvData.value;
      if (!meetingData.tokens || !meetingData.livekitUrl) {
        throw { userMessage: 'Invalid meeting data.', helpText: 'Ask the host to restart the meeting.' };
      }
      this._tokenPool = meetingData.tokens;
      this._livekitUrl = meetingData.livekitUrl;
      this._tokenIndex = Math.floor(Math.random() * this._tokenPool.length);

      // Step 2: Get camera/mic (requires user gesture on mobile)
      this.setStep('Requesting camera and microphone...');
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true
        });
      } catch (mediaErr) {
        const name = mediaErr.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          throw { userMessage: 'Camera and microphone access was denied.',
                  helpText: 'Open your browser settings and allow camera/microphone access for this site, then try again.' };
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          throw { userMessage: 'No camera or microphone found.',
                  helpText: 'Make sure your device has a camera and microphone, or connect an external one.' };
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          throw { userMessage: 'Camera or microphone is already in use.',
                  helpText: 'Close other apps that might be using your camera (FaceTime, Zoom, etc.) and try again.' };
        } else if (name === 'OverconstrainedError') {
          try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          } catch {
            throw { userMessage: 'Could not access camera.',
                    helpText: 'Your device camera may not support the required settings.' };
          }
        } else {
          throw { userMessage: 'Could not access camera or microphone.',
                  helpText: mediaErr.message || 'Check your browser permissions and try again.' };
        }
      }

      // Step 3: Connect to LiveKit room with a token from the pool
      await this._connectWithTokenRetry();

    } catch (err) {
      console.error('[Guest] Join error:', err);

      if (err.userMessage) {
        this.setError(err.userMessage, err.helpText);
      } else {
        this.setError(err.message || 'Something went wrong. Please try again.');
      }

      this.setButtonLoading(false);
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => t.stop());
        this.localStream = null;
      }
      if (this.room) {
        try { this.room.disconnect(); } catch {}
        this.room = null;
      }
    }
  },

  // Connect using the current token; retry with next token on identity collision
  async _connectWithTokenRetry() {
    const token = this._tokenPool[this._tokenIndex];
    this._tokenRetries++;

    this.setStep('Connecting to meeting...');
    const { Room, RoomEvent, DataPacket_Kind, Track } = LivekitClient;

    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    // Track subscriptions — per-participant containers
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const pName = participant.name || participant.identity;
      console.log('[Guest] Track subscribed:', track.kind, 'from', pName);
      const cell = this._ensureParticipantCell(participant.sid, pName);
      const element = track.attach();
      if (track.kind === 'video') {
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.objectFit = 'cover';
        element.dataset.trackSid = track.sid;
        cell.appendChild(element);
      } else if (track.kind === 'audio') {
        element.dataset.trackSid = track.sid;
        element.style.display = 'none';
        cell.appendChild(element);
        // Explicitly play audio — browsers block autoplay without user gesture
        const playPromise = element.play();
        if (playPromise) {
          playPromise.then(() => {
            console.log('[Guest] Remote audio playing OK from', pName);
          }).catch(err => {
            console.warn('[Guest] Remote audio play blocked:', err.message, '- retrying on next user gesture');
            // Retry on next user interaction (tap, click, etc.)
            const resumeAudio = () => {
              element.play().then(() => {
                console.log('[Guest] Remote audio resumed after user gesture');
              }).catch(err => console.warn('[capture-guest-page] audio resume after gesture:', err.message));
              document.removeEventListener('click', resumeAudio);
              document.removeEventListener('touchstart', resumeAudio);
            };
            document.addEventListener('click', resumeAudio, { once: true });
            document.addEventListener('touchstart', resumeAudio, { once: true });
            this.showStatus('Tap anywhere to enable audio', 'info');
          });
        }
      }
      this._updateGridLayout();
    });

    this.room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach(el => el.remove());
    });

    // Participant presence
    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      const pName = participant.name || participant.identity;
      console.log('[Guest] Participant connected:', pName);
      this._ensureParticipantCell(participant.sid, pName);
      this._updateGridLayout();
    });

    // Update display name when a participant sets their name after connecting
    this.room.on(RoomEvent.ParticipantNameChanged, (name, participant) => {
      const entry = this._participants.get(participant.sid);
      if (entry) {
        entry.identity = name || participant.identity;
        const label = entry.cell.querySelector('.video-label');
        if (label) label.textContent = entry.identity;
      }
    });

    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const pName = participant.name || participant.identity;
      console.log('[Guest] Participant disconnected:', pName);
      this._removeParticipantCell(participant.sid);
      this._updateGridLayout();
      this.showStatus(participant.identity + ' left the meeting.', 'info');
    });

    // Active speaker highlighting
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this._participants.forEach((entry) => {
        entry.cell.classList.remove('speaking');
      });
      for (const p of speakers) {
        const isLocal = this.room && this.room.localParticipant &&
          (p.sid === this.room.localParticipant.sid);
        const key = isLocal ? this._localSid : p.sid;
        const entry = this._participants.get(key);
        if (entry) {
          entry.cell.classList.add('speaking');
        }
      }
    });

    // Data messages (recording sync from host)
    this.room.on(RoomEvent.DataReceived, (data, participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(data));
        if (msg.type === 'recording-start') {
          this.startRecording(msg.timestamp);
        } else if (msg.type === 'recording-stop') {
          this.stopRecording();
        }
      } catch {}
    });

    this.room.on(RoomEvent.Disconnected, () => {
      console.log('[Guest] Disconnected from room');
      this.onDisconnected('disconnected');
    });

    // Attempt connection
    try {
      await this.room.connect(this._livekitUrl, token);
      console.log('[Guest] Connected to LiveKit room');
    } catch (connErr) {
      // Identity collision or other connection error — retry with next token
      const msg = (connErr.message || '').toLowerCase();
      if (this._tokenRetries < this.MAX_TOKEN_RETRIES && this._tokenPool.length > 1) {
        console.warn('[Guest] Connection failed, trying next token (' + this._tokenRetries + '/' + this.MAX_TOKEN_RETRIES + '):', msg);
        try { this.room.disconnect(); } catch {}
        this.room = null;
        this._nextToken();
        return this._connectWithTokenRetry();
      }
      throw connErr;
    }

    // Step 4: Publish existing local tracks to LiveKit
    // (reuse the getUserMedia stream from step 2 so recording and LiveKit share the same tracks
    //  — avoids a second getUserMedia call that can steal the camera on mobile)
    this.setStep('Publishing camera...');
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (videoTrack) {
        await this.room.localParticipant.publishTrack(videoTrack, {
          source: LivekitClient.Track.Source.Camera,
          name: 'camera',
        });
      }
      if (audioTrack) {
        await this.room.localParticipant.publishTrack(audioTrack, {
          source: LivekitClient.Track.Source.Microphone,
          name: 'microphone',
        });
      }
    } else {
      // Fallback if localStream was lost — let LiveKit request its own
      await this.room.localParticipant.enableCameraAndMicrophone();
    }

    this.onConnected();
  },

  // ================================================
  // CONNECTION LIFECYCLE
  // ================================================

  onConnected() {
    this.setStep('');
    this.setButtonLoading(false);
    document.getElementById('joinPanel').classList.add('hidden');
    document.getElementById('sessionView').classList.add('active');
    document.getElementById('badgeConnected').style.display = 'inline-block';

    // Re-layout on resize/orientation change (PiP mode depends on viewport width)
    if (!this._resizeListenerBound) {
      this._resizeListenerBound = true;
      window.addEventListener('resize', () => this._updateGridLayout());
    }

    // Update local SID and set display name in LiveKit
    if (this.room && this.room.localParticipant) {
      this._localSid = this.room.localParticipant.sid || this.room.localParticipant.identity || 'local';
      // Broadcast display name to all participants
      if (this._displayName) {
        try {
          this.room.localParticipant.setName(this._displayName);
          this.room.localParticipant.setMetadata(JSON.stringify({ displayName: this._displayName }));
        } catch (e) {
          console.warn('[Guest] Could not set participant name:', e);
        }
      }
    }

    // Create local participant cell with display name
    const localLabel = this._displayName ? (this._displayName + ' (You)') : 'You';
    const localCell = this._ensureParticipantCell(this._localSid, localLabel);
    if (this.localStream) {
      const localVideo = document.createElement('video');
      localVideo.autoplay = true;
      localVideo.muted = true;
      localVideo.playsInline = true;
      localVideo.style.width = '100%';
      localVideo.style.height = '100%';
      localVideo.style.objectFit = 'cover';
      localVideo.srcObject = this.localStream;
      localCell.insertBefore(localVideo, localCell.firstChild);
    }
    this._updateGridLayout();

    this.showStatus('Connected', 'success');
  },

  onDisconnected(state) {
    document.getElementById('badgeConnected').style.display = 'none';

    if (!document.getElementById('sessionView').classList.contains('active')) {
      // Still on join panel
      this.setStep('');
      this.setError(
        'Could not connect to the meeting.',
        'Check your internet connection and try again, or ask the host for a new link.'
      );
      this.setButtonLoading(false);
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => t.stop());
        this.localStream = null;
      }
    } else {
      // In session — check for unsent recording
      if (this.recordedBlob && !this._transferComplete) {
        document.getElementById('transferOverlay').classList.add('active');
        document.getElementById('transferTitle').textContent = 'Connection lost';
        document.getElementById('transferStatus').textContent =
          'Recording saved locally (' + this.formatBytes(this.recordedBlob.size) + '). Download it to keep it safe.';
        document.getElementById('transferFill').style.width = '100%';
        this._showTransferActions(true, false);
      }
      this.showStatus('Connection lost. The host may have ended the session.', 'error');
    }
  },

  // Send data via LiveKit data channel (reliable mode)
  sendData(data) {
    if (!this.room || !this.room.localParticipant) {
      throw new Error('Not connected to meeting');
    }
    const payload = (data instanceof ArrayBuffer || data instanceof Uint8Array)
      ? new Uint8Array(data)
      : new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
    this.room.localParticipant.publishData(payload, { reliable: true });
  },

  // ================================================
  // RECORDING (synced with host via LiveKit data channel)
  // ================================================

  startRecording(hostTimestamp) {
    if (this.isRecording || !this.localStream) return;

    const mixedStream = new MediaStream();
    this.localStream.getTracks().forEach(t => mixedStream.addTrack(t));

    this.recordedChunks = [];
    try {
      this.mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: 'video/webm;codecs=vp9,opus'
      });
    } catch {
      this.mediaRecorder = new MediaRecorder(mixedStream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      this.recordedBlob = new Blob(this.recordedChunks, { type: 'video/webm' });
      console.log('[Guest] Recording stopped, blob size:', this.formatBytes(this.recordedBlob.size));
      this.sendRecordingToHost();
    };

    this.mediaRecorder.start(1000);
    this.isRecording = true;
    this.recordingStartTime = Date.now();

    document.getElementById('recIndicator').classList.add('active');
    document.getElementById('badgeRecording').style.display = 'inline-block';

    this.durationInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      document.getElementById('duration').textContent = mm + ':' + ss;
    }, 500);
  },

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    clearInterval(this.durationInterval);

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    document.getElementById('recIndicator').classList.remove('active');
    document.getElementById('badgeRecording').style.display = 'none';
  },

  // ================================================
  // TRACK TRANSFER (send recording to host via LiveKit data channel)
  // ================================================

  async sendRecordingToHost() {
    if (!this.recordedBlob) {
      this.showStatus('No recording to send', 'error');
      return;
    }

    this._transferFailed = false;
    this._transferComplete = false;
    document.getElementById('transferOverlay').classList.add('active');
    document.getElementById('transferTitle').textContent = 'Saving recording...';
    document.getElementById('transferFill').style.width = '0%';
    document.getElementById('transferActions').style.display = 'none';
    document.getElementById('retryBtn').style.display = 'none';

    // 0. Persist to IndexedDB as safety net (survives page refresh)
    try {
      await this._saveToIndexedDB(this.recordedBlob);
      console.log('[Guest] Recording persisted to IndexedDB');
    } catch (dbErr) {
      console.warn('[Guest] IndexedDB save failed (continuing):', dbErr.message);
    }

    // If no LiveKit connection, show download immediately
    if (!this.room || !this.room.localParticipant) {
      document.getElementById('transferTitle').textContent = 'Host not connected';
      document.getElementById('transferStatus').textContent = 'Download your recording to save it.';
      this._showTransferActions(true, false);
      return;
    }

    document.getElementById('transferTitle').textContent = 'Sending recording to host...';

    try {
      const arrayBuffer = await this.recordedBlob.arrayBuffer();
      const totalBytes = arrayBuffer.byteLength;
      const totalChunks = Math.ceil(totalBytes / this.CHUNK_SIZE);

      // 1. Send metadata header
      this.sendData({
        type: 'track-transfer-start',
        totalChunks,
        totalBytes,
        mimeType: this.recordedBlob.type || 'video/webm',
        duration: this.recordingStartTime ? (Date.now() - this.recordingStartTime) / 1000 : 0,
        sessionCode: this.sessionCode,
        recordedAt: new Date().toISOString()
      });

      // 2. Send binary chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, totalBytes);
        const chunk = arrayBuffer.slice(start, end);

        this.sendData(chunk);

        // Small yield every 10 chunks to prevent flooding
        if (i % 10 === 9) {
          await new Promise(r => setTimeout(r, 10));
        }

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        document.getElementById('transferFill').style.width = pct + '%';
        document.getElementById('transferStatus').textContent =
          'Sending: ' + this.formatBytes(end) + ' / ' + this.formatBytes(totalBytes);
      }

      // 3. Send completion
      this.sendData({ type: 'track-transfer-complete' });

      this._transferComplete = true;
      document.getElementById('transferFill').style.width = '100%';
      document.getElementById('transferTitle').textContent = 'Transfer complete';
      document.getElementById('transferStatus').textContent = 'Recording sent to host.';
      this._showTransferActions(true, false);
      this.showStatus('Recording sent to host', 'success');

      // Clean up IndexedDB since transfer succeeded
      this._clearIndexedDB();

    } catch (err) {
      console.error('[Guest] Transfer error:', err);
      this._transferFailed = true;
      document.getElementById('transferTitle').textContent = 'Transfer failed';
      document.getElementById('transferStatus').textContent = err.message || 'Connection lost. Download your recording or retry.';
      this._showTransferActions(true, true);
    }
  },

  // Show/hide action buttons in transfer overlay
  _showTransferActions(showDownload, showRetry) {
    document.getElementById('transferActions').style.display = 'flex';
    document.getElementById('retryBtn').style.display = showRetry ? '' : 'none';
  },

  // Retry sending recording to host
  async retrySendRecording() {
    if (!this.recordedBlob) return;
    if (!this.room || !this.room.localParticipant) {
      this.showStatus('Not connected. Download your recording instead.', 'error');
      return;
    }
    await this.sendRecordingToHost();
  },

  // Download recording locally as a file
  downloadRecording() {
    const blob = this.recordedBlob;
    if (!blob) {
      this.showStatus('No recording available', 'error');
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = 'wiser-recording-' + (this._displayName || 'guest') + '-' + ts + '.webm';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.showStatus('Recording downloaded: ' + name, 'success');
  },

  // --- IndexedDB Persistence ---

  _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('wiser-recordings', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async _saveToIndexedDB(blob) {
    const db = await this._openIDB();
    const key = 'recording-' + Date.now();
    this._idbKey = key;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  },

  async _clearIndexedDB() {
    try {
      const db = await this._openIDB();
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').clear();
      tx.oncomplete = () => db.close();
    } catch {}
  },

  async _loadFromIndexedDB() {
    try {
      const db = await this._openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction('blobs', 'readonly');
        const store = tx.objectStore('blobs');
        const req = store.openCursor(null, 'prev'); // newest first
        req.onsuccess = () => {
          const cursor = req.result;
          db.close();
          if (cursor) {
            resolve(cursor.value); // Returns the Blob
          } else {
            resolve(null);
          }
        };
        req.onerror = () => { db.close(); resolve(null); };
      });
    } catch {
      return null;
    }
  },

  formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  },

  // ================================================
  // LEAVE
  // ================================================

  leave() {
    if (this.isRecording) this.stopRecording();

    // Clean up background processor
    this._bgProcessor = null;
    this._bgActive = false;

    // Clear token state
    this._tokenPool = [];
    this._livekitUrl = '';
    this._tokenIndex = -1;
    this._tokenRetries = 0;

    if (this.room) {
      try { this.room.disconnect(); } catch {}
      this.room = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Remove all participant cells
    this._participants.forEach((entry) => entry.cell.remove());
    this._participants.clear();

    // Remove any stray LiveKit-attached elements
    document.querySelectorAll('[data-track-sid]').forEach(el => el.remove());

    document.getElementById('sessionView').classList.remove('active');
    document.getElementById('joinPanel').classList.remove('hidden');
    document.getElementById('badgeConnected').style.display = 'none';
    document.getElementById('badgeRecording').style.display = 'none';
    this.setButtonLoading(false);
    this.setStep('');
    document.getElementById('joinError').innerHTML = '';

    const codeInput = document.getElementById('codeInput');
    codeInput.readOnly = false;
    codeInput.style.opacity = '1';

    this.showStatus('Left session', 'info');
  },

  // ================================================
  // UTILS
  // ================================================

  // ================================================
  // VIRTUAL BACKGROUND (blur toggle)
  // ================================================

  _bgProcessor: null,
  _bgActive: false,

  async toggleBlur() {
    if (!window._BgProcessor) {
      this.showStatus('Background effects not supported in this browser', 'error');
      return;
    }

    const btn = document.getElementById('blurBtn');
    this._bgActive = !this._bgActive;

    try {
      const camTrack = this._getLocalCameraTrack();
      if (!camTrack) return;

      if (this._bgActive) {
        if (this._bgProcessor) {
          await this._bgProcessor.switchTo({ mode: 'background-blur', blurRadius: 10 });
        } else {
          this._bgProcessor = window._BgProcessor({ mode: 'background-blur', blurRadius: 10 });
          await camTrack.setProcessor(this._bgProcessor);
        }
        btn.classList.add('active');
        btn.textContent = 'Blur On';
      } else {
        if (this._bgProcessor) {
          await camTrack.stopProcessor();
          this._bgProcessor = null;
        }
        btn.classList.remove('active');
        btn.textContent = 'Blur BG';
      }
    } catch (err) {
      console.error('[Guest] Blur toggle error:', err);
      this.showStatus('Background blur failed', 'error');
      this._bgActive = false;
      btn.classList.remove('active');
      btn.textContent = 'Blur BG';
    }
  },

  _getLocalCameraTrack() {
    if (!this.room || !this.room.localParticipant) return null;
    const camPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    return camPub && camPub.track ? camPub.track : null;
  },

  // ================================================
  // MIC / CAMERA CONTROLS
  // ================================================

  _micMuted: false,
  _camOff: false,

  toggleMic() {
    this._micMuted = !this._micMuted;
    const btn = document.getElementById('micBtn');
    const icon = document.getElementById('micIcon');

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = !this._micMuted; });
    }
    // Also mute/unmute the LiveKit published track
    if (this.room && this.room.localParticipant) {
      const micPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
      if (micPub && micPub.track) {
        if (this._micMuted) {
          micPub.mute();
        } else {
          micPub.unmute();
        }
      }
    }

    btn.classList.toggle('off', this._micMuted);
    if (this._micMuted) {
      icon.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    } else {
      icon.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    }
    this.showStatus(this._micMuted ? 'Microphone muted' : 'Microphone on', 'info');
  },

  toggleCamera() {
    this._camOff = !this._camOff;
    const btn = document.getElementById('camBtn');
    const icon = document.getElementById('camIcon');

    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(t => { t.enabled = !this._camOff; });
    }
    // Also mute/unmute the LiveKit published camera track
    if (this.room && this.room.localParticipant) {
      const camPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
      if (camPub && camPub.track) {
        if (this._camOff) {
          camPub.mute();
        } else {
          camPub.unmute();
        }
      }
    }

    btn.classList.toggle('off', this._camOff);
    if (this._camOff) {
      icon.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>';
    } else {
      icon.innerHTML = '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>';
    }
    this.showStatus(this._camOff ? 'Camera off' : 'Camera on', 'info');
  },

  // ================================================
  // DEVICE SELECTION (settings panel)
  // ================================================

  _devicePanelOpen: false,

  toggleDevicePanel() {
    this._devicePanelOpen = !this._devicePanelOpen;
    const panel = document.getElementById('devicePanel');
    const btn = document.getElementById('settingsBtn');
    panel.classList.toggle('visible', this._devicePanelOpen);
    btn.classList.toggle('off', this._devicePanelOpen);
    if (this._devicePanelOpen) {
      this._enumerateDevices();
    }
  },

  async _enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const micSelect = document.getElementById('micSelect');
      const camSelect = document.getElementById('camSelect');

      // Get current active device IDs
      const currentMicId = this.localStream
        ? (this.localStream.getAudioTracks()[0]?.getSettings()?.deviceId || '')
        : '';
      const currentCamId = this.localStream
        ? (this.localStream.getVideoTracks()[0]?.getSettings()?.deviceId || '')
        : '';

      // Populate mic dropdown
      micSelect.innerHTML = '';
      devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('Microphone ' + (i + 1));
        if (d.deviceId === currentMicId) opt.selected = true;
        micSelect.appendChild(opt);
      });

      // Populate camera dropdown
      camSelect.innerHTML = '';
      devices.filter(d => d.kind === 'videoinput').forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('Camera ' + (i + 1));
        if (d.deviceId === currentCamId) opt.selected = true;
        camSelect.appendChild(opt);
      });
    } catch (err) {
      console.error('[Guest] Device enumeration failed:', err);
    }
  },

  async switchMic(deviceId) {
    if (!deviceId || !this.room) return;
    try {
      // Get new audio stream with selected device
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } }
      });
      const newAudioTrack = newStream.getAudioTracks()[0];
      if (!newAudioTrack) return;

      // Replace in localStream
      if (this.localStream) {
        const oldTrack = this.localStream.getAudioTracks()[0];
        if (oldTrack) {
          this.localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        this.localStream.addTrack(newAudioTrack);
      }

      // Republish to LiveKit
      const micPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
      if (micPub && micPub.track) {
        await this.room.localParticipant.unpublishTrack(micPub.track);
      }
      await this.room.localParticipant.publishTrack(newAudioTrack, {
        source: LivekitClient.Track.Source.Microphone,
        name: 'microphone',
      });

      // Respect current mute state
      if (this._micMuted) {
        newAudioTrack.enabled = false;
        const newPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        if (newPub) newPub.mute();
      }

      this.showStatus('Microphone switched', 'success');
    } catch (err) {
      console.error('[Guest] Mic switch failed:', err);
      this.showStatus('Failed to switch microphone', 'error');
    }
  },

  async switchCamera(deviceId) {
    if (!deviceId || !this.room) return;
    try {
      // Get new video stream with selected device
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) return;

      // Replace in localStream
      if (this.localStream) {
        const oldTrack = this.localStream.getVideoTracks()[0];
        if (oldTrack) {
          this.localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        this.localStream.addTrack(newVideoTrack);
      }

      // Republish to LiveKit
      const camPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
      if (camPub && camPub.track) {
        // Remove blur processor before unpublishing
        if (this._bgActive && this._bgProcessor) {
          try { await camPub.track.stopProcessor(); } catch {}
          this._bgProcessor = null;
          this._bgActive = false;
          const blurBtn = document.getElementById('blurBtn');
          if (blurBtn) { blurBtn.classList.remove('active'); blurBtn.textContent = 'Blur BG'; }
        }
        await this.room.localParticipant.unpublishTrack(camPub.track);
      }
      await this.room.localParticipant.publishTrack(newVideoTrack, {
        source: LivekitClient.Track.Source.Camera,
        name: 'camera',
      });

      // Update local video preview
      const localEntry = this._participants.get(this._localSid);
      if (localEntry) {
        const localVideo = localEntry.cell.querySelector('video');
        if (localVideo) {
          localVideo.srcObject = this.localStream;
        }
      }

      // Respect current camera off state
      if (this._camOff) {
        newVideoTrack.enabled = false;
        const newPub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        if (newPub) newPub.mute();
      }

      this.showStatus('Camera switched', 'success');
    } catch (err) {
      console.error('[Guest] Camera switch failed:', err);
      this.showStatus('Failed to switch camera', 'error');
    }
  },

  // ================================================
  // MULTI-PARTICIPANT HELPERS
  // ================================================

  _ensureParticipantCell(sid, identity) {
    if (this._participants.has(sid)) {
      return this._participants.get(sid).cell;
    }

    const cell = document.createElement('div');
    cell.className = 'video-cell';
    cell.dataset.sid = sid;

    const label = document.createElement('div');
    label.className = 'video-label' + (sid !== this._localSid ? ' remote' : '');
    label.textContent = identity || 'Participant';
    cell.appendChild(label);

    document.getElementById('videoGrid').appendChild(cell);
    this._participants.set(sid, { cell, identity: identity || 'Participant' });

    return cell;
  },

  _removeParticipantCell(sid) {
    const entry = this._participants.get(sid);
    if (!entry) return;
    entry.cell.remove();
    this._participants.delete(sid);
  },

  _updateGridLayout() {
    const grid = document.getElementById('videoGrid');
    const count = this._participants.size;
    const isMobile = window.innerWidth <= 600;

    // Remove old grid-N and pip-mode classes
    grid.className = 'video-grid';

    // Remove pip-self from all cells
    this._participants.forEach((entry) => {
      entry.cell.classList.remove('pip-self');
      entry.cell.style.removeProperty('bottom');
      entry.cell.style.removeProperty('right');
    });

    // Mobile + 2 participants: use PiP mode (remote full-screen, self as small overlay)
    if (isMobile && count === 2) {
      grid.classList.add('pip-mode');
      const localEntry = this._participants.get(this._localSid);
      if (localEntry) {
        localEntry.cell.classList.add('pip-self');
        this._enablePipDrag(localEntry.cell);
      }
      return;
    }

    if (count >= 2 && count <= 6) {
      grid.classList.add('grid-' + count);
    }
  },

  // Touch-draggable PiP self-view
  _pipDragBound: false,
  _enablePipDrag(cell) {
    if (this._pipDragBound) return;
    this._pipDragBound = true;

    let startX, startY, origX, origY;

    cell.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const rect = cell.getBoundingClientRect();
      startX = touch.clientX;
      startY = touch.clientY;
      origX = rect.left;
      origY = rect.top;
      cell.style.transition = 'none';
    }, { passive: true });

    cell.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const newX = origX + dx;
      const newY = origY + dy;

      // Constrain to viewport
      const maxX = window.innerWidth - cell.offsetWidth;
      const maxY = window.innerHeight - cell.offsetHeight;
      const clampedX = Math.max(0, Math.min(newX, maxX));
      const clampedY = Math.max(0, Math.min(newY, maxY));

      cell.style.position = 'fixed';
      cell.style.left = clampedX + 'px';
      cell.style.top = clampedY + 'px';
      cell.style.right = 'auto';
      cell.style.bottom = 'auto';
    }, { passive: false });

    cell.addEventListener('touchend', () => {
      cell.style.transition = '';
    }, { passive: true });
  },

  showStatus(message, type) {
    const el = document.getElementById('statusToast');
    el.textContent = message;
    el.className = 'status-toast visible ' + (type || '');
    clearTimeout(this._statusTimeout);
    this._statusTimeout = setTimeout(() => {
      el.classList.remove('visible');
    }, 3000);
  }
};

document.addEventListener('DOMContentLoaded', () => guest.init());
</script>
</body>
</html>`;
}

module.exports = { buildGuestPageHTML, GUEST_PAGE_VERSION };
