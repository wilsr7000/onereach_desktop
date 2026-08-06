/**
 * Capture Guest Page
 *
 * Builds a permanent, self-contained HTML page for joining WISER Meetings.
 * Published once to GSX Files — the URL never changes.
 *
 * At join time, the page fetches the token pool from GSX KeyValue
 * using the room name. The host stores tokens there when creating a meeting.
 *
 * The KV endpoint accepts unauthenticated writes, so the page never
 * trusts raw KV data: the host signs the stored payload (ECDSA P-256)
 * and the join link carries the public verify key in its fragment
 * (#k=...). Only payloads that verify are used; links without a key
 * cannot join at all.
 *
 * Supports ?room=xyz query param to pre-fill the room name.
 *
 * @param {Object} [options]
 * @param {string} [options.kvUrl] - GSX KeyValue API endpoint URL
 */

// Bump this version whenever the guest page code changes to force re-publish
const GUEST_PAGE_VERSION = 14;

function buildGuestPageHTML(options = {}) {
  const kvUrl = options.kvUrl || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0d0d0d">
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
    /* Multiple simultaneous screen shares stack vertically on phones so each
       stays legible at full width instead of shrinking to side-by-side
       slivers. A single share is unaffected (it already fills the area). */
    .screen-share-area {
      flex-direction: column;
    }

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

    /* Controls bar: wrap on narrow screens */
    .controls-bar {
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px;
    }

    .controls-bar button {
      min-width: 44px;
      min-height: 44px;
    }

    /* Screen share container: compact */
    .screen-share-container {
      border-radius: 6px;
    }

    .screen-share-label {
      font-size: 10px;
    }
  }

  /* Theme color for mobile browser chrome */
  @supports (padding: env(safe-area-inset-bottom)) {
    .controls-bar {
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
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

  .video-cell video[data-screen-share] {
    object-fit: contain;
    background: #000;
  }

  /* Screen share area: one container per active share, split evenly */
  .screen-share-area {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 4px;
    padding: 4px 4px 0 4px;
  }

  /* Dedicated screen share container */
  .screen-share-container {
    position: relative;
    width: 100%;
    flex: 1;
    background: #000;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }

  .screen-share-label {
    position: absolute;
    top: 8px;
    left: 10px;
    max-width: calc(100% - 20px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 500;
    color: var(--text);
    background: rgba(0, 0, 0, 0.72);
    padding: 3px 8px;
    border-radius: 6px;
    pointer-events: none;
  }

  /* Presentation mode: the participant grid collapses into a short, centered
     strip of thumbnails below the screen share(s). Flex (not an auto-fill
     grid) so a couple of tiles sit centered instead of clinging to the left
     with a large empty gap; tiles shrink rather than overflow when many. */
  .video-grid.presentation-mode {
    flex: 0 0 120px;
    height: 120px;
    display: flex;
    justify-content: center;
    align-items: stretch;
    gap: 8px;
  }

  .video-grid.presentation-mode .video-cell {
    flex: 0 1 160px;
    min-width: 0;
    height: 100%;
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
    max-width: calc(100% - 16px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    z-index: 2;
  }

  .video-label.remote {
    color: var(--accent);
  }

  /* Mute / camera-off indicators on participant cells */
  .mic-off-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: var(--accent-red);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
  }

  .mic-off-badge svg { width: 14px; height: 14px; }

  .cam-off-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-elevated);
    color: var(--text-muted);
    z-index: 1;
  }

  .cam-off-placeholder svg { width: 36px; height: 36px; opacity: 0.7; }

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

  .ctrl-btn.active {
    background: rgba(77, 124, 255, 0.15);
    border-color: rgba(77, 124, 255, 0.3);
    color: var(--accent);
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
  .status-toast.info { border-color: var(--accent); color: var(--accent); }

  /* Reconnecting banner */
  .reconnect-banner {
    display: none;
    text-align: center;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(255, 170, 60, 0.12);
    color: #ffb340;
    border-bottom: 1px solid rgba(255, 170, 60, 0.3);
    flex-shrink: 0;
  }

  .reconnect-banner.visible { display: block; }

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
  /* Blur is one of the circular icon controls (it inherits .ctrl-btn); it
     just stays hidden until background effects are detected as supported. */
  .blur-btn {
    display: none;
  }

  .blur-btn.supported { display: flex; }

  /* Leave matches the control row's height so the bar reads as one set. */
  .leave-btn {
    padding: 0 18px;
    height: 44px;
    display: flex;
    align-items: center;
  }

  .blur-btn.active {
    background: rgba(77, 124, 255, 0.15);
    border-color: rgba(77, 124, 255, 0.3);
    color: #4d7cff;
  }

  .blur-btn:hover { filter: brightness(1.1); }
</style>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2.17.1/dist/livekit-client.umd.min.js"><\/script>
<script type="module">
  import { BackgroundProcessor, supportsBackgroundProcessors } from 'https://esm.run/@livekit/track-processors@0.7.0';
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

  <!-- Reconnecting banner (shown while LiveKit attempts to resume) -->
  <div class="reconnect-banner" id="reconnectBanner">Reconnecting...</div>

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
      <button class="btn btn-danger" id="cancelJoinBtn" onclick="guest.cancelJoin()" style="display:none">Cancel</button>
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
      <button class="ctrl-btn" id="shareBtn" onclick="guest.toggleScreenShare()" title="Share Screen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </button>
      <button class="ctrl-btn" id="settingsBtn" onclick="guest.toggleDevicePanel()" title="Audio/Video Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <div class="ctrl-sep"></div>
      <button class="ctrl-btn blur-btn" id="blurBtn" onclick="guest.toggleBlur()" title="Blur background">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="8" r="3.5"/>
          <path d="M5.5 19a6.5 6.5 0 0 1 13 0"/>
          <path d="M2.5 12.5h2M19.5 12.5h2M3.5 16h1.5M19 16h1.5" opacity="0.55"/>
        </svg>
      </button>
      <button class="btn btn-danger leave-btn" id="leaveBtn" onclick="guest.leave()">Leave</button>
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
        <button class="btn btn-retry" id="continueBtn" onclick="guest.dismissTransferOverlay()" style="display:none">Continue</button>
        <button class="btn btn-retry" id="discardBtn" onclick="guest.discardRecoveredRecording()" style="display:none">Discard</button>
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
  CHUNK_SIZE: 15000,  // stay under the ~15 KiB LiveKit reliable data packet limit
  MAX_TOKEN_RETRIES: 5,

  // State
  room: null,          // LiveKit Room instance
  localStream: null,   // getUserMedia stream (for MediaRecorder)
  mediaRecorder: null,
  _mixedStream: null,  // MediaStream feeding the recorder (tracks swapped on device switch)
  recordedChunks: [],
  recordedBlob: null,
  isRecording: false,
  recordingStartTime: null,
  durationInterval: null,
  sessionCode: null,
  _intentionalLeave: false,  // true while leave() is disconnecting on purpose
  _displayName: '',    // Guest's display name
  _tokenPool: [],      // Fetched from KV at join time
  _livekitUrl: '',     // Fetched from KV at join time
  _tokenIndex: -1,     // Current index in pool
  _tokenRetries: 0,    // How many tokens we've tried
  _joinKey: '',        // Public verify key from the link fragment (#k=...)

  // Transfer resilience
  _transferFailed: false,        // True if last transfer failed
  _transferComplete: false,      // True if transfer succeeded
  _idbKey: null,                 // IndexedDB key for persisted blob

  // Multi-participant state
  _participants: new Map(),       // sid -> { cell, identity }
  _localSid: 'local',            // key for own tile
  _screenShares: new Map(),       // track.sid -> screen share container element
  _screenShareArea: null,         // flex row that holds all active share containers

  // ================================================
  // INIT
  // ================================================

  init() {
    const nameInput = document.getElementById('nameInput');
    const codeInput = document.getElementById('codeInput');
    const joinBtn = document.getElementById('joinBtn');

    // The screen-share button is always shown so its availability matches the
    // in-app host UI. Browsers that can't capture a screen (mobile, some
    // embedded webviews) surface a clear "not supported" message on tap —
    // toggleScreenShare() guards on getDisplayMedia at click time.

    if (!KV_URL) {
      codeInput.style.display = 'none';
      nameInput.style.display = 'none';
      joinBtn.style.display = 'none';
      document.getElementById('joinError').innerHTML =
        'This page is not configured.<div class="join-error-help">Ask the host to share a valid meeting link.</div>';
      return;
    }

    // The link fragment carries the host's public verify key. Without it
    // the page cannot authenticate the meeting data it fetches (KV writes
    // are unauthenticated), so joining is disabled outright.
    this._joinKey = this._parseJoinKeyFromHash();
    if (!this._joinKey) {
      codeInput.style.display = 'none';
      nameInput.style.display = 'none';
      joinBtn.style.display = 'none';
      document.getElementById('joinError').innerHTML =
        'This meeting link is incomplete or from an older version.<div class="join-error-help">Ask the host to copy a fresh link from WISER Meeting and share it again.</div>';
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
        this._showTransferActions(true, false, false, true);
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
      btn.textContent = 'Join Meeting';
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
    this._joinCancelled = false;
    this._setCancelVisible(true);

    try {
      // Step 0: Import the link's verify key. Without a working key no KV
      // payload can be trusted, so fail fast with a clear message.
      let verifyKey;
      try {
        verifyKey = await crypto.subtle.importKey(
          'raw', this._b64uToBytes(this._joinKey),
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
        );
      } catch (keyErr) {
        throw { userMessage: 'This meeting link is damaged.',
                helpText: 'Ask the host to copy a fresh link from WISER Meeting and share it again.' };
      }

      // Step 1: Fetch token pool from KV (with waiting-for-host polling)
      this.setStep('Looking up meeting room...');
      const kvKey = 'wiser-room:' + roomName;
      const meetingData = await this._fetchTokensWithWait(kvKey, roomName, verifyKey);
      this._setCancelVisible(false);
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
      this._setCancelVisible(false);
      this._waitingForHost = false;

      if (err && err.cancelled) {
        // User cancelled while waiting for the host — restore the join form quietly
        console.log('[Guest] Join cancelled by user');
        this.setStep('');
        this.setButtonLoading(false);
        if (this.localStream) {
          this.localStream.getTracks().forEach(t => t.stop());
          this.localStream = null;
        }
        return;
      }

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

  // Fetch tokens from KV, polling every few seconds if the host hasn't started yet
  _waitingForHost: false,
  _joinCancelled: false,

  // Cancel a join attempt while waiting for the host (checked each poll iteration)
  cancelJoin() {
    this._joinCancelled = true;
    this.setStep('Cancelling...');
  },

  _setCancelVisible(visible) {
    const btn = document.getElementById('cancelJoinBtn');
    if (btn) btn.style.display = visible ? '' : 'none';
  },

  _showWaitingStep() {
    if (!this._waitingForHost) {
      this._waitingForHost = true;
      this.setStep('Waiting for the host to start this meeting...');
    }
  },

  async _fetchTokensWithWait(kvKey, roomName, verifyKey) {
    const MAX_WAIT_POLLS = 60;
    const POLL_INTERVAL_MS = 5000;
    const MAX_CONSECUTIVE_ERRORS = 4;
    let consecutiveErrors = 0;

    for (let attempt = 0; attempt < MAX_WAIT_POLLS; attempt++) {
      if (this._joinCancelled) {
        throw { cancelled: true };
      }
      try {
        const kvResp = await fetch(KV_URL + '?id=' + encodeURIComponent(KV_COLLECTION) + '&key=' + encodeURIComponent(kvKey));
        if (!kvResp.ok) {
          throw new Error('Meeting server returned ' + kvResp.status);
        }
        const kvData = await kvResp.json();
        consecutiveErrors = 0;

        if (kvData.Status === 'No data found.' || !kvData.value) {
          this._showWaitingStep();
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        const parsed = typeof kvData.value === 'string' ? JSON.parse(kvData.value) : kvData.value;

        // Only a correctly signed v2 payload is trusted: KV writes are
        // unauthenticated, so anything unsigned, mis-signed, for another
        // room, or expired reads as "no active meeting" and we keep
        // polling. Tampering can't redirect a join -- at worst it delays
        // one until the host's genuine write lands.
        const meetingData = await this._verifySignedPayload(parsed, roomName, verifyKey);
        if (!meetingData) {
          this._showWaitingStep();
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        this._waitingForHost = false;
        return meetingData;
      } catch (err) {
        if (err && (err.userMessage || err.cancelled)) throw err;
        // Transient failure (network blip, 5xx): keep polling and only give
        // up after several consecutive errors
        consecutiveErrors++;
        console.warn('[Guest] Meeting lookup failed (' + consecutiveErrors + '/' + MAX_CONSECUTIVE_ERRORS + '):', (err && err.message) || err);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw { userMessage: 'Could not reach the meeting server.', helpText: 'Check your internet connection.' };
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
    }

    this._waitingForHost = false;
    throw { userMessage: 'The host has not started this meeting yet.', helpText: 'Try again later or ask the host to start the meeting. If they say it is running, ask them for a fresh link.' };
  },

  // Pull the verify key out of the URL fragment (#k=...). The fragment
  // never reaches servers or proxy logs, unlike query params.
  _parseJoinKeyFromHash() {
    const m = /(?:^|[#&])k=([A-Za-z0-9_-]+)/.exec(window.location.hash || '');
    return m ? m[1] : '';
  },

  _b64uToBytes(s) {
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  },

  // Verify a stored meeting payload against the link's public key.
  // Returns the parsed payload, or null when it must not be trusted
  // (callers treat null exactly like "no meeting stored yet").
  async _verifySignedPayload(raw, roomName, verifyKey) {
    if (!raw || raw.v !== 2 || typeof raw.payload !== 'string' || typeof raw.sig !== 'string') {
      if (raw) console.warn('[Guest] Ignoring unsigned/legacy meeting payload');
      return null;
    }
    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, verifyKey,
        this._b64uToBytes(raw.sig), new TextEncoder().encode(raw.payload)
      );
    } catch (verifyErr) {
      ok = false;
    }
    if (!ok) {
      console.warn('[Guest] Meeting payload failed signature verification');
      return null;
    }
    let data;
    try {
      data = JSON.parse(raw.payload);
    } catch {
      return null;
    }
    if (data.roomName !== roomName) {
      console.warn('[Guest] Verified payload is for a different room');
      return null;
    }
    if (!Array.isArray(data.tokens) || data.tokens.length === 0) return null;
    // No regex here: an escaped slash inside this template literal would
    // be emitted un-escaped and break the served script (see the
    // template-literal hazard tests).
    if (typeof data.livekitUrl !== 'string' || data.livekitUrl.slice(0, 6) !== 'wss://') return null;
    if (typeof data.expiresAt === 'number' && Date.now() > data.expiresAt) {
      console.warn('[Guest] Meeting payload expired');
      return null;
    }
    return data;
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
    this._intentionalLeave = false;

    // Track subscriptions — per-participant containers
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const pName = participant.name || participant.identity;
      const isScreenShare = publication.source === Track.Source.ScreenShare;
      console.log('[Guest] Track subscribed:', track.kind, isScreenShare ? '(screen share)' : '', 'from', pName);
      const element = track.attach();

      if (track.kind === 'video' && isScreenShare) {
        this._showScreenShare(element, track.sid, pName);
      } else if (track.kind === 'video') {
        const cell = this._ensureParticipantCell(participant.sid, pName);
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.objectFit = 'cover';
        element.dataset.trackSid = track.sid;
        cell.appendChild(element);
      } else if (track.kind === 'audio') {
        const cell = this._ensureParticipantCell(participant.sid, pName);
        element.dataset.trackSid = track.sid;
        element.style.display = 'none';
        cell.appendChild(element);
        const playPromise = element.play();
        if (playPromise) {
          playPromise.then(() => {
            console.log('[Guest] Remote audio playing OK from', pName);
          }).catch(err => {
            console.warn('[Guest] Remote audio play blocked:', err.message, '- retrying on next user gesture');
            const resumeAudio = () => {
              this.hideStatus();
              element.play().then(() => {
                console.log('[Guest] Remote audio resumed after user gesture');
              }).catch(err => console.warn('[capture-guest-page] audio resume after gesture:', err.message));
              document.removeEventListener('click', resumeAudio);
              document.removeEventListener('touchstart', resumeAudio);
            };
            document.addEventListener('click', resumeAudio, { once: true });
            document.addEventListener('touchstart', resumeAudio, { once: true });
            // Persistent until the first tap (resumeAudio hides it)
            this.showStatus('Tap anywhere to enable audio', 'info', true);
          });
        }
      }
      // Reflect mute state that existed before we subscribed
      if (publication.isMuted && !isScreenShare) {
        this._setTrackMutedUI(publication, participant, true);
      }
      this._updateGridLayout();
    });

    this.room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      const isScreenShare = publication.source === Track.Source.ScreenShare;
      track.detach().forEach(el => el.remove());
      if (isScreenShare) {
        // Only remove the container for this share — others stay up
        this._hideScreenShare(track.sid);
      }
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

    // Mute/camera-off indication on participant cells
    this.room.on(RoomEvent.TrackMuted, (publication, participant) => {
      this._setTrackMutedUI(publication, participant, true);
    });

    this.room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      this._setTrackMutedUI(publication, participant, false);
    });

    // Data messages (recording sync + overlays from host).
    // These are control messages — only honor them from the host identity.
    this.room.on(RoomEvent.DataReceived, (data, participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(data));
        if (msg.type === 'recording-start' || msg.type === 'recording-stop' ||
            msg.type === 'meeting-overlay' || msg.type === 'ai-assist-active') {
          if (!participant || participant.identity !== 'host') {
            console.warn('[Guest] Ignoring control message from non-host:', msg.type);
            return;
          }
        }
        if (msg.type === 'recording-start') {
          this.startRecording(msg.timestamp);
        } else if (msg.type === 'recording-stop') {
          this.stopRecording();
        } else if (msg.type === 'meeting-overlay') {
          this._showOverlay(msg.overlay);
        } else if (msg.type === 'ai-assist-active') {
          this._setAiAssist(msg.active);
        }
      } catch {}
    });

    this.room.on(RoomEvent.Reconnecting, () => {
      console.log('[Guest] Connection interrupted, reconnecting...');
      document.getElementById('reconnectBanner').classList.add('visible');
    });

    this.room.on(RoomEvent.Reconnected, () => {
      console.log('[Guest] Reconnected to room');
      document.getElementById('reconnectBanner').classList.remove('visible');
      this.showStatus('Connection restored', 'success');
    });

    this.room.on(RoomEvent.Disconnected, () => {
      console.log('[Guest] Disconnected from room');
      document.getElementById('reconnectBanner').classList.remove('visible');
      if (this._intentionalLeave) {
        this._intentionalLeave = false;
        return;
      }
      // Terminal disconnect mid-recording: stop the recorder so the
      // save-locally path runs instead of recording into the void
      if (this.isRecording) {
        this.stopRecording();
      }
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
      if (/expired|invalid token|unauthorized|401|permission denied/.test(msg)) {
        throw { userMessage: 'This meeting link has expired — ask the host to start the meeting again.' };
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
      // Broadcast display name to all participants.
      // setName and setMetadata are split so a permission failure on one
      // (e.g. missing canUpdateOwnMetadata grant) doesn't mask the other.
      if (this._displayName) {
        try {
          this.room.localParticipant.setName(this._displayName);
        } catch (e) {
          console.warn('[Guest] setName failed:', (e && e.message) || e);
        }
        try {
          this.room.localParticipant.setMetadata(JSON.stringify({ displayName: this._displayName }));
        } catch (e) {
          console.warn('[Guest] setMetadata failed (check canUpdateOwnMetadata grant):', (e && e.message) || e);
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
    // Kept so device switches mid-recording can swap tracks in the recorded stream
    this._mixedStream = mixedStream;

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
    this._mixedStream = null;

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
      this._showTransferActions(true, false, true, false);
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
  _showTransferActions(showDownload, showRetry, showContinue, showDiscard) {
    document.getElementById('transferActions').style.display = 'flex';
    document.getElementById('retryBtn').style.display = showRetry ? '' : 'none';
    document.getElementById('continueBtn').style.display = showContinue ? '' : 'none';
    document.getElementById('discardBtn').style.display = showDiscard ? '' : 'none';
  },

  // Dismiss the transfer overlay (e.g. after a completed transfer — the
  // meeting may still be running underneath)
  dismissTransferOverlay() {
    document.getElementById('transferOverlay').classList.remove('active');
  },

  // Discard a recording recovered from a previous session
  async discardRecoveredRecording() {
    try { await this._clearIndexedDB(); } catch {}
    this.recordedBlob = null;
    this._idbKey = null;
    document.getElementById('transferOverlay').classList.remove('active');
    this.showStatus('Recovered recording discarded', 'info');
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

    // Stop any active local screen share
    if (this._screenStream) {
      this._screenStream.getTracks().forEach(t => t.stop());
      this._screenStream = null;
    }
    this._screenSharing = false;
    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.classList.remove('active');

    if (this.room) {
      // Suppress the Disconnected-handler error UI for this on-purpose leave
      this._intentionalLeave = true;
      try { this.room.disconnect(); } catch {}
      this.room = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Remove all screen share containers
    this._hideScreenShare();

    // Remove all participant cells
    this._participants.forEach((entry) => entry.cell.remove());
    this._participants.clear();

    // PiP drag listeners died with their cell — allow a rebind on rejoin
    this._pipDragBound = false;
    this._pipDragCell = null;

    // Clear overlays, their timers, and the AI-assist indicator
    this._overlayTimers.forEach((timer) => clearTimeout(timer));
    this._overlayTimers.clear();
    const overlayStack = document.getElementById('guestOverlayStack');
    if (overlayStack) overlayStack.remove();
    this._setAiAssist(false);

    // Remove any stray LiveKit-attached elements
    document.querySelectorAll('[data-track-sid]').forEach(el => el.remove());

    document.getElementById('sessionView').classList.remove('active');
    document.getElementById('joinPanel').classList.remove('hidden');
    document.getElementById('badgeConnected').style.display = 'none';
    document.getElementById('badgeRecording').style.display = 'none';
    document.getElementById('reconnectBanner').classList.remove('visible');
    document.getElementById('duration').textContent = '00:00';
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
        btn.title = 'Background blur on';
      } else {
        if (this._bgProcessor) {
          await camTrack.stopProcessor();
          this._bgProcessor = null;
        }
        btn.classList.remove('active');
        btn.title = 'Blur background';
      }
    } catch (err) {
      console.error('[Guest] Blur toggle error:', err);
      this.showStatus('Background blur failed', 'error');
      this._bgActive = false;
      btn.classList.remove('active');
      btn.title = 'Blur background';
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
    // "Panel open" is a selected state, not a problem state — use the blue
    // .active treatment (like screen share), not the red .off used for
    // muted mic / camera off.
    btn.classList.toggle('active', this._devicePanelOpen);
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

      // Replace in localStream (and in the live recording mix, if any)
      if (this.localStream) {
        const oldTrack = this.localStream.getAudioTracks()[0];
        if (oldTrack) {
          if (this.isRecording && this._mixedStream) {
            this._mixedStream.removeTrack(oldTrack);
          }
          this.localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        this.localStream.addTrack(newAudioTrack);
        if (this.isRecording && this._mixedStream) {
          this._mixedStream.addTrack(newAudioTrack);
        }
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

      // Replace in localStream (and in the live recording mix, if any)
      if (this.localStream) {
        const oldTrack = this.localStream.getVideoTracks()[0];
        if (oldTrack) {
          if (this.isRecording && this._mixedStream) {
            this._mixedStream.removeTrack(oldTrack);
          }
          this.localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        this.localStream.addTrack(newVideoTrack);
        if (this.isRecording && this._mixedStream) {
          this._mixedStream.addTrack(newVideoTrack);
        }
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
          if (blurBtn) { blurBtn.classList.remove('active'); blurBtn.title = 'Blur background'; }
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
  // SCREEN SHARING (desktop browsers only)
  // ================================================

  _screenStream: null,
  _screenSharing: false,

  async toggleScreenShare() {
    if (this._screenSharing) {
      await this._stopScreenShare();
      return;
    }
    if (!this.room || !this.room.localParticipant) {
      this.showStatus('Join the meeting before sharing your screen', 'error');
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      this.showStatus('Screen sharing is not supported in this browser', 'error');
      return;
    }
    const startedAt = Date.now();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      this._screenStream = stream;
      await this.room.localParticipant.publishTrack(track, {
        source: LivekitClient.Track.Source.ScreenShare,
        name: 'screen',
      });
      // Fires when the user clicks the browser-level "Stop sharing" button
      track.onended = () => {
        this._stopScreenShare().catch(err => console.warn('[Guest] Screen share cleanup:', err.message));
      };
      this._screenSharing = true;
      const btn = document.getElementById('shareBtn');
      if (btn) btn.classList.add('active');

      // Show our own share in the share area, keyed 'local'
      const el = document.createElement('video');
      el.autoplay = true;
      el.muted = true;
      el.playsInline = true;
      el.srcObject = stream;
      this._showScreenShare(el, 'local', this._displayName || 'You');
      this.showStatus('Screen sharing started', 'info');
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        // NotAllowedError covers two very different situations:
        //  1. the user saw the browser picker and dismissed it (leave silent), or
        //  2. macOS blocked capture before any picker appeared because the
        //     browser lacks the Screen Recording grant.
        // Case 2 rejects almost instantly (no picker is ever drawn), while a
        // genuine dismissal requires the user to see and click the picker, so
        // it takes much longer. Use that timing gap to surface a recovery hint
        // only on macOS and only when the OS most likely blocked it -- this
        // avoids parsing browser-specific error strings.
        const rejectedInstantly = Date.now() - startedAt < 500;
        if (this._isMac() && rejectedInstantly) {
          this.showStatus(
            'macOS blocked screen sharing. Open System Settings > Privacy and Security > Screen Recording, turn on your browser, then click Share again.',
            'error',
            true
          );
        }
        return;
      }
      console.error('[Guest] Screen share failed:', err);
      this.showStatus('Screen share failed', 'error');
    }
  },

  // True when running on macOS, where the browser needs a Screen Recording
  // grant in System Settings before getDisplayMedia can capture anything.
  _isMac() {
    const plat = (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform || navigator.userAgent || '';
    return plat.toLowerCase().indexOf('mac') !== -1;
  },

  async _stopScreenShare() {
    if (!this._screenSharing && !this._screenStream) return;
    this._screenSharing = false;
    const btn = document.getElementById('shareBtn');
    if (btn) btn.classList.remove('active');
    if (this.room && this.room.localParticipant) {
      const pub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
      if (pub && pub.track) {
        try { await this.room.localParticipant.unpublishTrack(pub.track); } catch {}
      }
    }
    if (this._screenStream) {
      this._screenStream.getTracks().forEach(t => t.stop());
      this._screenStream = null;
    }
    this._hideScreenShare('local');
    this.showStatus('Screen sharing stopped', 'info');
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

  _showScreenShare(videoElement, trackSid, participantName) {
    // Replace any existing container for this same share
    this._hideScreenShare(trackSid);

    let area = this._screenShareArea;
    if (!area) {
      area = document.createElement('div');
      area.className = 'screen-share-area';
      area.id = 'screenShareArea';
      const grid = document.getElementById('videoGrid');
      grid.parentNode.insertBefore(area, grid);
      this._screenShareArea = area;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'screen-share-container';
    wrapper.dataset.shareSid = trackSid;
    videoElement.dataset.trackSid = trackSid;
    videoElement.style.width = '100%';
    videoElement.style.height = '100%';
    videoElement.style.objectFit = 'contain';
    wrapper.appendChild(videoElement);
    const label = document.createElement('div');
    label.className = 'screen-share-label';
    label.textContent = trackSid === 'local'
      ? 'You are sharing'
      : (participantName || 'Participant') + ' is sharing';
    wrapper.appendChild(label);
    area.appendChild(wrapper);
    this._screenShares.set(trackSid, wrapper);
    this._updateGridLayout();
  },

  // Remove one share container by sid, or all of them when sid is omitted
  _hideScreenShare(trackSid) {
    if (trackSid === undefined) {
      this._screenShares.forEach((wrapper) => wrapper.remove());
      this._screenShares.clear();
    } else {
      const wrapper = this._screenShares.get(trackSid);
      if (!wrapper) return;
      wrapper.remove();
      this._screenShares.delete(trackSid);
    }
    if (this._screenShares.size === 0 && this._screenShareArea) {
      this._screenShareArea.remove();
      this._screenShareArea = null;
    }
    this._updateGridLayout();
  },

  _overlayTimers: new Map(),

  _showOverlay(overlay) {
    let stack = document.getElementById('guestOverlayStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'guestOverlayStack';
      stack.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:15;display:flex;flex-direction:column;gap:6px;max-width:90%;pointer-events:none;';
      const sv = document.getElementById('sessionView');
      if (sv) { sv.style.position = 'relative'; sv.appendChild(stack); }
    }
    const id = overlay.id || ('ov_' + Date.now());
    const el = document.createElement('div');
    el.dataset.overlayId = id;
    el.style.cssText = 'background:rgba(0,0,0,0.75);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:8px 14px;color:#e8e8ed;font-size:12px;line-height:1.4;pointer-events:auto;display:flex;gap:10px;align-items:flex-start;animation:fadeIn 0.3s ease;';
    // overlay.source/content arrive over the network from other participants —
    // build with textContent so they are never parsed as HTML
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0';
    const sourceEl = document.createElement('div');
    sourceEl.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:0.05em;color:#8e8e93;margin-bottom:2px';
    sourceEl.textContent = overlay.source || 'AI';
    const contentEl = document.createElement('div');
    contentEl.textContent = overlay.content || '';
    body.appendChild(sourceEl);
    body.appendChild(contentEl);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:#8e8e93;cursor:pointer;font-size:16px;padding:0';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => el.remove());
    el.appendChild(body);
    el.appendChild(closeBtn);
    stack.appendChild(el);
    const ttl = (overlay.ttl || 15) * 1000;
    const timer = setTimeout(() => {
      this._overlayTimers.delete(id);
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.5s';
      setTimeout(() => el.remove(), 500);
    }, ttl);
    this._overlayTimers.set(id, timer);
  },

  _setAiAssist(active) {
    let ind = document.getElementById('guestAiAssist');
    if (active && !ind) {
      ind = document.createElement('div');
      ind.id = 'guestAiAssist';
      ind.style.cssText = 'position:absolute;top:8px;left:8px;z-index:12;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);border-radius:12px;padding:3px 10px;font-size:10px;color:#8e8e93;display:flex;align-items:center;gap:5px;';
      ind.innerHTML = '<div style="width:6px;height:6px;border-radius:50%;background:rgba(180,120,255,0.7);animation:pulse 1.5s ease-in-out infinite"></div>Host has AI assist active';
      const sv = document.getElementById('sessionView');
      if (sv) { sv.style.position = 'relative'; sv.appendChild(ind); }
    } else if (!active && ind) {
      ind.remove();
    }
  },

  _updateGridLayout() {
    const grid = document.getElementById('videoGrid');
    const count = this._participants.size;
    const isMobile = window.innerWidth <= 600;

    grid.className = 'video-grid';

    const presenting = this._screenShares.size > 0;
    const willPip = !presenting && isMobile && count === 2;

    this._participants.forEach((entry, sid) => {
      entry.cell.classList.remove('pip-self');
      // Clear drag positioning whenever the cell leaves PiP mode
      if (!(willPip && sid === this._localSid)) {
        entry.cell.style.removeProperty('position');
        entry.cell.style.removeProperty('left');
        entry.cell.style.removeProperty('top');
        entry.cell.style.removeProperty('bottom');
        entry.cell.style.removeProperty('right');
      }
    });

    // Presentation mode: screen share visible, participants go into bottom strip
    if (presenting) {
      grid.classList.add('presentation-mode');
      return;
    }

    // Mobile + 2 participants: PiP mode
    if (willPip) {
      grid.classList.add('pip-mode');
      const localEntry = this._participants.get(this._localSid);
      if (localEntry) {
        localEntry.cell.classList.add('pip-self');
        this._enablePipDrag(localEntry.cell);
        this._clampPipPosition(localEntry.cell);
      }
      return;
    }

    if (count >= 2 && count <= 6) {
      grid.classList.add('grid-' + count);
    }
  },

  // Keep a dragged PiP cell inside the viewport (runs on every resize while
  // in PiP mode via the resize -> _updateGridLayout listener)
  _clampPipPosition(cell) {
    if (cell.style.position !== 'fixed') return;
    const maxX = Math.max(0, window.innerWidth - cell.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - cell.offsetHeight);
    const x = Math.max(0, Math.min(parseFloat(cell.style.left) || 0, maxX));
    const y = Math.max(0, Math.min(parseFloat(cell.style.top) || 0, maxY));
    cell.style.left = x + 'px';
    cell.style.top = y + 'px';
  },

  // Touch-draggable PiP self-view
  _pipDragBound: false,
  _pipDragCell: null,  // the cell the listeners are bound to (cells are recreated on rejoin)
  _enablePipDrag(cell) {
    if (this._pipDragBound && this._pipDragCell === cell) return;
    this._pipDragBound = true;
    this._pipDragCell = cell;

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

  // Show or clear mute indicators on a participant cell
  _setTrackMutedUI(publication, participant, muted) {
    const isLocal = this.room && this.room.localParticipant &&
      participant.sid === this.room.localParticipant.sid;
    const key = isLocal ? this._localSid : participant.sid;
    const entry = this._participants.get(key);
    if (!entry) return;
    const cell = entry.cell;

    if (publication.kind === 'audio') {
      let badge = cell.querySelector('.mic-off-badge');
      if (muted && !badge) {
        badge = document.createElement('div');
        badge.className = 'mic-off-badge';
        badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
        cell.appendChild(badge);
      } else if (!muted && badge) {
        badge.remove();
      }
    } else if (publication.kind === 'video' && publication.source !== LivekitClient.Track.Source.ScreenShare) {
      let placeholder = cell.querySelector('.cam-off-placeholder');
      if (muted && !placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'cam-off-placeholder';
        placeholder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
        cell.appendChild(placeholder);
      } else if (!muted && placeholder) {
        placeholder.remove();
      }
    }
  },

  showStatus(message, type, persist) {
    const el = document.getElementById('statusToast');
    el.textContent = message;
    el.className = 'status-toast visible ' + (type || '');
    clearTimeout(this._statusTimeout);
    if (persist) return;
    this._statusTimeout = setTimeout(() => {
      el.classList.remove('visible');
    }, 3000);
  },

  hideStatus() {
    clearTimeout(this._statusTimeout);
    document.getElementById('statusToast').classList.remove('visible');
  }
};

document.addEventListener('DOMContentLoaded', () => guest.init());
</script>
</body>
</html>`;
}

module.exports = { buildGuestPageHTML, GUEST_PAGE_VERSION };
