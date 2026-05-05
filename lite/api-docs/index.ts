/**
 * API Reference renderer entry (ADR-035).
 *
 * Renders a sidebar of modules + a content pane. The doc data is the
 * static `MANIFEST` import (generated at build time from the actual
 * source by `manifest-builder.mjs`). Module READMEs are rendered via
 * `marked` -- already a project dep at ^17.0.1.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

// File is a module so esbuild treats it as ESM input.
export {};

import { marked } from 'marked';
import { MANIFEST } from './manifest.generated.js';
import type { ModuleDoc, MethodDoc, EventDoc } from './types.js';

// ─── State ──────────────────────────────────────────────────────────────

let activeSlug: string | null = null;

// ─── Bootstrap ──────────────────────────────────────────────────────────

function bootstrap(): void {
  const sidebarNav = document.getElementById('sidebar-nav');
  const untypedList = document.getElementById('untyped-list');
  const filterInput = document.getElementById('filter-input') as HTMLInputElement | null;
  const generatedAt = document.getElementById('generated-at');
  const closeBtn = document.getElementById('close-btn');

  if (sidebarNav === null || untypedList === null || filterInput === null) {
    // eslint-disable-next-line no-console
    console.error('[api-docs] required mount points not found');
    return;
  }

  if (generatedAt !== null) {
    const date = new Date(MANIFEST.generatedAt);
    if (!Number.isNaN(date.getTime())) {
      generatedAt.textContent = `manifest built ${date.toLocaleString()}`;
    }
  }

  // Configure marked: GitHub-flavoured + headings without IDs (no
  // anchor support inside the window for v1; clicking links is a
  // future enhancement per ADR-035).
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  // Build sidebar.
  for (const mod of MANIFEST.modules) {
    sidebarNav.appendChild(buildSidebarTab(mod));
  }

  // Build untyped list.
  for (const u of MANIFEST.untyped) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = u.title;
    li.appendChild(strong);
    li.appendChild(document.createTextNode(': ' + u.reason));
    untypedList.appendChild(li);
  }

  // Wire filter.
  filterInput.addEventListener('input', () => {
    applyFilter(filterInput.value);
  });

  // Close button.
  if (closeBtn !== null) {
    closeBtn.addEventListener('click', () => window.close());
  }

  // Activate the first module by default.
  const firstModule = MANIFEST.modules[0];
  if (firstModule !== undefined) {
    activate(firstModule.slug);
  }
}

// ─── Sidebar ────────────────────────────────────────────────────────────

function buildSidebarTab(mod: ModuleDoc): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sidebar-tab';
  btn.dataset['slug'] = mod.slug;
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', 'false');

  const label = document.createElement('span');
  label.textContent = mod.title;
  btn.appendChild(label);

  if (mod.surface !== null) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${mod.surface.methods.length}`;
    btn.appendChild(badge);
  }

  btn.addEventListener('click', () => activate(mod.slug));
  return btn;
}

function applyFilter(query: string): void {
  const q = query.trim().toLowerCase();
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-tab'));
  let firstVisible: string | null = null;
  for (const tab of tabs) {
    const slug = tab.dataset['slug'] ?? '';
    const title = (tab.textContent ?? '').toLowerCase();
    const visible = q === '' || slug.includes(q) || title.includes(q);
    tab.classList.toggle('hidden', !visible);
    if (visible && firstVisible === null) firstVisible = slug;
  }
  // If the active tab got filtered out, jump to the first visible one.
  if (
    firstVisible !== null &&
    activeSlug !== null &&
    !tabs.find((t) => t.dataset['slug'] === activeSlug && !t.classList.contains('hidden'))
  ) {
    activate(firstVisible);
  }
}

// ─── Content rendering ──────────────────────────────────────────────────

function activate(slug: string): void {
  if (slug === activeSlug) return;
  const mod = MANIFEST.modules.find((m) => m.slug === slug);
  if (mod === undefined) return;

  // Update sidebar active state.
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-tab'))) {
    const isActive = btn.dataset['slug'] === slug;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }

  const content = document.getElementById('content');
  if (content === null) return;

  content.innerHTML = '';
  content.appendChild(renderModule(mod));
  content.scrollTop = 0;
  activeSlug = slug;
}

function renderModule(mod: ModuleDoc): DocumentFragment {
  const frag = document.createDocumentFragment();

  // Header
  const header = document.createElement('div');
  header.className = 'module-header';
  const titleRow = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'module-title';
  title.textContent = mod.title;
  titleRow.appendChild(title);
  const slug = document.createElement('span');
  slug.className = 'module-slug';
  slug.textContent = `lite/${mod.slug}/`;
  titleRow.appendChild(document.createTextNode(' '));
  titleRow.appendChild(slug);
  header.appendChild(titleRow);

  if (mod.summary !== '') {
    const summary = document.createElement('p');
    summary.className = 'module-summary';
    summary.textContent = mod.summary;
    header.appendChild(summary);
  }
  frag.appendChild(header);

  // Public surface
  if (mod.surface !== null) {
    frag.appendChild(renderSurface(mod.surface));
  }

  // Events
  if (mod.events !== null && mod.events.count > 0) {
    frag.appendChild(renderEvents(mod.events));
  }

  // README
  if (mod.readme !== null && mod.readme.trim().length > 0) {
    frag.appendChild(renderReadme(mod.readme));
  }

  return frag;
}

function renderSurface(surface: NonNullable<ModuleDoc['surface']>): HTMLElement {
  const wrap = document.createElement('section');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = `Public API: ${surface.interfaceName}`;
  wrap.appendChild(heading);

  if (surface.interfaceDescription !== '') {
    const desc = document.createElement('p');
    desc.className = 'module-summary';
    desc.textContent = surface.interfaceDescription;
    wrap.appendChild(desc);
  }

  const list = document.createElement('div');
  list.className = 'method-list';
  for (const method of surface.methods) {
    list.appendChild(renderMethod(method));
  }
  wrap.appendChild(list);

  return wrap;
}

function renderMethod(method: MethodDoc): HTMLElement {
  const card = document.createElement('article');
  card.className = 'method-card';

  const nameRow = document.createElement('div');
  nameRow.className = 'method-name-row';
  const name = document.createElement('span');
  name.className = 'method-name';
  name.textContent = method.name;
  nameRow.appendChild(name);
  if (method.description === '') {
    const warn = document.createElement('span');
    warn.className = 'method-no-doc';
    warn.textContent = 'no JSDoc';
    nameRow.appendChild(warn);
  }
  card.appendChild(nameRow);

  const sig = document.createElement('pre');
  sig.className = 'method-signature';
  sig.textContent = method.signature;
  card.appendChild(sig);

  if (method.description !== '') {
    const desc = document.createElement('div');
    desc.className = 'method-description';
    desc.textContent = method.description;
    card.appendChild(desc);
  }

  if (method.tags.length > 0) {
    const dl = document.createElement('dl');
    dl.className = 'method-tags';
    for (const t of method.tags) {
      const dt = document.createElement('dt');
      dt.textContent = `@${t.tag}`;
      const dd = document.createElement('dd');
      dd.textContent = t.value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    card.appendChild(dl);
  }

  if (method.examples.length > 0) {
    const examples = document.createElement('div');
    examples.className = 'method-examples';
    for (const ex of method.examples) {
      const pre = document.createElement('pre');
      pre.textContent = ex;
      examples.appendChild(pre);
    }
    card.appendChild(examples);
  }

  return card;
}

function renderEvents(events: NonNullable<ModuleDoc['events']>): HTMLElement {
  const wrap = document.createElement('section');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = `Typed events: ${events.constantName} (${events.count})`;
  wrap.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'events-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of ['Constant', 'Event name']) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const e of events.entries) {
    tbody.appendChild(renderEventRow(e, events.constantName));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  return wrap;
}

function renderEventRow(e: EventDoc, constantName: string): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const tdKey = document.createElement('td');
  tdKey.textContent = `${constantName}.${e.constantKey}`;
  const tdName = document.createElement('td');
  tdName.textContent = e.name;
  tr.appendChild(tdKey);
  tr.appendChild(tdName);
  return tr;
}

function renderReadme(markdown: string): HTMLElement {
  const wrap = document.createElement('section');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = 'README';
  wrap.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'readme-content';
  try {
    // marked.parse may return Promise in async mode; we keep sync.
    const html = marked.parse(markdown, { async: false }) as string;
    body.innerHTML = html;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[api-docs] marked failed to parse README; rendering as <pre>', err);
    const pre = document.createElement('pre');
    pre.textContent = markdown;
    body.appendChild(pre);
  }

  wrap.appendChild(body);
  return wrap;
}

// ─── Run ────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
