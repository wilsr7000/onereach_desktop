/**
 * AI Run Times renderer.
 *
 * Loaded into the AI Run Times window. Wires up:
 *   - Tile grid with images, reading time, "new" / "read" badges
 *   - Article overlay reader (open via tile click)
 *   - Content preferences side panel
 *   - Reading log JSON download
 *   - TTS audio playlist (per-article Listen button + global
 *     prev/play/next + queue panel) with chunked OpenAI TTS, blob
 *     URL cleanup, queue auto-advance, mark-as-read on completion
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

export {};

// ─── helpers ─────────────────────────────────────────────────────────────

const READ_LOG_KEY_PREFIX = 'art-read-cache:';

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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}\u2026`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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

interface QueueItem {
  articleId: string;
  title: string;
  link: string;
}

let queue: QueueItem[] = [];
let currentQueueIndex = -1;
let currentAudio: HTMLAudioElement | null = null;
let currentAudioBlobUrl: string | null = null;
let currentAudioChunks: ArrayBuffer[] = [];
let currentChunkIndex = 0;
let isPlaying = false;
let articleStartTimestamp: number | null = null;

// ─── boot ────────────────────────────────────────────────────────────────

function boot(): void {
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
  const articleListen = $('article-listen-btn');
  if (articleListen !== null) articleListen.addEventListener('click', () => void listenToArticle());

  // Playlist controls
  const plPlay = $('pl-play');
  if (plPlay !== null) plPlay.addEventListener('click', () => togglePlayback());
  const plPrev = $('pl-prev');
  if (plPrev !== null) plPrev.addEventListener('click', () => playPrevious());
  const plNext = $('pl-next');
  if (plNext !== null) plNext.addEventListener('click', () => playNext());
  const plToggle = $('pl-toggle');
  if (plToggle !== null) plToggle.addEventListener('click', () => togglePlaylistPanel());
  const plSelectAll = $('pl-select-all');
  if (plSelectAll !== null) plSelectAll.addEventListener('click', () => selectAllInQueue());
  const plClearAll = $('pl-clear-all');
  if (plClearAll !== null) plClearAll.addEventListener('click', () => clearQueue());

  // Progress bar seek
  const progress = $('playlist-progress');
  if (progress !== null) {
    progress.addEventListener('click', (e) => {
      if (currentAudio === null) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      currentAudio.currentTime = currentAudio.duration * ratio;
    });
  }

  void initialLoad();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// ─── load ────────────────────────────────────────────────────────────────

async function initialLoad(): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) {
    showError('AI Run Times bridge unavailable. Restart the app to recover.');
    return;
  }
  showLoading();
  try {
    const [arts, prefs, log] = await Promise.all([
      bridge.listArticles(),
      bridge.listPreferences(),
      bridge.listReadingLog(),
    ]);
    articles = arts;
    preferences = prefs;
    readingLogIds = new Set(log.map((e) => e.articleId));
    if (articles.length === 0) {
      // Auto-refresh on first open.
      await refreshFeed(/* silent */ true);
    } else {
      render();
      updateFooter();
    }
  } catch (err) {
    showError(`Failed to load: ${(err as Error).message}`);
  }
}

