/**
 * OAGI (Organization System Twin) settings section.
 *
 * User-facing branding: "OAGI" -- the organization-wide data fabric
 * that holds shared content, automations, and cross-device state.
 * The underlying transport is provided by the lite/neon module, but
 * the UI never surfaces those internals to users.
 *
 * Hosts the configuration UI for connecting Lite to the user's
 * organization data fabric: endpoint URL, cluster URI, username,
 * password (masked), workspace. Save persists via
 * `lite:neon:configure` IPC; Test Connection runs `RETURN 1 AS ok`
 * via `lite:neon:test-connection`.
 *
 * Per ADR-031, this section consumes another module's bridge --
 * `window.lite.neon.*` -- and never reaches into the underlying
 * module's internals.
 *
 * Per the Neon README's security posture, the password value is
 * write-only across the IPC boundary: status() returns
 * `hasPassword: boolean`, never the value itself. The form starts
 * with the password field empty even when one is saved; users can
 * leave it blank to keep the existing password.
 *
 * Returns a disposer that the Settings shell calls on window close.
 * Today the section has no timers / listeners to clean up; the
 * disposer just clears the container.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

const STORAGE_PASSWORD_PLACEHOLDER = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

/**
 * Default values that the underlying client uses when fields are
 * empty. The UI hides these so users see "default" placeholders
 * instead of literal technical defaults.
 */
const HIDDEN_USER_DEFAULT = 'neo4j';
const HIDDEN_DATABASE_DEFAULT = 'neo4j';

function neon(): LiteNeonBridge {
  const n = window.lite?.neon;
  if (n === undefined) {
    throw new Error('preload bridge `window.lite.neon` is not available');
  }
  return n;
}

