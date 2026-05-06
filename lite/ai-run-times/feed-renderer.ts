/**
 * AI Run Times renderer.
 *
 * Loaded into the AI Run Times window. Wires up:
 *   - Tile grid with images, reading time, "new" / "read" badges
 *   - Article overlay reader (open via tile click)
 *   - Content preferences side panel
 *   - Reading log JSON download
 *
 * NOTE: TTS / "Listen" / audio playlist support was removed in
 * the first-run UX hardening pass -- the inline OpenAI dependency
 * was a niche surface that didn't earn its keep. The article
 * fetching + reader stays; bringing audio back is a separate chunk
 * that should also bring back the AI service module.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

import { extractArticle } from './article-extractor.js';

export {};

// ─── helpers ─────────────────────────────────────────────────────────────

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
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

function showToast(msg: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const stack = $('toast-stack');
  if (stack === null) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  stack.appendChild(t);
  window.setTimeout(() => t.classList.add('show'), 16);
  window.setTimeout(() => {
    t.classList.remove('show');
    window.setTimeout(() => {
      if (t.parentNode === stack) stack.removeChild(t);
    }, 220);
  }, 3500);
}

// ─── state ───────────────────────────────────────────────────────────────

let articles: LiteAiRunTimesArticle[] = [];
let preferences: LiteAiRunTimesPreference[] = [];
let readingLogIds = new Set<string>();
let currentArticleId: string | null = null;
let articleStartTimestamp: number | null = null;

// ─── boot ────────────────────────────────────────────────────────────────

function boot(): void {
  // Defensive: enforce hidden state on the two full-bleed overlay
  // panels. The HTML `hidden` attribute is in the markup but author
  // CSS rules (`.article-overlay { display: flex }` and
  // `.prefs-panel { display: flex }`) used to override it, leaving
  // both painted across the window on first open. The CSS now
  // includes a `[hidden] { display: none !important }` reset; this
  // line is a belt-and-suspenders backstop in case future CSS
  // edits accidentally regress the same way.
  const articleOverlayInit = $('article-overlay');
  if (articleOverlayInit !== null) articleOverlayInit.hidden = true;
  const prefsPanelInit = $('prefs-panel');
  if (prefsPanelInit !== null) prefsPanelInit.hidden = true;

  const closeBtn = $('close-btn');
  if (closeBtn !== null) closeBtn.addEventListener('click', () => window.close());

  const refreshBtn = $('refresh-btn');
  if (refreshBtn !== null) refreshBtn.addEventListener('click', () => void refreshFeed());

  const prefsBtn = $('prefs-btn');
  if (prefsBtn !== null) prefsBtn.addEventListener('click', () => togglePrefsPanel(true));

  const prefsClose = $('prefs-close');
  if (prefsClose !== null) prefsClose.addEventListener('click', () => togglePrefsPanel(false));

  const prefsSave = $('prefs-save');
  if (prefsSave !== null) prefsSave.addEventListener('click', () => void savePrefs());

  const prefsSelectAll = $('prefs-select-all');
  if (prefsSelectAll !== null)
    prefsSelectAll.addEventListener('click', () => togglePrefsSelectAll());

  const exportBtn = $('export-log-btn');
  if (exportBtn !== null) exportBtn.addEventListener('click', () => void exportLog());

  const articleClose = $('article-close-btn');
  if (articleClose !== null) articleClose.addEventListener('click', () => closeArticle());
  const articleOriginal = $('article-original-btn');
  if (articleOriginal !== null) articleOriginal.addEventListener('click', () => openOriginal());

  void initialLoad();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// ─── load ────────────────────────────────────────────────────────────────

async function initialLoad(): Promise<void> {
  window.logging?.info('ai-run-times', 'renderer: initialLoad start', {
    hasBridge: window.lite?.aiRunTimes !== undefined,
  });
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) {
    window.logging?.error('ai-run-times', 'renderer: bridge unavailable', {});
    showError('AI Run Times bridge unavailable. Restart the app to recover.');
    return;
  }
  showLoading();
  // Promise.allSettled (not Promise.all) so a single failing section
  // -- typically reading-log or preferences when KV is rejecting the
  // session -- doesn't take the whole window down. Each section
  // independently falls back to an empty default; the overall UI
  // shell still renders so the user can sign in again, refresh, or
  // file a bug report.
  const [artRes, prefRes, logRes] = await Promise.all([
    bridge.listArticles().catch((err) => ({ __error: err })),
    bridge.listPreferences().catch((err) => ({ __error: err })),
    bridge.listReadingLog().catch((err) => ({ __error: err })),
  ]);

  const sectionErrors: string[] = [];
  if (Array.isArray(artRes)) {
    articles = artRes;
  } else {
    sectionErrors.push(formatBridgeError(bridge, 'articles', artRes.__error));
    articles = [];
  }
  if (Array.isArray(prefRes)) {
    preferences = prefRes;
  } else {
    sectionErrors.push(formatBridgeError(bridge, 'preferences', prefRes.__error));
    preferences = [];
  }
  if (Array.isArray(logRes)) {
    readingLogIds = new Set(logRes.map((e) => e.articleId));
  } else {
    sectionErrors.push(formatBridgeError(bridge, 'reading log', logRes.__error));
    readingLogIds = new Set();
  }

  window.logging?.info('ai-run-times', 'renderer: initialLoad results', {
    articleCount: articles.length,
    preferenceCount: preferences.length,
    enabledPreferenceCount: preferences.filter((p) => p.enabled).length,
    readingLogSize: readingLogIds.size,
    sectionErrorCount: sectionErrors.length,
    sectionErrors,
    artResShape: Array.isArray(artRes) ? `array(${artRes.length})` : typeof artRes,
    prefResShape: Array.isArray(prefRes) ? `array(${prefRes.length})` : typeof prefRes,
  });

  if (articles.length === 0 && sectionErrors.length === 0) {
    window.logging?.info('ai-run-times', 'renderer: auto-refresh triggered (no cached articles)', {});
    await refreshFeed(/* silent */ true);
    return;
  }

  render();
  updateFooter();
  if (sectionErrors.length > 0) {
    // Non-fatal: tell the user once via a toast. The header/footer
    // remain interactive so they can still hit Refresh, Preferences,
    // or close the window.
    showToast(sectionErrors[0] ?? 'Some sections failed to load.', 'error');
  }
}