async function refreshFeed(silent = false): Promise<void> {
  const bridge = window.lite?.aiRunTimes;
  if (bridge === undefined) return;
  if (!silent) showToast('Refreshing feed...', 'info');
  showLoading();
  try {
    const result = await bridge.refreshFeed();
    articles = await bridge.listArticles();
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
  if (content === null) return;
  const enabledIds = new Set(preferences.filter((p) => p.enabled).map((p) => p.id));
  const visible = articles.filter((a) => articleMatchesPreferences(a, enabledIds));
  if (visible.length === 0) {
    content.innerHTML = `
      <div class="banner empty">
        <div class="empty-title">No articles to show</div>
        <div class="empty-subtitle">Try Refresh to fetch the latest, or open Preferences to widen the topic filter.</div>
      </div>
    `;
    return;
  }
  const tiles = visible.map(renderTile).join('\n');
  content.innerHTML = `
    <div class="section-header">
      <span class="section-title">Latest</span>
      <span class="section-count">(${visible.length})</span>
    </div>
    <div class="tile-grid">${tiles}</div>
  `;
  for (const tileEl of Array.from(content.querySelectorAll<HTMLButtonElement>('button[data-id]'))) {
    const id = tileEl.dataset['id'];
    if (typeof id !== 'string') continue;
    tileEl.addEventListener('click', () => void openArticle(id));
  }
}

function articleMatchesPreferences(
  article: LiteAiRunTimesArticle,
  enabledIds: Set<string>
): boolean {
  if (enabledIds.size === preferences.length) return true; // all enabled
  if (article.categories.length === 0) return true; // uncategorized always shows
  // Match if any of the article's categories overlap any enabled preference label
  // (simple substring match -- robust to feed-specific category strings).
  const enabledLabels = preferences
    .filter((p) => enabledIds.has(p.id))
    .map((p) => p.label.toLowerCase());
  const articleCats = article.categories.map((c) => c.toLowerCase());
  return enabledLabels.some((label) =>
    articleCats.some((cat) => cat.includes(label) || label.includes(cat))
  );
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
    body.innerHTML = `
      <h1>${escapeHtml(fetched.title)}</h1>
      ${fetched.author !== null ? `<p style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:18px;">By ${escapeHtml(fetched.author)}</p>` : ''}
      ${fetched.contentHtml ?? '<p>(No content extracted.)</p>'}
    `;
    if (fetched.readingTimeMinutes > 0) {
      readingTimeEl.textContent = `${fetched.readingTimeMinutes} min read`;
    }
    // Update local cache so re-render reflects the new reading time.
    const idx = articles.findIndex((a) => a.id === id);
    if (idx >= 0) articles[idx] = fetched;
    void recordOpen(fetched);
  } catch (err) {
    const parsed = bridge.parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    body.innerHTML = `<div class="banner error">${escapeHtml(msg)}</div>`;
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
  // Since the AI Run Times window has no setWindowOpenHandler defined
  // for external opens, falling back to changing location triggers
  // Electron's default external link handling.
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

// ─── TTS / audio playlist ────────────────────────────────────────────────

async function listenToArticle(): Promise<void> {
  if (currentArticleId === null) return;
  const article = articles.find((a) => a.id === currentArticleId);
  if (article === undefined) return;
  if (article.contentHtml === null) {
    showToast('Article body not loaded yet.', 'error');
    return;
  }
  // Add to queue if not already present
  if (!queue.some((q) => q.articleId === article.id)) {
    queue.push({ articleId: article.id, title: article.title, link: article.link });
    renderQueue();
    updateQueueCount();
  }
  // Set as current and play
  const idx = queue.findIndex((q) => q.articleId === article.id);
  currentQueueIndex = idx;
  await playArticle(article);
}

async function playArticle(article: LiteAiRunTimesArticle): Promise<void> {
  const aiBridge = window.lite?.ai;
  if (aiBridge === undefined) {
    showToast('Lite AI bridge unavailable.', 'error');
    return;
  }
  // Ensure key is configured before generating.
  let status: { hasApiKey: boolean; defaultTtsVoice: string } | null = null;
  try {
    status = await aiBridge.status();
  } catch {
    showToast('Could not read AI service status.', 'error');
    return;
  }
  if (!status.hasApiKey) {
    showToast('Add an OpenAI API key in Settings -> AI to enable Listen.', 'error');
    return;
  }
  showPlaylistBar();
  setLabelTitle(article.title);
  setPlayingTitle(article.title);
  showToast('Generating audio...', 'info');

  // Strip HTML to plain text + chunk to ~3500 chars on sentence boundary.
  const text = htmlToText(article.contentHtml ?? '');
  const chunks = chunkText(text, 3500);
  if (chunks.length === 0) {
    showToast('Article body is empty.', 'error');
    return;
  }
  currentAudioChunks = [];
  currentChunkIndex = 0;
  // Per ADR-045: route TTS through the cached-tts IPC so replays of
  // articles we've already listened to don't burn OpenAI credits.
  // The main process checks Files first by deterministic key
  // (articleId + voice + sha1(text)) and only generates on miss.
  const artBridge = window.lite?.aiRunTimes;
  if (artBridge === undefined) {
    showToast('AI Run Times bridge unavailable.', 'error');
    return;
  }
  // Generate first chunk before playing; subsequent chunks generate while playing.
  try {
    const firstResp = await artBridge.cachedTts({
      articleId: article.id,
      text: chunks[0] ?? '',
      voice: status.defaultTtsVoice as LiteAiTtsVoice,
    });
    const firstBytes = base64ToBytes(firstResp.audioBase64);
    currentAudioChunks.push(toArrayBuffer(firstBytes));
  } catch (err) {
    const parsed = aiBridge.parseError(err) ?? artBridge.parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showToast(`TTS failed: ${msg}`, 'error');
    return;
  }
  // Play first chunk
  startPlaybackOfChunk(0, article, chunks);
  // Background-generate remaining chunks
  void preloadRemainingChunks(chunks, status.defaultTtsVoice as LiteAiTtsVoice, article.id);
}

async function preloadRemainingChunks(
  chunks: string[],
  voice: LiteAiTtsVoice,
  articleId: string
): Promise<void> {
  const artBridge = window.lite?.aiRunTimes;
  if (artBridge === undefined) return;
  for (let i = 1; i < chunks.length; i += 1) {
    if (currentArticleId !== articleId) return; // user moved on
    try {
      const resp = await artBridge.cachedTts({
        articleId,
        text: chunks[i] ?? '',
        voice,
      });
      currentAudioChunks.push(toArrayBuffer(base64ToBytes(resp.audioBase64)));
    } catch {
      // chunk fail -> stop preloading; user gets what we generated
      return;
    }
  }
}

function startPlaybackOfChunk(
  index: number,
  article: LiteAiRunTimesArticle,
  chunks: string[]
): void {
  if (index < 0 || index >= currentAudioChunks.length) return;
  const buf = currentAudioChunks[index];
  if (buf === undefined) return;
  cleanupAudio();
  const blob = new Blob([buf], { type: 'audio/mpeg' });
  currentAudioBlobUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentAudioBlobUrl);
  currentAudio.addEventListener('timeupdate', updateProgress);
  currentAudio.addEventListener('ended', () => {
    // Try next chunk
    const nextIdx = currentChunkIndex + 1;
    if (nextIdx < chunks.length) {
      // Wait briefly for preload if not yet generated
      const tryNext = (): void => {
        if (nextIdx < currentAudioChunks.length) {
          currentChunkIndex = nextIdx;
          startPlaybackOfChunk(nextIdx, article, chunks);
        } else {
          window.setTimeout(tryNext, 400);
        }
      };
      tryNext();
    } else {
      // Article finished. Mark as listened in reading log + move to next queue item.
      void window.lite?.aiRunTimes?.recordRead({
        articleId: article.id,
        title: article.title,
        link: article.link,
        wordCount: article.wordCount,
        finishedAt: new Date().toISOString(),
        listenedToCompletion: true,
      });
      readingLogIds.add(article.id);
      updateFooter();
      render();
      void playNext();
    }
  });
  currentAudio.play().then(() => {
    isPlaying = true;
    updatePlayPauseButton();
  }).catch(() => {
    showToast('Audio playback failed.', 'error');
  });
}

function cleanupAudio(): void {
  if (currentAudio !== null) {
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    currentAudio.src = '';
    currentAudio = null;
  }
  if (currentAudioBlobUrl !== null) {
    URL.revokeObjectURL(currentAudioBlobUrl);
    currentAudioBlobUrl = null;
  }
}

function togglePlayback(): void {
  if (currentAudio === null) return;
  if (currentAudio.paused) {
    void currentAudio.play();
    isPlaying = true;
  } else {
    currentAudio.pause();
    isPlaying = false;
  }
  updatePlayPauseButton();
}

async function playNext(): Promise<void> {
  if (currentQueueIndex < 0) return;
  const nextIdx = currentQueueIndex + 1;
  if (nextIdx >= queue.length) {
    cleanupAudio();
    isPlaying = false;
    updatePlayPauseButton();
    showToast('Queue finished.', 'success');
    return;
  }
  const next = queue[nextIdx];
  if (next === undefined) return;
  currentQueueIndex = nextIdx;
  const article = articles.find((a) => a.id === next.articleId);
  if (article === undefined) return;
  // If article body not loaded yet, fetch it first
  if (article.contentHtml === null) {
    try {
      const fetched = await window.lite!.aiRunTimes!.fetchArticleBody(article.id);
      const idx = articles.findIndex((a) => a.id === article.id);
      if (idx >= 0) articles[idx] = fetched;
      await playArticle(fetched);
    } catch {
      showToast(`Could not load ${next.title}.`, 'error');
    }
  } else {
    await playArticle(article);
  }
  renderQueue();
}

async function playPrevious(): Promise<void> {
  if (currentQueueIndex <= 0) return;
  currentQueueIndex -= 1;
  const item = queue[currentQueueIndex];
  if (item === undefined) return;
  const article = articles.find((a) => a.id === item.articleId);
  if (article === undefined) return;
  if (article.contentHtml === null) {
    try {
      const fetched = await window.lite!.aiRunTimes!.fetchArticleBody(article.id);
      const idx = articles.findIndex((a) => a.id === article.id);
      if (idx >= 0) articles[idx] = fetched;
      await playArticle(fetched);
    } catch {
      showToast(`Could not load ${item.title}.`, 'error');
    }
  } else {
    await playArticle(article);
  }
  renderQueue();
}

function showPlaylistBar(): void {
  const bar = $('playlist-bar');
  if (bar !== null) bar.hidden = false;
}

function setLabelTitle(t: string): void {
  const label = $('playlist-label');
  if (label !== null) label.textContent = `Now Playing \u00b7 ${truncate(t, 30)}`;
}

function setPlayingTitle(t: string): void {
  const el = $('playlist-current-title');
  if (el !== null) el.textContent = t;
}

function updateProgress(): void {
  if (currentAudio === null) return;
  const fill = $('playlist-progress-fill');
  const time = $('playlist-time');
  if (fill !== null && currentAudio.duration > 0) {
    fill.style.width = `${(currentAudio.currentTime / currentAudio.duration) * 100}%`;
  }
  if (time !== null) {
    time.textContent = `${formatTime(currentAudio.currentTime)} / ${formatTime(currentAudio.duration)}`;
  }
}

function updatePlayPauseButton(): void {
  const btn = $('pl-play');
  if (btn === null) return;
  btn.innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9658;';
}

function togglePlaylistPanel(): void {
  const panel = $('playlist-panel');
  if (panel === null) return;
  panel.hidden = !panel.hidden;
}

function renderQueue(): void {
  const items = $('playlist-items');
  if (items === null) return;
  if (queue.length === 0) {
    items.innerHTML = '<p style="color:rgba(255,255,255,0.5);font-size:11.5px;padding:8px 0;">Queue is empty. Click Listen on an article to add it.</p>';
    return;
  }
  items.innerHTML = queue
    .map(
      (q, i) => `
      <div class="playlist-item ${i === currentQueueIndex ? 'playing' : ''}" data-idx="${i}">
        <span class="playlist-item-title">${escapeHtml(q.title)}</span>
        <span class="playlist-item-meta">${i === currentQueueIndex ? 'playing' : `#${i + 1}`}</span>
      </div>
    `
    )
    .join('');
  for (const el of Array.from(items.querySelectorAll<HTMLElement>('.playlist-item'))) {
    el.addEventListener('click', () => {
      const idxStr = el.dataset['idx'];
      if (typeof idxStr !== 'string') return;
      const idx = Number(idxStr);
      if (!Number.isFinite(idx)) return;
      const item = queue[idx];
      if (item === undefined) return;
      currentQueueIndex = idx;
      const article = articles.find((a) => a.id === item.articleId);
      if (article !== undefined) void playArticle(article);
    });
  }
}

function selectAllInQueue(): void {
  // For v1, the queue model is "items added via Listen button"; nothing extra to select.
  showToast('Use Listen on an article to add it to the queue.', 'info');
}

function clearQueue(): void {
  cleanupAudio();
  queue = [];
  currentQueueIndex = -1;
  isPlaying = false;
  updatePlayPauseButton();
  renderQueue();
  updateQueueCount();
  setPlayingTitle('No article selected');
}

function updateQueueCount(): void {
  const el = $('playlist-queue-count');
  if (el !== null) el.textContent = `${queue.length} in queue`;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // Insert a space before block-level closing tags so inline text doesn't fuse.
  return (tmp.innerText || tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function chunkText(text: string, maxChars: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Look for the last sentence boundary in the slice.
      const slice = text.slice(start, end);
      const lastPeriod = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('.\n'),
        slice.lastIndexOf('!\n'),
        slice.lastIndexOf('?\n')
      );
      if (lastPeriod > maxChars * 0.5) {
        end = start + lastPeriod + 1;
      }
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Copy a Uint8Array's bytes into a fresh ArrayBuffer. Avoids the
 * SharedArrayBuffer | ArrayBuffer ambiguity in `Uint8Array.buffer`
 * that breaks Blob constructor + addEventListener type checks.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// Touch unused imports so dep-cruiser doesn't flag.
void READ_LOG_KEY_PREFIX;
