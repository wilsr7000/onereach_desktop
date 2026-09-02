/**
 * Content tone -- is what is under the tab bar dark or light?
 *
 * The main window's header (the tab bar) matches the content beneath
 * it (2026-09-01: "detect if the content in the electron window is
 * dark or light and change the header to match"). The main process
 * captures a thin strip of the active view's top edge and this module
 * turns those pixels into a tone + the mean colour, so the bar can
 * paint itself in the page's own colour with ink that reads on it.
 *
 * Pure and electron-free so it unit-tests without a display.
 *
 * Thresholds: relative luminance (WCAG) of the mean colour. White ink
 * and black ink have equal contrast on a surface at L ≈ 0.18; the band
 * around it is hysteresis so a page hovering near the middle does not
 * flicker the bar between the two inks on every re-sample.
 */

export type Tone = 'dark' | 'light';

export interface ContentTone {
  tone: Tone;
  /** WCAG relative luminance of the mean colour, 0..1. */
  luminance: number;
  /** Mean colour of the strip as `#rrggbb`. */
  color: string;
}

/** Below this, white ink; above TONE_LIGHT_ABOVE, dark ink; between: keep the previous tone. */
export const TONE_DARK_BELOW = 0.16;
export const TONE_LIGHT_ABOVE = 0.21;

function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB colour (0..255 channels). */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function classifyTone(luminance: number, previous: ContentTone | null): Tone {
  if (luminance < TONE_DARK_BELOW) return 'dark';
  if (luminance > TONE_LIGHT_ABOVE) return 'light';
  if (previous !== null) return previous.tone;
  return luminance < (TONE_DARK_BELOW + TONE_LIGHT_ABOVE) / 2 ? 'dark' : 'light';
}

export function hexFromRgb(r: number, g: number, b: number): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Tone of a BGRA bitmap (what `NativeImage.toBitmap()` returns). Fully
 * transparent pixels are skipped; a bitmap with nothing opaque yields
 * null so the caller keeps its last answer. Large strips are
 * subsampled -- a few thousand pixels are plenty for a mean.
 */
export function toneFromBgra(
  pixels: Uint8Array,
  width: number,
  height: number,
  previous: ContentTone | null = null
): ContentTone | null {
  const count = Math.floor(width) * Math.floor(height);
  if (count <= 0 || pixels.length < count * 4) return null;
  const stride = Math.max(1, Math.floor(count / 4096));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let p = 0; p < count; p += stride) {
    const i = p * 4;
    const alpha = pixels[i + 3] ?? 255;
    if (alpha === 0) continue;
    b += pixels[i] ?? 0;
    g += pixels[i + 1] ?? 0;
    r += pixels[i + 2] ?? 0;
    n += 1;
  }
  if (n === 0) return null;
  r /= n;
  g /= n;
  b /= n;
  const luminance = relativeLuminance(r, g, b);
  return { tone: classifyTone(luminance, previous), luminance, color: hexFromRgb(r, g, b) };
}

/**
 * Tone of a page-declared colour (`<meta name="theme-color">`, which
 * Electron reports through `did-change-theme-color`). A cheap early
 * hint before the first pixel sample; null for anything unparseable.
 */
export function toneFromHex(hex: string | null | undefined, previous: ContentTone | null = null): ContentTone | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const digits = m[1] ?? '';
  const full = digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = relativeLuminance(r, g, b);
  return { tone: classifyTone(luminance, previous), luminance, color: hexFromRgb(r, g, b) };
}
