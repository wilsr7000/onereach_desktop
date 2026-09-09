/**
 * ADR-098 — the Add-asset dialog's kind picker and generated forms:
 * every creatable kind is a card, typing narrows, arrows walk, and a
 * draft becomes the payload the bridge needs with the metadata the
 * body implies.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXISTING_MODE,
  buildCreatePayload,
  builtinPaneFor,
  deriveBodyMetadata,
  describeBody,
  guessLanguage,
  isRegistryMode,
  pickerKindIds,
  pickerMatches,
  readRegistryDraft,
  registryMode,
  renderKindBar,
  renderKindPicker,
  renderRegistryPane,
  setRegistryFile,
  switchRegistryMode,
  tearDownRegistryPane,
  validateRegistryDraft,
  type RegistryDraft,
} from '../../spaces/asset-forms.js';
import { creatableKinds, kindSpec } from '../../spaces/asset-kinds.js';

beforeEach(() => {
  document.body.innerHTML = '';
  tearDownRegistryPane();
});

describe('kind picker', () => {
  it('renders one card per creatable kind plus the existing-asset card, grouped', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderKindPicker(host, { onPick: () => undefined });
    const ids = Array.from(host.querySelectorAll<HTMLElement>('.spaces-kindpicker-card')).map((c) => c.getAttribute('data-kind'));
    expect(ids).toEqual(pickerKindIds());
    expect(ids).toContain('tool');
    expect(ids).toContain('presentation');
    expect(ids).toContain('video');
    expect(ids).toContain(EXISTING_MODE);
    expect(ids).not.toContain('playbook');
    expect(host.querySelectorAll('.spaces-kindpicker-group').length).toBeGreaterThanOrEqual(5);
  });

  it('typing narrows the cards; Enter with one match picks it', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onPick = vi.fn();
    renderKindPicker(host, { onPick });
    const filter = host.querySelector<HTMLInputElement>('.spaces-kindpicker-filter') as HTMLInputElement;
    filter.value = 'slides';
    filter.dispatchEvent(new Event('input'));
    const visible = Array.from(host.querySelectorAll<HTMLElement>('.spaces-kindpicker-card')).filter((c) => !c.hidden);
    expect(visible.map((c) => c.getAttribute('data-kind'))).toEqual(['presentation']);
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onPick).toHaveBeenCalledWith('presentation');
    filter.value = 'zzzz-nothing';
    filter.dispatchEvent(new Event('input'));
    expect((host.querySelector('.spaces-kindpicker-empty') as HTMLElement).hidden).toBe(false);
  });

  it('matches by alias and hint, not just label', () => {
    expect(pickerMatches(kindSpec('presentation'), 'deck')).toBe(true);
    expect(pickerMatches(kindSpec('tool'), 'mcp')).toBe(true);
    expect(pickerMatches(kindSpec('video'), 'youtube')).toBe(true);
    expect(pickerMatches(kindSpec('code'), 'slides')).toBe(false);
  });

  it('arrow keys move between cards and Enter picks the focused one', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onPick = vi.fn();
    renderKindPicker(host, { onPick });
    const cards = Array.from(host.querySelectorAll<HTMLButtonElement>('.spaces-kindpicker-card'));
    cards[0]!.focus();
    cards[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(cards[1]);
    cards[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onPick).toHaveBeenCalledWith(cards[1]!.getAttribute('data-kind'));
  });

  it('the kind bar names the pick and offers Change', () => {
    const bar = document.createElement('div');
    const onChange = vi.fn();
    renderKindBar(bar, 'tool', onChange);
    expect(bar.querySelector('.spaces-kindbar-label')?.textContent).toBe('Tool');
    (bar.querySelector('.spaces-kindbar-change') as HTMLButtonElement).click();
    expect(onChange).toHaveBeenCalled();
    renderKindBar(bar, EXISTING_MODE, onChange);
    expect(bar.querySelector('.spaces-kindbar-label')?.textContent).toBe('Existing asset');
  });
});

describe('pane routing', () => {
  it('hand-built panes keep their kinds; every other creatable kind is a registry pane', () => {
    expect(builtinPaneFor('text')).toBe('text');
    expect(builtinPaneFor('document')).toBe('upload');
    expect(builtinPaneFor('other')).toBe('upload');
    expect(builtinPaneFor('agent')).toBe('agent');
    expect(builtinPaneFor('knowledge')).toBe('knowledge');
    expect(builtinPaneFor(EXISTING_MODE)).toBe(EXISTING_MODE);
    expect(builtinPaneFor('presentation')).toBeNull();
    for (const spec of creatableKinds()) {
      expect(isRegistryMode(spec.id)).toBe(spec.create?.pane === undefined);
    }
    expect(isRegistryMode(EXISTING_MODE)).toBe(false);
    expect(isRegistryMode('playbook')).toBe(false);
  });
});

describe('generated pane', () => {
  it('video: Upload and Link modes, the link input recognises YouTube', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'video', {});
    expect(registryMode()).toBe('upload');
    const modes = Array.from(host.querySelectorAll<HTMLElement>('[data-kindform-mode-btn]')).map((b) => b.getAttribute('data-kindform-mode-btn'));
    expect(modes).toEqual(['upload', 'link']);
    switchRegistryMode('link');
    expect(registryMode()).toBe('link');
    const link = host.querySelector<HTMLInputElement>('.spaces-kindform-link') as HTMLInputElement;
    link.value = 'https://youtu.be/dQw4w9WgXcQ';
    link.dispatchEvent(new Event('blur'));
    const hint = host.querySelector<HTMLElement>('[data-kindform-linkhint]') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('YouTube');
    const draft = readRegistryDraft() as RegistryDraft;
    expect(draft.link?.provider).toBe('youtube');
    expect(validateRegistryDraft(draft)).toBeNull();
    const payload = buildCreatePayload(draft, '');
    expect(payload.kind).toBe('video');
    expect(payload.sourceUrl).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(payload.metadata['video_provider']).toBe('YouTube');
    expect(payload.metadata['video_embed_url']).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(payload.title).toBe('YouTube video');
  });

  it('a web link that is really a deck suggests Slides', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSuggestKind = vi.fn();
    renderRegistryPane(host, 'url', { onSuggestKind });
    const link = host.querySelector<HTMLInputElement>('.spaces-kindform-link') as HTMLInputElement;
    link.value = 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit';
    link.dispatchEvent(new Event('blur'));
    const btn = host.querySelector<HTMLButtonElement>('.spaces-kindform-suggest') as HTMLButtonElement;
    expect(btn?.textContent).toBe('file it as Slides');
    btn.click();
    expect(onSuggestKind).toHaveBeenCalledWith('presentation');
  });

  it('code: paste mode derives the language and line count; optional details fold', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'code', {});
    const body = host.querySelector<HTMLTextAreaElement>('.spaces-kindform-body') as HTMLTextAreaElement;
    expect(body.getAttribute('data-code')).toBe('true');
    body.value = 'def hello():\n    print("hi")\n';
    body.dispatchEvent(new Event('input'));
    expect(host.querySelector<HTMLElement>('[data-kindform-bodyhint]')?.textContent).toBe('python · 2 lines');
    expect(host.querySelector('details.spaces-kindform-more')).not.toBeNull();
    const draft = readRegistryDraft() as RegistryDraft;
    const payload = buildCreatePayload(draft, 'hello.py');
    expect(payload.kind).toBe('code');
    expect(payload.content).toBe(body.value);
    expect(payload.metadata).toMatchObject({ language: 'python', lineCount: 2 });
    expect(payload.mimeType).toBe('text/plain');
    expect(payload.hasContent).toBe(true);
  });

  it('data: a pasted CSV reads its rows, columns, and headers', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'data', {});
    const body = host.querySelector<HTMLTextAreaElement>('.spaces-kindform-body') as HTMLTextAreaElement;
    body.value = 'name,email,plan\nAda,ada@x.io,pro\nGrace,g@x.io,free\n';
    body.dispatchEvent(new Event('input'));
    expect(describeBody('data', body.value)).toBe('CSV · 2 rows × 3 columns');
    const payload = buildCreatePayload(readRegistryDraft() as RegistryDraft, '');
    expect(payload.metadata).toMatchObject({ data_format: 'csv', rowCount: 2, columnCount: 3, headers: ['name', 'email', 'plan'] });
    expect(payload.mimeType).toBe('text/csv');
    expect(payload.title).toMatch(/^Data · /);
  });

  it('pasting a style guide into Data suggests filing it as a style guide', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSuggestKind = vi.fn();
    renderRegistryPane(host, 'data', { onSuggestKind });
    const body = host.querySelector<HTMLTextAreaElement>('.spaces-kindform-body') as HTMLTextAreaElement;
    body.value = '{"colors":{"primary":"#3f78c0"},"typography":{"body":{"fontFamily":"Inter"}}}';
    body.dispatchEvent(new Event('input'));
    (host.querySelector('.spaces-kindform-suggest') as HTMLButtonElement).click();
    expect(onSuggestKind).toHaveBeenCalledWith('styleguide');
  });

  it('tool: the form requires a type and, for network tools, an endpoint; the endpoint becomes the link', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'tool', {});
    expect(registryMode()).toBe('form');
    let draft = readRegistryDraft() as RegistryDraft;
    expect(validateRegistryDraft(draft)).toBe('Type is required.');
    (host.querySelector<HTMLSelectElement>('[data-kindform-field="tool_type"]') as HTMLSelectElement).value = 'mcp';
    draft = readRegistryDraft() as RegistryDraft;
    expect(validateRegistryDraft(draft)).toBe('An endpoint is required for this tool type.');
    (host.querySelector<HTMLInputElement>('[data-kindform-field="tool_endpoint"]') as HTMLInputElement).value = 'tools.example.com/mcp';
    (host.querySelector<HTMLInputElement>('[data-kindform-field="tool_operations"]') as HTMLInputElement).value = 'read, list';
    (host.querySelector<HTMLTextAreaElement>('.spaces-kindform-notes') as HTMLTextAreaElement).value = 'Call `search` first.';
    draft = readRegistryDraft() as RegistryDraft;
    expect(validateRegistryDraft(draft)).toBeNull();
    const payload = buildCreatePayload(draft, '');
    expect(payload.kind).toBe('tool');
    expect(payload.sourceUrl).toBe('https://tools.example.com/mcp');
    expect(payload.metadata).toMatchObject({ tool_type: 'mcp', tool_endpoint: 'https://tools.example.com/mcp', tool_operations: ['read', 'list'], link_domain: 'tools.example.com' });
    expect(payload.content).toBe('Call `search` first.');
    expect(payload.title).toBe('Mcp');
  });

  it('meeting: when is required; the title falls back to the date', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'meeting', {});
    expect(validateRegistryDraft(readRegistryDraft() as RegistryDraft)).toBe('When is required.');
    (host.querySelector<HTMLInputElement>('[data-kindform-field="meeting_at"]') as HTMLInputElement).value = '2026-09-10T10:00';
    (host.querySelector<HTMLInputElement>('[data-kindform-field="meeting_attendees"]') as HTMLInputElement).value = 'Ada, Grace';
    const payload = buildCreatePayload(readRegistryDraft() as RegistryDraft, '');
    expect(payload.metadata['meeting_attendees']).toEqual(['Ada', 'Grace']);
    expect(typeof payload.metadata['meeting_at']).toBe('string');
    expect(payload.title).toMatch(/^Meeting · /);
  });

  it('monitor: the address is required and is both the link and monitor_url', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'monitor', {});
    expect(validateRegistryDraft(readRegistryDraft() as RegistryDraft)).toBe('Address is required.');
    (host.querySelector<HTMLInputElement>('[data-kindform-field="monitor_url"]') as HTMLInputElement).value = 'https://example.com/pricing';
    const payload = buildCreatePayload(readRegistryDraft() as RegistryDraft, '');
    expect(payload.sourceUrl).toBe('https://example.com/pricing');
    expect(payload.metadata['monitor_url']).toBe('https://example.com/pricing');
    expect(payload.title).toBe('Watch Pricing');
  });

  it('upload: a file lands in the chip, retitles, and rides the upload pipeline', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onFile = vi.fn();
    renderRegistryPane(host, 'presentation', { onFile });
    const file = new File(['x'], 'roadmap.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    setRegistryFile(file);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(host.querySelector('.spaces-kindform-file-chip')?.textContent).toContain('roadmap.pptx');
    const draft = readRegistryDraft() as RegistryDraft;
    expect(validateRegistryDraft(draft)).toBeNull();
    const payload = buildCreatePayload(draft, '');
    expect(payload.file).toBe(file);
    expect(payload.title).toBe('roadmap.pptx');
    expect(payload.kind).toBe('presentation');
  });

  it('upload: a file of another kind offers to refile it', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSuggestKind = vi.fn();
    renderRegistryPane(host, 'presentation', { onSuggestKind });
    setRegistryFile(new File(['x'], 'notes.ipynb', { type: '' }));
    const btn = host.querySelector<HTMLButtonElement>('.spaces-kindform-suggest') as HTMLButtonElement;
    expect(btn?.textContent).toBe('file it as Notebook');
    btn.click();
    expect(onSuggestKind).toHaveBeenCalledWith('notebook');
  });

  it('validation names the missing piece for paste and link modes', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRegistryPane(host, 'journey', {});
    expect(validateRegistryDraft(readRegistryDraft() as RegistryDraft)).toBe('Paste the stages first — that is the asset.');
    renderRegistryPane(host, 'url', {});
    expect(validateRegistryDraft(readRegistryDraft() as RegistryDraft)).toBe('Paste the address first.');
    (host.querySelector<HTMLInputElement>('.spaces-kindform-link') as HTMLInputElement).value = 'not a url';
    expect(validateRegistryDraft(readRegistryDraft() as RegistryDraft)).toMatch(/not a web address/);
  });
});

describe('deriveBodyMetadata', () => {
  it('style guide: colours and fonts from tokens', () => {
    const meta = deriveBodyMetadata('styleguide', '{"colors":{"brand":{"primary":"#3f78c0","ink":"#1b1712"}},"typography":{"body":{"fontFamily":"Inter, sans-serif","fontSize":14}}}');
    expect(meta).toMatchObject({ styleguide_colors: 2, styleguide_fonts: ['Inter'] });
  });
  it('conversation: turns and provider from a JSON export and from text', () => {
    const json = deriveBodyMetadata('conversation', '{"model":"gpt-5.2","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]}');
    expect(json).toMatchObject({ conversation_messages: 2, conversation_model: 'gpt-5.2' });
    const text = deriveBodyMetadata('conversation', 'You: hi\nClaude: hello there\nYou: thanks');
    expect(text).toMatchObject({ conversation_messages: 3, conversation_provider: 'claude' });
  });
  it('journey: stages; notebook: cells; flow: steps; json data: rows', () => {
    expect(deriveBodyMetadata('journey', '## 1. Discover\n\n## 2. Evaluate\n')).toMatchObject({ journey_stage_count: 2 });
    expect(deriveBodyMetadata('notebook', '{"cells":[{"cell_type":"markdown","source":"# T"},{"cell_type":"code","source":["print(1)"]}],"metadata":{"kernelspec":{"display_name":"Python 3"},"language_info":{"name":"python"}}}')).toMatchObject({ notebook_cells: 2, notebook_code_cells: 1, notebook_kernel: 'Python 3', notebook_language: 'python' });
    expect(deriveBodyMetadata('flow', '{"flowId":"f1","botId":"b1","data":{"trees":{"main":{"steps":[{},{},{}]}}}}')).toMatchObject({ flow_id: 'f1', flow_bot_id: 'b1', flow_step_count: 3 });
    expect(deriveBodyMetadata('data', '[{"a":1,"b":2},{"a":3,"b":4}]')).toMatchObject({ data_format: 'json', rowCount: 2, columnCount: 2, headers: ['a', 'b'] });
  });
  it('code: extension beats shebang beats a guess', () => {
    expect(deriveBodyMetadata('code', 'x = 1', 'thing.rb')['language']).toBe('ruby');
    expect(deriveBodyMetadata('code', '#!/usr/bin/env node\nconsole.log(1)')['language']).toBe('javascript');
    expect(guessLanguage('SELECT * FROM t WHERE x = 1')).toBe('sql');
    expect(guessLanguage('const a = 1;\nfunction f() {}')).toBe('javascript');
    expect(guessLanguage('plain words here')).toBeNull();
  });
});
