/**
 * WISER Meeting — simultaneous screen share over a REAL LiveKit SFU (env-guarded)
 *
 * Proves the thing a hermetic render test can't: when two remote peers publish
 * screen-share tracks to a real room, a third (viewer) peer's REAL guest-page
 * handlers subscribe to both and render them side by side — and independent
 * teardown works over the wire. No getDisplayMedia / OS screen-record grant is
 * needed: the app renders off the LiveKit track *source*, so each publisher
 * ships a fake-camera track tagged Track.Source.ScreenShare
 * (--use-fake-device-for-media-stream), which drives the identical path.
 *
 * The livekit-client UMD is served from node_modules, so the ONLY external
 * dependency is a LiveKit server. This test SKIPS unless one is configured:
 *
 *   Hermetic (recommended):  run a dev server and point the env at it
 *     docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
 *       -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server --dev
 *     LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey \
 *       LIVEKIT_API_SECRET=secret npx playwright test test/e2e/meeting-screenshare-transport.spec.js
 *
 *   Against the app's zero-config shared project (hits LiveKit Cloud):
 *     WISER_E2E_USE_LEGACY=1 npx playwright test test/e2e/meeting-screenshare-transport.spec.js
 *
 * Run via npm:  npm run test:meeting:transport   (skips unless the above is set)
 */

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const http = require('http');
const { AccessToken } = require('livekit-server-sdk');
const livekitService = require('../../lib/livekit-service');
const { buildGuestPageHTML } = require('../../lib/capture-guest-page');

const LOCAL_UMD = path.join(__dirname, '../../node_modules/livekit-client/dist/livekit-client.umd.js');

// LiveKit config: explicit env creds win; else opt into the app's zero-config
// shared project; else there is nothing to talk to and we skip.
function resolveLiveKit() {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: apiSecret } = process.env;
  if (url && apiKey && apiSecret) return { url, apiKey, apiSecret, source: 'env' };
  if (process.env.WISER_E2E_USE_LEGACY === '1') {
    const c = livekitService.getCredentials();
    if (c && c.url) return { url: c.url, apiKey: c.apiKey, apiSecret: c.apiSecret, source: 'legacy-shared' };
  }
  return null;
}

const LK = resolveLiveKit();
const ROOM = `wiser-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let baseURL; // http://127.0.0.1:<port>/ — a secure origin so getUserMedia works

async function mintToken(identity) {
  const at = new AccessToken(LK.apiKey, LK.apiSecret, { identity, ttl: '1h' });
  at.addGrant({ roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

// A connected peer running the REAL guest page. We seed the guest object's
// connection state and call its real _connectWithTokenRetry(), so the real
// RoomEvent handlers (and _showScreenShare) are what run.
async function launchPeer(browser, identity, displayName) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Serve the real livekit-client UMD from node_modules (no CDN / network).
  await page.route('**/cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ path: LOCAL_UMD, contentType: 'application/javascript' })
  );
  // Navigate to the page over http://127.0.0.1 (a secure context) rather than
  // setContent's about:blank — getUserMedia is only exposed on secure origins,
  // and the peers need real (fake-device) media to publish tracks.
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof LivekitClient !== 'undefined', null, { timeout: 20000 });

  const token = await mintToken(identity);
  await page.evaluate(
    async ({ token, url, displayName }) => {
      guest._displayName = displayName;
      guest._livekitUrl = url;
      guest._tokenPool = [token];
      guest._tokenIndex = 0;
      guest._tokenRetries = 0;
      try {
        guest.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch {
        guest.localStream = null;
      }
      document.getElementById('joinPanel').classList.add('hidden');
      document.getElementById('sessionView').classList.add('active');
      await guest._connectWithTokenRetry();
    },
    { token, url: LK.url, displayName }
  );
  return { context, page };
}

// Publish a fake-camera video track tagged as a screen share. Kept on
// window.__shareTrack so the peer can later unpublish it.
async function startShare(page) {
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    await guest.room.localParticipant.publishTrack(track, {
      source: LivekitClient.Track.Source.ScreenShare,
      name: 'screen',
    });
    window.__shareTrack = track;
  });
}

async function stopShare(page) {
  await page.evaluate(async () => {
    if (window.__shareTrack) await guest.room.localParticipant.unpublishTrack(window.__shareTrack);
  });
}

test.describe('WISER meeting — simultaneous screen share over real LiveKit', () => {
  test.skip(
    !LK,
    'No LiveKit server configured. Set LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET, or WISER_E2E_USE_LEGACY=1 to use the app’s shared project.'
  );

  let browser;
  let server;
  const peers = [];

  test.beforeAll(async () => {
    console.log(`[transport] LiveKit source=${LK.source} url=${LK.url} room=${ROOM}`);
    // Serve the real guest page over a secure (localhost) origin.
    const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseURL = `http://127.0.0.1:${server.address().port}/`;

    browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  });

  test.afterAll(async () => {
    for (const p of peers) {
      await p.context.close().catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  test('a viewer renders two remote shares at once, then independent teardown', async () => {
    test.setTimeout(90_000);

    const alice = await launchPeer(browser, `alice-${ROOM}`, 'Alice');
    const bob = await launchPeer(browser, `bob-${ROOM}`, 'Bob');
    const viewer = await launchPeer(browser, `viewer-${ROOM}`, 'Viewer');
    peers.push(alice, bob, viewer);

    // Everyone should see three participants settle in (cameras published).
    await expect
      .poll(() => viewer.page.evaluate(() => guest._participants.size), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // Two people share simultaneously.
    await startShare(alice.page);
    await startShare(bob.page);

    // The viewer's REAL handlers subscribe to both and tile them.
    await expect(viewer.page.locator('.screen-share-container')).toHaveCount(2, { timeout: 20_000 });
    await expect(viewer.page.locator('#videoGrid')).toHaveClass(/presentation-mode/);
    await expect(viewer.page.locator('.screen-share-label').filter({ hasText: 'is sharing' })).toHaveCount(2);

    // Alice stops — Bob's share stays up (independent teardown over the wire).
    await stopShare(alice.page);
    await expect(viewer.page.locator('.screen-share-container')).toHaveCount(1, { timeout: 20_000 });
    await expect(viewer.page.locator('#videoGrid')).toHaveClass(/presentation-mode/);

    // Bob stops — viewer returns to the normal grid.
    await stopShare(bob.page);
    await expect(viewer.page.locator('.screen-share-container')).toHaveCount(0, { timeout: 20_000 });
    await expect(viewer.page.locator('#videoGrid')).not.toHaveClass(/presentation-mode/);
  });
});
