/**
 * Centralized auto-login confirmation prompt.
 *
 * All three auto-login paths (gsx-autologin, browserWindow, browser-renderer)
 * call through here so the consent UX is consistent.
 */

const { dialog, BrowserWindow } = require('electron');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

let confirmedThisSession = false;

/**
 * @typedef {Object} AutoLoginResult
 * @property {boolean} allowed - Whether auto-login should proceed
 * @property {string} [reason] - Why it was blocked: 'disabled' | 'environment' | 'declined'
 * @property {string} [environment] - The environment that was checked
 */

/**
 * Determine whether auto-login is allowed for the given environment,
 * optionally showing a native confirmation dialog.
 *
 * @param {BrowserWindow|null} parentWindow - Attach dialog to this window (may be null)
 * @param {string} email - The email that would be used to sign in
 * @param {Object} autoLoginSettings - The `settings.autoLoginSettings` object
 * @param {string} [environment] - edison | staging | production (optional)
 * @returns {Promise<AutoLoginResult>}
 */
async function confirmAutoLogin(parentWindow, email, autoLoginSettings, environment) {
  const settings = autoLoginSettings || {};

  if (settings.enabled === false) {
    log.info('app', 'Auto-login disabled globally', { feature: 'auto-login' });
    return { allowed: false, reason: 'disabled' };
  }

  if (environment && !isEnvironmentEnabled(settings, environment)) {
    log.info('app', 'Auto-login disabled for environment', { environment, feature: 'auto-login' });
    return { allowed: false, reason: 'environment', environment };
  }

  if (!settings.promptBeforeAutoLogin) {
    return { allowed: true };
  }

  if (confirmedThisSession) {
    return { allowed: true };
  }

  const win = (parentWindow && !parentWindow.isDestroyed()) ? parentWindow : BrowserWindow.getFocusedWindow();

  const dialogOpts = {
    type: 'question',
    title: 'Auto-Login',
    message: `Sign in as ${email}?`,
    detail: 'OneReach auto-login detected a login page. Proceed with saved credentials?',
    buttons: ['Sign In', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  };

  try {
    const result = win
      ? await dialog.showMessageBox(win, dialogOpts)
      : await dialog.showMessageBox(dialogOpts);

    if (result.response === 0) {
      confirmedThisSession = true;
      log.info('app', 'User confirmed auto-login', { email, feature: 'auto-login' });
      return { allowed: true };
    }

    log.info('app', 'User declined auto-login', { email, feature: 'auto-login' });
    return { allowed: false, reason: 'declined' };
  } catch (err) {
    log.error('app', 'Auto-login prompt error, proceeding without prompt', { error: err.message });
    return { allowed: true };
  }
}

/**
 * Check whether auto-login is enabled for a specific environment.
 */
function isEnvironmentEnabled(settings, environment) {
  if (!environment) return true;

  const env = environment.toLowerCase();
  if (env === 'edison' && settings.edison === false) return false;
  if (env === 'staging' && settings.staging === false) return false;
  if (env === 'production' && settings.production === false) return false;
  return true;
}

/**
 * Reset the session confirmation (e.g. for testing).
 */
function resetSessionConfirmation() {
  confirmedThisSession = false;
}

module.exports = { confirmAutoLogin, isEnvironmentEnabled, resetSessionConfirmation };
