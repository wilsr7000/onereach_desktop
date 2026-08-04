/**
 * WISER Meeting — guest page screen-share RENDER + LAYOUT (hermetic)
 *
 * Runs the REAL generated guest page in a real Chromium (Playwright), reveals
 * the session view, and drives the real _showScreenShare / _hideScreenShare /
 * _updateGridLayout helpers with several simultaneous shares. Unlike the jsdom
 * unit suite (test/unit/capture-guest-page-screenshare.test.js), this asserts
 * on REAL computed geometry — tiles actually tile side by side without
 * overlapping, the share area sits above the participant strip, presentation
 * mode collapses the grid — which only a real layout engine can verify.
 *
 * Hermetic: no LiveKit server, no network. The page is served via setContent
 * and the livekit CDN <script> is aborted; we exercise the render pipeline
 * directly with canvas-backed video elements (the exact shape LiveKit's
 * track.attach() would hand us). Real transport is covered separately by
 * meeting-screenshare-transport.spec.js (env-guarded).
 *
 * Also emits screenshots under test-results/screenshare/ for UX review.
 *
 * Run:  npx playwright test test/e2e/meeting-screenshare-render.spec.js
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { buildGuestPageHTML } = require('../../lib/capture-guest-page');

const SHOT_DIR = path.join(__dirname, '../../test-results/screenshare');

// Reveal the session view and inject N simultaneous screen shares, each backed
// by a distinctly coloured canvas stream so screenshots read clearly. Returns
// nothing; assertions run against the resulting DOM from the test side.
async function setupShares(page, shares, { participants = ['You', 'Casey'] } = {}) {
  await page.evaluate(
    ({ shares, participants }) => {
      document.getElementById('joinPanel').classList.add('hidden');
      document.getElementById('sessionView').classList.add('active');

      // A couple of participant tiles so the bottom strip is visible in
      // presentation mode (mirrors real remote/local cells).
      participants.forEach((name, i) => guest._ensureParticipantCell('p-' + i, name));

      for (const s of shares) {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = s.color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 44px sans-serif';
        ctx.fillText(s.name + "'s screen", 40, 200);
        const stream = canvas.captureStream(10);
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        guest._showScreenShare(video, s.sid, s.name);
      }
    },
    { shares, participants }
  );
}

// Horizontal overlap between two boxes, in px (0 == perfectly non-overlapping).
function overlapX(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
}

test.describe('WISER guest page — screen-share render & layout', () => {
  test.beforeEach(async ({ page }) => {
    // Keep it fully offline: the only external subresource is the livekit UMD.
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // Sanity: the real guest object is present and reachable.
    expect(await page.evaluate(() => typeof guest)).toBe('object');
  });

  test('two people sharing at once tile side by side without overlapping', async ({ page }) => {
    await setupShares(page, [
      { sid: 'sid-alice', name: 'Alice', color: '#3b5bdb' },
      { sid: 'sid-bob', name: 'Bob', color: '#2f9e44' },
    ]);

    const containers = page.locator('.screen-share-container');
    await expect(containers).toHaveCount(2);
    await expect(page.locator('#videoGrid')).toHaveClass(/presentation-mode/);

    // Real geometry: equal-ish widths, genuinely side by side, no overlap.
    const b0 = await containers.nth(0).boundingBox();
    const b1 = await containers.nth(1).boundingBox();
    expect(b0).toBeTruthy();
    expect(b1).toBeTruthy();
    expect(overlapX(b0, b1)).toBeLessThan(6);
    expect(Math.abs(b0.width - b1.width)).toBeLessThan(4); // evenly split
    expect(b0.width).toBeGreaterThan(100); // each share is a real, usable panel

    // The share area sits ABOVE the participant strip (not on top of it).
    const shareArea = await page.locator('#screenShareArea').boundingBox();
    const grid = await page.locator('#videoGrid').boundingBox();
    expect(shareArea.y + shareArea.height).toBeLessThanOrEqual(grid.y + 2);
    // Presentation strip is short — it must not eat the shares' space.
    expect(grid.height).toBeLessThan(200);

    // Labels name each sharer.
    await expect(page.locator('.screen-share-label').filter({ hasText: 'Alice is sharing' })).toHaveCount(1);
    await expect(page.locator('.screen-share-label').filter({ hasText: 'Bob is sharing' })).toHaveCount(1);

    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-two-shares.png') });
  });

  test('three simultaneous shares still tile evenly and stay on screen', async ({ page }) => {
    await setupShares(page, [
      { sid: 's1', name: 'Alice', color: '#3b5bdb' },
      { sid: 's2', name: 'Bob', color: '#2f9e44' },
      { sid: 's3', name: 'Dana', color: '#e8590c' },
    ]);

    const containers = page.locator('.screen-share-container');
    await expect(containers).toHaveCount(3);

    const boxes = [];
    for (let i = 0; i < 3; i++) boxes.push(await containers.nth(i).boundingBox());
    // Pairwise no-overlap and all within the viewport width.
    expect(overlapX(boxes[0], boxes[1])).toBeLessThan(6);
    expect(overlapX(boxes[1], boxes[2])).toBeLessThan(6);
    const vw = page.viewportSize().width;
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(-1);
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 1);
      expect(b.width).toBeGreaterThan(60);
    }

    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-three-shares.png') });
  });

  test('stopping one share reflows the other to fill the space', async ({ page }) => {
    await setupShares(page, [
      { sid: 'sid-alice', name: 'Alice', color: '#3b5bdb' },
      { sid: 'sid-bob', name: 'Bob', color: '#2f9e44' },
    ]);

    const widthTwoUp = (await page.locator('.screen-share-container').first().boundingBox()).width;

    await page.evaluate(() => guest._hideScreenShare('sid-alice'));

    const containers = page.locator('.screen-share-container');
    await expect(containers).toHaveCount(1);
    await expect(page.locator('.screen-share-label')).toHaveText('Bob is sharing');
    // The survivor grew to (roughly) fill the row.
    const widthOneUp = (await containers.first().boundingBox()).width;
    expect(widthOneUp).toBeGreaterThan(widthTwoUp * 1.5);
    await expect(page.locator('#videoGrid')).toHaveClass(/presentation-mode/);
  });

  test('ending the last share restores the normal participant grid', async ({ page }) => {
    await setupShares(page, [
      { sid: 'sid-alice', name: 'Alice', color: '#3b5bdb' },
      { sid: 'sid-bob', name: 'Bob', color: '#2f9e44' },
    ]);

    await page.evaluate(() => guest._hideScreenShare());

    await expect(page.locator('.screen-share-container')).toHaveCount(0);
    await expect(page.locator('#screenShareArea')).toHaveCount(0);
    await expect(page.locator('#videoGrid')).not.toHaveClass(/presentation-mode/);
  });

  test('mobile viewport: two shares stack vertically at full width (not slivers)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupShares(page, [
      { sid: 'sid-alice', name: 'Alice', color: '#3b5bdb' },
      { sid: 'sid-bob', name: 'Bob', color: '#2f9e44' },
    ]);

    const containers = page.locator('.screen-share-container');
    await expect(containers).toHaveCount(2);

    const b0 = await containers.nth(0).boundingBox();
    const b1 = await containers.nth(1).boundingBox();
    // Stacked, not side by side: the second sits below the first...
    expect(b1.y).toBeGreaterThanOrEqual(b0.y + b0.height - 6);
    // ...and each spans (nearly) the full viewport width so it stays readable.
    expect(b0.width).toBeGreaterThan(390 * 0.8);
    expect(b1.width).toBeGreaterThan(390 * 0.8);

    // Nothing spills past the narrow viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.screenshot({ path: path.join(SHOT_DIR, 'mobile-two-shares.png') });
  });
});
