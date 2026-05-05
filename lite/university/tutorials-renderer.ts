/**
 * Agentic University tutorials catalog renderer.
 *
 * Loaded into the tutorials window (`university-tutorials.html`).
 * Calls `window.lite.university.list()` to fetch the curated
 * catalog and `window.lite.university.open(id)` to route a click
 * into the Lite-internal Learning Browser.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

// File is a module so esbuild treats it as ESM input.
export {};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const KIND_ORDER: ReadonlyArray<LiteUniversityKind> = [
  'lms',
  'course',
  'tutorial',
  'feed',
  'method',
];

const KIND_PLURAL: Readonly<Record<LiteUniversityKind, string>> = {
  lms: 'LMS',
  course: 'Courses',
  tutorial: 'Tutorials',
  feed: 'Feeds',
  method: 'Methods',
};

const KIND_LABEL_SINGULAR: Readonly<Record<LiteUniversityKind, string>> = {
  lms: 'LMS',
  course: 'Course',
  tutorial: 'Tutorial',
  feed: 'Feed',
  method: 'Method',
};

const KIND_DEFAULT_EMOJI: Readonly<Record<LiteUniversityKind, string>> = {
  lms: '\u{1F3DB}',
  course: '\u{1F4DA}',
  tutorial: '\u{1F393}',
  feed: '\u{1F4F0}',
  method: '\u{1F9ED}',
};

let entries: LiteLearningEntry[] = [];

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  const closeBtn = document.getElementById('close-btn');
  if (closeBtn !== null) {
    closeBtn.addEventListener('click', () => window.close());
  }
  void initialLoad();
}

async function initialLoad(): Promise<void> {
  const content = document.getElementById('content');
  if (content === null) return;

  const bridge = window.lite?.university;
  if (bridge === undefined) {
    showError('Agentic University bridge unavailable. Restart the app to recover.');
    return;
  }

  try {
    entries = await bridge.list();
  } catch (err) {
    showError(`Could not load tutorials: ${(err as Error).message}`);
    return;
  }

  render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  const content = document.getElementById('content');
  if (content === null) return;
  if (entries.length === 0) {
    content.innerHTML = `
      <div class="banner error">No tutorials in the curated catalog yet.</div>
    `;
    return;
  }

  const featured = entries.filter((e) => e.featured === true);
  const byKind = new Map<LiteUniversityKind, LiteLearningEntry[]>();
  for (const k of KIND_ORDER) byKind.set(k, []);
  for (const e of entries) (byKind.get(e.kind) as LiteLearningEntry[]).push(e);

  const sections: string[] = [];
  if (featured.length > 0) {
    sections.push(`
      <div class="section-block">
        <div class="section-header">
          <span class="section-accent-bar" style="background:linear-gradient(90deg,var(--accent-lms),var(--accent-tutorial));"></span>
          <span class="section-title">Featured</span>
          <span class="section-count">(${featured.length})</span>
        </div>
        <div class="featured-row">
          ${featured.map(renderFeaturedCard).join('')}
        </div>
      </div>
    `);
  }
  for (const k of KIND_ORDER) {
    const items = byKind.get(k) ?? [];
    if (items.length === 0) continue;
    sections.push(renderSection(k, items));
  }

  content.innerHTML = sections.join('\n');
  wireCardClicks(content);
}

function renderFeaturedCard(entry: LiteLearningEntry): string {
  const accent = `var(--accent-${entry.kind})`;
  const icon = entry.iconEmoji ?? KIND_DEFAULT_EMOJI[entry.kind];
  const meta: string[] = [];
  if (entry.duration !== undefined) meta.push(escapeHtml(entry.duration));
  if (entry.category !== undefined) meta.push(escapeHtml(entry.category));
  return `
    <button type="button" class="featured-card" data-id="${escapeAttr(entry.id)}" style="--accent:${accent};">
      <div class="featured-card-accent">${escapeHtml(icon)}</div>
      <div class="featured-card-body">
        <span class="featured-card-pill pill" data-kind="${entry.kind}">${escapeHtml(KIND_LABEL_SINGULAR[entry.kind])}</span>
        <div class="featured-card-title">${escapeHtml(entry.title)}</div>
        <div class="featured-card-description">${escapeHtml(entry.description)}</div>
        ${meta.length > 0 ? `<div class="featured-card-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''}
      </div>
    </button>
  `;
}

function renderSection(kind: LiteUniversityKind, items: LiteLearningEntry[]): string {
  const accent = `var(--accent-${kind})`;
  const cards = items.map((e) => renderCard(e)).join('\n');
  return `
    <div class="section-block">
      <div class="section-header">
        <span class="section-accent-bar" style="background:${accent};"></span>
        <span class="section-title">${escapeHtml(KIND_PLURAL[kind])}</span>
        <span class="section-count">(${items.length})</span>
      </div>
      <div class="card-grid">${cards}</div>
    </div>
  `;
}

function renderCard(entry: LiteLearningEntry): string {
  const accent = `var(--accent-${entry.kind})`;
  const icon = entry.iconEmoji ?? KIND_DEFAULT_EMOJI[entry.kind];
  return `
    <button type="button" class="card" data-id="${escapeAttr(entry.id)}" style="--accent:${accent};">
      <div class="card-accent"></div>
      <div class="card-body">
        <div class="card-head">
          <div class="card-icon"><span aria-hidden="true">${escapeHtml(icon)}</span></div>
          <div class="card-headtext">
            <div class="card-name">${escapeHtml(entry.title)}</div>
            ${entry.category !== undefined ? `<div class="card-category">${escapeHtml(entry.category)}</div>` : ''}
          </div>
        </div>
        <div class="card-description">${escapeHtml(entry.description)}</div>
        <div class="card-meta">
          <span class="pill" data-kind="${entry.kind}">${escapeHtml(KIND_LABEL_SINGULAR[entry.kind])}</span>
          ${entry.duration !== undefined ? `<span class="pill pill-duration">${escapeHtml(entry.duration)}</span>` : ''}
        </div>
      </div>
    </button>
  `;
}

function wireCardClicks(content: HTMLElement): void {
  for (const btn of Array.from(content.querySelectorAll<HTMLButtonElement>('button[data-id]'))) {
    const id = btn.dataset['id'];
    if (typeof id !== 'string') continue;
    btn.addEventListener('click', () => {
      void openFlow(id);
    });
  }
}

async function openFlow(id: string): Promise<void> {
  const bridge = window.lite?.university;
  if (bridge === undefined) {
    showToast('University bridge unavailable.', 'error');
    return;
  }
  try {
    await bridge.open(id);
  } catch (err) {
    const parsed = bridge.parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showToast(msg, 'error');
  }
}

function showError(message: string): void {
  const content = document.getElementById('content');
  if (content === null) return;
  content.innerHTML = `<div class="banner error">${escapeHtml(message)}</div>`;
}

function showToast(message: string, kind: 'error' | 'info'): void {
  const stack = document.getElementById('toast-stack');
  if (stack === null) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => toast.classList.add('show'), 16);
  window.setTimeout(() => {
    toast.classList.remove('show');
    window.setTimeout(() => {
      if (toast.parentNode === stack) stack.removeChild(toast);
    }, 220);
  }, 3000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
