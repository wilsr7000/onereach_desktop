/**
 * Onereach.ai Lite -- Help window renderer.
 *
 * Loaded by `help.html` as a bundled IIFE (per the strict CSP --
 * `script-src 'self'` blocks inline scripts; see the punch-list note
 * about `placeholder.ts` for context). Two responsibilities:
 *   1. Stamp the live Lite version into the TOC brand area, replacing
 *      the static "User Guide" placeholder.
 *   2. Highlight whichever section is currently in view in the TOC.
 *
 * This file is bundled to `dist-lite/build/help.js` by
 * `lite/esbuild.config.mjs`. It runs in the renderer process and only
 * touches the DOM.
 */

interface LiteWindow {
  lite?: {
    version?: string;
  };
}

/**
 * Stamp the Lite version into the TOC header (replaces the static
 * "User Guide" subline). Falls back to the placeholder text if
 * `window.lite.version` isn't populated -- e.g. when the help page
 * is loaded outside the Electron preload (rare; mostly during dev).
 */
function stampVersion(): void {
  const versionEl = document.getElementById('version');
  if (versionEl === null) return;
  const liteWin = window as unknown as LiteWindow;
  const v = liteWin.lite?.version;
  if (typeof v === 'string' && v.length > 0) {
    versionEl.textContent = `User Guide • v${v}`;
  }
}

/**
 * IntersectionObserver-based TOC scroll spy. Highlights the TOC link
 * matching the section closest to the top of the viewport. The
 * `rootMargin` shifts the trigger line ~30% down from the top so a
 * section is "active" when its heading is roughly at eye level rather
 * than only after the previous section has fully scrolled off.
 *
 * Falls back to no-op if IntersectionObserver isn't available
 * (modern Electron always supports it; the guard is paranoid).
 */
function initScrollSpy(): void {
  if (typeof IntersectionObserver === 'undefined') return;

  const sections = Array.from(document.querySelectorAll<HTMLElement>('main.content > section'));
  if (sections.length === 0) return;

  const linkById = new Map<string, HTMLAnchorElement>();
  for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('.toc-link'))) {
    const href = link.getAttribute('href');
    if (typeof href === 'string' && href.startsWith('#')) {
      linkById.set(href.slice(1), link);
    }
  }

  let activeId: string | null = null;
  const setActive = (id: string | null): void => {
    if (id === activeId) return;
    if (activeId !== null) {
      linkById.get(activeId)?.classList.remove('is-active');
    }
    activeId = id;
    if (id !== null) {
      linkById.get(id)?.classList.add('is-active');
    }
  };

  // Track which sections are currently intersecting; the topmost one
  // wins. We don't trust `entry.isIntersecting` alone because two
  // sections often satisfy the rootMargin window simultaneously
  // (e.g. on initial load when content is short).
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (entry.isIntersecting) {
          visible.add(id);
        } else {
          visible.delete(id);
        }
      }
      // Pick the first section (in document order) currently visible.
      let chosen: string | null = null;
      for (const section of sections) {
        if (visible.has(section.id)) {
          chosen = section.id;
          break;
        }
      }
      if (chosen !== null) setActive(chosen);
    },
    {
      // Trigger when a section enters the upper third of the viewport.
      rootMargin: '0px 0px -70% 0px',
      threshold: 0,
    }
  );

  for (const section of sections) observer.observe(section);

  // Initial state: pick the section whose top is closest to (but not
  // below) the viewport top. Without this, the first link doesn't
  // light up until the user scrolls.
  const initial = sections[0]?.id ?? null;
  setActive(initial);
}

/**
 * Smooth-scroll TOC anchor clicks. Native browser behavior already
 * smooth-scrolls when `scroll-behavior: smooth` is set on the scroll
 * container (it is, in `help.css`). This handler just calls
 * `scrollIntoView` directly so the selected section's `scroll-margin-top`
 * is honored (it is) and the URL hash updates.
 */
function initAnchorScroll(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLAnchorElement)) return;
    const href = target.getAttribute('href');
    if (typeof href !== 'string' || !href.startsWith('#')) return;
    const id = href.slice(1);
    const section = document.getElementById(id);
    if (section === null) return;
    ev.preventDefault();
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Update the URL fragment without forcing a re-scroll.
    history.replaceState(null, '', `#${id}`);
  });
}

function init(): void {
  stampVersion();
  initScrollSpy();
  initAnchorScroll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
