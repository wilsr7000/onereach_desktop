/**
 * The Spaces window frames only the providers it recognises (ADR-098,
 * 2026-09-09 pre-release review): spaces.html's `frame-src` and the
 * EMBED_HOSTS allowlist in link-embeds.ts are the same list, and every
 * embed URL the recogniser produces lives on one of those hosts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBED_HOSTS, describeLink, safeEmbedUrl } from '../../spaces/link-embeds.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '../../spaces/spaces.html'), 'utf8');

function directive(name: string): string[] {
  const m = new RegExp(`${name}\\s+([^;"]+)`).exec(html);
  expect(m, `${name} directive missing`).not.toBeNull();
  return (m as RegExpExecArray)[1]!.trim().split(/\s+/);
}

describe('embed CSP', () => {
  it('frame-src lists exactly self, data:, blob: and the allowlisted provider hosts', () => {
    const tokens = directive('frame-src');
    expect(tokens.slice(0, 3)).toEqual(["'self'", 'data:', 'blob:']);
    expect(tokens.slice(3).sort()).toEqual(EMBED_HOSTS.map((h) => `https://${h}`).sort());
    expect(tokens).not.toContain('https:');
  });

  it('every recognised embed URL is on an allowlisted host', () => {
    const samples = [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://vimeo.com/123456789',
      'https://www.loom.com/share/0123456789abcdef0123456789abcdef',
      'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit',
      'https://www.canva.com/design/DAFabc123/view',
      'https://pitch.com/public/abcdef12-3456',
      'https://www.figma.com/design/AbCdEf123456/x',
    ];
    for (const s of samples) {
      const info = describeLink(s);
      expect(info?.embedUrl, s).not.toBeNull();
      expect(safeEmbedUrl(info?.embedUrl), s).toBe(info?.embedUrl);
    }
  });

  it('safeEmbedUrl refuses other hosts, lookalikes, and plain http', () => {
    expect(safeEmbedUrl('https://evil.example.com/embed')).toBeNull();
    expect(safeEmbedUrl('https://docs.google.com.evil.example/x')).toBeNull();
    expect(safeEmbedUrl('https://notdocs.google.com/x')).toBeNull();
    expect(safeEmbedUrl('http://www.figma.com/embed?x=1')).toBeNull();
    expect(safeEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(safeEmbedUrl(42)).toBeNull();
    expect(safeEmbedUrl('https://www.youtube-nocookie.com/embed/abc')).toBe('https://www.youtube-nocookie.com/embed/abc');
  });
});