function formatBridgeError(
  bridge: LiteAiRunTimesBridge,
  section: string,
  err: unknown
): string {
  const parsed = bridge.parseError(err);
  if (parsed !== null) {
    const msg = `${parsed.message} ${parsed.remediation}`.trim();
    return `Couldn't load ${section}: ${msg}`;
  }
  // Strip Electron's "Error invoking remote method '...':" prefix
  // when the error wasn't our structured shape.
  const raw = (err as Error)?.message ?? String(err);
  const cleaned = raw.replace(/^Error invoking remote method[^:]*:\s*Error:\s*/, '');
  return `Couldn't load ${section}: ${cleaned}`;
}

async function refreshFeed(silent = false): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) return;
  if (!silent) showToast('Refreshing feed...', 'info');
  showLoading();
  window.logging?.info('ai-run-times', 'renderer: refreshFeed start', { silent });
  try {
    const result = await bridge.refreshFeed();
    window.logging?.info('ai-run-times', 'renderer: refreshFeed result', {
      fetchedCount: result.fetchedCount,
      newArticles: result.newArticles,
      perFeedCount: result.perFeed.length,
      failedFeeds: result.perFeed.filter((p) => !p.ok).length,
    });
    const fetchedArticles = await bridge.listArticles();
    window.logging?.info('ai-run-times', 'renderer: refreshFeed listArticles', {
      articleCount: fetchedArticles.length,
      sampleIds: fetchedArticles.slice(0, 3).map((a) => a.id),
    });
    articles = fetchedArticles;
    if (result.newArticles > 0) {
      showToast(`Added ${result.newArticles} new article${result.newArticles === 1 ? '' : 's'}.`, 'success');
    } else if (result.fetchedCount > 0) {
      showToast('Feed is up to date.', 'info');
    }
    const failed = result.perFeed.filter((p) => p.ok === false);
    if (failed.length > 0) {
      const first = failed[0];
      if (first !== undefined && first.ok === false) {
        showToast(`${failed.length} feed${failed.length === 1 ? '' : 's'} failed: ${first.message}`, 'error');
      }
    }
    render();
    updateFooter();
  } catch (err) {
    const parsed = bridge.parseError(err);
    const msg = parsed !== null ? parsed.message : (err as Error).message;
    showError(`Refresh failed: ${msg}`);
  }
}

