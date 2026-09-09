/**
 * ADR-098 — tile previews and detail blocks for the registry kinds:
 * they paint from what the list projection carries, never blank, and
 * the detail blocks embed what can be embedded.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildRegistryDetailBlock,
  buildRegistryTilePreview,
  extractFontFamilies,
  extractHexColors,
  flattenColors,
  flattenTypography,
  parseConversation,
  parseDelimitedHead,
  parseNotebook,
  registryBlockOwnsContent,
  tileFacts,
} from '../../spaces/asset-previews.js';

function preview(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'spaces-card-preview';
  return el;
}

describe('buildRegistryTilePreview', () => {
  it('leaves the classic kinds to their own builders', () => {
    expect(buildRegistryTilePreview({ id: '1', title: 'T', kind: 'text' }, preview())).toBe(false);
    expect(buildRegistryTilePreview({ id: '1', title: 'T', kind: 'image', fileKey: 'k' }, preview())).toBe(false);
    expect(buildRegistryTilePreview({ id: '1', title: 'T', kind: 'url', sourceUrl: 'https://x.io' }, preview())).toBe(false);
    expect(buildRegistryTilePreview({ id: '1', title: 'T', kind: 'playbook' }, preview())).toBe(false);
  });

  it('paints every registry kind and sets its accent', () => {
    for (const kind of ['tool', 'presentation', 'code', 'data', 'design', 'flow', 'notebook', 'styleguide', 'conversation', 'meeting', 'monitor']) {
      const el = preview();
      expect(buildRegistryTilePreview({ id: '1', title: `Sample ${kind}`, kind }, el), kind).toBe(true);
      expect(el.children.length, kind).toBeGreaterThan(0);
      expect(el.style.getPropertyValue('--tile-accent').length, kind).toBeGreaterThan(0);
    }
  });

  it('code shows the first lines and the language; data a mini table; style guide swatches', () => {
    const code = preview();
    buildRegistryTilePreview({ id: '1', title: 'x', kind: 'code', contentHead: 'a\nb\nc\nd\ne\nf\ng\nh\ni', metadata: { language: 'python', lineCount: 9 } }, code);
    expect(code.querySelector('pre')?.textContent).toBe('a\nb\nc\nd\ne\nf\ng');
    expect(code.textContent).toContain('python');
    expect(code.textContent).toContain('9 lines');
    const data = preview();
    buildRegistryTilePreview({ id: '1', title: 'x', kind: 'data', contentHead: 'name,email\nAda,a@x.io\nGrace,g@x.io', metadata: { rowCount: 2, columnCount: 2 } }, data);
    expect(data.querySelectorAll('tr').length).toBe(3);
    expect(data.querySelector('th')?.textContent).toBe('name');
    const sg = preview();
    buildRegistryTilePreview({ id: '1', title: 'x', kind: 'styleguide', contentHead: '{"colors":{"a":"#112233","b":"#445566"}}' }, sg);
    expect(sg.querySelectorAll('.spaces-card-kindpreview-swatch').length).toBe(2);
  });

  it('a conversation head becomes bubbles; a meeting a calendar block', () => {
    const conv = preview();
    buildRegistryTilePreview({ id: '1', title: 'x', kind: 'conversation', contentHead: 'You: hi\nAssistant: hello' }, conv);
    expect(conv.querySelectorAll('.spaces-card-kindpreview-bubble').length).toBe(2);
    expect(conv.querySelector('.is-user')).not.toBeNull();
    const meet = preview();
    buildRegistryTilePreview({ id: '1', title: 'x', kind: 'meeting', metadata: { meeting_at: '2026-09-10T10:00:00.000Z', meeting_attendees: ['a', 'b'] } }, meet);
    expect(meet.querySelector('.spaces-card-kindpreview-cal-day')?.textContent).toMatch(/\d+/);
    expect(meet.textContent).toContain('2 attendees');
  });

  it('linked media with no file paints a provider tile (or the image itself)', () => {
    const vid = preview();
    expect(buildRegistryTilePreview({ id: '1', title: 'x', kind: 'video', sourceUrl: 'https://youtu.be/dQw4w9WgXcQ', metadata: { video_provider: 'YouTube' } }, vid)).toBe(true);
    expect(vid.textContent).toContain('YouTube');
    const img = preview();
    expect(buildRegistryTilePreview({ id: '1', title: 'x', kind: 'image', sourceUrl: 'https://cdn.x.io/a.png' }, img)).toBe(true);
    expect(img.querySelector('img')?.getAttribute('src')).toBe('https://cdn.x.io/a.png');
  });

  it('tileFacts formats the registry facts', () => {
    expect(tileFacts({ id: '1', title: 'x', kind: 'video', metadata: { durationSeconds: 200, video_provider: 'Vimeo' } })).toBe('3m 20s · Vimeo');
    expect(tileFacts({ id: '1', title: 'x', kind: 'tool', metadata: { tool_type: 'mcp', tool_status: 'available' } })).toBe('MCP server · Available');
    expect(tileFacts({ id: '1', title: 'x', kind: 'tool' })).toBe('');
  });
});

describe('buildRegistryDetailBlock', () => {
  const deps = {
    renderMarkdown: (s: string) => { const p = document.createElement('p'); p.className = 'md'; p.textContent = s; return p; },
    codePreview: vi.fn((s: string, lang: string) => { const pre = document.createElement('pre'); pre.className = `code-${lang}`; pre.textContent = s; return pre; }),
    csvPreview: vi.fn((s: string) => { const t = document.createElement('table'); t.className = 'csv'; t.textContent = s; return t; }),
  };

  it('is null for kinds without a block and for classic kinds', () => {
    expect(buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'text', content: 'hi' }, deps)).toBeNull();
    expect(buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'video', fileKey: 'k' }, deps)).toBeNull();
    expect(buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'flow' }, deps)).toBeNull();
  });

  it('a linked YouTube video embeds the nocookie player and links out', () => {
    const el = buildRegistryDetailBlock({ id: '1', title: 'Talk', kind: 'video', sourceUrl: 'https://youtu.be/dQw4w9WgXcQ' }, deps) as HTMLElement;
    const iframe = el.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(el.querySelector('a')?.textContent).toBe('Open on YouTube');
  });

  it('never frames a metadata embed URL off the allowlist; the recogniser beats metadata', () => {
    // No source link, hostile metadata: no iframe at all.
    const hostile = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'presentation', metadata: { presentation_embed_url: 'https://evil.example.com/embed' } }, deps);
    expect(hostile === null || hostile.querySelector('iframe') === null).toBe(true);
    // No source link, allowlisted metadata: framed.
    const fromMeta = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'presentation', metadata: { presentation_embed_url: 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/embed' } }, deps) as HTMLElement;
    expect(fromMeta.querySelector('iframe')?.getAttribute('src')).toBe('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/embed');
    // A real YouTube link with poisoned metadata: the recogniser's embed wins.
    const poisoned = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'video', sourceUrl: 'https://youtu.be/dQw4w9WgXcQ', metadata: { video_embed_url: 'https://evil.example.com/embed' } }, deps) as HTMLElement;
    expect(poisoned.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    const design = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'design', metadata: { design_embed_url: 'https://evil.example.com/embed' } }, deps);
    expect(design === null || design.querySelector('iframe') === null).toBe(true);
  });

  it('a direct video file gets a player; a deck with an embed gets a frame', () => {
    const file = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'video', sourceUrl: 'https://cdn.x.io/clip.mp4' }, deps) as HTMLElement;
    expect(file.querySelector('video')?.getAttribute('src')).toBe('https://cdn.x.io/clip.mp4');
    const deck = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'presentation', sourceUrl: 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit', metadata: { slide_count: 12 } }, deps) as HTMLElement;
    expect(deck.querySelector('iframe')?.getAttribute('src')).toBe('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/embed');
    expect(deck.querySelector('a')?.textContent).toBe('Open in Google Slides');
  });

  it('tool and meeting cards carry their facts and links', () => {
    const tool = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'tool', metadata: { tool_type: 'api', tool_endpoint: 'https://api.x.io/v1', tool_operations: ['read', 'list'], tool_auth: 'bearer', tool_docs_url: 'https://x.io/docs' } }, deps) as HTMLElement;
    expect(tool.querySelector('.spaces-detail-kind-card-kicker')?.textContent).toBe('HTTP API');
    expect(tool.querySelector('code')?.textContent).toBe('https://api.x.io/v1');
    expect(tool.querySelectorAll('.spaces-detail-kind-chip').length).toBe(2);
    // Transport / auth / status belong to the Details section, not the card.
    expect(tool.textContent).not.toContain('Bearer token');
    const meeting = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'meeting', metadata: { meeting_at: '2026-09-10T10:00:00.000Z', meeting_attendees: ['Ada'], meeting_recording_url: 'https://rec.x.io/1' } }, deps) as HTMLElement;
    expect(meeting.querySelector('.spaces-detail-kind-card-link')?.textContent).toBe('Recording');
    expect(meeting.textContent).toContain('Ada');
  });

  it('notebook cells render markdown and code through the injected renderers', () => {
    const nb = '{"cells":[{"cell_type":"markdown","source":"# Title"},{"cell_type":"code","source":["print(1)"],"outputs":[{"text":["1\\n"]}]}],"metadata":{"language_info":{"name":"python"}}}';
    const el = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'notebook', content: nb }, deps) as HTMLElement;
    expect(el.querySelector('.md')?.textContent).toBe('# Title');
    expect(el.querySelector('.code-python')?.textContent).toBe('print(1)');
    expect(el.querySelector('.spaces-detail-kind-nb-output')?.textContent).toBe('1\n');
  });

  it('style guide tokens become swatches and type samples; conversations become a thread', () => {
    const sg = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'styleguide', content: '{"colors":{"brand":{"primary":"#3f78c0"},"ink":"#1b1712"},"typography":{"body":{"fontFamily":"Inter","fontSize":14,"fontWeight":400}}}' }, deps) as HTMLElement;
    expect(sg.querySelectorAll('.spaces-detail-kind-swatch').length).toBe(2);
    expect(sg.querySelector('.spaces-detail-kind-swatch-name')?.textContent).toBe('brand/primary');
    expect(sg.querySelector('.spaces-detail-kind-type-sample')?.textContent).toContain('body');
    const conv = buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'conversation', content: '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":{"parts":["hello"]}}]}' }, deps) as HTMLElement;
    expect(conv.querySelectorAll('.spaces-detail-kind-turn').length).toBe(2);
    expect(conv.querySelector('.is-assistant .md')?.textContent).toBe('hello');
  });

  it('data and code delegate to the injected previews', () => {
    buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'data', content: 'a,b\n1,2' }, deps);
    expect(deps.csvPreview).toHaveBeenCalledWith('a,b\n1,2');
    buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'data', content: '[{"a":1}]' }, deps);
    expect(deps.codePreview).toHaveBeenCalledWith('[{"a":1}]', 'json');
    buildRegistryDetailBlock({ id: '1', title: 'x', kind: 'code', content: 'x', metadata: { language: 'go' } }, deps);
    expect(deps.codePreview).toHaveBeenCalledWith('x', 'go');
    expect(registryBlockOwnsContent('code')).toBe(true);
    expect(registryBlockOwnsContent('tool')).toBe(false);
  });
});

describe('parsers', () => {
  it('parseConversation reads exports and transcripts', () => {
    expect(parseConversation('{"messages":[{"role":"user","content":"a"}]}')).toEqual([{ role: 'user', text: 'a' }]);
    expect(parseConversation('You: a\nmore\nAssistant: b')).toEqual([{ role: 'user', text: 'a\nmore' }, { role: 'assistant', text: 'b' }]);
    expect(parseConversation('no turns here')).toEqual([]);
  });
  it('parseNotebook returns null for non-notebooks', () => {
    expect(parseNotebook('{"a":1}')).toBeNull();
    expect(parseNotebook('nope')).toBeNull();
    expect(parseNotebook('{"cells":[]}')?.cells).toEqual([]);
  });
  it('colour and font extraction, delimited heads', () => {
    expect(extractHexColors('#fff #FFF #123456 #123456')).toEqual(['#fff', '#123456']);
    expect(extractFontFamilies('"fontFamily": "Inter, sans-serif", "font-family": "Georgia"')).toEqual(['Inter', 'Georgia']);
    expect(flattenColors({ a: '#111', g: { b: { value: '#222' }, c: 'nope' } })).toEqual([{ name: 'a', value: '#111' }, { name: 'g/b', value: '#222' }]);
    expect(flattenTypography({ heading: { fontFamily: 'Georgia', fontSize: '24px' } })[0]).toMatchObject({ name: 'heading', family: 'Georgia', size: 24 });
    expect(parseDelimitedHead('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
