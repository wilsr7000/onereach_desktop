/**
 * Tile previews and detail blocks for the registry kinds (ADR-098).
 *
 * The renderer's `buildAssetTilePreview` / `buildDetailTypeBlock`
 * switches keep their hand-built branches for the original kinds; every
 * kind added by the registry lands here. Each preview reads what the
 * LIST projection already carries (metadata facts, `contentHead`, the
 * source URL) so a grid of a hundred tiles costs no extra round-trips,
 * and each detail block reads the full item.
 *
 * Pure DOM: no bridge calls, no module state. Markdown / code / CSV
 * rendering is injected (`PreviewDeps`) because those renderers live in
 * spaces.ts, which imports this module — a direct import would be a
 * cycle. Exported for jsdom tests.
 */

import { kindSpec, kindGlyph } from './asset-kinds.js';
import { describeLink } from './link-embeds.js';
import { formatFieldValue } from './asset-fields.js';

export interface PreviewItem {
  id: string;
  title: string;
  kind: string;
  metadata?: Record<string, unknown>;
  contentHead?: string;
  excerpt?: string;
  description?: string;
  sourceUrl?: string;
  content?: string;
  mimeType?: string;
  fileKey?: string;
}

export interface PreviewDeps {
  renderMarkdown?: (source: string) => HTMLElement;
  codePreview?: (source: string, language: string) => HTMLElement;
  csvPreview?: (source: string) => HTMLElement;
}

// ─── Small DOM helpers ────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function meta(item: PreviewItem): Record<string, unknown> {
  return item.metadata !== undefined && item.metadata !== null ? item.metadata : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x) => x.length > 0);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  return [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/** A row of small chips. Empty input → no node. */
function chips(values: readonly string[], className: string, max = 4): HTMLElement | null {
  const items = values.slice(0, max);
  if (items.length === 0) return null;
  const row = el('div', `${className}-chips`);
  for (const v of items) row.appendChild(el('span', `${className}-chip`, v));
  if (values.length > max) row.appendChild(el('span', `${className}-chip is-more`, `+${values.length - max}`));
  return row;
}

/** The facts line under a tile: the kind's `facts` keys, formatted. */
export function tileFacts(item: PreviewItem): string {
  const spec = kindSpec(item.kind);
  const m = meta(item);
  const parts: string[] = [];
  for (const key of spec.facts) {
    const field = spec.fields.find((f) => f.key === key);
    const v = m[key];
    if (v === undefined || v === null || v === '') continue;
    const text = field !== undefined ? formatFieldValue(field, v) : str(v);
    if (text.length > 0) parts.push(field !== undefined && field.type === 'number' && !/count|rows|columns|cells|slides|frames|changes|steps|messages|lines|pages|words/i.test(field.key) ? `${field.label} ${text}` : text);
  }
  return parts.join(' · ');
}

/** Facts row element (or null when there is nothing to say). */
function factsRow(item: PreviewItem, className: string): HTMLElement | null {
  const text = tileFacts(item);
  if (text.length === 0) return null;
  return el('div', `${className}-facts`, text);
}

function glyphBadge(item: PreviewItem, className: string): HTMLElement {
  const badge = el('div', `${className}-glyph`, kindGlyph(item.kind));
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

// ─── Content parsers (defensive — heads are truncated) ────────────────

/** First N lines of a CSV/TSV head as cells. */
export function parseDelimitedHead(text: string, maxRows = 4, maxCols = 4): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, maxRows);
  if (lines.length === 0) return [];
  const delim = (lines[0] ?? '').includes('\t') ? '\t' : (lines[0] ?? '').includes(';') && !(lines[0] ?? '').includes(',') ? ';' : ',';
  return lines.map((l) => l.split(delim).slice(0, maxCols).map((c) => c.trim().replace(/^"|"$/g, '')));
}

