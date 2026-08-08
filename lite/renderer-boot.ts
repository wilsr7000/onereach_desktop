/**
 * Onereach Lite -- shared renderer boot guard.
 *
 * Last-resort crash surface for every renderer entry point. Extracted
 * from `lite/spaces/spaces.ts` (the 2026-08-08 hardening review found
 * the pattern existed ONLY there and mandated it everywhere).
 *
 * A thrown exception during a renderer's `init()` used to leave the
 * window blank with no message and nothing in any log --
 * indistinguishable from a crash, and impossible to diagnose after the
 * fact. `bootRenderer` makes the failure:
 *
 *   (a) printed to `console.error`, which the main process forwards to
 *       the central log via `attachRendererDiagnostics`, and
 *   (b) shown to the user as something they can act on (a reload
 *       button) rather than a black rectangle.
 *
 * It also installs `window.onerror` / `unhandledrejection` listeners so
 * async failures from event handlers and un-awaited promises -- which
 * are otherwise silent -- reach the central log too.
 *
 * The opaque full-screen overlay is a BOOT-failure surface only. After
 * the first successful paint, a stray uncaught error in some click
 * handler must not blank a working app -- past that point failures are
 * console-only. "First successful paint" is (whichever comes first):
 *
 *   - `init()`'s returned promise resolving (or a sync `init`
 *     returning), or
 *   - the entry point calling `ctx.markBootSucceeded()` explicitly --
 *     for windows whose init keeps running long after the UI is up
 *     (spaces marks after the first space-list render; the main-window
 *     chrome marks before entering the long-lived chat loop).
 *
 * Deliberately dependency-free: it must work even when the failure
 * happened while wiring up the app, so it cannot rely on toasts, the
 * preload bridge, or any DOM the entry point normally builds.
 *
 * Usage (replaces the bare DOMContentLoaded dispatch):
 *
 *   bootRenderer({
 *     scope: 'settings',
 *     title: 'Settings failed to load',
 *     init: () => bootstrap(),
 *   });
 */

export interface RendererBootContext {
  /**
   * Mark the first meaningful paint. Idempotent. After this, uncaught
   * errors still go to `console.error` (and the central log) but the
   * full-screen failure banner is suppressed.
   */
  markBootSucceeded(): void;
}

export interface BootRendererOptions {
  /** Console log prefix, e.g. `'spaces'` -> `[spaces] fatal in ...`. */
  scope: string;
  /** Banner headline, e.g. `'Spaces failed to load'`. */
  title: string;
  /**
   * The entry point's init routine. Sync or async; a rejection or
   * throw before boot succeeds paints the failure banner.
   */
  init: (ctx: RendererBootContext) => void | Promise<unknown>;
}

/**
 * Install the crash surface and run `init` once the DOM is ready.
 * Call once at module scope of a renderer entry point.
 */
export function bootRenderer(opts: BootRendererOptions): void {
  let bootSucceeded = false;
  const markBootSucceeded = (): void => {
    bootSucceeded = true;
  };

  function reportFatalRendererError(where: string, err: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    // Routed to the central log by the main process.
    console.error(`[${opts.scope}] fatal in ${where}: ${detail}`);
    if (bootSucceeded) return;
    try {
      if (document.getElementById('lite-fatal') !== null) return;
      const banner = document.createElement('div');
      banner.id = 'lite-fatal';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99999',
        'display:flex', 'flex-direction:column', 'gap:12px',
        'align-items:center', 'justify-content:center',
        'padding:32px', 'text-align:center',
        'background:#0F1115', 'color:#e6e6e6',
        'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';');

      const title = document.createElement('div');
      title.textContent = opts.title;
      title.style.cssText = 'font-size:18px;font-weight:600';

      const body = document.createElement('div');
      body.textContent = 'The error has been written to the log. Reload to try again.';
      body.style.cssText = 'opacity:.75;max-width:44ch';

      const pre = document.createElement('pre');
      pre.textContent = detail.slice(0, 600);
      pre.style.cssText = [
        'max-width:80ch', 'max-height:30vh', 'overflow:auto',
        'text-align:left', 'padding:12px', 'border-radius:8px',
        'background:#171A21', 'color:#c6c9d1',
        'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
        // Dark scrollbars -- never a white slab on a dark surface.
        'scrollbar-color:#3a3f4b #171A21', 'scrollbar-width:thin',
      ].join(';');

      const reload = document.createElement('button');
      reload.textContent = 'Reload';
      reload.style.cssText =
        'padding:8px 18px;border-radius:6px;border:1px solid #3a3f4b;' +
        'background:#232833;color:#e6e6e6;cursor:pointer;font-size:13px';
      reload.addEventListener('click', () => window.location.reload());

      banner.append(title, body, pre, reload);
      (document.body ?? document.documentElement).appendChild(banner);
    } catch {
      /* the DOM itself is unusable -- console.error above is all we have */
    }
  }

  // Catch what escapes the boot path too: async failures from event
  // handlers and un-awaited promises, which are otherwise silent.
  window.addEventListener('error', (ev) => {
    reportFatalRendererError('window.onerror', ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    reportFatalRendererError('unhandledrejection', ev.reason);
  });

  function boot(): void {
    try {
      const result = opts.init({ markBootSucceeded }) as unknown;
      // `init` may be async -- an awaited rejection would otherwise
      // only surface as an unhandled rejection with no context about
      // boot.
      if (result instanceof Promise) {
        result.then(markBootSucceeded).catch((err: unknown) => {
          reportFatalRendererError('init', err);
        });
      } else {
        markBootSucceeded();
      }
    } catch (err) {
      reportFatalRendererError('init', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
