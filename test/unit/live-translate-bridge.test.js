/**
 * Live Translate IPC bridge -- source-level invariants + behavior smoke
 *
 * The bridge wires lib/live-translate-service caption events to renderer
 * windows (recorder, future caption surfaces) via the
 * `live-translate:event` IPC. The bridge code is inline in main.js; this
 * test pins:
 *   - main.js registers the three `live-translate:*` IPC handlers.
 *   - The subscribe handler attaches a service subscriber that forwards
 *     events to every registered webContents.
 *   - preload-recorder exposes `window.recorder.liveTranslate.subscribe`
 *     and unsubscribe, and recorder.html wires both.
 *   - The service subscriber emits the documented event shapes the
 *     renderer can branch on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const mainSrc = readFileSync(resolve(REPO_ROOT, 'main.js'), 'utf8');
const preloadSrc = readFileSync(resolve(REPO_ROOT, 'preload-recorder.js'), 'utf8');
const recorderSrc = readFileSync(resolve(REPO_ROOT, 'recorder.html'), 'utf8');

describe('main.js -- live-translate IPC handlers', () => {
  it('registers live-translate:subscribe', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]live-translate:subscribe['"]/);
  });

  it('registers live-translate:unsubscribe', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]live-translate:unsubscribe['"]/);
  });

  it('registers live-translate:status', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]live-translate:status['"]/);
  });

  it('subscribes the bridge to lib/live-translate-service exactly once', () => {
    // The bridge guards re-attachment with _liveTranslateBridgeAttached.
    expect(mainSrc).toMatch(/_liveTranslateBridgeAttached/);
    expect(mainSrc).toMatch(/getLiveTranslateService/);
  });

  it('forwards events to every registered webContents as live-translate:event', () => {
    expect(mainSrc).toMatch(/wc\.send\(\s*['"]live-translate:event['"]/);
  });

  it('prunes destroyed webContents from the subscriber set', () => {
    expect(mainSrc).toMatch(/_liveTranslateSubscribers\.delete/);
    expect(mainSrc).toMatch(/wc\.isDestroyed\s*&&\s*wc\.isDestroyed\(\)/);
  });
});

describe('preload-recorder.js -- liveTranslate surface', () => {
  it('exposes liveTranslate.subscribe / unsubscribe / getStatus', () => {
    expect(preloadSrc).toMatch(/liveTranslate:\s*\{/);
    expect(preloadSrc).toMatch(/subscribe:\s*\(callback\)\s*=>/);
    expect(preloadSrc).toMatch(/unsubscribe:\s*\(\)\s*=>/);
    expect(preloadSrc).toMatch(/getStatus:\s*\(\)\s*=>/);
  });

  it('subscribe attaches an ipcRenderer.on listener for live-translate:event', () => {
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(\s*['"]live-translate:event['"]/);
  });

  it('uses the right IPC channel names', () => {
    expect(preloadSrc).toMatch(/['"]live-translate:subscribe['"]/);
    expect(preloadSrc).toMatch(/['"]live-translate:unsubscribe['"]/);
    expect(preloadSrc).toMatch(/['"]live-translate:status['"]/);
  });
});

describe('recorder.html -- caption rendering wiring', () => {
  it('subscribes via window.recorder.liveTranslate.subscribe at init', () => {
    expect(recorderSrc).toMatch(/window\.recorder\.liveTranslate\.subscribe/);
  });

  it('routes the events through a handleLiveTranslateEvent method', () => {
    expect(recorderSrc).toMatch(/handleLiveTranslateEvent\s*\(/);
  });

  it('handles the documented event types', () => {
    // Pull the handler body (anchor on the method DEFINITION, not the
    // earlier subscribe-callsite). Find `handleLiveTranslateEvent(evt) {`
    // followed by the switch.
    const startIdx = recorderSrc.indexOf('handleLiveTranslateEvent(evt) {');
    expect(startIdx).toBeGreaterThan(0);
    const slice = recorderSrc.slice(startIdx, startIdx + 1800);
    expect(slice).toMatch(/session_started/);
    expect(slice).toMatch(/session_stopped/);
    expect(slice).toMatch(/caption_delta/);
    expect(slice).toMatch(/caption_final/);
    expect(slice).toMatch(/'error'/);
  });

  it('auto-enables captions on session_started', () => {
    const startIdx = recorderSrc.indexOf('handleLiveTranslateEvent(evt) {');
    const slice = recorderSrc.slice(startIdx, startIdx + 1800);
    expect(slice).toMatch(/captionsEnabled\s*=\s*true/);
    expect(slice).toMatch(/captionOverlay\.classList\.add\(['"]visible['"]\)/);
  });
});

// Behavior smoke against the actual service: when the service emits
// caption events, the shape matches what the renderer branches on.
describe('lib/live-translate-service event shape contract', () => {
  it('emits session_started with sourceLang + targetLang', async () => {
    const { LiveTranslateService } = await import('../../lib/live-translate-service.js');
    const svc = new LiveTranslateService();
    const events = [];
    svc.subscribe((e) => events.push(e));

    // Stub a fake WebSocket ctor that we drive manually.
    const fakeWs = {
      readyState: 1,
      _handlers: {},
      send: () => {},
      on(ev, cb) { this._handlers[ev] = cb; },
      close: () => {},
      fire(ev, data) { if (this._handlers[ev]) this._handlers[ev](data); },
    };
    const ctor = function FakeWs() { ctor.last = fakeWs; return fakeWs; };
    svc.__setDeps({ WebSocketCtor: ctor, resolveApiKey: () => 'k' });

    await svc.start({ sourceLang: 'en', targetLang: 'es' });
    fakeWs.fire('open');

    expect(events).toContainEqual({
      type: 'session_started',
      sourceLang: 'en',
      targetLang: 'es',
    });
  });

  it('emits caption_delta with sourceText or targetText (not both required)', async () => {
    const { LiveTranslateService } = await import('../../lib/live-translate-service.js');
    const svc = new LiveTranslateService();
    const events = [];
    svc.subscribe((e) => events.push(e));
    const fakeWs = {
      readyState: 1, _handlers: {}, send: () => {}, close: () => {},
      on(ev, cb) { this._handlers[ev] = cb; },
      fire(ev, data) { if (this._handlers[ev]) this._handlers[ev](data); },
    };
    const ctor = function FakeWs() { ctor.last = fakeWs; return fakeWs; };
    svc.__setDeps({ WebSocketCtor: ctor, resolveApiKey: () => 'k' });
    await svc.start({ targetLang: 'es' });
    fakeWs.fire('open');

    fakeWs.fire('message', Buffer.from(JSON.stringify({
      type: 'session.output_transcript.delta',
      delta: 'hola',
    })));
    expect(events).toContainEqual({
      type: 'caption_delta',
      targetText: 'hola',
      isFinal: false,
    });
  });
});