/** Hex colours in a token document head, deduplicated, in order. */
export function extractHexColors(text: string, max = 8): string[] {
  const out: string[] = [];
  const re = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < max) {
    const c = m[0].toLowerCase();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Font families named in a token document (`"fontFamily": "Inter"`). */
export function extractFontFamilies(text: string, max = 4): string[] {
  const out: string[] = [];
  const re = /"font(?:Family|-family)"\s*:\s*"([^"]{2,60})"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < max) {
    const f = (m[1] ?? '').split(',')[0]?.trim() ?? '';
    if (f.length > 0 && !out.includes(f)) out.push(f);
  }
  return out;
}

export interface ChatTurn {
  role: string;
  text: string;
}

/**
 * Turns from a conversation body: a JSON export (`{messages:[{role,
 * content}]}`, the ChatGPT `mapping` shape is NOT walked — it lands as
 * data) or a text transcript with `Role:` line prefixes.
 */
export function parseConversation(text: string, max = 200): ChatTurn[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['messages'])
          ? ((parsed as Record<string, unknown>)['messages'] as unknown[])
          : null;
      if (arr !== null) {
        const turns: ChatTurn[] = [];
        for (const m of arr) {
          if (m === null || typeof m !== 'object') continue;
          const r = m as Record<string, unknown>;
          const role = str(r['role']) || str((r['author'] as Record<string, unknown> | undefined)?.['role']) || str(r['author']) || 'user';
          let content = r['content'];
          if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
            const parts = (content as Record<string, unknown>)['parts'];
            content = Array.isArray(parts) ? parts.map((p) => (typeof p === 'string' ? p : '')).join('\n') : str((content as Record<string, unknown>)['text']);
          } else if (Array.isArray(content)) {
            content = content.map((p) => (typeof p === 'string' ? p : str((p as Record<string, unknown>)['text']))).join('\n');
          }
          const body = str(content);
          if (body.length === 0) continue;
          turns.push({ role, text: body });
          if (turns.length >= max) break;
        }
        return turns;
      }
    } catch {
      // fall through to the text parser
    }
  }
  const turns: ChatTurn[] = [];
  const lineRe = /^\s*(?:\*\*)?(you|user|me|human|assistant|ai|bot|system|claude|chatgpt|gemini|copilot|gsx|[A-Z][\w .-]{0,24})(?:\*\*)?\s*:\s*(.*)$/i;
  let current: ChatTurn | null = null;
  for (const raw of trimmed.split(/\r?\n/)) {
    const m = lineRe.exec(raw);
    if (m !== null) {
      if (current !== null) turns.push(current);
      const who = (m[1] ?? '').toLowerCase();
      const role = /^(you|user|me|human)$/.test(who) ? 'user' : /^(assistant|ai|bot|claude|chatgpt|gemini|copilot|gsx)$/.test(who) ? 'assistant' : m[1] ?? 'user';
      current = { role, text: (m[2] ?? '').trim() };
      if (turns.length >= max) break;
    } else if (current !== null) {
      current.text = `${current.text}\n${raw}`.trim();
    }
  }
  if (current !== null && turns.length < max) turns.push(current);
  return turns;
}

export interface NotebookCell {
  type: 'markdown' | 'code' | 'raw';
  source: string;
  outputs: string[];
}

export interface NotebookSummary {
  kernel: string;
  language: string;
  cells: NotebookCell[];
}

/** A parsed `.ipynb`, or null when the body is not one. */
export function parseNotebook(text: string): NotebookSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o['cells'])) return null;
  const md = (o['metadata'] ?? {}) as Record<string, unknown>;
  const kernelSpec = (md['kernelspec'] ?? {}) as Record<string, unknown>;
  const langInfo = (md['language_info'] ?? {}) as Record<string, unknown>;
  // Sources are arrays of line fragments; joined verbatim (never
  // trimmed — indentation is the code).
  const join = (src: unknown): string => (Array.isArray(src) ? src.map((s) => (typeof s === 'string' ? s : '')).join('') : typeof src === 'string' ? src : '');
  const cells: NotebookCell[] = [];
  for (const c of o['cells'] as unknown[]) {
    if (c === null || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const type = r['cell_type'] === 'markdown' ? 'markdown' : r['cell_type'] === 'code' ? 'code' : 'raw';
    const outputs: string[] = [];
    if (Array.isArray(r['outputs'])) {
      for (const out of r['outputs'] as unknown[]) {
        if (out === null || typeof out !== 'object') continue;
        const ro = out as Record<string, unknown>;
        if (ro['text'] !== undefined) outputs.push(join(ro['text']));
        else if (ro['data'] !== null && typeof ro['data'] === 'object') {
          const d = ro['data'] as Record<string, unknown>;
          if (d['text/plain'] !== undefined) outputs.push(join(d['text/plain']));
        }
      }
    }
    cells.push({ type, source: join(r['source']), outputs });
  }
  return {
    kernel: str(kernelSpec['display_name']) || str(kernelSpec['name']),
    language: str(langInfo['name']) || str(kernelSpec['language']),
    cells,
  };
}

