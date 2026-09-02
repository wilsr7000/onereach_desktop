/**
 * Content tone (2026-09-01): "is there a way to detect if the content
 * in the electron window is dark or light and change the header to
 * match? If not, keep the main window header dark because the IDW is
 * dark right now."
 *
 * The header (tab bar) is the window's title bar on macOS and wears the
 * colour of the content under it, with ink that reads on that colour.
 * This file pins the pure classifier and the wiring that makes it real.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  toneFromBgra,
  toneFromHex,
  classifyTone,
  relativeLuminance,
  TONE_DARK_BELOW,
  TONE_LIGHT_ABOVE,
} from '../../main-window/content-tone.js';

const read = (...candidates: string[]): string => {
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`not found: ${candidates.join(', ')}`);
  return readFileSync(found, 'utf8');
};

function bgra(width: number, height: number, rgb: [number, number, number], alpha = 255): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    out[p * 4] = rgb[2];
    out[p * 4 + 1] = rgb[1];
    out[p * 4 + 2] = rgb[0];
    out[p * 4 + 3] = alpha;
  }
  return out;
}

describe('classifying a strip of pixels', () => {
  it('a dark IDW header reads dark, white ink; a light page reads light, dark ink', () => {
    const dark = toneFromBgra(bgra(120, 6, [30, 30, 36]), 120, 6);
    expect(dark?.tone).toBe('dark');
    expect(dark?.color).toBe('#1e1e24');
    const light = toneFromBgra(bgra(120, 6, [244, 240, 232]), 120, 6);
    expect(light?.tone).toBe('light');
    expect(light?.color).toBe('#f4f0e8');
  });

  it('the mean colour is what the bar wears (BGRA order respected)', () => {
    // Half pure red, half pure blue -> a purple mean; if channels were
    // read RGBA the colour would come out swapped.
    const w = 10;
    const px = new Uint8Array(w * 4);
    for (let p = 0; p < w; p += 1) {
      const red = p < 5;
      px[p * 4] = red ? 0 : 255; // B
      px[p * 4 + 1] = 0; // G
      px[p * 4 + 2] = red ? 255 : 0; // R
      px[p * 4 + 3] = 255;
    }
    const t = toneFromBgra(px, w, 1);
    expect(t?.color).toBe('#800080');
  });

  it('transparent pixels are ignored and an empty strip yields null (keep the last tone)', () => {
    expect(toneFromBgra(bgra(8, 2, [255, 255, 255], 0), 8, 2)).toBeNull();
    expect(toneFromBgra(new Uint8Array(0), 8, 2)).toBeNull();
    const mixed = bgra(4, 1, [0, 0, 0]);
    // Make the last pixel a transparent white — must not lighten the mean.
    mixed[12] = 255;
    mixed[13] = 255;
    mixed[14] = 255;
    mixed[15] = 0;
    expect(toneFromBgra(mixed, 4, 1)?.color).toBe('#000000');
  });

  it('hysteresis: a mid-grey keeps whatever tone it had, so the ink never flickers', () => {
    const mid = (TONE_DARK_BELOW + TONE_LIGHT_ABOVE) / 2;
    expect(classifyTone(mid, { tone: 'dark', luminance: 0, color: '#000000' })).toBe('dark');
    expect(classifyTone(mid, { tone: 'light', luminance: 1, color: '#ffffff' })).toBe('light');
    // With no history the band splits at its middle.
    expect(classifyTone(TONE_DARK_BELOW + 0.001, null)).toBe('dark');
    expect(classifyTone(TONE_LIGHT_ABOVE - 0.001, null)).toBe('light');
  });

  it('the thresholds sit where white and black ink have equal contrast (L ≈ 0.18)', () => {
    expect(TONE_DARK_BELOW).toBeLessThan(0.18);
    expect(TONE_LIGHT_ABOVE).toBeGreaterThan(0.18);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
    expect(relativeLuminance(0, 0, 0)).toBe(0);
  });

  it('a page-declared theme-color is an early hint, in either hex form', () => {
    expect(toneFromHex('#111')?.tone).toBe('dark');
    expect(toneFromHex('#f4f5f7')?.tone).toBe('light');
    expect(toneFromHex('#f4f5f7')?.color).toBe('#f4f5f7');
    expect(toneFromHex('rgb(0,0,0)')).toBeNull();
    expect(toneFromHex(null)).toBeNull();
  });
});

describe('the header follows the content', () => {
  const windowSrc = (): string => read('main-window/window.ts', 'lite/main-window/window.ts');

  it('the bar is the window header on macOS (title bar hidden, traffic lights inset), gated to darwin', () => {
    const s = windowSrc();
    const i = s.indexOf("titleBarStyle: 'hiddenInset'");
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i - 120, i)).toContain("process.platform === 'darwin'");
    expect(s).toContain('trafficLightPosition: { x: 14, y: 18 }');
    const css = read('main-window/chrome.css', 'lite/main-window/chrome.css');
    expect(css).toContain('html[data-platform="darwin"] .tab-bar');
  });

  it('every view is sampled at the seam: a thin top strip, on load, in-page nav, theme-color, and on an interval', () => {
    const s = windowSrc();
    const fn = s.indexOf('function startToneSampler(');
    expect(fn).toBeGreaterThan(-1);
    const block = s.slice(fn, fn + 3200);
    expect(block).toContain('capturePage({');
    expect(block).toContain('height: TONE_STRIP_HEIGHT_PX');
    expect(block).toContain("on('did-finish-load', settle)");
    expect(block).toContain("on('did-navigate-in-page'");
    expect(block).toContain("on('did-change-theme-color'");
    expect(block).toContain('setInterval(');
    expect(block).toContain('if (!view.getVisible()) return;'); // never forces a hidden capture
    // Both the tabs and the Home view get one.
    expect(s).toContain('startToneSampler(win, view, tab.id)');
    expect(s).toContain('startToneSampler(win, view, null)');
  });

  it('the chrome hears about the ACTIVE content only, deduped, and null when the boot chat is under the bar', () => {
    const s = windowSrc();
    const fn = s.indexOf('function publishActiveTone(');
    const block = s.slice(fn, fn + 1400);
    expect(block).toContain('if (activeAttachedTabId !== null)');
    expect(block).toContain('if (homeFeedView.getVisible()) current = homeTone;');
    expect(block).toContain('if (key === lastPublishedTone) return;');
    expect(block).toContain('win.webContents.send(CONTENT_TONE_CHANNEL, payload)');
    // A tab switch publishes the cached tone and re-samples the new view.
    const rec = s.indexOf('function reconcileViews(');
    expect(s.indexOf('publishActiveTone(win);', rec)).toBeGreaterThan(rec);
    expect(s.indexOf('sampleToneNow()', rec)).toBeGreaterThan(rec);
  });

  it('preload bridges the channel; the chrome paints the bar in the colour with matching ink', () => {
    const preload = read('preload-lite.ts', 'lite/preload-lite.ts');
    expect(preload).toContain("const MAIN_WINDOW_CONTENT_TONE = 'lite:main-window:content-tone';");
    expect(preload).toContain('onContentTone: (handler) => {');
    const chrome = read('main-window/chrome.ts', 'lite/main-window/chrome.ts');
    expect(chrome).toContain('mw.onContentTone(applyContentTone)');
    expect(chrome).toContain("bar.dataset['tone'] = payload.tone;");
    expect(chrome).toContain("bar.style.setProperty('--chrome-content-color', payload.color);");
    const css = read('main-window/chrome.css', 'lite/main-window/chrome.css');
    expect(css).toContain('background: var(--chrome-content-color, var(--or-bg-shell));');
    expect(css).toContain('.tab-bar[data-tone="dark"] {\n  --bar-ink-rgb: var(--or-tone-dark-ink-rgb);');
    expect(css).toContain('.tab-bar[data-tone="light"] {\n  --bar-ink-rgb: var(--or-tone-light-ink-rgb);');
    // No control in the bar bypasses the ladder with a theme text token.
    const barRules = css.slice(css.indexOf('.tab-bar-refresh-btn {'), css.indexOf('.tab-pill-close {'));
    expect(barRules).not.toMatch(/var\(--or-text-(muted|secondary|primary)\)/);
  });

  it('the tone ink tokens exist in both theme blocks, invariant', () => {
    const sig = read('signature.css', 'lite/signature.css');
    expect(sig.match(/--or-tone-dark-ink-rgb: 255, 255, 255;/g)?.length).toBe(2);
    expect(sig.match(/--or-tone-light-ink-rgb: 17, 20, 28;/g)?.length).toBe(2);
  });
});
