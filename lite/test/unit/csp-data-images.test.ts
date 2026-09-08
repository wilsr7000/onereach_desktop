/**
 * Every page that links signature.css inherits the marks kit
 * (.or-ink-underline / .or-hand / .or-sketch / .or-ink-splatter), whose
 * strokes are CSS masks over `data:` SVG images. A page whose
 * Content-Security-Policy stops at `default-src 'self'` silently drops
 * every mask — no console error, the stroke just never paints (that is
 * how the help page shipped blank underlines on 2026-09-06 until its CSP
 * grew `img-src 'self' data:`). This pins the rule for the whole surface:
 * a signature.css page either has no CSP meta or its CSP allows data:
 * images.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walkHtml(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** The CSP meta's content attribute, or null when the page declares none. */
export function cspOf(html: string): string | null {
  const meta = html.match(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
  if (meta === null) return null;
  // The value itself is full of single quotes ('self', 'unsafe-inline'),
  // so match each quoting style on its own.
  const content = meta[0].match(/content="([^"]*)"/i) ?? meta[0].match(/content='([^']*)'/i);
  return content === null ? '' : (content[1] ?? '');
}

/** True when the policy lets `data:` images load (the marks are masks over data: SVGs). */
export function allowsDataImages(csp: string | null): boolean {
  if (csp === null) return true;
  const directives = csp.split(';').map((d) => d.trim()).filter((d) => d.length > 0);
  const img = directives.find((d) => /^img-src(\s|$)/.test(d));
  if (img !== undefined) return /\sdata:(\s|$)/.test(`${img} `);
  const def = directives.find((d) => /^default-src(\s|$)/.test(d));
  if (def === undefined) return true;
  return /\sdata:(\s|$)/.test(`${def} `);
}

describe('pages that link signature.css allow data: images (the marks kit paints as masks)', () => {
  const pages = walkHtml(LITE_ROOT).filter((file) =>
    /signature\.css/.test(fs.readFileSync(file, 'utf8'))
  );

  it('finds the signature.css pages', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  for (const file of pages) {
    it(`${path.relative(LITE_ROOT, file)} lets data: images through its CSP`, () => {
      const csp = cspOf(fs.readFileSync(file, 'utf8'));
      expect(allowsDataImages(csp), `CSP: ${csp ?? '(none)'}`).toBe(true);
    });
  }
});

describe('allowsDataImages', () => {
  it('reads an explicit img-src', () => {
    expect(allowsDataImages("default-src 'self'; img-src 'self' data:; script-src 'self'")).toBe(true);
    expect(allowsDataImages("default-src 'self'; img-src 'self' https:; script-src 'self'")).toBe(false);
  });

  it('falls back to default-src when img-src is absent', () => {
    expect(allowsDataImages("default-src 'self'; style-src 'self' 'unsafe-inline'")).toBe(false);
    expect(allowsDataImages("default-src 'self' data:")).toBe(true);
    expect(allowsDataImages("style-src 'self'")).toBe(true);
  });

  it('treats a page without a CSP as open', () => {
    expect(allowsDataImages(null)).toBe(true);
    expect(cspOf('<html><head></head></html>')).toBeNull();
  });

  it('parses a multi-line meta', () => {
    const html = `<meta\n      http-equiv="Content-Security-Policy"\n      content="default-src 'self'; img-src 'self' data:"\n    />`;
    expect(cspOf(html)).toBe("default-src 'self'; img-src 'self' data:");
  });
});
