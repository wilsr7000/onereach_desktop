/**
 * Safe IPC send helpers.
 *
 * Sending to a BrowserWindow whose webContents has been destroyed throws
 * synchronously from the main process -- a common crash path when windows
 * close between "lookup" and "send". These helpers centralize the destroy
 * checks so individual callers don't have to remember them.
 */

/**
 * Send an IPC message to a BrowserWindow only if it still exists.
 *
 * @param {import('electron').BrowserWindow|null|undefined} win
 * @param {string} channel
 * @param {...any} args
 * @returns {boolean} true if the message was dispatched
 */
function safeSend(win, channel, ...args) {
  try {
    if (
      win &&
      typeof win.isDestroyed === 'function' &&
      !win.isDestroyed() &&
      win.webContents &&
      !win.webContents.isDestroyed()
    ) {
      win.webContents.send(channel, ...args);
      return true;
    }
  } catch (e) {
    // Swallow -- destroyed-window races and IPC errors shouldn't crash main.
    // Use stderr so the diagnostic is visible but doesn't spam the log queue
    // from an environment where log infrastructure may not be loaded yet.
    // eslint-disable-next-line no-console
    console.warn(`[safeSend] Failed to send '${channel}':`, e && e.message ? e.message : e);
  }
  return false;
}

/**
 * Send an IPC message on a WebContents (e.g. an embedded webview) rather than
 * a BrowserWindow. Same destroy-check semantics.
 */
function safeSendToContents(contents, channel, ...args) {
  try {
    if (contents && typeof contents.isDestroyed === 'function' && !contents.isDestroyed()) {
      contents.send(channel, ...args);
      return true;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[safeSend] Failed to send '${channel}' to contents:`, e && e.message ? e.message : e);
  }
  return false;
}

module.exports = { safeSend, safeSendToContents };
