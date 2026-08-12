/**
 * lib/capture-guest-page.js -- simultaneous screen-share behaviour on the
 * hosted guest page (the "remote app" a participant opens from a meeting link).
 *
 * The user's concern: "make sure multiple people screen sharing at the same
 * time works, and screen sharing in the remote app." The guest page renders
 * every subscribed ScreenShare track into its own container keyed by track sid
 * (`_showScreenShare`), tears exactly one down on unsubscribe/stop
 * (`_hideScreenShare`), and flips the grid into presentation mode while any
 * share is live (`_updateGridLayout`). Those three methods are the whole
 * multi-share contract, so we exercise them against a real DOM.
 *
 * We load the ACTUAL generated page into jsdom and evaluate its real inline
 * script to get the same `guest` object the browser runs -- no re-implementation
 * of the logic under test. Construction only registers a DOMContentLoaded
 * listener (never fired here), so LiveKit/getDisplayMedia are never touched;
 * we drive the render helpers directly the way TrackSubscribed / a local
 * share / TrackUnsubscribed / disconnect would.
 *
 * Run:  npx vitest run test/unit/capture-guest-page-screenshare.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';
const { JSDOM } = require('jsdom');

const { buildGuestPageHTML } = require('../../lib/meeting/capture-guest-page');

// Same extractor the sibling suite uses: pull inline <script> bodies.
function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue; // external -- no inline body
    out.push({ attrs: attrs.trim(), body });
  }
  return out;
}

// Render the real guest page into jsdom and hand back the live `guest` object
// bound to that document/window. jsdom parses the DOM (so #videoGrid exists)
// but does not run page scripts; we evaluate the main script ourselves via
// Function() exactly like the sibling suite, passing the jsdom document so the
// render helpers manipulate a real DOM.
function loadGuestWithDom() {
  const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
  const dom = new JSDOM(html); // scripts NOT executed by default
  const { document, window } = dom.window;
  const main = extractInlineScripts(html).find((s) => /const KV_URL =/.test(s.body));
  if (!main) throw new Error('main guest script not found');
  const guest = new Function('document', 'window', `${main.body}; return guest;`)(document, window);
  return { guest, document, window };
}

// A stand-in for the <video> element LiveKit's track.attach() would return
// (or the local getDisplayMedia preview element the page builds itself).
function fakeVideo(document) {
  return document.createElement('video');
}

const containers = (document) =>
  Array.from(document.querySelectorAll('.screen-share-container'));
const labels = (document) =>
  containers(document).map((c) => c.querySelector('.screen-share-label').textContent);
const isPresenting = (document) =>
  document.getElementById('videoGrid').classList.contains('presentation-mode');

describe('guest page — simultaneous screen sharing (remote app)', () => {
  let guest, document;

  beforeEach(() => {
    ({ guest, document } = loadGuestWithDom());
  });

  it('renders two remote shares side by side at the same time', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-alice', 'Alice');
    guest._showScreenShare(fakeVideo(document), 'sid-bob', 'Bob');

    // Both shares are tracked and rendered -- the core "multiple people at once"
    expect(guest._screenShares.size).toBe(2);
    expect(containers(document).length).toBe(2);
    expect(labels(document).sort()).toEqual(['Alice is sharing', 'Bob is sharing']);

    // A single flex row (the share area) holds both, and it was inserted
    // before the participant grid so the layout stacks correctly.
    const area = document.getElementById('screenShareArea');
    expect(area).toBeTruthy();
    expect(area.querySelectorAll('.screen-share-container').length).toBe(2);
    const grid = document.getElementById('videoGrid');
    expect(area.nextElementSibling).toBe(grid);

    // Any live share flips the grid into presentation mode.
    expect(isPresenting(document)).toBe(true);
  });

  it('stopping one share leaves the other running (independent teardown)', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-alice', 'Alice');
    guest._showScreenShare(fakeVideo(document), 'sid-bob', 'Bob');

    // Alice's TrackUnsubscribed fires -> remove only her container.
    guest._hideScreenShare('sid-alice');

    expect(guest._screenShares.size).toBe(1);
    expect(labels(document)).toEqual(['Bob is sharing']);
    // Bob is still presenting, so presentation mode stays on.
    expect(isPresenting(document)).toBe(true);
  });

  it('removing the last share tears down the area and exits presentation mode', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-alice', 'Alice');
    guest._showScreenShare(fakeVideo(document), 'sid-bob', 'Bob');

    guest._hideScreenShare('sid-alice');
    guest._hideScreenShare('sid-bob');

    expect(guest._screenShares.size).toBe(0);
    expect(document.getElementById('screenShareArea')).toBeNull();
    expect(guest._screenShareArea).toBeNull();
    expect(isPresenting(document)).toBe(false);
  });

  it('shows the local share and a remote share together (guest shares while host shares)', () => {
    // Local share is keyed 'local' and labelled "You are sharing".
    guest._showScreenShare(fakeVideo(document), 'local', 'You');
    guest._showScreenShare(fakeVideo(document), 'sid-host', 'Host');

    expect(guest._screenShares.size).toBe(2);
    expect(labels(document).sort()).toEqual(['Host is sharing', 'You are sharing']);

    // Guest clicks Stop -> only the local container goes; host's stays.
    guest._hideScreenShare('local');
    expect(guest._screenShares.size).toBe(1);
    expect(labels(document)).toEqual(['Host is sharing']);
    expect(isPresenting(document)).toBe(true);
  });

  it('re-showing the same track sid replaces rather than duplicates', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-x', 'X');
    // e.g. a full reconnect re-fires TrackSubscribed for the same sid.
    guest._showScreenShare(fakeVideo(document), 'sid-x', 'X');

    expect(guest._screenShares.size).toBe(1);
    expect(containers(document).length).toBe(1);
  });

  it('bare _hideScreenShare() clears every share (used on leave/disconnect)', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-alice', 'Alice');
    guest._showScreenShare(fakeVideo(document), 'sid-bob', 'Bob');

    guest._hideScreenShare(); // no sid == clear all

    expect(guest._screenShares.size).toBe(0);
    expect(containers(document).length).toBe(0);
    expect(document.getElementById('screenShareArea')).toBeNull();
    expect(isPresenting(document)).toBe(false);
  });

  it('hiding an unknown sid is a no-op and never throws', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-alice', 'Alice');
    expect(() => guest._hideScreenShare('sid-does-not-exist')).not.toThrow();
    expect(guest._screenShares.size).toBe(1);
    expect(isPresenting(document)).toBe(true);
  });

  it('falls back to a generic label when the sharer has no name', () => {
    guest._showScreenShare(fakeVideo(document), 'sid-anon', undefined);
    expect(labels(document)).toEqual(['Participant is sharing']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// LIVE CAPTIONS FROM THE HOST (guest side). The host broadcasts
// live-caption / cc-state data messages; these drive the CC chip and the
// caption bar. Same jsdom harness — we call the real handlers directly,
// exactly as the DataReceived dispatcher does after its host-identity gate.
// ═══════════════════════════════════════════════════════════════════

describe('guest page — live captions from the host', () => {
  let guest, document;

  beforeEach(() => {
    ({ guest, document } = loadGuestWithDom());
  });

  const bar = (d) => d.getElementById('guestCaption');
  const chip = (d) => d.getElementById('ccLive');

  it('cc-state true shows the CC chip; false hides chip and caption bar', () => {
    guest._setCcState(true);
    expect(chip(document).classList.contains('visible')).toBe(true);

    guest._handleLiveCaption({ text: 'hello there', speaker: 'Rich', final: false });
    expect(bar(document).classList.contains('visible')).toBe(true);

    guest._setCcState(false);
    expect(chip(document).classList.contains('visible')).toBe(false);
    expect(bar(document).classList.contains('visible')).toBe(false);
  });

  it('renders speaker-prefixed text; interim vs final styling', () => {
    guest._handleLiveCaption({ text: 'first half', speaker: 'Rich', final: false });
    const txt = document.getElementById('guestCaptionText');
    expect(txt.textContent).toBe('Rich: first half');
    expect(bar(document).classList.contains('interim')).toBe(true);

    guest._handleLiveCaption({ text: 'first half done.', speaker: 'Rich', final: true });
    expect(txt.textContent).toBe('Rich: first half done.');
    expect(bar(document).classList.contains('interim')).toBe(false);
  });

  it('a caption implies CC is live (indicator lights even without cc-state)', () => {
    expect(chip(document).classList.contains('visible')).toBe(false);
    guest._handleLiveCaption({ text: 'implicit activation', speaker: null, final: false });
    expect(chip(document).classList.contains('visible')).toBe(true);
  });

  it('caption text is rendered as text, never markup (injection-safe)', () => {
    guest._handleLiveCaption({ text: '<img src=x onerror=alert(1)>', speaker: '<b>Evil</b>', final: true });
    const txt = document.getElementById('guestCaptionText');
    expect(txt.querySelector('img')).toBeNull();
    expect(txt.querySelector('b')).toBeNull();
    expect(txt.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('empty caption messages are ignored', () => {
    expect(() => guest._handleLiveCaption({ text: '', final: true })).not.toThrow();
    expect(() => guest._handleLiveCaption(null)).not.toThrow();
    expect(bar(document).classList.contains('visible')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// RECORDING TRANSFER GUARDS. A meeting ending abruptly used to hijack the
// guest's screen with a doomed "uploading" overlay that then failed — the
// old guard only checked the room OBJECT existed (it survives disconnect).
// ═══════════════════════════════════════════════════════════════════

describe('guest page — recording transfer guards', () => {
  let guest, document;

  beforeEach(() => {
    ({ guest, document } = loadGuestWithDom());
  });

  const overlayActive = (d) => d.getElementById('transferOverlay').classList.contains('active');
  const title = (d) => d.getElementById('transferTitle').textContent;

  it('empty recording: no upload theater, blob discarded', async () => {
    guest.recordedBlob = { size: 100 };
    await guest.sendRecordingToHost();
    expect(overlayActive(document)).toBe(false);
    expect(guest.recordedBlob).toBeNull();
  });

  it('room disconnected: straight to download, zero chunks sent', async () => {
    guest.recordedBlob = { size: 50000 };
    guest.room = { state: 'disconnected', localParticipant: {}, remoteParticipants: new Map() };
    let sent = 0;
    guest.sendData = () => { sent++; };
    await guest.sendRecordingToHost();
    expect(title(document)).toBe('Meeting connection closed');
    expect(sent).toBe(0);
    expect(overlayActive(document)).toBe(true); // download UI is shown
  });

  it('host left (room still connected): download offered, zero chunks sent', async () => {
    guest.recordedBlob = { size: 50000 };
    const remotes = new Map([['g1', { identity: 'guest-3' }]]); // no host
    guest.room = { state: 'connected', localParticipant: {}, remoteParticipants: remotes };
    let sent = 0;
    guest.sendData = () => { sent++; };
    await guest.sendRecordingToHost();
    expect(title(document)).toBe('Host has left the meeting');
    expect(sent).toBe(0);
  });

  it('host present + connected: transfer proceeds and completes', async () => {
    const bytes = new ArrayBuffer(20000);
    guest.recordedBlob = { size: 20000, type: 'video/webm', arrayBuffer: async () => bytes };
    const remotes = new Map([['h', { identity: 'host' }]]);
    guest.room = { state: 'connected', localParticipant: {}, remoteParticipants: remotes };
    const sentTypes = [];
    guest.sendData = (d) => { sentTypes.push(d && d.type ? d.type : 'chunk'); };
    await guest.sendRecordingToHost();
    expect(sentTypes[0]).toBe('track-transfer-start');
    expect(sentTypes[sentTypes.length - 1]).toBe('track-transfer-complete');
    expect(sentTypes.filter((t) => t === 'chunk').length).toBeGreaterThan(0);
    expect(title(document)).toBe('Transfer complete');
  });
});
