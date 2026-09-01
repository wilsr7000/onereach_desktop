/**
 * AI settings section -- Anthropic (Claude) API key.
 *
 * Lets the user paste their Claude API key so the app can automatically
 * extract metadata for assets (summary, tags, topics, entities, ...).
 * The key is stored in the OS keychain via `window.lite.ai.saveKey` and
 * is **write-only** across the bridge: this UI can save / check / clear
 * it but never read the value back. The form shows only whether a key is
 * configured.
 *
 * Reuses the generic `neon-*` form primitives from settings.css (card,
 * field, input, status pill, actions, banner) so it needs no new styles.
 *
 * Per ADR-031, this section consumes another module's bridge
 * (`window.lite.ai.*`) and never reaches into module internals.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

const KEY_PLACEHOLDER = '••••••••';

function aiBridge(): LiteAiBridge {
  const a = window.lite?.ai;
  if (a === undefined) {
    throw new Error('preload bridge `window.lite.ai` is not available');
  }
  return a;
}

export const mountAi: SectionDescriptor['mount'] = (container) => {
  void render(container);
  return (): void => {
    container.innerHTML = '';
  };
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(container: HTMLElement): Promise<void> {
  let bridge: LiteAiBridge;
  try {
    bridge = aiBridge();
  } catch (err) {
    container.innerHTML = `<div class="pane-placeholder">AI settings are unavailable: ${escapeHtml(
      (err as Error).message
    )}</div>`;
    return;
  }

  let configured = false;
  try {
    const res = await bridge.hasKey();
    configured = res.ok ? res.value.hasKey : false;
  } catch {
    configured = false;
  }

  renderForm(container, configured);
}

function renderForm(container: HTMLElement, configured: boolean): void {
  const pill = configured ? 'neon-status-pill ok' : 'neon-status-pill warn';
  const pillText = configured ? 'Key configured' : 'Not configured';
  const placeholder = configured
    ? `${KEY_PLACEHOLDER}  (saved -- leave blank to keep)`
    : 'sk-ant-...';

  container.innerHTML = `
    <div class="neon-card">
      <div class="neon-status-row">
        <span class="${pill}">${escapeHtml(pillText)}</span>
        <span class="neon-status-help">
          Powers automatic metadata for your assets.
        </span>
      </div>

      <div class="neon-explainer">
        <div class="neon-explainer-title">Claude (Anthropic) API key</div>
        <p class="neon-explainer-body">
          When a key is set, Onereach.ai Lite uses <strong>Claude</strong> to
          read each asset you add and fill in metadata automatically -- a short
          summary, tags, topics, entities, and key points -- so your Spaces
          stay searchable without manual tagging.
        </p>
        <p class="neon-explainer-body">
          Get a key from the
          <strong>Anthropic Console</strong> (console.anthropic.com). It's
          stored only in this device's keychain, never shown again once saved,
          and never sent anywhere except Anthropic when extracting metadata.
        </p>
      </div>

      <div class="neon-field">
        <div class="neon-field-label-row">
          <label for="ai-key">API key</label>
          <button type="button" id="ai-key-toggle" class="neon-link-button">show</button>
        </div>
        <input
          type="password"
          id="ai-key"
          class="neon-input neon-input-password"
          spellcheck="false"
          autocomplete="new-password"
          placeholder="${escapeHtml(placeholder)}"
        />
        <div class="neon-field-help">
          Stored in your OS keychain. Asset content is sent to Anthropic only
          to generate metadata.
        </div>
      </div>

      <div class="neon-actions">
        <button type="button" id="ai-save" class="btn-primary">Save key</button>
        <button type="button" id="ai-test" class="btn-secondary">Test</button>
        <button type="button" id="ai-clear" class="btn-secondary"${
          configured ? '' : ' disabled'
        }>Clear key</button>
      </div>

      <div id="ai-banner" class="banner" style="display: none;"></div>
    </div>
  `;

  wireForm(container);
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

function wireForm(container: HTMLElement): void {
  const keyInput = el<HTMLInputElement>(container, 'ai-key');
  const toggle = el<HTMLButtonElement>(container, 'ai-key-toggle');
  const save = el<HTMLButtonElement>(container, 'ai-save');
  const test = el<HTMLButtonElement>(container, 'ai-test');
  const clear = el<HTMLButtonElement>(container, 'ai-clear');
  const banner = el<HTMLElement>(container, 'ai-banner');

  toggle.addEventListener('click', () => {
    if (keyInput.type === 'password') {
      keyInput.type = 'text';
      toggle.textContent = 'hide';
    } else {
      keyInput.type = 'password';
      toggle.textContent = 'show';
    }
  });

  save.addEventListener('click', () => {
    void (async () => {
      const key = keyInput.value.trim();
      if (key.length === 0) {
        showBanner(banner, 'Paste your Anthropic API key first.', 'warn');
        return;
      }
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const res = await aiBridge().saveKey(key);
        if (res.ok) {
          showBanner(banner, 'Key saved. Claude metadata is now enabled.', 'ok');
          // Re-render so the status pill flips + the input clears.
          await render(container);
          return;
        }
        showBanner(banner, res.error.message, 'warn');
      } catch (err) {
        window.logging?.error?.('settings', 'AI key save failed', { error: (err as Error).message });
        showBanner(banner, (err as Error).message, 'warn');
      } finally {
        save.disabled = false;
        save.textContent = 'Save key';
      }
    })();
  });

  test.addEventListener('click', () => {
    void (async () => {
      const key = keyInput.value.trim();
      if (key.length === 0) {
        showBanner(banner, 'Paste a key to test it.', 'warn');
        return;
      }
      test.disabled = true;
      const original = test.textContent;
      test.textContent = 'Testing…';
      try {
        const res = await aiBridge().testKey(key);
        if (res.ok) {
          showBanner(
            banner,
            `Key works — authenticated with Claude (${res.value.model}).`,
            'ok'
          );
        } else {
          showBanner(banner, `Key test failed: ${res.error.message}`, 'warn');
        }
      } catch (err) {
        window.logging?.error?.('settings', 'AI key test failed', { error: (err as Error).message });
        showBanner(banner, (err as Error).message, 'warn');
      } finally {
        test.disabled = false;
        test.textContent = original;
      }
    })();
  });

  clear.addEventListener('click', () => {
    void (async () => {
      clear.disabled = true;
      try {
        const res = await aiBridge().deleteKey();
        if (res.ok) {
          showBanner(banner, 'Key cleared. Automatic metadata is off.', 'ok');
          await render(container);
          return;
        }
        showBanner(banner, res.error.message, 'warn');
      } catch (err) {
        window.logging?.error?.('settings', 'AI key clear failed', { error: (err as Error).message });
        showBanner(banner, (err as Error).message, 'warn');
      } finally {
        clear.disabled = false;
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showBanner(banner: HTMLElement, message: string, kind: 'ok' | 'warn'): void {
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  banner.style.display = 'block';
}

function el<T extends HTMLElement>(container: HTMLElement, id: string): T {
  const node = container.querySelector<T>(`#${id}`);
  if (node === null) throw new Error(`settings/ai: missing #${id}`);
  return node;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
