/**
 * ADR-098 — a pasted address is recognised for what it is: the
 * provider, the id, the embed form, and the kind it implies.
 */

import { describe, it, expect } from 'vitest';
import { describeLink, linkMetadata, normalizeHttpUrl, titleFromUrl, domainOf } from '../../spaces/link-embeds.js';

describe('normalizeHttpUrl', () => {
  it('defaults the scheme and rejects non-http', () => {
    expect(normalizeHttpUrl('example.com/x')).toBe('https://example.com/x');
    expect(normalizeHttpUrl('  https://a.b/c ')).toBe('https://a.b/c');
    expect(normalizeHttpUrl('ftp://a.b/c')).toBeNull();
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('nodots')).toBeNull();
    expect(normalizeHttpUrl('')).toBeNull();
  });
});

describe('describeLink', () => {
  it('YouTube in every spelling → video with a nocookie embed', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      const info = describeLink(u);
      expect(info?.provider).toBe('youtube');
      expect(info?.kind).toBe('video');
      expect(info?.id).toBe('dQw4w9WgXcQ');
      expect(info?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    }
  });
  it('Vimeo and Loom → video', () => {
    expect(describeLink('https://vimeo.com/123456789')?.embedUrl).toBe('https://player.vimeo.com/video/123456789');
    expect(describeLink('https://www.loom.com/share/0123456789abcdef0123456789abcdef')?.embedUrl).toBe(
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef'
    );
  });
  it('Google Slides → presentation; published decks embed as /d/e/', () => {
    const priv = describeLink('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit#slide=id.p');
    expect(priv?.kind).toBe('presentation');
    expect(priv?.provider).toBe('google-slides');
    expect(priv?.embedUrl).toBe('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/embed');
    const pub = describeLink('https://docs.google.com/presentation/d/e/2PACX-1vQabcdefg/pub?start=false');
    expect(pub?.embedUrl).toBe('https://docs.google.com/presentation/d/e/2PACX-1vQabcdefg/embed');
  });
  it('Google Docs → document, Sheets → data', () => {
    expect(describeLink('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit')?.kind).toBe('document');
    expect(describeLink('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit')?.kind).toBe('data');
  });
  it('Figma → design with an embed', () => {
    const info = describeLink('https://www.figma.com/design/AbCdEf123456/My-File?node-id=1');
    expect(info?.kind).toBe('design');
    expect(info?.provider).toBe('figma');
    expect(info?.embedUrl).toContain('https://www.figma.com/embed?embed_host=onereach&url=');
  });
  it('Canva and Pitch → presentation', () => {
    expect(describeLink('https://www.canva.com/design/DAFabc123/view')?.kind).toBe('presentation');
    expect(describeLink('https://pitch.com/public/abcdef12-3456')?.kind).toBe('presentation');
  });
  it('GSX Designer flow link → flow with the flow id', () => {
    const info = describeLink('https://studio.edison.onereach.ai/flows/bot-1/flow-42');
    expect(info?.kind).toBe('flow');
    expect(info?.id).toBe('flow-42');
  });
  it('direct media files → their kind, playable as-is', () => {
    expect(describeLink('https://cdn.example.com/clip.mp4')?.kind).toBe('video');
    expect(describeLink('https://cdn.example.com/clip.mp4')?.embedUrl).toBe('https://cdn.example.com/clip.mp4');
    expect(describeLink('https://cdn.example.com/talk.mp3?x=1')?.kind).toBe('audio');
    expect(describeLink('https://cdn.example.com/a.png')?.kind).toBe('image');
  });
  it('anything else is a plain link with its domain', () => {
    const info = describeLink('https://www.example.com/docs/getting-started');
    expect(info?.provider).toBe('link');
    expect(info?.kind).toBe('url');
    expect(info?.domain).toBe('example.com');
    expect(info?.embedUrl).toBeNull();
    expect(describeLink('not a url')).toBeNull();
  });
});

describe('titleFromUrl / domainOf / linkMetadata', () => {
  it('de-slugs the last MEANINGFUL path segment, else the domain', () => {
    expect(titleFromUrl('https://example.com/docs/getting-started')).toBe('Getting started');
    expect(titleFromUrl('https://example.com/')).toBe('example.com');
    expect(titleFromUrl('https://example.com/a1b2c3d4e5f6a1b2')).toBe('example.com');
    // `/edit`, `/view`, `/d/<id>` name a mode or an id, never the thing.
    expect(titleFromUrl('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUv/edit')).toBe('docs.google.com');
    expect(titleFromUrl('https://www.figma.com/design/AbCdEf123456/Checkout-flow?node-id=1')).toBe('Checkout flow');
    expect(titleFromUrl('https://acme.example.com/pricing/index.html')).toBe('Pricing');
  });
  it('domainOf drops www', () => {
    expect(domainOf('https://www.example.com/x')).toBe('example.com');
  });
  it('linkMetadata writes the provider facts the tile shows', () => {
    const yt = describeLink('https://youtu.be/dQw4w9WgXcQ');
    expect(yt).not.toBeNull();
    const meta = linkMetadata(yt as NonNullable<typeof yt>);
    expect(meta).toMatchObject({ link_domain: 'youtu.be', video_provider: 'YouTube', video_id: 'dQw4w9WgXcQ' });
    const fig = describeLink('https://www.figma.com/file/AbCdEf123456/x');
    expect(linkMetadata(fig as NonNullable<typeof fig>)['design_tool']).toBe('figma');
  });
});