// ─── Tile previews ────────────────────────────────────────────────────

const T = 'spaces-card-kindpreview';

/**
 * Fill `preview` for a registry kind. Returns false for kinds this
 * module does not own, so the caller can fall through to its own
 * branches (text / document / other keep the classic text tile).
 */
export function buildRegistryTilePreview(item: PreviewItem, preview: HTMLElement): boolean {
  const m = meta(item);
  const head = typeof item.contentHead === 'string' ? item.contentHead : '';
  const spec = kindSpec(item.kind);
  preview.style.setProperty('--tile-accent', spec.accent);
  // Linked media (no file in the bucket, an address instead): the
  // classic image / video / audio tiles only know file keys.
  const hasFile = typeof item.fileKey === 'string' && item.fileKey.length > 0;
  const sourceUrl = typeof item.sourceUrl === 'string' ? item.sourceUrl.trim() : '';
  if (!hasFile && sourceUrl.length > 0 && (item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')) {
    const info = describeLink(sourceUrl);
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'spaces-card-image';
      img.alt = '';
      img.loading = 'lazy';
      img.src = sourceUrl;
      preview.appendChild(img);
      return true;
    }
    const box = el('div', `${T} ${T}-linked ${T}-linked-${item.kind}`);
    const poster = str(m['video_poster']);
    if (item.kind === 'video' && poster.length > 0) {
      const img = document.createElement('img');
      img.className = `${T}-poster`;
      img.alt = '';
      img.loading = 'lazy';
      img.src = poster;
      box.appendChild(img);
    }
    box.appendChild(glyphBadge(item, T));
    const provider = str(m['video_provider']) || (info !== null && info.provider !== 'link' ? info.providerLabel : '');
    box.appendChild(el('div', `${T}-title`, provider.length > 0 ? provider : hostOf(sourceUrl)));
    const facts = factsRow(item, T);
    if (facts !== null) box.appendChild(facts);
    else box.appendChild(el('div', `${T}-sub`, hostOf(sourceUrl)));
    preview.appendChild(box);
    return true;
  }
  switch (item.kind) {
    case 'tool': {
      const card = el('div', `${T} ${T}-tool`);
      card.appendChild(glyphBadge(item, T));
      const typeField = spec.fields.find((f) => f.key === 'tool_type');
      const typeLabel = typeField !== undefined ? formatFieldValue(typeField, m['tool_type']) : str(m['tool_type']);
      card.appendChild(el('div', `${T}-title`, typeLabel.length > 0 ? typeLabel : 'Tool'));
      const endpoint = str(m['tool_endpoint']) || (typeof item.sourceUrl === 'string' ? item.sourceUrl : '');
      if (endpoint.length > 0) card.appendChild(el('div', `${T}-sub`, hostOf(endpoint)));
      const ops = chips(list(m['tool_operations']), T);
      if (ops !== null) card.appendChild(ops);
      preview.appendChild(card);
      return true;
    }
    case 'presentation': {
      const deck = el('div', `${T} ${T}-deck`);
      const stack = el('div', `${T}-deck-stack`);
      for (let i = 0; i < 3; i += 1) stack.appendChild(el('div', `${T}-deck-slide`));
      const front = stack.lastElementChild as HTMLElement | null;
      if (front !== null) front.appendChild(el('div', `${T}-deck-title`, item.title));
      deck.appendChild(stack);
      const provider = str(m['presentation_provider']);
      const count = num(m['slide_count']);
      const parts = [provider, count !== null ? `${count} slide${count === 1 ? '' : 's'}` : ''].filter((p) => p.length > 0);
      if (parts.length > 0) deck.appendChild(el('div', `${T}-facts`, parts.join(' · ')));
      preview.appendChild(deck);
      return true;
    }
    case 'code': {
      const box = el('div', `${T} ${T}-code`);
      const lang = str(m['language']);
      if (lang.length > 0) box.appendChild(el('span', `${T}-badge`, lang));
      const pre = el('pre', `${T}-code-body`);
      const src = head.length > 0 ? head : typeof item.excerpt === 'string' ? item.excerpt : '';
      pre.textContent = src.split(/\r?\n/).slice(0, 7).join('\n');
      box.appendChild(pre);
      const lines = num(m['lineCount']);
      if (lines !== null) box.appendChild(el('div', `${T}-facts`, `${lines} line${lines === 1 ? '' : 's'}`));
      preview.appendChild(box);
      return true;
    }
    case 'data': {
      const box = el('div', `${T} ${T}-data`);
      const rows = head.length > 0 && !head.trimStart().startsWith('{') && !head.trimStart().startsWith('[') ? parseDelimitedHead(head) : [];
      if (rows.length > 0) {
        const table = el('table', `${T}-table`);
        rows.forEach((r, i) => {
          const tr = document.createElement('tr');
          for (const c of r) {
            const cell = document.createElement(i === 0 ? 'th' : 'td');
            cell.textContent = c;
            tr.appendChild(cell);
          }
          table.appendChild(tr);
        });
        box.appendChild(table);
      } else {
        box.appendChild(glyphBadge(item, T));
      }
      const facts = factsRow(item, T);
      if (facts !== null) box.appendChild(facts);
      preview.appendChild(box);
      return true;
    }
    case 'styleguide': {
      const box = el('div', `${T} ${T}-styleguide`);
      const colors = extractHexColors(head.length > 0 ? head : typeof item.excerpt === 'string' ? item.excerpt : '');
      if (colors.length > 0) {
        const row = el('div', `${T}-swatches`);
        for (const c of colors) {
          const sw = el('span', `${T}-swatch`);
          sw.style.background = c;
          sw.title = c;
          row.appendChild(sw);
        }
        box.appendChild(row);
      } else {
        box.appendChild(glyphBadge(item, T));
      }
      const fonts = list(m['styleguide_fonts']);
      const fontsFromHead = fonts.length > 0 ? fonts : extractFontFamilies(head);
      const sub = [str(m['styleguide_brand']), fontsFromHead.slice(0, 2).join(', ')].filter((p) => p.length > 0).join(' · ');
      if (sub.length > 0) box.appendChild(el('div', `${T}-facts`, sub));
      preview.appendChild(box);
      return true;
    }
    case 'conversation': {
      const box = el('div', `${T} ${T}-conversation`);
      const turns = parseConversation(head.length > 0 ? head : typeof item.excerpt === 'string' ? item.excerpt : '', 3);
      if (turns.length > 0) {
        for (const t of turns.slice(0, 3)) {
          const bubble = el('div', `${T}-bubble ${t.role === 'user' ? 'is-user' : 'is-assistant'}`);
          bubble.textContent = t.text.length > 90 ? `${t.text.slice(0, 88).trimEnd()}…` : t.text;
          box.appendChild(bubble);
        }
      } else {
        box.appendChild(glyphBadge(item, T));
      }
      const facts = factsRow(item, T);
      if (facts !== null) box.appendChild(facts);
      preview.appendChild(box);
      return true;
    }
    case 'meeting': {
      const box = el('div', `${T} ${T}-meeting`);
      const when = str(m['meeting_at']);
      const date = when.length > 0 ? new Date(when) : null;
      if (date !== null && !Number.isNaN(date.getTime())) {
        const cal = el('div', `${T}-cal`);
        cal.appendChild(el('div', `${T}-cal-month`, date.toLocaleDateString(undefined, { month: 'short' })));
        cal.appendChild(el('div', `${T}-cal-day`, String(date.getDate())));
        cal.appendChild(el('div', `${T}-cal-time`, date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
        box.appendChild(cal);
      } else {
        box.appendChild(glyphBadge(item, T));
      }
      const attendees = list(m['meeting_attendees']);
      const side = el('div', `${T}-meeting-side`);
      if (attendees.length > 0) side.appendChild(el('div', `${T}-sub`, `${attendees.length} attendee${attendees.length === 1 ? '' : 's'}`));
      const dur = num(m['meeting_duration']);
      if (dur !== null) side.appendChild(el('div', `${T}-sub`, `${dur} min`));
      if (str(m['meeting_recording_url']).length > 0) side.appendChild(el('span', `${T}-chip`, 'Recording'));
      if (side.children.length > 0) box.appendChild(side);
      preview.appendChild(box);
      return true;
    }
    case 'monitor': {
      const box = el('div', `${T} ${T}-monitor`);
      box.appendChild(glyphBadge(item, T));
      const url = str(m['monitor_url']) || (typeof item.sourceUrl === 'string' ? item.sourceUrl : '');
      box.appendChild(el('div', `${T}-title`, url.length > 0 ? hostOf(url) : 'Web monitor'));
      const status = str(m['monitor_status']);
      const facts = factsRow(item, T);
      if (status.length > 0) box.appendChild(el('span', `${T}-badge is-${status}`, status));
      if (facts !== null) box.appendChild(facts);
      preview.appendChild(box);
      return true;
    }
    case 'design': {
      const box = el('div', `${T} ${T}-design`);
      const frame = el('div', `${T}-design-frame`);
      frame.appendChild(el('div', `${T}-design-shape is-a`));
      frame.appendChild(el('div', `${T}-design-shape is-b`));
      frame.appendChild(el('div', `${T}-design-shape is-c`));
      box.appendChild(frame);
      const facts = factsRow(item, T);
      if (facts !== null) box.appendChild(facts);
      preview.appendChild(box);
      return true;
    }
    case 'flow': {
      const box = el('div', `${T} ${T}-flow`);
      const nodes = el('div', `${T}-flow-nodes`);
      for (let i = 0; i < 3; i += 1) {
        nodes.appendChild(el('span', `${T}-flow-node`));
        if (i < 2) nodes.appendChild(el('span', `${T}-flow-edge`));
      }
      box.appendChild(nodes);
      const facts = factsRow(item, T);
      if (facts !== null) box.appendChild(facts);
      preview.appendChild(box);
      return true;
    }
    case 'notebook': {
      const box = el('div', `${T} ${T}-notebook`);
      const cells = el('div', `${T}-nb-cells`);
      cells.appendChild(el('div', `${T}-nb-cell is-md`));
      cells.appendChild(el('div', `${T}-nb-cell is-code`));
      cells.appendChild(el('div', `${T}-nb-cell is-md`));
      box.appendChild(cells);
      const facts = factsRow(item, T);
      if (facts !== null) box.appendChild(facts);
      preview.appendChild(box);
      return true;
    }
    default:
      return false;
  }
}

// ─── Detail blocks ────────────────────────────────────────────────────

const D = 'spaces-detail-kind';

/** A provider embed inside a fixed-ratio frame. */
function embedFrame(url: string, title: string, ratioClass: string): HTMLElement {
  const wrap = el('div', `${D}-embed ${ratioClass}`);
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = title;
  iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; clipboard-write');
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation');
  wrap.appendChild(iframe);
  return wrap;
}

function linkCard(url: string, label: string, sub: string | null): HTMLElement {
  const card = el('div', `${D}-linkcard`);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = `${D}-linkcard-main`;
  a.textContent = label;
  card.appendChild(a);
  card.appendChild(el('div', `${D}-linkcard-sub`, sub ?? hostOf(url)));
  return card;
}

/**
 * The kind-specific hero block for the detail rail, or null when the
 * kind is not a registry kind (the caller keeps its own branches) or
 * has nothing to show beyond the content and the Details section.
 */
export function buildRegistryDetailBlock(item: PreviewItem, deps: PreviewDeps = {}): HTMLElement | null {
  const m = meta(item);
  const sourceUrl = typeof item.sourceUrl === 'string' && item.sourceUrl.length > 0 ? item.sourceUrl : '';
  const link = sourceUrl.length > 0 ? describeLink(sourceUrl) : null;
  const content = typeof item.content === 'string' ? item.content : '';
  const wrap = el('section', `${D} ${D}-${item.kind}`);
  wrap.setAttribute('data-kind', item.kind);
  switch (item.kind) {
    case 'video': {
      // Uploaded videos take the binary preview path; this block is
      // for LINKED videos: a provider embed when one is known, else a
      // player for a direct file, else the link.
      if (link === null) return null;
      const embed = str(m['video_embed_url']) || (link.embedUrl ?? '');
      if (link.provider === 'video-file') {
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        video.src = link.url;
        video.className = 'spaces-detail-video';
        wrap.appendChild(video);
      } else if (embed.length > 0) {
        wrap.appendChild(embedFrame(embed, item.title, 'is-16x9'));
      }
      wrap.appendChild(linkCard(link.url, `Open on ${link.providerLabel}`, null));
      return wrap;
    }
    case 'audio': {
      if (link === null) return null;
      if (link.provider === 'audio-file') {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = link.url;
        audio.className = 'spaces-detail-audio';
        wrap.appendChild(audio);
      }
      wrap.appendChild(linkCard(link.url, 'Open audio', null));
      return wrap;
    }
    case 'image': {
      if (link === null || typeof item.fileKey === 'string') return null;
      const img = document.createElement('img');
      img.src = link.url;
      img.alt = item.title;
      img.loading = 'lazy';
      img.className = 'spaces-detail-image';
      wrap.appendChild(img);
      wrap.appendChild(linkCard(link.url, 'Open image', null));
      return wrap;
    }
    case 'presentation': {
      const embed = str(m['presentation_embed_url']) || (link?.embedUrl ?? '');
      if (embed.length > 0) wrap.appendChild(embedFrame(embed, item.title, 'is-16x9'));
      if (link !== null) wrap.appendChild(linkCard(link.url, `Open in ${link.providerLabel}`, null));
      return wrap.children.length > 0 ? wrap : null;
    }
    case 'design': {
      const embed = str(m['design_embed_url']) || (link?.embedUrl ?? '');
      if (embed.length > 0) wrap.appendChild(embedFrame(embed, item.title, 'is-4x3'));
      if (link !== null) wrap.appendChild(linkCard(link.url, `Open in ${link.providerLabel}`, null));
      return wrap.children.length > 0 ? wrap : null;
    }
    case 'tool': {
      const card = el('div', `${D}-card`);
      const spec = kindSpec('tool');
      const typeField = spec.fields.find((f) => f.key === 'tool_type');
      const typeLabel = typeField !== undefined ? formatFieldValue(typeField, m['tool_type']) : '';
      card.appendChild(el('div', `${D}-card-kicker`, typeLabel.length > 0 ? typeLabel : 'Tool'));
      const endpoint = str(m['tool_endpoint']) || sourceUrl;
      if (endpoint.length > 0) {
        const code = el('code', `${D}-card-mono`, endpoint);
        card.appendChild(code);
      }
      const ops = chips(list(m['tool_operations']), D, 8);
      if (ops !== null) card.appendChild(ops);
      // Transport, auth, status, owner… live in the Details section
      // below (editable there); the card says only what the tool IS.
      wrap.appendChild(card);
      return wrap;
    }
    case 'meeting': {
      const card = el('div', `${D}-card ${D}-meeting-card`);
      const when = str(m['meeting_at']);
      const date = when.length > 0 ? new Date(when) : null;
      if (date !== null && !Number.isNaN(date.getTime())) {
        card.appendChild(el('div', `${D}-card-kicker`, date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
      }
      const attendees = chips(list(m['meeting_attendees']), D, 12);
      if (attendees !== null) card.appendChild(attendees);
      const links = el('div', `${D}-card-links`);
      const rec = str(m['meeting_recording_url']);
      const tr = str(m['meeting_transcript_url']);
      for (const [url, label] of [[rec, 'Recording'], [tr, 'Transcript']] as const) {
        if (url.length === 0) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = `${D}-card-link`;
        a.textContent = label;
        links.appendChild(a);
      }
      if (links.children.length > 0) card.appendChild(links);
      wrap.appendChild(card);
      return wrap;
    }
    case 'monitor': {
      const url = str(m['monitor_url']) || sourceUrl;
      if (url.length > 0) wrap.appendChild(linkCard(url, hostOf(url), url));
      const note = el('p', `${D}-note`, 'Checks run in the full Onereach app; results land on this asset.');
      wrap.appendChild(note);
      return wrap;
    }
    case 'flow': {
      if (link !== null) wrap.appendChild(linkCard(link.url, 'Open in GSX Designer', null));
      return wrap.children.length > 0 ? wrap : null;
    }
    case 'notebook': {
      const nb = content.length > 0 ? parseNotebook(content) : null;
      if (nb === null) return null;
      const list_ = el('div', `${D}-nb`);
      let shown = 0;
      for (const cell of nb.cells) {
        if (shown >= 60) break;
        const cellEl = el('div', `${D}-nb-cell is-${cell.type}`);
        if (cell.type === 'markdown' && deps.renderMarkdown !== undefined) {
          cellEl.appendChild(deps.renderMarkdown(cell.source));
        } else if (cell.type === 'code' && deps.codePreview !== undefined) {
          cellEl.appendChild(deps.codePreview(cell.source, nb.language.length > 0 ? nb.language : 'python'));
        } else {
          const pre = el('pre', `${D}-nb-pre`);
          pre.textContent = cell.source;
          cellEl.appendChild(pre);
        }
        for (const out of cell.outputs.slice(0, 2)) {
          const pre = el('pre', `${D}-nb-output`);
          pre.textContent = out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
          cellEl.appendChild(pre);
        }
        list_.appendChild(cellEl);
        shown += 1;
      }
      if (nb.cells.length > shown) list_.appendChild(el('p', `${D}-note`, `${nb.cells.length - shown} more cells — download the notebook to see them all.`));
      wrap.appendChild(list_);
      return wrap;
    }
    case 'styleguide': {
      if (content.length === 0) return null;
      let tokens: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(content) as unknown;
        tokens = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        tokens = null;
      }
      const colors = tokens !== null ? flattenColors(tokens['colors']) : [];
      const hex = colors.length > 0 ? colors : extractHexColors(content, 24).map((c) => ({ name: c, value: c }));
      if (hex.length > 0) {
        const grid = el('div', `${D}-swatch-grid`);
        for (const c of hex.slice(0, 24)) {
          const sw = el('div', `${D}-swatch`);
          const chip = el('div', `${D}-swatch-chip`);
          chip.style.background = c.value;
          sw.appendChild(chip);
          sw.appendChild(el('div', `${D}-swatch-name`, c.name));
          sw.appendChild(el('div', `${D}-swatch-value`, c.value));
          grid.appendChild(sw);
        }
        wrap.appendChild(grid);
      }
      const type = tokens !== null ? flattenTypography(tokens['typography']) : [];
      if (type.length > 0) {
        const samples = el('div', `${D}-type-samples`);
        for (const t of type.slice(0, 6)) {
          const sample = el('div', `${D}-type-sample`);
          sample.style.fontFamily = `${t.family}, var(--or-font-sans, sans-serif)`;
          if (t.size !== null) sample.style.fontSize = `${Math.min(Math.max(t.size, 10), 40)}px`;
          if (t.weight !== null) sample.style.fontWeight = String(t.weight);
          sample.textContent = `${t.name} — The quick brown fox jumps over the lazy dog`;
          samples.appendChild(sample);
        }
        wrap.appendChild(samples);
      }
      return wrap.children.length > 0 ? wrap : null;
    }
    case 'conversation': {
      if (content.length === 0) return null;
      const turns = parseConversation(content);
      if (turns.length === 0) return null;
      const thread = el('div', `${D}-thread`);
      for (const t of turns) {
        const row = el('div', `${D}-turn ${t.role === 'user' ? 'is-user' : t.role === 'assistant' ? 'is-assistant' : 'is-other'}`);
        row.appendChild(el('div', `${D}-turn-role`, t.role === 'user' ? 'You' : t.role === 'assistant' ? 'Assistant' : t.role));
        const body = el('div', `${D}-turn-body`);
        if (deps.renderMarkdown !== undefined) body.appendChild(deps.renderMarkdown(t.text));
        else body.textContent = t.text;
        row.appendChild(body);
        thread.appendChild(row);
      }
      wrap.appendChild(thread);
      return wrap;
    }
    case 'data': {
      if (content.length === 0) return null;
      const trimmed = content.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        if (deps.codePreview !== undefined) wrap.appendChild(deps.codePreview(content, 'json'));
        else {
          const pre = el('pre', `${D}-nb-pre`);
          pre.textContent = content.slice(0, 20000);
          wrap.appendChild(pre);
        }
      } else if (deps.csvPreview !== undefined) {
        wrap.appendChild(deps.csvPreview(content));
      } else {
        return null;
      }
      return wrap;
    }
    case 'code': {
      if (content.length === 0) return null;
      const lang = str(m['language']) || 'text';
      if (deps.codePreview !== undefined) wrap.appendChild(deps.codePreview(content, lang));
      else {
        const pre = el('pre', `${D}-nb-pre`);
        pre.textContent = content;
        wrap.appendChild(pre);
      }
      return wrap;
    }
    default:
      return null;
  }
}

/** Does this kind's detail block already show the inline content? */
export function registryBlockOwnsContent(kind: string): boolean {
  return kind === 'notebook' || kind === 'conversation' || kind === 'data' || kind === 'code' || kind === 'styleguide';
}

interface ColorToken {
  name: string;
  value: string;
}

/** `colors` → flat `[ {name, value} ]`, nested groups joined with `/`. */
export function flattenColors(node: unknown, prefix = '', out: ColorToken[] = []): ColorToken[] {
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const name = prefix.length > 0 ? `${prefix}/${key}` : key;
    if (typeof value === 'string' && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(value.trim())) {
      out.push({ name, value: value.trim() });
    } else if (value !== null && typeof value === 'object') {
      const v = (value as Record<string, unknown>)['value'];
      if (typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v.trim())) out.push({ name, value: v.trim() });
      else flattenColors(value, name, out);
    }
    if (out.length >= 64) break;
  }
  return out;
}

