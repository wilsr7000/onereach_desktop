/**
 * Orb mic-lifecycle regression test.
 *
 * Pins the invariant that broke v4.x: the orb tore down its mic resources
 * (mediaStream, audioContext, processor) on every `listening -> X` transition.
 * That meant any time the orb came back to `listening` mid-session -- for a
 * follow-up answer, dwell-listen, or click barge-in -- it appeared to be
 * listening (UI shows listening, ready chime plays) but no audio was being
 * captured. The user complaint: "the orb asks me a follow-up but doesn't
 * listen for the answer".
 *
 * This test is structural: it greps orb.html's transition handler to assert
 * the mic lifecycle contract. It is intentionally cheap (no Electron, no
 * Playwright) so it can run in the unit suite and catch any future regression
 * that re-introduces aggressive mic teardown.
 *
 * Contract:
 *   - stopAudioCapture() is ONLY called from `to === 'idle'` (full session
 *     end) and from the `disconnected` event handler. Never from a
 *     `from === 'listening' && to !== 'listening'` block.
 *   - The "Leaving listening" handler may clear timers (clearAllSpeechTimers)
 *     but must not destroy the mic.
 *
 * Run: npx vitest run test/unit/orb-mic-lifecycle.test.js
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ORB_HTML_PATH = path.join(__dirname, '..', '..', 'orb.html');
const orbHtml = fs.readFileSync(ORB_HTML_PATH, 'utf8');

describe('Orb mic lifecycle (regression)', () => {
  it('does not call stopAudioCapture in the "Leaving listening" transition block', () => {
    // Grab the "Leaving listening" transition block. It begins at the marker
    // comment and runs until the next `// ---` divider in the side-effect
    // handler.
    const startMarker = orbHtml.indexOf('// --- Leaving listening');
    expect(startMarker).toBeGreaterThan(-1);

    const afterStart = orbHtml.slice(startMarker);
    const endIdx = afterStart.indexOf('// ---', 5); // skip the marker itself
    expect(endIdx).toBeGreaterThan(-1);

    const block = afterStart.slice(0, endIdx);
    // The fix removed stopAudioCapture from this block. If anyone re-adds it,
    // multi-turn voice breaks immediately and silently, so this assertion is
    // the load-bearing one.
    expect(block).not.toMatch(/stopAudioCapture\s*\(/);
  });

  it('only calls stopAudioCapture from idle entry and the disconnected handler', () => {
    // Find every callsite of stopAudioCapture( ... ) in the file. Function
    // definitions and comments are excluded by requiring an opening paren
    // and not being preceded by `function`.
    const lines = orbHtml.split(/\r?\n/);
    const callsites = [];
    lines.forEach((line, i) => {
      if (/stopAudioCapture\s*\(/.test(line) && !/function\s+stopAudioCapture/.test(line)) {
        callsites.push({ line: i + 1, text: line.trim() });
      }
    });

    // We expect exactly two call sites:
    //   - Inside the `to === 'idle'` block (full session cleanup)
    //   - Inside the `disconnected:` event handler (WebSocket dropped)
    // If more appear, someone reintroduced aggressive teardown.
    expect(callsites.length).toBe(2);

    // Each callsite should have nearby context that matches one of the two
    // legitimate paths. Look at the surrounding 25 lines for the context.
    const contexts = callsites.map(({ line }) => {
      const start = Math.max(0, line - 25);
      return lines.slice(start, line).join('\n');
    });

    const idleContext = contexts.find((c) => /to\s*===\s*['"]idle['"]/.test(c));
    const disconnectedContext = contexts.find((c) => /disconnected\s*:/.test(c));

    expect(idleContext).toBeTruthy();
    expect(disconnectedContext).toBeTruthy();
  });

  it('stopAudioCapture resets _micCaptureReady so the next listening transition cannot lie', () => {
    // Once the mic is torn down, _micCaptureReady must be false. Otherwise a
    // future listening transition checks `if (_micCaptureReady)` and shows
    // the listening UI / plays the ready chime even though there is no live
    // mic -- exactly the original bug shape.
    const fnStart = orbHtml.indexOf('function stopAudioCapture');
    expect(fnStart).toBeGreaterThan(-1);
    const closingBrace = orbHtml.indexOf('\n      }', fnStart);
    const body = orbHtml.slice(fnStart, closingBrace);
    expect(body).toMatch(/_micCaptureReady\s*=\s*false/);
  });

  it('warns loudly when listening is entered without an active mic', () => {
    // Defensive log: if any future code path lets us back into listening
    // without a live mic, the console.warn makes it visible immediately
    // instead of presenting silent failure to the user.
    const enteringListeningIdx = orbHtml.indexOf('// --- Entering listening');
    expect(enteringListeningIdx).toBeGreaterThan(-1);
    const block = orbHtml.slice(enteringListeningIdx, enteringListeningIdx + 2500);
    expect(block).toMatch(/Entered listening without an active mic/);
  });
});