// ─── render ──────────────────────────────────────────────────────────────

function showLoading(): void {
  const content = $('feed-content');
  if (content === null) return;
  if (articles.length > 0) return; // keep existing tiles visible during refresh
  const tiles = Array.from({ length: 9 }).map(() => '<div class="skeleton-tile"></div>').join('');
  content.innerHTML = `<div class="skeleton-grid">${tiles}</div>`;
}

function render(): void {
  const content = $('feed-content');
  if (content === null) {
    window.logging?.warn('ai-run-times', 'renderer: render() called but #feed-content not in DOM', {});
    return;
  }
  // Show every cached article. The full app's Flipboard reader does
  // not filter the article grid by preferences (the prefs panel in
  // the full app is for the audio playlist queue, not for hiding
  // tiles); Lite mirrors that behavior. Topic preferences remain
  // in the side panel for a future feature -- e.g. when articles
  // are classified by an OAGI model rather than relying on the
  // RSS feed's categorical hints -- but they never hide tiles
  // today.
  window.logging?.info('ai-run-times', 'renderer: render', {
    articleCount: articles.length,
    preferenceCount: preferences.length,
  });
  if (articles.length === 0) {
    content.innerHTML = `
      <div class="banner empty">
        <div class="empty-title">No articles to show</div>
        <div class="empty-subtitle">Hit Refresh to fetch the latest stories from your feeds.</div>
      </div>
    `;
    return;
  }
  const tiles = articles.map(renderTile).join('\n');
  content.innerHTML = `
    <div class="section-header">
      <span class="section-title">Latest</span>
      <span class="section-count">(${articles.length})</span>
    </div>
    <div class="tile-grid">${tiles}</div>
  `;
  for (const tileEl of Array.from(content.querySelectorAll<HTMLButtonElement>('button[data-id]'))) {
    const id = tileEl.dataset['id'];
    if (typeof id !== 'string') continue;
    tileEl.addEventListener('click', () => void openArticle(id));
  }
}

