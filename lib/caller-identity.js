/**
 * Caller Identity Registry
 *
 * Lets ipcMain handlers attribute an AI call to the renderer that made it.
 * Window creators (module-manager for web tools, main window loaders, etc.)
 * register their webContents with an identity -- {agentId, agentName} --
 * and ipcMain handlers look up the sender to stamp accountability metadata
 * onto every `ai.chat(...)` call.
 *
 * Used by: main.js ai:* handlers, module-manager.js (web tools).
 */

'use strict';

const _byWebContentsId = new Map();
const _byUrlPrefix = new Map(); // url-prefix -> identity (fallback when webContents wasn't registered at creation)

/**
 * Register a webContents (renderer) with an agent identity.
 * Auto-unregisters when the window is destroyed.
 *
 * @param {Electron.WebContents} webContents
 * @param {{agentId: string, agentName?: string}} identity
 * @returns {function} unregister callback
 */
function register(webContents, identity) {
  if (!webContents || !identity || !identity.agentId) return () => {};
  const id = webContents.id;
  const value = {
    agentId: identity.agentId,
    agentName: identity.agentName || identity.agentId,
  };
  _byWebContentsId.set(id, value);

  const cleanup = () => {
    _byWebContentsId.delete(id);
  };

  try {
    webContents.once('destroyed', cleanup);
  } catch (_err) {
    // Fine if the contents don't support listeners (e.g. already destroyed)
  }

  return cleanup;
}

/**
 * Register a URL-prefix fallback. If a renderer wasn't explicitly registered
 * at creation (e.g. a legacy path), we fall back to matching its URL.
 *
 * @param {string} urlPrefix - e.g. 'https://playbooks.example.com/'
 * @param {{agentId: string, agentName?: string}} identity
 */
function registerUrlPrefix(urlPrefix, identity) {
  if (!urlPrefix || !identity || !identity.agentId) return;
  _byUrlPrefix.set(urlPrefix, {
    agentId: identity.agentId,
    agentName: identity.agentName || identity.agentId,
  });
}

/**
 * Identify the renderer that sent an IPC event.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {{agentId: string|null, agentName: string|null}}
 */
function identifyEvent(event) {
  const sender = event && event.sender;
  if (!sender) return { agentId: null, agentName: null };

  const exact = _byWebContentsId.get(sender.id);
  if (exact) return { ...exact };

  try {
    const url = sender.getURL ? sender.getURL() : '';
    if (url) {
      for (const [prefix, identity] of _byUrlPrefix.entries()) {
        if (url.startsWith(prefix)) return { ...identity };
      }
      // Heuristic for http(s) renderers not registered -- tag them as a
      // generic webtool so they don't vanish into "unattributed".
      if (/^https?:\/\//.test(url)) {
        try {
          const host = new URL(url).hostname || 'external';
          return { agentId: `webtool:${host}`, agentName: `Web tool: ${host}` };
        } catch (_err) {
          return { agentId: 'webtool:external', agentName: 'Web tool (external)' };
        }
      }
    }
  } catch (_err) {
    // fall through
  }

  return { agentId: null, agentName: null };
}

/**
 * For diagnostics / tests.
 */
function getRegisteredCount() {
  return _byWebContentsId.size;
}

function clear() {
  _byWebContentsId.clear();
  _byUrlPrefix.clear();
}

module.exports = {
  register,
  registerUrlPrefix,
  identifyEvent,
  getRegisteredCount,
  clear,
};