export const mountNeon: SectionDescriptor['mount'] = (container) => {
  void render(container);
  return (): void => {
    container.innerHTML = '';
  };
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(container: HTMLElement): Promise<void> {
  let bridge: LiteNeonBridge;
  try {
    bridge = neon();
  } catch (err) {
    renderBridgeMissing(container, (err as Error).message);
    return;
  }

  let status: LiteNeonStatus;
  try {
    status = await bridge.status();
  } catch (err) {
    renderError(container, (err as Error).message);
    return;
  }

  renderForm(container, status);
}

function renderForm(container: HTMLElement, status: LiteNeonStatus): void {
  const ready = status.ready ? 'Connected' : 'Not connected';
  const readyClass = status.ready ? 'neon-status-pill ok' : 'neon-status-pill warn';
  const passwordPlaceholder = status.hasPassword
    ? `${STORAGE_PASSWORD_PLACEHOLDER}  (saved -- leave blank to keep)`
    : 'Provided by your OAGI administrator';

  // Hide internal defaults from the UI so users see helpful placeholders
  // instead of literal technical default values.
  const userDisplay =
    status.user === HIDDEN_USER_DEFAULT ? '' : status.user;
  const databaseDisplay =
    status.database === HIDDEN_DATABASE_DEFAULT ? '' : status.database;

  container.innerHTML = `
    <div class="neon-card">
      <div class="neon-status-row">
        <span class="${readyClass}">${escapeHtml(ready)}</span>
        <span class="neon-status-help">
          Connect Lite to your organization's data fabric.
        </span>
      </div>

      <div class="neon-explainer">
        <div class="neon-explainer-title">What is OAGI?</div>
        <p class="neon-explainer-body">
          OAGI is your <strong>Organization System Twin</strong> -- the data fabric
          that holds your organization's shared knowledge, content, and
          automation state. Once connected, OAGI is the source of truth for
          everything your team shares across devices and apps.
        </p>
        <p class="neon-explainer-body">
          Ask your administrator for the connection details below. They come
          from your OAGI configuration profile and look the same across every
          device that connects to the same organization.
        </p>
      </div>

      <div class="neon-field">
        <label for="neon-endpoint">Endpoint URL</label>
        <input
          type="text"
          id="neon-endpoint"
          class="neon-input"
          spellcheck="false"
          autocomplete="off"
          placeholder="Provided by your OAGI administrator"
          value="${escapeHtml(status.endpoint ?? '')}"
        />
        <div class="neon-field-help">
          The OAGI endpoint for your organization.
        </div>
      </div>

      <div class="neon-field">
        <label for="neon-uri">Cluster URI</label>
        <input
          type="text"
          id="neon-uri"
          class="neon-input"
          spellcheck="false"
          autocomplete="off"
          placeholder="Provided by your OAGI administrator"
          value="${escapeHtml(status.uri ?? '')}"
        />
        <div class="neon-field-help">
          The connection address from your OAGI profile.
        </div>
      </div>

      <div class="neon-field-row">
        <div class="neon-field neon-field-half">
          <label for="neon-user">Username</label>
          <input
            type="text"
            id="neon-user"
            class="neon-input"
            spellcheck="false"
            autocomplete="off"
            placeholder="default"
            value="${escapeHtml(userDisplay)}"
          />
        </div>
        <div class="neon-field neon-field-half">
          <label for="neon-database">Workspace</label>
          <input
            type="text"
            id="neon-database"
            class="neon-input"
            spellcheck="false"
            autocomplete="off"
            placeholder="default"
            value="${escapeHtml(databaseDisplay)}"
          />
        </div>
      </div>

      <div class="neon-field">
        <label for="neon-password">
          Password
          <button type="button" id="neon-password-toggle" class="neon-link-button">show</button>
        </label>
        <input
          type="password"
          id="neon-password"
          class="neon-input neon-input-password"
          spellcheck="false"
          autocomplete="new-password"
          placeholder="${escapeHtml(passwordPlaceholder)}"
        />
        <div class="neon-field-help">
          Stored locally on this device. Never displayed back to the screen once saved, and never sent to anywhere outside your organization's OAGI.
        </div>
      </div>

      <div class="neon-actions">
        <button type="button" id="neon-save" class="btn-primary">Save</button>
        <button type="button" id="neon-test" class="btn-secondary">Test connection</button>
      </div>

      <div id="neon-status-banner" class="banner" style="display: none;"></div>
    </div>
  `;

  wireForm(container, status);
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

interface FormElements {
  endpoint: HTMLInputElement;
  uri: HTMLInputElement;
  user: HTMLInputElement;
  database: HTMLInputElement;
  password: HTMLInputElement;
  passwordToggle: HTMLButtonElement;
  save: HTMLButtonElement;
  test: HTMLButtonElement;
  banner: HTMLElement;
}

function wireForm(container: HTMLElement, initialStatus: LiteNeonStatus): void {
  const els: FormElements = {
    endpoint: el<HTMLInputElement>(container, 'neon-endpoint'),
    uri: el<HTMLInputElement>(container, 'neon-uri'),
    user: el<HTMLInputElement>(container, 'neon-user'),
    database: el<HTMLInputElement>(container, 'neon-database'),
    password: el<HTMLInputElement>(container, 'neon-password'),
    passwordToggle: el<HTMLButtonElement>(container, 'neon-password-toggle'),
    save: el<HTMLButtonElement>(container, 'neon-save'),
    test: el<HTMLButtonElement>(container, 'neon-test'),
    banner: el<HTMLElement>(container, 'neon-status-banner'),
  };

  els.passwordToggle.addEventListener('click', () => {
    if (els.password.type === 'password') {
      els.password.type = 'text';
      els.passwordToggle.textContent = 'hide';
    } else {
      els.password.type = 'password';
      els.passwordToggle.textContent = 'show';
    }
  });

  els.save.addEventListener('click', () => {
    void saveFlow(container, els, initialStatus);
  });

  els.test.addEventListener('click', () => {
    void testFlow(els);
  });
}

async function saveFlow(
  container: HTMLElement,
  els: FormElements,
  initialStatus: LiteNeonStatus
): Promise<void> {
  els.save.disabled = true;
  els.test.disabled = true;
  setStatus(els.banner, 'Saving...', 'info');

  // Build the config diff. Skip password when the field is empty
  // AND a password is already saved -- "leave blank to keep" UX.
  const config: LiteNeonConfig = {
    endpoint: els.endpoint.value.trim(),
    uri: els.uri.value.trim(),
    user: els.user.value.trim(),
    database: els.database.value.trim(),
  };
  const passwordInput = els.password.value;
  if (passwordInput.length > 0) {
    config.password = passwordInput;
  } else if (!initialStatus.hasPassword) {
    // No saved password and the field is empty -- send empty string
    // so the validator doesn't pass through stale state silently.
    config.password = '';
  }

  try {
    await neon().configure(config);
    setStatus(els.banner, 'Saved.', 'success');
    // Re-render against the new status so the password field shows
    // the "saved" placeholder and "Connected" badge updates.
    window.setTimeout(() => {
      void render(container);
    }, 400);
  } catch (err) {
    const parsed = neon().parseError(err);
    if (parsed !== null) {
      setStatus(els.banner, `${parsed.message} ${parsed.remediation}`.trim(), 'error');
    } else {
      setStatus(els.banner, (err as Error).message ?? 'Save failed.', 'error');
    }
  } finally {
    els.save.disabled = false;
    els.test.disabled = false;
  }
}

async function testFlow(els: FormElements): Promise<void> {
  els.save.disabled = true;
  els.test.disabled = true;
  setStatus(els.banner, 'Testing connection...', 'info');

  try {
    const result = await neon().testConnection();
    if (result.ok) {
      setStatus(els.banner, 'Connected to OAGI.', 'success');
    } else {
      const msg = result.error ?? 'Connection failed.';
      setStatus(els.banner, msg, 'error');
    }
  } catch (err) {
    setStatus(els.banner, (err as Error).message ?? 'Test failed.', 'error');
  } finally {
    els.save.disabled = false;
    els.test.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Error / fallback rendering
// ---------------------------------------------------------------------------

function renderBridgeMissing(container: HTMLElement, message: string): void {
  container.innerHTML = `
    <div class="neon-card">
      <div class="banner error">
        OAGI settings are unavailable: ${escapeHtml(message)}
      </div>
    </div>
  `;
}

function renderError(container: HTMLElement, message: string): void {
  container.innerHTML = `
    <div class="neon-card">
      <div class="banner error">
        Could not load OAGI settings: ${escapeHtml(message)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement = HTMLElement>(container: HTMLElement, id: string): T {
  const node = container.querySelector(`#${id}`) ?? document.getElementById(id);
  if (node === null) throw new Error(`element #${id} not found`);
  return node as T;
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