interface TypeToken {
  name: string;
  family: string;
  size: number | null;
  weight: number | string | null;
}

/** `typography` → flat samples: `{ body: { fontFamily, fontSize, fontWeight } }` or CSS-ish keys. */
export function flattenTypography(node: unknown, prefix = '', out: TypeToken[] = []): TypeToken[] {
  if (node === null || typeof node !== 'object') return out;
  const o = node as Record<string, unknown>;
  const family = str(o['fontFamily'] ?? o['font-family'] ?? o['family'] ?? o['font']);
  if (family.length > 0) {
    const sizeRaw = o['fontSize'] ?? o['font-size'] ?? o['size'];
    const size = typeof sizeRaw === 'number' ? sizeRaw : typeof sizeRaw === 'string' ? Number.parseFloat(sizeRaw) : NaN;
    const weightRaw = o['fontWeight'] ?? o['font-weight'] ?? o['weight'];
    out.push({
      name: prefix.length > 0 ? prefix : 'body',
      family: family.split(',')[0]?.trim() ?? family,
      size: Number.isFinite(size) ? size : null,
      weight: typeof weightRaw === 'number' || typeof weightRaw === 'string' ? weightRaw : null,
    });
    return out;
  }
  for (const [key, value] of Object.entries(o)) {
    if (value !== null && typeof value === 'object') flattenTypography(value, prefix.length > 0 ? `${prefix}/${key}` : key, out);
    if (out.length >= 12) break;
  }
  return out;
}
