/**
 * IPC Recorder Namespace — preload/main contract test
 *
 * Loads the REAL preload-recorder.js against a stubbed `electron` module,
 * records every channel the exposed APIs invoke or listen on, then checks
 * each invoked channel against the handlers actually registered in
 * recorder.js (extracted from source with a regex) plus the documented
 * channels owned by other main-process modules. If the preload and the
 * main process drift apart — a renamed handler, a phantom channel — this
 * test fails.
 *
 * The preload is pure CommonJS loaded through Node's native require, so
 * the electron stub is injected via Module._load (vi.mock only intercepts
 * the ESM module-runner graph and never sees this require chain).
 *
 * Run:  npx vitest run test/unit/ipc-recorder.test.js
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const recorderSourcePath = path.resolve(__dirnameLocal, '../../recorder.js');
const preloadPath = path.resolve(__dirnameLocal, '../../preload-recorder.js');

// ─── Recording electron stub ───────────────────────────────────────────────

const exposedWorlds = {};
const invokedChannels = new Set();
const listenerChannels = new Set();

const electronStub = {
  contextBridge: {
    exposeInMainWorld: (name, api) => {
      exposedWorlds[name] = api;
    },
  },
  ipcRenderer: {
    invoke: (channel) => {
      invokedChannels.add(channel);
      return Promise.resolve({ success: true });
    },
    send: (channel) => {
      invokedChannels.add(channel);
    },
    on: (channel) => {
      listenerChannels.add(channel);
    },
    removeAllListeners: () => {},
  },
};

// Load the real preload with `require('electron')` (and any transitive
// electron requires in the helper preloads it pulls in) answered by the
// stub above.
function loadPreloadWithStub() {
  const Module = requireCjs('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    requireCjs(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
}

// ─── Known-channel inventory ───────────────────────────────────────────────

function extractMainHandlers(source) {
  const channels = new Set();
  const re = /ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    channels.add(m[1]);
  }
  return channels;
}

// Channels the recorder preload uses that are registered by OTHER
// main-process modules (clipboard manager, live-translate bridge,
// diagnostics, electron-audio-loopback, shell handler).
const EXTERNAL_CHANNELS = [
  'clipboard:get-spaces',
  'clipboard:write-text',
  'live-translate:subscribe',
  'live-translate:unsubscribe',
  'live-translate:status',
  'diagnostics:diagnose',
  'diagnostics:get-recent-logs',
  'enable-loopback-audio',
  'disable-loopback-audio',
  'shell:open-external',
];

// Method names window.recorder must expose (renderer code in recorder.html
// depends on these).
const EXPECTED_RECORDER_METHODS = [
  'getInstructions',
  'getDevices',
  'requestPermissions',
  'saveToSpace',
  'getSpaces',
  'getProjectFolder',
  'close',
  'minimize',
  'getScreenSources',
  'setScreenShareSource',
  'enableLoopbackAudio',
  'disableLoopbackAudio',
  'getOpenAIKey',
  'transcribeItem',
  'writeLiveTranscript',
  'saveTranscriptToSpace',
  'startMonitor',
  'stopMonitor',
  'getSystemDiagnostics',
  'onInstructionsReceived',
  'onMonitorAlert',
  'pushOverlay',
  'onOverlay',
  'createMeeting',
  'getMeetings',
  'updateMeeting',
  'completeMeeting',
  'postMeetingAnalyze',
  'getTemplates',
  'saveCustomTemplate',
  'createRoom',
  'endSession',
  'getGuestPageUrl',
  'publishGuestPage',
  'storeMeetingTokens',
  'clearMeetingTokens',
  'getMeetingLinkKey',
  'saveGuestTrack',
  'mergeTracks',
  'getSpaceRecordings',
  'onMergeProgress',
];

// Exercise every function on the recorder-owned surfaces so each one
// records the channel it talks to. agentHUD is provided by
// preload-hud-api.js and has its own main-process contract; it is
// deliberately not exercised here.
function exerciseRecorderSurfaces() {
  const dummy = () => {};
  const callAll = (api) => {
    for (const value of Object.values(api)) {
      if (typeof value === 'function') {
        try {
          value(dummy);
        } catch {
          /* signature mismatches are fine — we only record channels */
        }
      } else if (value && typeof value === 'object') {
        callAll(value);
      }
    }
  };
  callAll(exposedWorlds.recorder || {});
  if (exposedWorlds.electron) exposedWorlds.electron.openExternal('https://example.com');
  if (exposedWorlds.electronClipboard) exposedWorlds.electronClipboard.writeText('x');
  if (exposedWorlds.diagnostics) {
    exposedWorlds.diagnostics.diagnose({ message: 'x' }, {});
    exposedWorlds.diagnostics.getRecentLogs({});
  }
}

// ═══════════════════════════════════════════════════════════════════
// PRELOAD <-> MAIN CONTRACT
// ═══════════════════════════════════════════════════════════════════

describe('IPC Recorder - preload/main contract', () => {
  let mainHandlers;
  let knownChannels;

  beforeAll(() => {
    loadPreloadWithStub();
    const source = fs.readFileSync(recorderSourcePath, 'utf8');
    mainHandlers = extractMainHandlers(source);
    knownChannels = new Set([...mainHandlers, ...EXTERNAL_CHANNELS]);
    exerciseRecorderSurfaces();
  });

  it('exposes the recorder API in the main world', () => {
    expect(exposedWorlds.recorder).toBeDefined();
    expect(typeof exposedWorlds.recorder).toBe('object');
  });

  it('recorder.js registers a plausible set of IPC handlers', () => {
    expect(mainHandlers.size).toBeGreaterThanOrEqual(20);
    expect(mainHandlers.has('recorder:save-to-space')).toBe(true);
    expect(mainHandlers.has('recorder:merge-tracks')).toBe(true);
  });

  it('every channel the preload invokes has a known main-process handler', () => {
    // Sanity: exercising the surface actually recorded a broad set
    expect(invokedChannels.size).toBeGreaterThanOrEqual(30);

    const unknown = [...invokedChannels].filter((ch) => !knownChannels.has(ch));
    expect(unknown).toEqual([]);
  });

  it('recorder API surface exposes the expected method names', () => {
    const names = Object.keys(exposedWorlds.recorder);
    for (const method of EXPECTED_RECORDER_METHODS) {
      expect(names).toContain(method);
      expect(typeof exposedWorlds.recorder[method]).toBe('function');
    }
    // Nested live-translate namespace
    expect(typeof exposedWorlds.recorder.liveTranslate).toBe('object');
    expect(typeof exposedWorlds.recorder.liveTranslate.subscribe).toBe('function');
    expect(typeof exposedWorlds.recorder.liveTranslate.unsubscribe).toBe('function');
    expect(typeof exposedWorlds.recorder.liveTranslate.getStatus).toBe('function');
  });

  it('event subscriptions register listeners on the expected channels', () => {
    expect(listenerChannels.has('recorder:instructions')).toBe(true);
    expect(listenerChannels.has('recorder:monitor-alert')).toBe(true);
    expect(listenerChannels.has('recorder:overlay')).toBe(true);
    expect(listenerChannels.has('recorder:merge-progress')).toBe(true);
    expect(listenerChannels.has('live-translate:event')).toBe(true);
  });

  it('companion worlds expose the shell and clipboard bridges', () => {
    expect(typeof exposedWorlds.electron?.openExternal).toBe('function');
    expect(typeof exposedWorlds.electronClipboard?.writeText).toBe('function');
  });
});