function renderTile(a: LiteAiRunTimesArticle): string {
  const inLog = readingLogIds.has(a.id);
  const recent = a.publishedAt !== null && Date.now() - Date.parse(a.publishedAt) < 7 * 24 * 60 * 60 * 1000;
  const meta: string[] = [];
  if (a.readingTimeMinutes > 0) meta.push(`<span class="pill pill-reading-time">${a.readingTimeMinutes} min read</span>`);
  if (recent && !inLog) meta.push('<span class="pill pill-new">New</span>');
  if (inLog) meta.push('<span class="pill pill-read">Read</span>');

  const sourceHost = (() => {
    try {
      return new URL(a.link).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  const imageStyle =
    a.thumbnailUrl !== null && a.thumbnailUrl !== ''
      ? `style="background-image:url('${escapeAttr(a.thumbnailUrl)}')"`
      : '';

  const imageContent = a.thumbnailUrl === null || a.thumbnailUrl === '' ? '<div class="tile-image-empty">\u{1F4F0}</div>' : '';

  return `
    <button type="button" class="tile" data-id="${escapeAttr(a.id)}">
      <div class="tile-image" ${imageStyle}>${imageContent}</div>
      <div class="tile-body">
        <div class="tile-source">${escapeHtml(sourceHost)}</div>
        <div class="tile-title">${escapeHtml(a.title)}</div>
        ${a.author !== null ? `<div class="tile-author">${escapeHtml(a.author)}</div>` : ''}
        <div class="tile-meta">${meta.join('')}</div>
      </div>
    </button>
  `;
}

function showError(msg: string): void {
  const content = $('feed-content');
  if (content === null) return;
  content.innerHTML = `<div class="banner error">${escapeHtml(msg)}</div>`;
}

function updateFooter(): void {
  const info = $('footer-info');
  if (info === null) return;
  info.textContent = `${articles.length} cached \u00b7 ${readingLogIds.size} in reading log`;
}

// ─── article overlay ─────────────────────────────────────────────────────

async function openArticle(id: string): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) return;
  currentArticleId = id;
  articleStartTimestamp = Date.now();
  const overlay = $('article-overlay');
  const body = $('article-body');
  const sourceEl = $('article-source');
  const readingTimeEl = $('article-reading-time');
  if (overlay === null || body === null || sourceEl === null || readingTimeEl === null) return;
  overlay.hidden = false;
  body.innerHTML = '<div class="banner info">Loading article...</div>';
  sourceEl.textContent = '';
  readingTimeEl.textContent = '';

  const seed = articles.find((a) => a.id === id);
  if (seed !== undefined) {
    const host = (() => {
      try {
        return new URL(seed.link).host.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    sourceEl.textContent = host;
    if (seed.readingTimeMinutes > 0) {
      readingTimeEl.textContent = `${seed.readingTimeMinutes} min read`;
    }
  }

  try {
    const fetched = await bridge.fetchArticleBody(id);
    // The bridge delivers raw HTML in `contentHtml` -- the renderer
    // owns extraction now (see `article-extractor.ts`). Mirrors the
    // full app's `Flipboard-IDW-Feed/uxmag-script.js` flow.
    const rawHtml = fetched.contentHtml ?? '';
    if (rawHtml.length === 0) {
      body.innerHTML = '<div class="banner error">Article body could not be loaded.</div>';
      return;
    }
    const extracted = extractArticle(rawHtml, fetched.link);

    // Hero image: prefer the article's own thumbnail (already in the
    // feed cache) for visual continuity with the tile, fall back to
    // the og:image / twitter:image meta the extractor pulled.
    const heroUrl = fetched.thumbnailUrl ?? extracted.heroImageUrl;
    const author = fetched.author ?? extracted.author;
    const dateStr = formatPublishedDate(fetched.publishedAt);

    body.innerHTML = renderArticleBody({
      title: fetched.title,
      heroUrl,
      author,
      dateStr,
      contentHtml: extracted.contentHtml,
    });

    // Reading time: prefer the renderer's count over the main-side
    // raw-HTML count -- the renderer's count is on the cleaned body,
    // which is what the user actually reads.
    const minutes =
      extracted.readingTimeMinutes > 0
        ? extracted.readingTimeMinutes
        : fetched.readingTimeMinutes;
    if (minutes > 0) readingTimeEl.textContent = `${minutes} min read`;

    // Open external links in the user's default browser. The
    // article body comes from a third-party page; in-window
    // navigation would replace the modal with that page. Same
    // behavior the full app's `processContentLinks` enforces.
    const articleBodyContent = body.querySelector('.article-content');
    if (articleBodyContent !== null) {
      for (const a of Array.from(articleBodyContent.querySelectorAll('a'))) {
        if (a instanceof HTMLAnchorElement) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      }
    }

    const idx = articles.findIndex((a) => a.id === id);
    if (idx >= 0) articles[idx] = fetched;
    void recordOpen(fetched);
  } catch (err) {
    const parsed = bridge.parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    body.innerHTML = `<div class="banner error">${escapeHtml(msg)}</div>`;
  }
}

interface RenderArticleBodyOpts {
  title: string;
  heroUrl: string | null;
  author: string | null;
  dateStr: string | null;
  contentHtml: string;
}

/**
 * Render the article body: hero image with title overlay, then a
 * metadata row (date + author), then the cleaned article content.
 * Mirrors the full app's `articleHTML` template in
 * `uxmag-script.js:openArticle`.
 *
 * The extracted `contentHtml` is interpolated raw -- it has already
 * been DOMParser-cleaned (scripts / styles / event handlers removed
 * by the extractor). Title / author / date are escaped.
 */
function renderArticleBody(opts: RenderArticleBodyOpts): string {
  const heroBlock =
    opts.heroUrl !== null && opts.heroUrl.length > 0
      ? `
      <div class="article-header">
        <img class="article-header-image" src="${escapeAttr(opts.heroUrl)}" alt="${escapeAttr(opts.title)}" loading="lazy" />
        <div class="article-header-overlay">
          <h1 id="article-title">${escapeHtml(opts.title)}</h1>
        </div>
      </div>
    `
      : `<h1 class="article-headline-no-hero">${escapeHtml(opts.title)}</h1>`;

  const metaParts: string[] = [];
  if (opts.dateStr !== null) metaParts.push(`<span class="article-date">${escapeHtml(opts.dateStr)}</span>`);
  if (opts.author !== null && opts.author.length > 0) {
    metaParts.push(`<span class="article-author">By ${escapeHtml(opts.author)}</span>`);
  }
  const metaBlock =
    metaParts.length > 0 ? `<div class="article-metadata">${metaParts.join('')}</div>` : '';

  return `
    ${heroBlock}
    ${metaBlock}
    <div class="article-content">${opts.contentHtml}</div>
  `;
}

/** Format an ISO publishedAt for the article-metadata bar. Best-effort -- returns null on parse failure. */
function formatPublishedDate(iso: string | null): string | null {
  if (iso === null || iso.length === 0) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  try {
    return new Date(ts).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

async function recordOpen(article: LiteAiRunTimesArticle): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) return;
  try {
    await bridge.recordRead({
      articleId: article.id,
      title: article.title,
      link: article.link,
      wordCount: article.wordCount,
    });
    readingLogIds.add(article.id);
    updateFooter();
  } catch {
    // best-effort
  }
}

function closeArticle(): void {
  const overlay = $('article-overlay');
  if (overlay !== null) overlay.hidden = true;
  if (currentArticleId !== null && articleStartTimestamp !== null) {
    const article = articles.find((a) => a.id === currentArticleId);
    if (article !== undefined) {
      void window.lite?.aiRunTimes?.recordRead({
        articleId: article.id,
        title: article.title,
        link: article.link,
        wordCount: article.wordCount,
        finishedAt: new Date().toISOString(),
      });
    }
  }
  currentArticleId = null;
  articleStartTimestamp = null;
  // Re-render so the "Read" badge appears.
  render();
}

function openOriginal(): void {
  if (currentArticleId === null) return;
  const article = articles.find((a) => a.id === currentArticleId);
  if (article === undefined) return;
  // Use Electron's window.open which routes through setWindowOpenHandler.
  // Falling through to anchor-click triggers Electron's default
  // external-link handling.
  const a = document.createElement('a');
  a.href = article.link;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.click();
}

// ─── preferences ─────────────────────────────────────────────────────────

function togglePrefsPanel(open: boolean): void {
  const panel = $('prefs-panel');
  if (panel === null) return;
  if (open) {
    panel.hidden = false;
    renderPrefsPanel();
  } else {
    panel.hidden = true;
  }
}

function renderPrefsPanel(): void {
  const list = $('prefs-list');
  if (list === null) return;
  list.innerHTML = preferences
    .map((p) => `
      <label class="prefs-item">
        <input type="checkbox" data-prefid="${escapeAttr(p.id)}" ${p.enabled ? 'checked' : ''} />
        <div class="prefs-item-text">
          <span class="prefs-item-label">${escapeHtml(p.label)}</span>
          <span class="prefs-item-description">${escapeHtml(p.description)}</span>
        </div>
      </label>
    `)
    .join('');
}

async function savePrefs(): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) return;
  const list = $('prefs-list');
  if (list === null) return;
  const enabled: string[] = [];
  for (const cb of Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    if (cb.checked) {
      const id = cb.dataset['prefid'];
      if (typeof id === 'string') enabled.push(id);
    }
  }
  try {
    preferences = await bridge.savePreferences(enabled as LiteAiRunTimesPreferenceId[]);
    showToast('Preferences saved.', 'success');
    togglePrefsPanel(false);
    render();
  } catch (err) {
    showToast(`Save failed: ${(err as Error).message}`, 'error');
  }
}

function togglePrefsSelectAll(): void {
  const list = $('prefs-list');
  if (list === null) return;
  const cbs = Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const allChecked = cbs.every((c) => c.checked);
  for (const cb of cbs) cb.checked = !allChecked;
}

// ─── reading log download ────────────────────────────────────────────────

async function exportLog(): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) return;
  try {
    const json = await bridge.exportReadingLog();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-run-times-reading-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Reading log downloaded.', 'success');
  } catch (err) {
    showToast(`Export failed: ${(err as Error).message}`, 'error');
  }
}
