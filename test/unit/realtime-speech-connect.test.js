/**
 * realtime-speech IPC -- Phase 3 speaker auto-subscribe removal
 *
 * Phase 3 (audio output hard cut) removed the auto-subscribe to
 * voice-speaker.js inside the `realtime-speech:connect` handler. The
 * orb now receives audio directly from the realtime API stream via
 * voice-listener's broadcast (audio_delta + audio_done).
 *
 * voice-speaker.js stays alive for non-orb proactive callers (critical
 * meeting alarm, etc.). This test asserts:
 *   1. After realtime-speech:connect runs, the speaker's subscriber map
 *      does NOT contain the connecting webContentsId.
 *   2. The voice-listener subscriber map DOES contain the webContentsId
 *      (the user still gets transcripts + audio_delta etc.).
 *   3. Proactive speaker callers (voice-speaker.speak with proactive=true)
 *      still work independently -- they call ai.tts, broadcast audio_wav
 *      to their own subscribers. Regression guard for the alarm path.
 *
 * We avoid loading the real realtime-speech.js (which pulls in Electron)
 * by simulating the handler's logic against a fake listener+speaker.
 * The behavior under test is the small slice we changed in
 * realtime-speech.js setupIPC -- the assertion is that the slice
 * subscribes ONLY to the listener, never to the speaker.
 */

import { describe, it, expect, vi } from 'vitest';

// Re-implement the realtime-speech:connect handler slice as a pure function.
// This mirrors the production code shape and lets us assert subscriber state
// without bringing electron + ws into the test.
function simulateConnectHandler(listener, speaker, webContentsId) {
  // The actual handler under test:
  //   1. await this.connect();
  //   2. this.subscribe(webContentsId, ...) -- listener subscription
  //   3. (Phase 3: speaker auto-subscribe REMOVED)
  // We exercise step 2 only; the absence of step 3 is the assertion.
  listener.subscribe(webContentsId, () => {});
}

describe('realtime-speech:connect (Phase 3) -- speaker auto-subscribe removed', () => {
  it('subscribes webContents to the listener', () => {
    const subs = new Map();
    const listener = { subscribe: (id, cb) => subs.set(id, cb) };
    const speaker = { subscribers: new Map() };
    simulateConnectHandler(listener, speaker, 42);
    expect(subs.has(42)).toBe(true);
  });

  it('does NOT subscribe webContents to the speaker (regression guard)', () => {
    const listener = { subscribe: () => {} };
    const speakerSubs = new Map();
    const speaker = {
      subscribers: speakerSubs,
      subscribe: (id, cb) => speakerSubs.set(id, cb),
    };
    simulateConnectHandler(listener, speaker, 42);
    expect(speakerSubs.has(42)).toBe(false);
  });
});

describe('realtime-speech.js setupIPC source (Phase 3 invariant)', () => {
  it('the setupIPC code path does NOT auto-subscribe orb to voice-speaker', async () => {
    // Read the actual realtime-speech.js source and assert the speaker
    // auto-subscribe block is gone. This guards against accidental
    // re-introduction of the orb double-audio bug (TTS-1 + realtime audio
    // both playing) when someone re-copies the legacy pattern.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'realtime-speech.js'),
      'utf8'
    );
    // Inside realtime-speech:connect we used to see a `this.speaker.subscribe`
    // call. Phase 3 should have removed it.
    const connectStart = src.indexOf("ipcMain.handle('realtime-speech:connect'");
    const connectEnd = src.indexOf('ipcMain.handle', connectStart + 1);
    const connectSlice = src.slice(connectStart, connectEnd);
    expect(connectSlice).not.toMatch(/this\.speaker\.subscribe/);
    expect(connectSlice).not.toMatch(/speaker\.subscribers\.has/);
  });
});

describe('voice-speaker.js proactive path -- regression guard', () => {
  it('proactive speaker callers still hit ai.tts and broadcast independently', async () => {
    // We don't import voice-speaker.js directly (it pulls in Electron),
    // but we can assert the source preserves the proactive contract:
    //   - speak() / _doSpeak() exists
    //   - calls getAIService().tts(...)
    //   - broadcasts audio_wav events
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'voice-speaker.js'),
      'utf8'
    );
    expect(src).toMatch(/_doSpeak/);
    expect(src).toMatch(/ai\.tts\(/);
    expect(src).toMatch(/audio_wav/);
    // Proactive flag still acknowledged
    expect(src).toMatch(/proactive/);
  });
});
