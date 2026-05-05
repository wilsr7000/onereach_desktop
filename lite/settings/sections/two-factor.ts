/**
 * Two-Factor Authentication section.
 *
 * Per ADR-031, hosts the OneReach 2FA authenticator UI inside the
 * Settings shell. Migrated from the deleted `lite/totp/authenticator.ts`.
 *
 * **What this section is**: it generates the rotating six-digit code
 * the user pastes into the OneReach 2FA prompt during GSX login.
 * **What it is NOT**: a place to type the current six-digit code.
 * Inputs accept the long-lived authenticator secret (from the QR or the
 * Base32 key shown when 2FA is set up on OneReach), never the rotating
 * code. The button labels ("Scan OneReach setup QR", "Paste setup QR
 * image", "Enter setup secret") and the warning copy in
 * `renderSignedOut` reinforce intent.
 *
 * Two states:
 *   - SIGNED-OUT: setup card with three paths -- scan setup QR from
 *     screen, paste a copied QR image, or enter the Base32 secret key.
 *   - SIGNED-IN: live 6-digit code with a 30-second countdown bar,
 *     account info, click-to-copy, and a Remove button.
 *
 * Communicates with the main process via `window.lite.totp.*` (preload
 * bridge declared in `lite/preload-lite.ts`). Per ADR-027:
 *   - The TOTP secret value never round-trips back to the renderer.
 *   - The live 6-digit code IS exposed (ephemeral, 30s lifetime).
 *
 * Returns a disposer that the Settings shell calls on window close to
 * clean up the countdown interval.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

const TICK_MS = 1000;

function totp(): LiteTotpBridge {
  const t = window.lite?.totp;
  if (t === undefined) {
    throw new Error('preload bridge `window.lite.totp` is not available');
  }
  return t;
}

interface MountState {
  container: HTMLElement;
  tickInterval: number | null;
}

/**
 * Mount the Two-Factor section into the given container. Returns a
 * disposer that clears the countdown interval and detaches handlers.
 */
export const mountTwoFactor: SectionDescriptor['mount'] = (container) => {
  const state: MountState = { container, tickInterval: null };

  void refresh(state);

  return (): void => {
    clearTick(state);
    container.innerHTML = '';
  };
};

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function clearTick(state: MountState): void {
  if (state.tickInterval !== null) {
    window.clearInterval(state.tickInterval);
    state.tickInterval = null;
  }
}

async function refresh(state: MountState): Promise<void> {
  try {
    const { metadata } = await totp().getMetadata();
    if (metadata !== null) {
      renderSignedIn(state, metadata);
    } else {
      renderSignedOut(state, null);
    }
  } catch {
    renderSignedOut(state, null);
  }
}

// ---------------------------------------------------------------------------
// SIGNED-OUT (no secret yet)
// ---------------------------------------------------------------------------

function renderSignedOut(state: MountState, errorText: string | null): void {
  clearTick(state);
  state.container.innerHTML = `
    ${introCardsMarkup()}
    <div class="tf-setup-card">
      <div class="tf-setup-title">Set up code generation for GSX</div>
      <div class="tf-setup-help">
        No authenticator secret is saved yet. Add the OneReach setup QR or secret key to let Lite generate GSX login codes.
      </div>
      <div class="tf-setup-help tf-setup-warning">
        Do not enter the current six-digit login code here -- that code changes every 30 seconds and is only used on the OneReach login screen.
      </div>
      <div class="tf-setup-actions">
        <button type="button" id="tf-btn-scan-screen" class="btn-primary">Scan OneReach setup QR</button>
        <button type="button" id="tf-btn-scan-clipboard" class="btn-secondary">Paste setup QR image</button>
        <button type="button" id="tf-btn-manual-toggle" class="btn-secondary">Enter setup secret</button>
      </div>
      <div id="tf-manual-form" class="tf-manual-form" style="display: none;">
        <input type="text" id="tf-manual-input" placeholder="JBSWY3DPEHPK3PXP" autocomplete="off" spellcheck="false" />
        <div class="tf-manual-help">Paste the long setup secret from OneReach, not the current six-digit code.</div>
        <button type="button" id="tf-btn-manual-save" class="btn-primary">Save</button>
      </div>
    </div>
    <div id="tf-status" class="banner" style="display: none;"></div>
  `;

  const status = el(state, 'tf-status');
  if (errorText !== null && errorText.length > 0) {
    setStatus(status, errorText, 'error');
  }

  el<HTMLButtonElement>(state, 'tf-btn-scan-screen').addEventListener('click', () => {
    void scanFlow(state, 'screen', status);
  });
  el<HTMLButtonElement>(state, 'tf-btn-scan-clipboard').addEventListener('click', () => {
    void scanFlow(state, 'clipboard', status);
  });
  el<HTMLButtonElement>(state, 'tf-btn-manual-toggle').addEventListener('click', () => {
    const form = el(state, 'tf-manual-form');
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });
  el<HTMLButtonElement>(state, 'tf-btn-manual-save').addEventListener('click', () => {
    void manualSaveFlow(state, status);
  });
}

