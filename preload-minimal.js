// Minimal preload script for external content windows
// This script provides only the necessary APIs for external content
const { contextBridge, ipcRenderer } = require('electron');

// ========================================
// SSO: localStorage injection DISABLED
// The 'or' cookie/localStorage data is account-specific and doesn't help with SSO.
// The 'mult' cookie (injected via main process) is sufficient to enable SSO -
// it proves the user is authenticated to OneReach, so they only need to
// confirm/select their account instead of re-entering credentials.
// ========================================

// Expose a minimal API to the external content
contextBridge.exposeInMainWorld('electronAPI', {
  // Method to close the window
  closeWindow: () => {
    ipcRenderer.send('close-content-window');
  },
  // Method to get window info
  getWindowInfo: () => {
    return {
      isElectron: true,
      platform: process.platform,
    };
  },
  // Method to open Spaces picker for file uploads
  openSpacesPicker: () => {
    return ipcRenderer.invoke('open-spaces-picker');
  },
});

// Expose drag and drop API for outbound drags (webview content to desktop)
contextBridge.exposeInMainWorld('electronDrag', {
  // Start a native file drag from the webview to external apps/desktop
  startDrag: (filePath, iconPath) => {
    ipcRenderer.send('webview-start-native-drag', { filePath, iconPath });
  },
  // Check if we're in an Electron webview with drag support
  isSupported: () => true,
});

// Listen for close events from the main process
ipcRenderer.on('close-window', () => {
  // Notify the page that it's about to be closed
  window.dispatchEvent(new Event('electron-window-closing'));
});

// ========================================
// Drag and Drop Event Forwarding Support
// ========================================

// Listen for file drop messages from the parent window (via executeJavaScript)
// and create synthetic events that web apps can use
window.addEventListener('message', (event) => {
  // Only handle messages from the same origin (parent window injection)
  if (event.source !== window) return;

  if (event.data && event.data.type === 'electron-file-drop') {
    console.log('[Electron Preload] Received file drop message:', event.data.files?.length, 'files');

    // Create and dispatch a custom event with file data
    const dropEvent = new CustomEvent('electron-file-drop', {
      detail: {
        files: event.data.files,
        clientX: event.data.clientX,
        clientY: event.data.clientY,
      },
      bubbles: true,
      cancelable: true,
    });

    // Find the element at the drop coordinates and dispatch
    const targetElement = document.elementFromPoint(event.data.clientX, event.data.clientY);
    if (targetElement) {
      targetElement.dispatchEvent(dropEvent);
    } else {
      document.body.dispatchEvent(dropEvent);
    }
  }

  if (event.data && event.data.type === 'electron-url-drop') {
    console.log('[Electron Preload] Received URL drop message:', event.data.url);

    // Create and dispatch a custom event with URL data
    const dropEvent = new CustomEvent('electron-url-drop', {
      detail: {
        url: event.data.url,
        clientX: event.data.clientX,
        clientY: event.data.clientY,
      },
      bubbles: true,
      cancelable: true,
    });

    const targetElement = document.elementFromPoint(event.data.clientX, event.data.clientY);
    if (targetElement) {
      targetElement.dispatchEvent(dropEvent);
    } else {
      document.body.dispatchEvent(dropEvent);
    }
  }
});

// Expose helper to check for Electron drag/drop support
contextBridge.exposeInMainWorld('electronDropSupport', {
  // Web apps can check this to know if Electron file drops are available
  isAvailable: true,
  // Event names that will be dispatched
  events: {
    fileDrop: 'electron-file-drop',
    urlDrop: 'electron-url-drop',
  },
});

// ========================================
// ORB CONTROL API
//
// Uses the shared module from preload-orb-control.js.
// NOTE: sandbox: true preloads CAN require local modules in Electron 20+
// when specified via webPreferences.preload (the preload itself runs with
// Node.js access; only the renderer is sandboxed). If this fails in a
// specific context, see the git history for the previous inline version.
// ========================================
const { getOrbControlMethods } = require('./preload-orb-control');
contextBridge.exposeInMainWorld('orbControl', getOrbControlMethods());
console.log('[Minimal Preload] orbControl API exposed (shared module)');

// Playbook + Sync APIs (shared module)
const { getPlaybookMethods, getSyncMethods } = require('./preload-playbook-sync');
contextBridge.exposeInMainWorld('playbook', getPlaybookMethods('preload-minimal'));
contextBridge.exposeInMainWorld('sync', getSyncMethods());
console.log('[Minimal Preload] playbook + sync APIs exposed');

// ========================================
// CENTRALIZED AI SERVICE BRIDGE
// Provides window.ai for LLM calls routed through the main process,
// bypassing renderer-side CSP restrictions.
// ========================================
contextBridge.exposeInMainWorld('ai', {
  chat: (opts) => ipcRenderer.invoke('ai:chat', opts),
  complete: (prompt, opts) => ipcRenderer.invoke('ai:complete', prompt, opts),
  json: (prompt, opts) => ipcRenderer.invoke('ai:json', prompt, opts),
  vision: (imageData, prompt, opts) => ipcRenderer.invoke('ai:vision', imageData, prompt, opts),
  embed: (input, opts) => ipcRenderer.invoke('ai:embed', input, opts),
  transcribe: (audioBuffer, opts) => ipcRenderer.invoke('ai:transcribe', audioBuffer, opts),
  chatStream: (opts) => ipcRenderer.invoke('ai:chatStream', opts),
  onStreamChunk: (requestId, callback) => {
    const channel = `ai:stream:${requestId}`;
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
console.log('[Minimal Preload] ai bridge exposed');

// ========================================
// SPEECH BRIDGES
// Provides window.speechBridge, window.realtimeSpeech, window.micManager,
// window.voiceTTS for voice features routed through the main process.
// ========================================
try {
  const {
    getSpeechBridgeMethods,
    getRealtimeSpeechMethods,
    getMicManagerMethods,
    getVoiceTTSMethods,
  } = require('./preload-speech');
  contextBridge.exposeInMainWorld('speechBridge', getSpeechBridgeMethods());
  contextBridge.exposeInMainWorld('realtimeSpeech', getRealtimeSpeechMethods());
  contextBridge.exposeInMainWorld('micManager', getMicManagerMethods());
  contextBridge.exposeInMainWorld('voiceTTS', getVoiceTTSMethods());
  console.log('[Minimal Preload] speech bridges exposed');
} catch (err) {
  console.warn('[Minimal Preload] Speech module unavailable:', err.message);
}
