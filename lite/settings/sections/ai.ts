/**
 * Settings -> AI section.
 *
 * Hosts the OpenAI API key configuration that powers the Lite AI
 * service (TTS for AI Run Times today; chat / future profiles
 * later). The key is the only secret on this surface; status()
 * returns `hasApiKey: boolean` so the form starts empty even when
 * one is saved -- the user can leave the key field blank to keep
 * the existing one.
 *
 * Per ADR-040, the v1 AI service is OpenAI-only with a BYO-key
 * model. The key persists in KV today; the README's hardening
 * roadmap (A1) moves it to the OS keychain via `keytar` (same
 * pattern as `lite/totp/store.ts`) without changing the bridge
 * surface or this section's UI.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

const STORAGE_KEY_PLACEHOLDER = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

const VOICE_OPTIONS = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
const MODEL_OPTIONS = ['tts-1', 'tts-1-hd'] as const;

function ai(): LiteAiBridge {
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

async function render(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="settings-section">
      <h2>AI Service</h2>
      <p class="settings-section-explainer">
        The Lite AI service powers features like AI Run Times text-to-speech. v1 talks to OpenAI directly with your own API key (no OneReach proxy). The key lives in this app's local storage and is never logged or sent anywhere except OpenAI.
      </p>

      <div id="ai-status" class="settings-status-card"></div>

      <form id="ai-form" class="settings-form">
        <div class="settings-field">
          <label for="ai-api-key">OpenAI API key</label>
          <div class="settings-input-row">
            <input id="ai-api-key" type="password" autocomplete="new-password" placeholder="sk-..." />
            <button type="button" id="ai-key-toggle" class="settings-icon-btn" title="Show / hide">Show</button>
          </div>
          <p class="settings-field-hint">
            Get a key from <span class="settings-mono">platform.openai.com -> API keys</span>. Leave blank to keep the existing one. Type <span class="settings-mono">clear</span> to remove the saved key.
          </p>
        </div>

        <div class="settings-field">
          <label for="ai-tts-voice">Default TTS voice</label>
          <select id="ai-tts-voice">
            ${VOICE_OPTIONS.map((v) => `<option value="${v}">${v}</option>`).join('')}
          </select>
          <p class="settings-field-hint">Voice used when AI Run Times generates audio. <span class="settings-mono">nova</span> is balanced.</p>
        </div>

        <div class="settings-field">
          <label for="ai-tts-model">Default TTS quality</label>
          <select id="ai-tts-model">
            ${MODEL_OPTIONS.map((m) => `<option value="${m}">${m === 'tts-1' ? 'tts-1 (fast)' : 'tts-1-hd (higher quality)'}</option>`).join('')}
          </select>
        </div>

        <div class="settings-actions">
          <button type="button" id="ai-test-btn" class="btn-secondary">Test Connection</button>
          <button type="submit" id="ai-save-btn" class="btn-primary">Save</button>
        </div>
      </form>

      <div id="ai-toast"></div>
    </div>
  `;

  await refreshStatus(container);
  wireEvents(container);
}

async function refreshStatus(container: HTMLElement): Promise<void> {
  const statusEl = container.querySelector('#ai-status') as HTMLElement | null;
  if (statusEl === null) return;
  try {
    const status = await ai().status();
    const voiceEl = container.querySelector('#ai-tts-voice') as HTMLSelectElement | null;
    const modelEl = container.querySelector('#ai-tts-model') as HTMLSelectElement | null;
    if (voiceEl !== null) voiceEl.value = status.defaultTtsVoice;
    if (modelEl !== null) modelEl.value = status.defaultTtsModel;
    const apiKeyEl = container.querySelector('#ai-api-key') as HTMLInputElement | null;
    if (apiKeyEl !== null) {
      apiKeyEl.value = '';
      apiKeyEl.placeholder = status.hasApiKey ? STORAGE_KEY_PLACEHOLDER : 'sk-...';
    }
    statusEl.innerHTML = renderStatus(status);
  } catch (err) {
    statusEl.innerHTML = `<div class="settings-status-error">Could not read AI status: ${escapeHtml((err as Error).message)}</div>`;
  }
}

function renderStatus(status: LiteAiStatus): string {
  const ready = status.hasApiKey;
  const dot = ready ? 'settings-status-dot-ok' : 'settings-status-dot-warn';
  const label = ready ? 'API key configured' : 'No API key set';
  const sub = ready
    ? `provider: ${status.provider} \u00b7 default voice: ${status.defaultTtsVoice} \u00b7 model: ${status.defaultTtsModel}`
    : 'AI Run Times TTS will be disabled until you add a key.';
  return `
    <div class="settings-status-row">
      <span class="settings-status-dot ${dot}"></span>
      <div>
        <div class="settings-status-title">${escapeHtml(label)}</div>
        <div class="settings-status-sub">${escapeHtml(sub)}</div>
      </div>
    </div>
  `;
}

function wireEvents(container: HTMLElement): void {
  const form = container.querySelector('#ai-form') as HTMLFormElement | null;
  const toggleBtn = container.querySelector('#ai-key-toggle') as HTMLButtonElement | null;
  const apiKeyEl = container.querySelector('#ai-api-key') as HTMLInputElement | null;
  const testBtn = container.querySelector('#ai-test-btn') as HTMLButtonElement | null;

  if (toggleBtn !== null && apiKeyEl !== null) {
    toggleBtn.addEventListener('click', () => {
      apiKeyEl.type = apiKeyEl.type === 'password' ? 'text' : 'password';
      toggleBtn.textContent = apiKeyEl.type === 'password' ? 'Show' : 'Hide';
    });
  }

  if (form !== null) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void save(container);
    });
  }

  if (testBtn !== null) {
    testBtn.addEventListener('click', () => void testConnection(container));
  }
}

async function save(container: HTMLElement): Promise<void> {
  const apiKeyEl = container.querySelector('#ai-api-key') as HTMLInputElement | null;
  const voiceEl = container.querySelector('#ai-tts-voice') as HTMLSelectElement | null;
  const modelEl = container.querySelector('#ai-tts-model') as HTMLSelectElement | null;
  const config: LiteAiConfig = {};
  if (apiKeyEl !== null) {
    const v = apiKeyEl.value.trim();
    if (v === 'clear') {
      config.apiKey = '';
    } else if (v.length > 0) {
      config.apiKey = v;
    }
  }
  if (voiceEl !== null && voiceEl.value.length > 0) {
    config.defaultTtsVoice = voiceEl.value as LiteAiTtsVoice;
  }
  if (modelEl !== null && modelEl.value.length > 0) {
    config.defaultTtsModel = modelEl.value as LiteAiTtsModel;
  }
  try {
    await ai().configure(config);
    showToast(container, 'Settings saved.', 'success');
    await refreshStatus(container);
  } catch (err) {
    const parsed = ai().parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showToast(container, `Save failed: ${msg}`, 'error');
  }
}

async function testConnection(container: HTMLElement): Promise<void> {
  showToast(container, 'Testing OpenAI key...', 'info');
  try {
    // A 1-token chat is the cheapest validation request OpenAI offers.
    await ai().chat({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      feature: 'settings-test',
    });
    showToast(container, 'OpenAI key works.', 'success');
  } catch (err) {
    const parsed = ai().parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showToast(container, `Test failed: ${msg}`, 'error');
  }
}

function showToast(container: HTMLElement, message: string, kind: 'info' | 'success' | 'error'): void {
  const toast = container.querySelector('#ai-toast') as HTMLElement | null;
  if (toast === null) return;
  toast.innerHTML = `<div class="settings-toast settings-toast-${kind}">${escapeHtml(message)}</div>`;
  window.setTimeout(() => {
    toast.innerHTML = '';
  }, 4000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