async function scanFlow(state: MountState, source: 'screen' | 'clipboard', status: HTMLElement): Promise<void> {
  const btnScreen = el<HTMLButtonElement>(state, 'tf-btn-scan-screen');
  const btnClipboard = el<HTMLButtonElement>(state, 'tf-btn-scan-clipboard');
  btnScreen.disabled = true;
  btnClipboard.disabled = true;
  setStatus(status, source === 'screen' ? 'Scanning your screen...' : 'Reading clipboard...', 'info');

  try {
    const result = source === 'screen' ? await totp().scanQrFromScreen() : await totp().scanQrFromClipboard();
    if (result.saved) {
      setStatus(status, 'Saved.', 'success');
      window.setTimeout(() => {
        void refresh(state);
      }, 250);
      return;
    }
    setStatus(status, friendlyReason(result.reason ?? 'no-qr-found', source), 'error');
  } catch (err) {
    showError(status, err);
  } finally {
    btnScreen.disabled = false;
    btnClipboard.disabled = false;
  }
}

async function manualSaveFlow(state: MountState, status: HTMLElement): Promise<void> {
  const input = el<HTMLInputElement>(state, 'tf-manual-input');
  const value = input.value.trim();
  if (value.length === 0) {
    setStatus(status, 'Paste the secret key first.', 'error');
    return;
  }
  const btn = el<HTMLButtonElement>(state, 'tf-btn-manual-save');
  btn.disabled = true;
  setStatus(status, 'Validating...', 'info');
  try {
    await totp().saveSecret(value);
    input.value = '';
    setStatus(status, 'Saved.', 'success');
    window.setTimeout(() => {
      void refresh(state);
    }, 250);
  } catch (err) {
    showError(status, err);
  } finally {
    btn.disabled = false;
  }
}

function friendlyReason(reason: string, source: 'screen' | 'clipboard'): string {
  switch (reason) {
    case 'no-qr-found':
      return source === 'screen'
        ? 'No QR code found on screen. Make sure the code is visible, then try again.'
        : 'No QR code found in the clipboard image. Copy the QR as an image, then try again.';
    case 'not-authenticator-qr':
      return 'That QR is not an authenticator setup code.';
    case 'invalid-secret':
      return 'The QR code embedded an invalid secret.';
    case 'keychain-failed':
      return 'Could not save to the keychain. Make sure macOS Keychain is unlocked.';
    default:
      return 'Could not save. Try again.';
  }
}

// ---------------------------------------------------------------------------
// SIGNED-IN (live code)
// ---------------------------------------------------------------------------

function renderSignedIn(state: MountState, meta: LiteTotpSecretMetadata): void {
  clearTick(state);
  state.container.innerHTML = `
    <div class="tf-code-card">
      <div class="tf-code-meta">Current GSX / OneReach 2FA code</div>
      <div id="tf-code-value" class="tf-code-value" title="Click to copy">--- ---</div>
      <div class="tf-code-help">Use this code in the OneReach 2FA prompt. It refreshes every 30 seconds.</div>
      <div class="tf-countdown-row">
        <div class="tf-countdown-bar"><div id="tf-countdown-fill" class="tf-countdown-fill"></div></div>
        <span id="tf-countdown-text" class="tf-countdown-text">--s</span>
      </div>
      <div class="tf-account-row">
        ${meta.issuer !== undefined ? escapeHtml(meta.issuer) + ' &middot; ' : ''}${meta.account !== undefined ? escapeHtml(meta.account) : 'OneReach'}
      </div>
    </div>
    <div class="tf-code-source">Source: system keychain. Shared with full Onereach.ai app.</div>
    <div id="tf-copy-hint" class="tf-copy-hint">Click the code to copy.</div>
    ${introCardsMarkup()}
    <div class="tf-config-actions">
      <button type="button" id="tf-btn-copy" class="btn-secondary">Copy Code</button>
      <button type="button" id="tf-btn-remove" class="btn-secondary btn-danger">Remove Saved Secret</button>
    </div>
    <div id="tf-status" class="banner" style="display: none;"></div>
  `;

  const codeEl = el(state, 'tf-code-value');
  const fillEl = el(state, 'tf-countdown-fill');
  const textEl = el(state, 'tf-countdown-text');
  const hintEl = el(state, 'tf-copy-hint');
  const status = el(state, 'tf-status');

  codeEl.addEventListener('click', () => {
    void copyCurrentCode(codeEl, hintEl);
  });
  el<HTMLButtonElement>(state, 'tf-btn-copy').addEventListener('click', () => {
    void copyCurrentCode(codeEl, hintEl);
  });
  el<HTMLButtonElement>(state, 'tf-btn-remove').addEventListener('click', () => {
    void removeFlow(state, status);
  });

  void tick(state, codeEl, fillEl, textEl);
  state.tickInterval = window.setInterval(() => {
    void tick(state, codeEl, fillEl, textEl);
  }, TICK_MS);
}

async function tick(
  state: MountState,
  codeEl: HTMLElement,
  fillEl: HTMLElement,
  textEl: HTMLElement
): Promise<void> {
  try {
    const info = await totp().getCurrentCode();
    codeEl.textContent = info.formattedCode;
    const pct = Math.max(0, Math.min(100, (info.timeRemaining / 30) * 100));
    fillEl.style.width = pct + '%';
    textEl.textContent = info.timeRemaining + 's';
    fillEl.classList.remove('warning', 'danger');
    if (info.timeRemaining <= 5) {
      fillEl.classList.add('danger');
    } else if (info.timeRemaining <= 10) {
      fillEl.classList.add('warning');
    }
  } catch {
    // The most likely failure is "no secret" -- could happen if the
    // user removes from another renderer instance. Refresh to the
    // signed-out state.
    clearTick(state);
    void refresh(state);
  }
}

async function copyCurrentCode(codeEl: HTMLElement, hintEl: HTMLElement): Promise<void> {
  try {
    const info = await totp().getCurrentCode();
    await navigator.clipboard.writeText(info.code);
    codeEl.classList.add('copied');
    hintEl.textContent = 'Copied to clipboard.';
    hintEl.classList.add('success');
    window.setTimeout(() => {
      codeEl.classList.remove('copied');
      hintEl.textContent = 'Click the code to copy.';
      hintEl.classList.remove('success');
    }, 1200);
  } catch {
    // Clipboard write can fail in some sandbox configurations -- fall
    // back to a select-and-instruct path.
    hintEl.textContent = 'Select the code and copy with the menu.';
  }
}

async function removeFlow(state: MountState, status: HTMLElement): Promise<void> {
  const confirmed = window.confirm(
    'Remove the saved authenticator secret? Lite and the full Onereach.ai app use the same keychain entry, so you will need to scan the OneReach setup QR again to generate 2FA codes on this Mac.'
  );
  if (!confirmed) return;
  try {
    await totp().deleteSecret();
    void refresh(state);
  } catch (err) {
    showError(status, err);
  }
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function introCardsMarkup(): string {
  return `
    <div class="tf-explainer-card">
      <div class="tf-card-title">GSX / OneReach two-factor codes</div>
      <div class="tf-card-body">
        When OneReach asks for a 2FA code during GSX login, Lite can generate that code for you.
        To do that, Lite needs the authenticator setup secret from OneReach -- the same QR code
        or secret key you would normally add to Google Authenticator, 1Password, Authy, or another
        authenticator app.
      </div>
      <ol class="tf-explainer-list">
        <li>Add the setup secret once.</li>
        <li>Lite stores it in your system keychain.</li>
        <li>Lite generates the current six-digit code.</li>
        <li>The code changes every 30 seconds.</li>
      </ol>
    </div>
    <div class="tf-security-card">
      <div class="tf-card-title">Security</div>
      <ul class="tf-security-list">
        <li>The authenticator secret is stored in the macOS Keychain / system credential vault.</li>
        <li>The secret is not written to app settings, logs, bug reports, or KV storage.</li>
        <li>Lite never shows the saved secret again after setup.</li>
        <li>Lite only displays the temporary six-digit code, which expires every 30 seconds.</li>
        <li>Lite reads the same OneReach authenticator secret used by the full Onereach.ai app, so existing full-app 2FA setup can generate codes here too.</li>
      </ul>
    </div>
  `;
}

function el<T extends HTMLElement = HTMLElement>(state: MountState, id: string): T {
  const node = state.container.querySelector(`#${id}`) ?? document.getElementById(id);
  if (node === null) throw new Error(`element #${id} not found`);
  return node as T;
}

function showError(banner: HTMLElement | null, err: unknown): void {
  if (banner === null) return;
  const parsed = totp().parseError(err);
  banner.textContent = parsed !== null ? parsed.message + ' ' + parsed.remediation : (err as Error).message ?? 'Unknown error';
  banner.classList.remove('info', 'success');
  banner.classList.add('error');
  banner.style.display = '';
}

function setStatus(banner: HTMLElement, text: string, kind: 'info' | 'success' | 'error'): void {
  banner.textContent = text;
  banner.classList.remove('info', 'success', 'error');
  banner.classList.add(kind);
  banner.style.display = '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
