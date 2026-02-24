// Tab management for the browser
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let openChatLinksInNewTab = false; // Preference for chat link behavior

// Initialize IDW Registry for reliable tab tracking
const idwRegistry = new IDWRegistry();

// LLM Badge state
let llmBadgeTimeout = null;
let llmBadgeHideTimeout = null;

// ── WebMCP: per-tab tool tracking ──────────────────────────
const webmcpTabTools = new Map(); // tabId -> Map<toolName, toolDef>

/**
 * Inject WebMCP bridge into webview to detect tool registrations.
 * The bridge script intercepts navigator.modelContext.registerTool()
 * and posts tool metadata back via console.log JSON messages.
 */
function injectWebMCPBridge(webview, tabId) {
  fetch('webmcp-bridge.js')
    .then((res) => res.text())
    .then((script) => {
      webview
        .executeJavaScript(script)
        .then(() => {
          console.log(`[WebMCP] Bridge injected into tab ${tabId}`);
        })
        .catch((err) => {
          if (!err.message?.includes('Script failed to execute')) {
            console.warn(`[WebMCP] Bridge injection error in tab ${tabId}:`, err.message);
          }
        });
    })
    .catch((err) => {
      console.warn('[WebMCP] Error loading bridge script:', err.message);
    });
}

/**
 * Handle a WebMCP message from a webview's console-message event.
 * Returns true if the message was a WebMCP message and was handled.
 */
function handleWebMCPConsoleMessage(tabId, webview, message) {
  if (!message || !message.includes('"_webmcp":true')) return false;

  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  if (!parsed._webmcp) return false;

  const origin = (() => {
    try { return webview.getURL(); } catch { return 'unknown'; }
  })();

  switch (parsed.type) {
    case 'bridge-ready':
      console.log(`[WebMCP] Bridge ready on tab ${tabId} (${parsed.toolCount} tools)`);
      break;

    case 'tool-registered':
      if (parsed.tool?.name) {
        if (!webmcpTabTools.has(tabId)) webmcpTabTools.set(tabId, new Map());
        webmcpTabTools.get(tabId).set(parsed.tool.name, parsed.tool);
        updateWebMCPBadge(tabId);
        if (window.api?.invoke) {
          window.api.invoke('webmcp:tool-registered', { tabId, tool: parsed.tool, origin });
        }
      }
      break;

    case 'tool-unregistered':
      if (parsed.name) {
        const tools = webmcpTabTools.get(tabId);
        if (tools) {
          tools.delete(parsed.name);
          updateWebMCPBadge(tabId);
        }
        if (window.api?.invoke) {
          window.api.invoke('webmcp:tool-unregistered', { tabId, name: parsed.name });
        }
      }
      break;

    case 'context-cleared':
      if (webmcpTabTools.has(tabId)) {
        webmcpTabTools.get(tabId).clear();
        updateWebMCPBadge(tabId);
      }
      if (window.api?.invoke) {
        window.api.invoke('webmcp:context-cleared', { tabId });
      }
      break;
  }

  return true;
}

/**
 * Show/hide a small tool-count badge on tabs that expose WebMCP tools.
 */
function updateWebMCPBadge(tabId) {
  const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
  if (!tabElement) return;

  let badge = tabElement.querySelector('.webmcp-badge');
  const tools = webmcpTabTools.get(tabId);
  const count = tools ? tools.size : 0;

  if (count === 0) {
    if (badge) badge.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'webmcp-badge';
    badge.style.cssText =
      'position:absolute;top:2px;right:18px;min-width:14px;height:14px;' +
      'border-radius:7px;background:#6366f1;color:#fff;font-size:9px;' +
      'font-weight:600;display:flex;align-items:center;justify-content:center;' +
      'padding:0 3px;pointer-events:none;z-index:2;';
    tabElement.style.position = 'relative';
    tabElement.appendChild(badge);
  }
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.title = `${count} WebMCP tool${count !== 1 ? 's' : ''} available`;
}

/**
 * Clean up WebMCP state when a tab navigates or closes.
 */
function cleanupWebMCPForTab(tabId) {
  webmcpTabTools.delete(tabId);
  updateWebMCPBadge(tabId);
  if (window.api?.invoke) {
    window.api.invoke('webmcp:tab-closed', { tabId });
  }
}

/**
 * Handle a tool invocation request from the main process.
 * Finds the correct webview and calls the bridge's stored execute function.
 */
function handleWebMCPCallTool({ callId, tabId, toolName, input }) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !tab.webview) {
    if (window.api?.invoke) {
      window.api.invoke('webmcp:call-tool-result', {
        callId,
        error: `Tab ${tabId} not found`,
      });
    }
    return;
  }

  const escaped = JSON.stringify(input || {});
  tab.webview
    .executeJavaScript(`window.__webmcp__callTool(${JSON.stringify(toolName)}, ${escaped})`)
    .then((result) => {
      if (window.api?.invoke) {
        window.api.invoke('webmcp:call-tool-result', {
          callId,
          result: result?.result,
          error: result?.error,
        });
      }
    })
    .catch((err) => {
      if (window.api?.invoke) {
        window.api.invoke('webmcp:call-tool-result', {
          callId,
          error: err.message || 'executeJavaScript failed',
        });
      }
    });
}

// Listen for tool invocation requests from the main process
if (window.api?.receive) {
  window.api.receive('webmcp:call-tool', handleWebMCPCallTool);
}

/**
 * Inject Spaces upload enhancer into webview
 * Adds "Spaces" buttons next to file inputs
 */
function injectSpacesUploadEnhancer(webview) {
  // Check if feature is enabled
  window.api
    .getSettings()
    .then((settings) => {
      const spacesEnabled = settings.spacesUploadIntegration !== false;

      if (!spacesEnabled) {
        console.log('[Spaces Upload] Feature disabled, not injecting');
        return;
      }

      // Read and inject the enhancer script
      fetch('browser-file-input-enhancer.js')
        .then((res) => res.text())
        .then((script) => {
          webview
            .executeJavaScript(script)
            .then(() => {
              console.log('[Spaces Upload] Injected file input enhancer');
            })
            .catch((err) => {
              console.error('[Spaces Upload] Error injecting enhancer:', err);
            });
        })
        .catch((err) => {
          console.error('[Spaces Upload] Error loading enhancer script:', err);
        });
    })
    .catch((err) => {
      console.error('[Spaces Upload] Error checking settings:', err);
    });
}

// Track auto-login state per tab to prevent duplicate attempts
const autoLoginState = new Map();

// Global rate limiting for auto-login across ALL tabs
let globalLastLoginAttempt = 0;
let globalLoginQueue = []; // Array of { tabId, loginFn, webview }
let globalLoginInProgress = false;
const tabsWithActiveLogin = new Set(); // Track tabs with queued OR in-progress login

// Rate limit: 30 seconds between login attempts (server is VERY strict)
const LOGIN_RATE_LIMIT_MS = 30000;

/**
 * Structured auth event logger - persists to event log files AND DevTools console.
 * All auth events are tagged with feature:'auto-login' and event:'auth:*' for filtering.
 * Sensitive values (passwords, TOTP codes) are NEVER included.
 *
 * @param {'info'|'warn'|'error'} level - Log level
 * @param {string} message - Human-readable message
 * @param {Object} data - Structured event data (tabId, pageType, url, etc.)
 */
function logAuthEvent(level, message, data = {}) {
  const prefix = '[Auth]';
  // DevTools console
  if (level === 'error') {
    console.error(`${prefix} ${message}`, Object.keys(data).length ? data : '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`, Object.keys(data).length ? data : '');
  } else {
    console.log(`${prefix} ${message}`, Object.keys(data).length ? data : '');
  }
  // Persist to event logger via IPC
  if (window.api && window.api.log) {
    try {
      const logData = { feature: 'auto-login', ...data };
      window.api.log[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'](`${prefix} ${message}`, logData);
    } catch (_e) {
      // Fail silently - logging should never break auth flow
    }
  }
}

/**
 * Show a loading overlay in a webview with countdown
 */
function showLoginQueueOverlay(webview, waitSeconds, _queuePosition) {
  const overlayScript = `
        (function() {
            // Remove existing overlay if any
            const existing = document.getElementById('onereach-login-queue-overlay');
            if (existing) existing.remove();
            
            const overlay = document.createElement('div');
            overlay.id = 'onereach-login-queue-overlay';
            overlay.innerHTML = \`
                <style>
                    #onereach-login-queue-overlay {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0, 0, 0, 0.85);
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        z-index: 999999;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        color: white;
                    }
                    #onereach-login-queue-overlay .spinner {
                        width: 48px;
                        height: 48px;
                        border: 3px solid rgba(255,255,255,0.3);
                        border-top-color: #3b82f6;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                        margin-bottom: 24px;
                    }
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                    #onereach-login-queue-overlay .message {
                        font-size: 18px;
                        font-weight: 500;
                        margin-bottom: 8px;
                    }
                    #onereach-login-queue-overlay .countdown {
                        font-size: 14px;
                        color: rgba(255,255,255,0.7);
                        margin-bottom: 16px;
                    }
                    #onereach-login-queue-overlay .hint {
                        font-size: 12px;
                        color: rgba(255,255,255,0.5);
                        max-width: 300px;
                        text-align: center;
                    }
                </style>
                <div class="spinner"></div>
                <div class="message">Preparing secure login...</div>
                <div class="countdown" id="queue-countdown">Please wait ~${waitSeconds} seconds</div>
                <div class="hint">Multiple tabs require sequential authentication to avoid rate limits</div>
            \`;
            document.body.appendChild(overlay);
        })();
    `;
  webview
    .executeJavaScript(overlayScript)
    .catch((err) => console.warn('[browser-renderer] inject login overlay:', err.message));
}

/**
 * Update the countdown on the loading overlay
 */
function updateLoginQueueOverlay(webview, secondsRemaining) {
  const updateScript = `
        (function() {
            const countdown = document.getElementById('queue-countdown');
            if (countdown) {
                countdown.textContent = 'Please wait ~${secondsRemaining} seconds';
            }
        })();
    `;
  webview
    .executeJavaScript(updateScript)
    .catch((err) => console.warn('[browser-renderer] update login countdown:', err.message));
}

/**
 * Hide the loading overlay (login starting or complete)
 */
function hideLoginQueueOverlay(webview) {
  const hideScript = `
        (function() {
            const overlay = document.getElementById('onereach-login-queue-overlay');
            if (overlay) {
                overlay.style.transition = 'opacity 0.3s';
                overlay.style.opacity = '0';
                setTimeout(() => overlay.remove(), 300);
            }
        })();
    `;
  webview
    .executeJavaScript(hideScript)
    .catch((err) => console.warn('[browser-renderer] hide login overlay:', err.message));
}

/**
 * Queue a login attempt with global rate limiting
 * Only one login happens at a time, with 30 second spacing
 * Only one login per tab can be queued/active at a time
 */
function queueGlobalLogin(tabId, loginFn, webview) {
  // Don't queue if this tab already has an active login (queued or in progress)
  if (tabsWithActiveLogin.has(tabId)) {
    logAuthEvent('info', 'Queue skip - active login exists', {
      event: 'auth:queue-skip',
      tabId,
      reason: 'active-login',
    });
    return;
  }

  // Also check if login is already complete or in progress via state tracking
  const state = autoLoginState.get(tabId);
  if (state) {
    if (state.loginComplete) {
      console.log(`[AutoLogin] Skipping queue for ${tabId} - login already complete`);
      return;
    }
    if (state.formFilled && Date.now() - state.formFilledAt < 30000) {
      console.log(`[AutoLogin] Skipping queue for ${tabId} - form filled, waiting for 2FA`);
      return;
    }
  }

  tabsWithActiveLogin.add(tabId);
  globalLoginQueue.push({ tabId, loginFn, webview });
  logAuthEvent('info', 'Login queued', {
    event: 'auth:queued',
    tabId,
    queueSize: globalLoginQueue.length,
    activeLogins: tabsWithActiveLogin.size,
  });

  // Check if we need to show the wait overlay
  const timeSinceLastLogin = Date.now() - globalLastLoginAttempt;
  if (globalLoginInProgress || timeSinceLastLogin < LOGIN_RATE_LIMIT_MS) {
    // Calculate wait time
    const waitTime = globalLoginInProgress
      ? LOGIN_RATE_LIMIT_MS + (LOGIN_RATE_LIMIT_MS - timeSinceLastLogin)
      : LOGIN_RATE_LIMIT_MS - timeSinceLastLogin;
    const waitSeconds = Math.ceil(waitTime / 1000);
    const queuePosition = globalLoginQueue.length;

    // Show overlay with countdown
    showLoginQueueOverlay(webview, waitSeconds, queuePosition);

    // Start countdown updates
    startCountdownUpdates(tabId, webview, waitSeconds);
  }

  processGlobalLoginQueue();
}

/**
 * Start countdown updates for a queued tab
 */
function startCountdownUpdates(tabId, webview, initialSeconds) {
  let remaining = initialSeconds;
  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0 || !tabsWithActiveLogin.has(tabId)) {
      clearInterval(interval);
      return;
    }
    updateLoginQueueOverlay(webview, remaining);
  }, 1000);

  // Store interval so we can clear it when login starts
  if (!autoLoginState.has(tabId)) {
    autoLoginState.set(tabId, {});
  }
  autoLoginState.get(tabId).countdownInterval = interval;
}

/**
 * Mark a tab's login as complete (removes from active tracking)
 */
function clearActiveLogin(tabId) {
  tabsWithActiveLogin.delete(tabId);
  // Clear countdown interval if any
  const state = autoLoginState.get(tabId);
  if (state && state.countdownInterval) {
    clearInterval(state.countdownInterval);
  }
}

async function processGlobalLoginQueue() {
  if (globalLoginInProgress || globalLoginQueue.length === 0) return;

  // Wait at least 30 seconds between login attempts (server rate limit is very strict)
  const timeSinceLastLogin = Date.now() - globalLastLoginAttempt;
  if (timeSinceLastLogin < LOGIN_RATE_LIMIT_MS) {
    const waitTime = LOGIN_RATE_LIMIT_MS - timeSinceLastLogin;
    logAuthEvent('info', `Rate limited, waiting ${Math.ceil(waitTime / 1000)}s`, {
      event: 'auth:rate-limit',
      waitMs: waitTime,
      queueSize: globalLoginQueue.length,
    });
    setTimeout(processGlobalLoginQueue, waitTime);
    return;
  }

  globalLoginInProgress = true;
  const { tabId, loginFn, webview } = globalLoginQueue.shift();
  // NOTE: Don't remove from tabsWithActiveLogin here - login is still in progress

  // Hide the queue overlay - login is starting
  if (webview) {
    hideLoginQueueOverlay(webview);
  }

  // Clear countdown interval
  const state = autoLoginState.get(tabId);
  if (state && state.countdownInterval) {
    clearInterval(state.countdownInterval);
  }

  try {
    globalLastLoginAttempt = Date.now();
    logAuthEvent('info', 'Processing queued login', {
      event: 'auth:queue-process',
      tabId,
      queueRemaining: globalLoginQueue.length,
    });
    await loginFn();
  } catch (e) {
    logAuthEvent('error', 'Queued login error', { event: 'auth:queue-error', tabId, error: e.message });
    // On error, clear the active login so it can be retried
    clearActiveLogin(tabId);
  } finally {
    globalLoginInProgress = false;
    // Process next in queue after rate limit delay
    if (globalLoginQueue.length > 0) {
      setTimeout(processGlobalLoginQueue, LOGIN_RATE_LIMIT_MS);
    }
  }
}

/**
 * Extract accountId from a URL query parameter
 * Used to auto-select the correct account on account selection pages
 */
function extractAccountIdFromUrl(url) {
  if (!url) return null;
  try {
    const match = url.match(/accountId=([a-f0-9-]+)/i);
    return match ? match[1] : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve accountId using a fallback chain:
 *  1. Original pre-redirect URL stored for this tab (most specific)
 *  2. The current/passed URL (covers direct account-select navigation)
 *  3. Configured gsxAccountId from app settings (global fallback)
 *
 * This is necessary because auth redirects strip the accountId query parameter
 * from the URL, so extracting from the current URL alone usually fails.
 */
async function resolveAccountId(url, tabId) {
  // 1. Try the original (pre-redirect) URL stored for this tab
  const state = autoLoginState.get(tabId);
  if (state && state.originalDestinationUrl) {
    const fromOriginal = extractAccountIdFromUrl(state.originalDestinationUrl);
    if (fromOriginal) {
      logAuthEvent('info', 'Resolved accountId from original pre-redirect URL', {
        event: 'auth:account-resolve',
        tabId,
        source: 'originalUrl',
        accountId: fromOriginal,
      });
      return fromOriginal;
    }
  }

  // 2. Try the current URL (covers cases where accountId is still in the URL)
  const fromUrl = extractAccountIdFromUrl(url);
  if (fromUrl) {
    logAuthEvent('info', 'Resolved accountId from current URL', {
      event: 'auth:account-resolve',
      tabId,
      source: 'currentUrl',
      accountId: fromUrl,
    });
    return fromUrl;
  }

  // 3. Fall back to configured gsxAccountId from settings
  try {
    const settings = await window.api.getSettings();
    if (settings && settings.gsxAccountId) {
      logAuthEvent('info', 'Resolved accountId from app settings (fallback)', {
        event: 'auth:account-resolve',
        tabId,
        source: 'settings',
        accountId: settings.gsxAccountId,
      });
      return settings.gsxAccountId;
    }
  } catch (e) {
    logAuthEvent('warn', 'Could not read settings for accountId fallback', {
      event: 'auth:account-resolve-error',
      tabId,
      error: e.message,
    });
  }

  logAuthEvent('warn', 'Could not resolve accountId from any source', {
    event: 'auth:account-resolve-failed',
    tabId,
    url,
  });
  return null;
}

/**
 * Auto-select the correct account on an account selection/choice page
 * After login + 2FA, some auth flows show an account picker. Since IDWs
 * already specify their accountId, we can auto-select the right one.
 */
async function selectAccountOnPage(webview, tabId, targetAccountId) {
  if (!targetAccountId) {
    logAuthEvent('warn', 'No target accountId for selection', { event: 'auth:select-no-target', tabId });
    return false;
  }

  logAuthEvent('info', 'Attempting account selection', { event: 'auth:select-attempt', tabId, targetAccountId });

  try {
    const result = await webview.executeJavaScript(`
            (function() {
                const targetId = ${JSON.stringify(targetAccountId)};
                console.log('[AutoLogin AccountSelect] Looking for account:', targetId);
                
                // Strategy 1: Find links with accountId in href
                const allLinks = document.querySelectorAll('a');
                for (const link of allLinks) {
                    if (link.href && link.href.includes(targetId)) {
                        console.log('[AutoLogin AccountSelect] Found link with accountId:', link.textContent?.trim());
                        link.click();
                        return { success: true, method: 'link-href', text: link.textContent?.trim() };
                    }
                }
                
                // Strategy 2: Find elements with data-account-id or similar data attributes
                const dataElements = document.querySelectorAll('[data-account-id], [data-id], [data-account]');
                for (const el of dataElements) {
                    const attrId = el.dataset.accountId || el.dataset.id || el.dataset.account;
                    if (attrId === targetId) {
                        console.log('[AutoLogin AccountSelect] Found element with data attribute');
                        el.click();
                        return { success: true, method: 'data-attribute' };
                    }
                }
                
                // Strategy 3: Find any clickable element whose outerHTML contains the account ID
                const clickable = document.querySelectorAll('a, button, [role="button"], [onclick], li[class*="account"], div[class*="account"], .account-item, .account-card, .account-option');
                for (const el of clickable) {
                    const html = el.outerHTML || '';
                    if (html.includes(targetId)) {
                        console.log('[AutoLogin AccountSelect] Found clickable element containing accountId:', el.tagName, el.textContent?.trim()?.substring(0, 50));
                        el.click();
                        return { success: true, method: 'html-content-match' };
                    }
                }
                
                // Strategy 4: Find forms or hidden inputs with the accountId
                const forms = document.querySelectorAll('form');
                for (const form of forms) {
                    const html = form.outerHTML || '';
                    if (html.includes(targetId)) {
                        const submitBtn = form.querySelector('button[type="submit"], button, input[type="submit"]');
                        if (submitBtn) {
                            console.log('[AutoLogin AccountSelect] Found form with accountId, clicking submit');
                            submitBtn.click();
                            return { success: true, method: 'form-submit' };
                        }
                    }
                }
                
                // Log what we see for debugging
                const visibleText = document.body ? document.body.innerText.substring(0, 500) : '';
                console.log('[AutoLogin AccountSelect] Could not find account. Page text:', visibleText);
                
                return { success: false, reason: 'no_matching_account', visibleClickable: clickable.length };
            })()
        `);

    if (result.success) {
      logAuthEvent('info', 'Account selected successfully', {
        event: 'auth:account-selected',
        tabId,
        targetAccountId,
        method: result.method,
        text: result.text,
      });
      markAutoLoginComplete(tabId, true);
      return true;
    }
    logAuthEvent('warn', 'Account not found on page', {
      event: 'auth:account-missing',
      tabId,
      targetAccountId,
      reason: result.reason,
      clickableCount: result.visibleClickable,
    });
    return false;
  } catch (e) {
    logAuthEvent('error', 'Account selection error', { event: 'auth:select-error', tabId, error: e.message });
    return false;
  }
}

/**
 * Check if a URL is an actual auth/login page (not just any onereach page)
 */
function isAuthPage(url) {
  if (!url) return false;
  // Only trigger for actual auth pages, not landing pages
  return (
    (url.includes('auth.') && url.includes('onereach.ai')) || (url.includes('/login') && url.includes('onereach.ai'))
  );
}

/**
 * Extract the auth domain from a URL for comparison
 * This helps identify if two URLs are part of the same auth flow
 */
function getAuthDomain(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // For auth pages, we consider auth.*.onereach.ai as the key
    if (parsed.hostname.includes('auth.') && parsed.hostname.includes('onereach.ai')) {
      return parsed.hostname; // e.g., auth.edison.onereach.ai
    }
    // For idw login pages, extract the environment
    if (parsed.hostname.includes('idw.') && url.includes('/login')) {
      return parsed.hostname; // e.g., idw.edison.onereach.ai
    }
    return parsed.hostname;
  } catch (_e) {
    return null;
  }
}

/**
 * Check if two URLs are part of the same auth flow
 */
function isSameAuthFlow(url1, url2) {
  if (!url1 || !url2) return false;

  const domain1 = getAuthDomain(url1);
  const domain2 = getAuthDomain(url2);

  // Same domain means same auth flow
  if (domain1 === domain2) return true;

  // Also consider idw.*.onereach.ai/login and auth.*.onereach.ai as same flow
  // They share the same environment (edison, staging, etc.)
  const env1 = url1.match(/\.(edison|staging|store|production)\./)?.[1];
  const env2 = url2.match(/\.(edison|staging|store|production)\./)?.[1];

  if (env1 && env2 && env1 === env2) {
    return true;
  }

  return false;
}

/**
 * Check if auto-login is already in progress or completed for a tab
 * @param {string} tabId - The tab identifier
 * @param {string} url - The current URL (to detect new auth pages)
 */
function shouldAttemptAutoLogin(tabId, url = '') {
  const state = autoLoginState.get(tabId);
  if (!state) return true;

  // Don't attempt if login completed successfully
  if (state.loginComplete) {
    console.log(`[AutoLogin] Skipping ${tabId} - login already complete`);
    return false;
  }

  // If form was already filled, don't start over - wait for 2FA
  if (state.formFilled && Date.now() - state.formFilledAt < 30000) {
    console.log(`[AutoLogin] Skipping ${tabId} - form already filled, waiting for 2FA`);
    return false;
  }

  // Don't attempt if already in progress (within 5 seconds) on SAME auth flow
  if (state.inProgress && Date.now() - state.lastAttempt < 5000) {
    if (isSameAuthFlow(url, state.lastUrl)) {
      console.log(`[AutoLogin] Skipping ${tabId} - login in progress on same auth flow`);
      return false;
    }
  }

  // Don't attempt if we just gave up (within 10 seconds)
  if (state.gaveUp && Date.now() - state.gaveUpAt < 10000) {
    console.log(`[AutoLogin] Skipping ${tabId} - recently gave up`);
    return false;
  }

  return true;
}

/**
 * Mark auto-login as in progress for a tab
 */
function markAutoLoginInProgress(tabId, url = '') {
  autoLoginState.set(tabId, {
    ...(autoLoginState.get(tabId) || {}),
    inProgress: true,
    lastAttempt: Date.now(),
    lastUrl: url,
    gaveUp: false,
  });
}

/**
 * Mark that login form was successfully filled
 */
function markFormFilled(tabId) {
  autoLoginState.set(tabId, {
    ...(autoLoginState.get(tabId) || {}),
    formFilled: true,
    formFilledAt: Date.now(),
  });
}

/**
 * Mark auto-login as complete for a tab
 */
function markAutoLoginComplete(tabId, success) {
  logAuthEvent(success ? 'info' : 'warn', `Login flow ${success ? 'completed' : 'ended without success'}`, {
    event: success ? 'auth:complete' : 'auth:incomplete',
    tabId,
    success,
  });
  autoLoginState.set(tabId, {
    ...(autoLoginState.get(tabId) || {}),
    inProgress: false,
    loginComplete: success,
    completedAt: Date.now(),
    formFilled: false,
    gaveUp: false,
  });
  // Clear from active login tracking so queue can process
  clearActiveLogin(tabId);
}

/**
 * Mark auto-login as gave up (no form found after retries)
 */
function markAutoLoginGaveUp(tabId) {
  autoLoginState.set(tabId, {
    ...(autoLoginState.get(tabId) || {}),
    inProgress: false,
    gaveUp: true,
    gaveUpAt: Date.now(),
  });
  // Clear from active login tracking so queue can process
  clearActiveLogin(tabId);
}

/**
 * Attempt auto-login with retry mechanism for async-loaded forms
 */
async function attemptAutoLoginWithRetry(webview, url, tabId, attempt) {
  const maxAttempts = 5;
  const retryDelay = 1000;

  if (attempt === 0) {
    logAuthEvent('info', 'Login flow started', { event: 'auth:flow-start', tabId, url });
  }

  // Get the CURRENT URL from the webview (page may have navigated during queue wait)
  let currentUrl;
  try {
    currentUrl = await webview.executeJavaScript('window.location.href');
  } catch (_e) {
    logAuthEvent('warn', 'Webview not accessible', { event: 'auth:webview-error', tabId });
    markAutoLoginGaveUp(tabId);
    return;
  }

  // Only attempt on actual auth pages (check CURRENT url, not queued url)
  if (!isAuthPage(currentUrl)) {
    console.log(`[AutoLogin] Skipping ${tabId} - page is no longer on auth page: ${currentUrl}`);
    markAutoLoginGaveUp(tabId);
    return;
  }

  // Check if we should attempt login
  if (attempt === 0 && !shouldAttemptAutoLogin(tabId, currentUrl)) {
    return;
  }

  // Mark as in progress on first attempt
  if (attempt === 0) {
    markAutoLoginInProgress(tabId, currentUrl);
  }

  logAuthEvent('info', `Retry attempt ${attempt + 1}/${maxAttempts}`, {
    event: 'auth:retry',
    tabId,
    attempt: attempt + 1,
    maxAttempts,
    url: currentUrl,
  });

  // Check if form fields exist yet
  const formInfo = await webview
    .executeJavaScript(
      `
        (function() {
            // Check main document
            const hasPasswordInMain = !!document.querySelector('input[type="password"]');
            if (hasPasswordInMain) {
                console.log('[AutoLogin] Form found in main document');
                return { location: 'main', crossOrigin: false };
            }
            
            // Check for iframes
            const iframes = document.querySelectorAll('iframe');
            console.log('[AutoLogin] Found ' + iframes.length + ' iframes');
            
            let hasCrossOriginIframe = false;
            
            for (let i = 0; i < iframes.length; i++) {
                const iframe = iframes[i];
                const src = iframe.src || '';
                
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDoc && iframeDoc.querySelector('input[type="password"]')) {
                        console.log('[AutoLogin] Form found in same-origin iframe ' + i);
                        return { location: 'iframe-' + i, crossOrigin: false };
                    }
                } catch (e) {
                    // Cross-origin iframe - we can't access it directly
                    console.log('[AutoLogin] Cross-origin iframe detected: ' + src);
                    // Check if this looks like an auth iframe
                    if (src.includes('auth.') && src.includes('onereach.ai')) {
                        hasCrossOriginIframe = true;
                    }
                }
            }
            
            if (hasCrossOriginIframe) {
                return { location: 'cross-origin', crossOrigin: true };
            }
            
            return { location: 'none', crossOrigin: false };
        })()
    `
    )
    .catch(() => ({ location: 'error', crossOrigin: false }));

  logAuthEvent('info', `Form detection: ${formInfo.location}`, {
    event: 'auth:form-detect',
    tabId,
    location: formInfo.location,
    crossOrigin: formInfo.crossOrigin,
  });

  if (formInfo.location === 'main') {
    // Form is in main document, proceed with normal login
    await attemptAutoLogin(webview, url, tabId);
  } else if (formInfo.location.startsWith('iframe-')) {
    // Form is in a same-origin iframe
    logAuthEvent('info', 'Same-origin iframe form, filling', { event: 'auth:iframe-login', tabId });
    await attemptIframeAutoLogin(webview, url, tabId);
  } else if (formInfo.crossOrigin) {
    // Cross-origin iframe detected - use main process to access it
    logAuthEvent('info', 'Cross-origin auth iframe, using IPC', { event: 'auth:cross-origin-login', tabId });
    await attemptCrossOriginAutoLogin(webview, tabId);
  } else if (formInfo.location === 'none' && attempt < maxAttempts - 1) {
    // No form yet, retry after delay
    logAuthEvent('info', 'No form found yet, will retry', { event: 'auth:form-pending', tabId, retryMs: retryDelay });
    setTimeout(() => {
      attemptAutoLoginWithRetry(webview, url, tabId, attempt + 1);
    }, retryDelay);
  } else {
    logAuthEvent('warn', 'No form found, giving up', { event: 'auth:gave-up', tabId, attempts: attempt + 1 });
    markAutoLoginGaveUp(tabId);
  }
}

/**
 * Attempt auto-login inside an iframe
 */
async function attemptIframeAutoLogin(webview, url, tabId) {
  try {
    const credentials = await window.api.invoke('onereach:get-credentials');
    if (!credentials || !credentials.email || !credentials.password) {
      logAuthEvent('warn', 'No credentials for iframe login', { event: 'auth:iframe-no-credentials', tabId });
      return;
    }

    logAuthEvent('info', 'Filling iframe login form', { event: 'auth:iframe-fill', tabId, email: credentials.email });

    const filled = await webview.executeJavaScript(`
            (function() {
                const email = ${JSON.stringify(credentials.email)};
                const password = ${JSON.stringify(credentials.password)};
                
                function fillInput(input, value) {
                    if (!input) return false;
                    input.focus();
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeInputValueSetter.call(input, value);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                
                // Find the iframe with the form
                const iframes = document.querySelectorAll('iframe');
                for (let iframe of iframes) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        if (!doc) continue;
                        
                        const passwordField = doc.querySelector('input[type="password"]');
                        if (!passwordField) continue;
                        
                        const emailField = doc.querySelector(
                            'input[type="email"], input[type="text"][name*="email" i], ' +
                            'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
                            'input[placeholder*="email" i], input[placeholder*="user" i]'
                        );
                        
                        if (emailField) fillInput(emailField, email);
                        fillInput(passwordField, password);
                        
                        // Click submit
                        setTimeout(() => {
                            const submitBtn = doc.querySelector('button[type="submit"], input[type="submit"]') ||
                                             doc.querySelector('form button');
                            if (submitBtn) {
                                console.log('[AutoLogin] Clicking iframe submit button');
                                submitBtn.click();
                            }
                        }, 500);
                        
                        console.log('[AutoLogin] Filled iframe form');
                        return true;
                    } catch (e) {
                        console.log('[AutoLogin] Could not access iframe:', e.message);
                    }
                }
                return false;
            })()
        `);

    // Mark form as filled if successful
    if (filled) {
      logAuthEvent('info', 'Iframe login form filled', { event: 'auth:iframe-filled', tabId });
      markFormFilled(tabId);
    } else {
      logAuthEvent('warn', 'Iframe login form not found', { event: 'auth:iframe-not-found', tabId });
    }
  } catch (error) {
    logAuthEvent('error', 'Iframe login error', { event: 'auth:iframe-error', tabId, error: error.message });
  }
}

/**
 * Attempt auto-login in cross-origin iframe via main process
 * This uses webFrameMain to access frames that same-origin policy blocks
 */
async function attemptCrossOriginAutoLogin(webview, tabId) {
  try {
    // Get credentials
    const credentials = await window.api.invoke('onereach:get-credentials');
    if (!credentials || !credentials.email || !credentials.password) {
      logAuthEvent('warn', 'No credentials for cross-origin login', { event: 'auth:xorigin-no-creds', tabId });
      return;
    }

    // Get the webview's webContentsId
    const webContentsId = webview.getWebContentsId();
    logAuthEvent('info', 'Cross-origin login via IPC', { event: 'auth:xorigin-start', tabId, webContentsId });

    // Build the login script
    const loginScript = `
            (function() {
                const email = ${JSON.stringify(credentials.email)};
                const password = ${JSON.stringify(credentials.password)};
                
                console.log('[CrossOrigin AutoLogin] Running in auth frame');
                console.log('[CrossOrigin AutoLogin] URL:', window.location.href);
                
                // Log all inputs for debugging
                const allInputs = document.querySelectorAll('input');
                console.log('[CrossOrigin AutoLogin] Found ' + allInputs.length + ' inputs');
                allInputs.forEach((inp, i) => {
                    if (inp.type !== 'hidden') {
                        console.log('[CrossOrigin AutoLogin] Input ' + i + ': type=' + inp.type + ', name=' + inp.name);
                    }
                });
                
                function fillInput(input, value) {
                    if (!input) return false;
                    input.focus();
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    if (nativeInputValueSetter) {
                        nativeInputValueSetter.call(input, value);
                    } else {
                        input.value = value;
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                    console.log('[CrossOrigin AutoLogin] Filled:', input.name || input.type);
                    return true;
                }
                
                // Find email field (broad search)
                const emailField = document.querySelector(
                    'input[type="email"], input[type="text"][name*="email" i], ' +
                    'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
                    'input[autocomplete="email"], input[autocomplete="username"], ' +
                    'input[placeholder*="email" i], input[placeholder*="user" i], ' +
                    'input[type="text"]:not([name*="search"])' // Fallback: first text input
                );
                
                // Find password field
                const passwordField = document.querySelector('input[type="password"]');
                
                if (!passwordField) {
                    console.log('[CrossOrigin AutoLogin] No password field found');
                    return { success: false, reason: 'no_password_field' };
                }
                
                if (emailField) {
                    fillInput(emailField, email);
                }
                fillInput(passwordField, password);
                
                // Click submit after a delay
                setTimeout(() => {
                    const submitBtn = document.querySelector(
                        'button[type="submit"], input[type="submit"], button.submit'
                    ) || document.querySelector('form button:not([type="button"])');
                    
                    if (submitBtn) {
                        console.log('[CrossOrigin AutoLogin] Clicking submit:', submitBtn.textContent || submitBtn.type);
                        submitBtn.click();
                    } else {
                        // Find by text
                        const buttons = document.querySelectorAll('button');
                        for (const btn of buttons) {
                            const text = (btn.textContent || '').toLowerCase();
                            if (text.includes('sign in') || text.includes('log in') || text.includes('login') || text.includes('continue')) {
                                console.log('[CrossOrigin AutoLogin] Clicking button by text:', btn.textContent);
                                btn.click();
                                break;
                            }
                        }
                    }
                }, 500);
                
                return { success: true, emailFound: !!emailField, passwordFound: !!passwordField };
            })()
        `;

    // Execute in the auth iframe via main process
    const result = await window.api.invoke('onereach:execute-in-frame', {
      webContentsId,
      urlPattern: 'auth.', // Match auth.*.onereach.ai frames
      script: loginScript,
    });

    console.log('[AutoLogin] Cross-origin login result:', result);

    if (result.success) {
      console.log('[AutoLogin] Successfully filled cross-origin login form');

      // Mark form as filled to prevent re-attempts during auth flow
      markFormFilled(tabId);
      logAuthEvent('info', 'Cross-origin login form filled, monitoring for 2FA', {
        event: 'auth:xorigin-filled',
        tabId,
      });

      // After login submission, monitor for 2FA page
      setTimeout(() => {
        attemptCrossOrigin2FA(webview, tabId, 0);
      }, 2000); // Wait 2 seconds for login to process
    } else {
      logAuthEvent('warn', 'Cross-origin login failed', { event: 'auth:xorigin-failed', tabId, error: result.error });
    }
  } catch (error) {
    logAuthEvent('error', 'Cross-origin login error', { event: 'auth:xorigin-error', tabId, error: error.message });
  }
}

/**
 * Attempt 2FA code entry in cross-origin iframe
 */
async function attemptCrossOrigin2FA(webview, tabId, attempt) {
  const maxAttempts = 5;
  const retryDelay = 1500;

  // Check if 2FA already completed for this tab
  const state = autoLoginState.get(tabId);
  if (state && state.twoFAComplete) {
    logAuthEvent('info', 'Cross-origin 2FA already complete', { event: 'auth:xorigin-2fa-done', tabId });
    return;
  }

  try {
    logAuthEvent('info', `Cross-origin 2FA attempt ${attempt + 1}/${maxAttempts}`, {
      event: 'auth:xorigin-2fa-attempt',
      tabId,
      attempt: attempt + 1,
      maxAttempts,
    });

    // Get the webview's webContentsId
    const webContentsId = webview.getWebContentsId();

    // First, check if we're on a 2FA page
    const detect2FAScript = `
            (function() {
                console.log('[2FA Detection] Checking for 2FA page...');
                console.log('[2FA Detection] URL:', window.location.href);
                
                const allInputs = document.querySelectorAll('input');
                console.log('[2FA Detection] Found ' + allInputs.length + ' inputs');
                allInputs.forEach((inp, i) => {
                    if (inp.type !== 'hidden') {
                        console.log('[2FA Detection] Input ' + i + ': type=' + inp.type + ', name=' + inp.name + ', maxlength=' + inp.maxLength);
                    }
                });
                
                // Check for 2FA indicators
                const pageText = document.body ? document.body.innerText.toLowerCase() : '';
                const has2FAText = pageText.includes('two-factor') || pageText.includes('2fa') || 
                                  pageText.includes('verification code') || pageText.includes('authenticator') ||
                                  pageText.includes('enter the code') || pageText.includes('6-digit') ||
                                  pageText.includes('security code') || pageText.includes('authentication code');
                
                // Look for 2FA input fields
                const totpInput = document.querySelector(
                    'input[name="totp"], input[name="code"], input[name="otp"], ' +
                    'input[name="verificationCode"], input[name="twoFactorCode"], ' +
                    'input[autocomplete="one-time-code"], ' +
                    'input[inputmode="numeric"][maxlength="6"], ' +
                    'input[maxlength="6"]:not([type="password"]):not([name*="email"]):not([name*="user"]), ' +
                    'input[placeholder*="code" i], input[placeholder*="2fa" i], input[placeholder*="authenticator" i]'
                );
                
                // Also check for password field (means we're still on login)
                const passwordField = document.querySelector('input[type="password"]');
                
                if (totpInput) {
                    console.log('[2FA Detection] Found 2FA input field');
                    return { is2FAPage: true, reason: 'totp_input_found' };
                }
                
                if (has2FAText && !passwordField) {
                    console.log('[2FA Detection] 2FA text detected, no password field');
                    return { is2FAPage: true, reason: '2fa_text_found' };
                }
                
                if (passwordField) {
                    console.log('[2FA Detection] Still on login page (password field present)');
                    return { is2FAPage: false, reason: 'still_login_page' };
                }
                
                return { is2FAPage: false, reason: 'unknown' };
            })()
        `;

    const detectResult = await window.api.invoke('onereach:execute-in-frame', {
      webContentsId,
      urlPattern: 'auth.',
      script: detect2FAScript,
    });

    if (!detectResult.success) {
      logAuthEvent('warn', 'Cannot access auth frame for 2FA', { event: 'auth:xorigin-2fa-no-frame', tabId });
      if (attempt < maxAttempts - 1) {
        setTimeout(() => attemptCrossOrigin2FA(webview, tabId, attempt + 1), retryDelay);
      }
      return;
    }

    const detection = detectResult.result;

    if (!detection || !detection.is2FAPage) {
      if (attempt < maxAttempts - 1) {
        logAuthEvent('info', 'Not on 2FA page yet, retrying', {
          event: 'auth:xorigin-2fa-waiting',
          tabId,
          reason: detection?.reason,
        });
        setTimeout(() => attemptCrossOrigin2FA(webview, tabId, attempt + 1), retryDelay);
      } else {
        logAuthEvent('info', '2FA page not found after max retries (may not be required)', {
          event: 'auth:xorigin-2fa-skipped',
          tabId,
        });
      }
      return;
    }

    // We're on the 2FA page - get the TOTP code
    logAuthEvent('info', 'Cross-origin 2FA page detected, requesting code', {
      event: 'auth:xorigin-2fa-detected',
      tabId,
    });

    const codeResult = await window.api.invoke('totp:get-current-code');

    if (!codeResult || !codeResult.success) {
      logAuthEvent('error', 'Cross-origin TOTP code failed', {
        event: 'auth:xorigin-totp-failed',
        tabId,
        error: codeResult?.error,
      });
      return;
    }

    const totpCode = codeResult.code;
    logAuthEvent('info', 'TOTP code ready, filling cross-origin 2FA', {
      event: 'auth:xorigin-2fa-fill',
      tabId,
      timeRemaining: codeResult.timeRemaining,
    });

    // Fill in the 2FA code
    const fill2FAScript = `
            (function() {
                const code = ${JSON.stringify(totpCode)};
                
                console.log('[2FA Fill] Attempting to fill 2FA code');
                
                function fillInput(input, value) {
                    if (!input) return false;
                    input.focus();
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    if (nativeInputValueSetter) {
                        nativeInputValueSetter.call(input, value);
                    } else {
                        input.value = value;
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                    return true;
                }
                
                // Find 2FA input
                const totpInput = document.querySelector(
                    'input[name="totp"], input[name="code"], input[name="otp"], ' +
                    'input[name="verificationCode"], input[name="twoFactorCode"], ' +
                    'input[autocomplete="one-time-code"], ' +
                    'input[inputmode="numeric"][maxlength="6"], ' +
                    'input[maxlength="6"]:not([type="password"]):not([name*="email"]):not([name*="user"]), ' +
                    'input[placeholder*="code" i]'
                );
                
                if (!totpInput) {
                    // Try finding any numeric input
                    const numericInputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[inputmode="numeric"]');
                    for (const inp of numericInputs) {
                        if (inp.maxLength === 6 || inp.placeholder.toLowerCase().includes('code')) {
                            console.log('[2FA Fill] Found potential 2FA input by heuristic');
                            fillInput(inp, code);
                            
                            setTimeout(() => {
                                const submitBtn = document.querySelector('button[type="submit"]') || 
                                                 document.querySelector('form button');
                                if (submitBtn) {
                                    console.log('[2FA Fill] Clicking submit');
                                    submitBtn.click();
                                }
                            }, 500);
                            
                            return { success: true, method: 'heuristic' };
                        }
                    }
                    console.log('[2FA Fill] No 2FA input found');
                    return { success: false, reason: 'no_totp_input' };
                }
                
                console.log('[2FA Fill] Found 2FA input:', totpInput.name || totpInput.id);
                fillInput(totpInput, code);
                
                // Click submit after a delay
                setTimeout(() => {
                    const submitBtn = document.querySelector('button[type="submit"]') || 
                                     document.querySelector('form button:not([type="button"])');
                    if (submitBtn) {
                        console.log('[2FA Fill] Clicking submit:', submitBtn.textContent);
                        submitBtn.click();
                    } else {
                        // Try finding verify/continue button
                        const buttons = document.querySelectorAll('button');
                        for (const btn of buttons) {
                            const text = (btn.textContent || '').toLowerCase();
                            if (text.includes('verify') || text.includes('confirm') || text.includes('submit') || text.includes('continue')) {
                                console.log('[2FA Fill] Clicking button by text:', btn.textContent);
                                btn.click();
                                break;
                            }
                        }
                    }
                }, 500);
                
                return { success: true, method: 'direct' };
            })()
        `;

    const fillResult = await window.api.invoke('onereach:execute-in-frame', {
      webContentsId,
      urlPattern: 'auth.',
      script: fill2FAScript,
    });

    if (fillResult.success && fillResult.result?.success) {
      logAuthEvent('info', 'Cross-origin 2FA filled successfully', {
        event: 'auth:xorigin-2fa-filled',
        tabId,
        method: fillResult.result.method,
      });
      // Mark 2FA as complete to prevent further attempts
      autoLoginState.set(tabId, {
        ...(autoLoginState.get(tabId) || {}),
        twoFAComplete: true,
        loginComplete: true,
        completedAt: Date.now(),
      });
      logAuthEvent('info', 'Cross-origin login flow complete', { event: 'auth:xorigin-complete', tabId });
    } else {
      logAuthEvent('warn', 'Cross-origin 2FA fill failed', { event: 'auth:xorigin-2fa-fill-failed', tabId });
    }
  } catch (error) {
    logAuthEvent('error', 'Cross-origin 2FA error', { event: 'auth:xorigin-2fa-error', tabId, error: error.message });
  }
}

/**
 * Fill 2FA/TOTP code on the current page
 * Shared by both the main document login flow and direct 2FA page detection
 */
async function fill2FACode(webview, tabId, credentials) {
  if (!credentials.totpSecret) {
    logAuthEvent('warn', 'No TOTP secret configured', { event: 'auth:no-totp-secret', tabId });
    return;
  }

  // Get current TOTP code
  logAuthEvent('info', 'Requesting TOTP code', { event: 'auth:totp-request', tabId });
  const codeResult = await window.api.invoke('totp:get-current-code');

  if (!codeResult || !codeResult.success) {
    logAuthEvent('error', 'TOTP code generation failed', {
      event: 'auth:totp-failed',
      tabId,
      error: codeResult?.error,
    });
    return;
  }

  logAuthEvent('info', 'Filling 2FA code', {
    event: 'auth:2fa-filling',
    tabId,
    timeRemaining: codeResult.timeRemaining,
  });

  const filled = await webview.executeJavaScript(`
        (function() {
            const code = ${JSON.stringify(codeResult.code)};
            
            const totpInput = document.querySelector(
                'input[name="totp"], input[name="code"], input[name="otp"], ' +
                'input[autocomplete="one-time-code"], ' +
                'input[inputmode="numeric"][maxlength="6"], ' +
                'input[placeholder*="code" i], input[placeholder*="2fa" i], ' +
                'input[type="text"][maxlength="6"], input[type="number"][maxlength="6"]'
            );
            
            if (!totpInput) {
                console.log('[AutoLogin 2FA] No TOTP input found');
                return false;
            }
            
            console.log('[AutoLogin 2FA] Found TOTP input:', totpInput.name || totpInput.id || totpInput.type);
            
            totpInput.focus();
            
            // React compatibility - set native value
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(totpInput, code);
            } else {
                totpInput.value = code;
            }
            totpInput.dispatchEvent(new Event('input', { bubbles: true }));
            totpInput.dispatchEvent(new Event('change', { bubbles: true }));
            totpInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            // Auto-submit after a short delay
            setTimeout(function() {
                const submitBtn = document.querySelector(
                    'button[type="submit"], input[type="submit"]'
                ) || document.querySelector('form button:not([type="button"])');
                
                if (submitBtn) {
                    console.log('[AutoLogin 2FA] Clicking submit:', submitBtn.textContent || submitBtn.type);
                    submitBtn.click();
                } else {
                    // Try finding verify/continue button by text
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').toLowerCase();
                        if (text.includes('verify') || text.includes('confirm') || text.includes('submit') || text.includes('continue')) {
                            console.log('[AutoLogin 2FA] Clicking button by text:', btn.textContent);
                            btn.click();
                            break;
                        }
                    }
                }
            }, 300);
            
            return true;
        })()
    `);

  if (filled) {
    logAuthEvent('info', '2FA code filled successfully', { event: 'auth:2fa-filled', tabId });
  } else {
    logAuthEvent('warn', '2FA input not found on page', { event: 'auth:2fa-input-missing', tabId });
  }

  return filled;
}

/**
 * Monitor post-auth flow: handles 2FA → account selection → success
 * Continuously polls the page to detect and handle each step of the auth flow.
 * The full flow can be: login → 2FA → account-select → success
 */
async function monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt) {
  const maxAttempts = 12; // Up to ~18s monitoring (covers 2FA + account selection)
  const delay = 1500;

  if (attempt >= maxAttempts) {
    logAuthEvent('warn', 'Post-auth monitor exhausted', { event: 'auth:monitor-exhausted', tabId, maxAttempts });
    markAutoLoginComplete(tabId, false);
    return;
  }

  try {
    // Check if already completed
    const state = autoLoginState.get(tabId);
    if (state && state.loginComplete) {
      logAuthEvent('info', 'Monitor: login already complete', { event: 'auth:monitor-done', tabId });
      return;
    }

    const curUrl = await webview.executeJavaScript('window.location.href');

    // If no longer on auth page, login flow succeeded
    if (!isAuthPage(curUrl)) {
      logAuthEvent('info', 'Login succeeded - navigated away from auth', {
        event: 'auth:login-success',
        tabId,
        finalUrl: curUrl,
      });
      markAutoLoginComplete(tabId, true);
      return;
    }

    // Detect current page type
    const curPageType = await webview.executeJavaScript(`
            (function() {
                // Check for 2FA inputs
                var totpInputs = document.querySelectorAll(
                    'input[name="totp"], input[name="code"], input[name="otp"], ' +
                    'input[autocomplete="one-time-code"], ' +
                    'input[inputmode="numeric"][maxlength="6"], ' +
                    'input[placeholder*="code" i], input[placeholder*="2fa" i], ' +
                    'input[placeholder*="authenticator" i]'
                );
                var visible2FA = Array.from(totpInputs).find(function(input) {
                    var rect = input.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
                if (visible2FA) return '2fa';
                
                // Check for login form (still on login page)
                var passwordInput = document.querySelector('input[type="password"]');
                if (passwordInput) return 'login';
                
                // Check for account selection page
                var pageText = document.body ? document.body.innerText.toLowerCase() : '';
                var hasAccountText = pageText.includes('choose') || pageText.includes('select') || 
                                    pageText.includes('switch') || pageText.includes('account');
                var accountLinks = document.querySelectorAll('a[href*="accountId"], [data-account-id], [data-account], .account-item, .account-card');
                var clickableItems = document.querySelectorAll('a, button, [role="button"]');
                var accountClickable = Array.from(clickableItems).filter(function(el) {
                    var html = el.outerHTML || '';
                    return html.includes('account') || html.includes('Account');
                });
                
                if (accountLinks.length > 0 || (hasAccountText && accountClickable.length > 0)) {
                    return 'account-select';
                }
                
                return 'other';
            })()
        `);

    logAuthEvent('info', `Monitor poll ${attempt + 1}/${maxAttempts}: ${curPageType}`, {
      event: 'auth:monitor-poll',
      tabId,
      attempt: attempt + 1,
      maxAttempts,
      pageType: curPageType,
    });

    if (curPageType === '2fa') {
      logAuthEvent('info', 'Monitor detected 2FA page', { event: 'auth:monitor-2fa', tabId });
      const filled = await fill2FACode(webview, tabId, credentials);
      if (filled) {
        // After 2FA, continue monitoring for account selection or success
        setTimeout(() => monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt + 1), 2000);
      } else {
        // Couldn't fill 2FA, retry
        setTimeout(
          () => monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt + 1),
          delay
        );
      }
    } else if (curPageType === 'account-select') {
      if (targetAccountId) {
        logAuthEvent('info', 'Monitor detected account selection', {
          event: 'auth:monitor-account-select',
          tabId,
          targetAccountId,
        });
        const selected = await selectAccountOnPage(webview, tabId, targetAccountId);
        if (!selected) {
          logAuthEvent('warn', 'Account not found on page, retrying', {
            event: 'auth:account-not-found',
            tabId,
            targetAccountId,
          });
          setTimeout(
            () => monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt + 1),
            delay
          );
        }
        // If selected, selectAccountOnPage already called markAutoLoginComplete
      } else {
        logAuthEvent('warn', 'Account selection page but no accountId to match', {
          event: 'auth:no-target-account',
          tabId,
          url: originalUrl,
        });
        markAutoLoginComplete(tabId, false);
      }
    } else if (curPageType === 'login') {
      // Still on login page, page hasn't navigated yet
      setTimeout(() => monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt + 1), delay);
    } else {
      // Unknown state (might be transitioning), keep monitoring
      setTimeout(() => monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt + 1), delay);
    }
  } catch (e) {
    logAuthEvent('error', 'Monitor error', { event: 'auth:monitor-error', tabId, error: e.message });
    setTimeout(() => monitorPostAuth(webview, tabId, originalUrl, credentials, targetAccountId, attempt + 1), delay);
  }
}

/**
 * Attempt auto-login for OneReach pages
 * Detects login and 2FA pages and fills them automatically
 */
async function attemptAutoLogin(webview, url, tabId) {
  logAuthEvent('info', 'Checking auth page', { event: 'auth:check-page', tabId, url });

  try {
    // Check if auto-login is enabled
    const settings = await window.api.getSettings();
    const autoLoginSettings = settings.autoLoginSettings || {};

    if (autoLoginSettings.enabled === false) {
      logAuthEvent('info', 'Auto-login disabled in settings', { event: 'auth:disabled', tabId });
      return;
    }

    // Detect page type (login, 2fa, or other)
    const pageType = await webview.executeJavaScript(`
            (function() {
                // Log all inputs for debugging
                const allInputs = document.querySelectorAll('input');
                console.log('[AutoLogin] Found ' + allInputs.length + ' input fields on page');
                allInputs.forEach((inp, i) => {
                    if (inp.type !== 'hidden') {
                        console.log('[AutoLogin] Input ' + i + ': type=' + inp.type + ', name=' + inp.name + ', placeholder=' + inp.placeholder + ', id=' + inp.id);
                    }
                });
                
                // Check for 2FA input first (more specific)
                const totpInputs = document.querySelectorAll(
                    'input[name="totp"], input[name="code"], input[name="otp"], ' +
                    'input[autocomplete="one-time-code"], ' +
                    'input[inputmode="numeric"][maxlength="6"], ' +
                    'input[placeholder*="code" i], input[placeholder*="2fa" i], ' +
                    'input[placeholder*="authenticator" i]'
                );
                
                const visible2FA = Array.from(totpInputs).find(input => {
                    const rect = input.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
                
                if (visible2FA) {
                    console.log('[AutoLogin] Found 2FA field');
                    return '2fa';
                }
                
                // Check for login form - broader search
                const passwordInput = document.querySelector('input[type="password"]');
                const emailInput = document.querySelector(
                    'input[type="email"], input[type="text"][name*="email" i], ' +
                    'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
                    'input[autocomplete="email"], input[autocomplete="username"], ' +
                    'input[placeholder*="email" i], input[placeholder*="user" i]'
                );
                
                console.log('[AutoLogin] Email field found:', !!emailInput, 'Password field found:', !!passwordInput);
                
                if (passwordInput && emailInput) {
                    console.log('[AutoLogin] Login form detected');
                    return 'login';
                }
                
                // Check for password-only (might be second step)
                if (passwordInput) {
                    console.log('[AutoLogin] Password field only - might be step 2');
                    return 'password-only';
                }
                
                // Check for account selection page (appears after login/2FA)
                // No password field, no 2FA field, but has clickable account items
                var pageText = document.body ? document.body.innerText.toLowerCase() : '';
                var hasAccountText = pageText.includes('choose') || pageText.includes('select') || 
                                    pageText.includes('switch') || pageText.includes('account');
                var accountLinks = document.querySelectorAll('a[href*="accountId"], [data-account-id], [data-account], .account-item, .account-card');
                var clickableItems = document.querySelectorAll('a, button, [role="button"]');
                var accountClickable = Array.from(clickableItems).filter(function(el) {
                    var html = el.outerHTML || '';
                    return html.includes('account') || html.includes('Account');
                });
                
                if (accountLinks.length > 0 || (hasAccountText && accountClickable.length > 0)) {
                    console.log('[AutoLogin] Account selection page detected (links:', accountLinks.length, 'text:', hasAccountText, ')');
                    return 'account-select';
                }
                
                return 'other';
            })()
        `);

    logAuthEvent('info', `Page type detected: ${pageType}`, { event: 'auth:page-type', tabId, pageType, url });

    if (pageType === 'other') {
      return; // Not a login page, nothing to do
    }

    // Get credentials
    const credentials = await window.api.invoke('onereach:get-credentials');

    if (!credentials || !credentials.email || !credentials.password) {
      logAuthEvent('warn', 'No credentials configured', { event: 'auth:no-credentials', tabId });
      return;
    }

    logAuthEvent('info', 'Credentials retrieved', {
      event: 'auth:credentials-ok',
      tabId,
      email: credentials.email,
      has2FA: !!credentials.totpSecret,
    });

    if (pageType === 'login' || pageType === 'password-only') {
      logAuthEvent('info', `Filling ${pageType} form`, {
        event: 'auth:fill-login',
        tabId,
        pageType,
        email: credentials.email,
      });

      await webview.executeJavaScript(`
                (function() {
                    const email = ${JSON.stringify(credentials.email)};
                    const password = ${JSON.stringify(credentials.password)};
                    
                    function fillInput(input, value) {
                        if (!input) return false;
                        input.focus();
                        
                        // React compatibility - set native value
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        ).set;
                        nativeInputValueSetter.call(input, value);
                        
                        // Dispatch events
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                        
                        console.log('[AutoLogin] Filled field:', input.name || input.type);
                        return true;
                    }
                    
                    // Find and fill email (broader search)
                    const emailInput = document.querySelector(
                        'input[type="email"], input[type="text"][name*="email" i], ' +
                        'input[type="text"][name*="user" i], input[name="email"], input[name="username"], ' +
                        'input[autocomplete="email"], input[autocomplete="username"], ' +
                        'input[placeholder*="email" i], input[placeholder*="user" i]'
                    );
                    if (emailInput) {
                        fillInput(emailInput, email);
                    }
                    
                    // Find and fill password
                    const passwordInput = document.querySelector('input[type="password"]');
                    if (passwordInput) {
                        fillInput(passwordInput, password);
                    }
                    
                    // Auto-submit after a delay
                    setTimeout(() => {
                        // Try multiple submit button selectors
                        const submitBtn = document.querySelector(
                            'button[type="submit"], input[type="submit"], ' +
                            'button.submit, button.login, button.signin'
                        ) || document.querySelector('form button:not([type="button"])');
                        
                        if (submitBtn) {
                            console.log('[AutoLogin] Clicking submit button:', submitBtn.textContent || submitBtn.type);
                            submitBtn.click();
                        } else {
                            // Try finding by text content
                            const buttons = document.querySelectorAll('button');
                            for (const btn of buttons) {
                                const text = (btn.textContent || '').toLowerCase();
                                if (text.includes('sign in') || text.includes('log in') || text.includes('login') || text.includes('submit') || text.includes('continue')) {
                                    console.log('[AutoLogin] Clicking button by text:', btn.textContent);
                                    btn.click();
                                    break;
                                }
                            }
                        }
                    }, 500);
                    
                    return true;
                })()
            `);

      // Track that login form was filled and clear active login lock
      markFormFilled(tabId);
      clearActiveLogin(tabId);

      logAuthEvent('info', 'Login form filled, submit scheduled', {
        event: 'auth:form-filled',
        tabId,
        email: credentials.email,
      });

      // Resolve accountId using fallback chain (original URL -> current URL -> settings)
      const targetAccountId = await resolveAccountId(url, tabId);

      // Monitor for 2FA, account selection, or success after login form submission
      // Wait 2s for the login submit (which has a 500ms delay) to process
      logAuthEvent('info', 'Starting post-login monitor', { event: 'auth:monitor-start', tabId, targetAccountId });
      setTimeout(() => monitorPostAuth(webview, tabId, url, credentials, targetAccountId, 0), 2000);
    } else if (pageType === '2fa') {
      logAuthEvent('info', '2FA page detected directly, filling code', { event: 'auth:2fa-direct', tabId });
      const filled = await fill2FACode(webview, tabId, credentials);
      if (filled) {
        // After 2FA, monitor for account selection or success
        const targetAccountId = await resolveAccountId(url, tabId);
        logAuthEvent('info', '2FA filled, starting post-2FA monitor', {
          event: 'auth:post-2fa-monitor',
          tabId,
          targetAccountId,
        });
        setTimeout(() => monitorPostAuth(webview, tabId, url, credentials, targetAccountId, 0), 2000);
      } else {
        logAuthEvent('warn', '2FA fill failed', { event: 'auth:2fa-fill-failed', tabId });
      }
    } else if (pageType === 'account-select') {
      const targetAccountId = await resolveAccountId(url, tabId);
      logAuthEvent('info', 'Account selection page detected directly', {
        event: 'auth:account-select-direct',
        tabId,
        targetAccountId,
      });
      if (targetAccountId) {
        await selectAccountOnPage(webview, tabId, targetAccountId);
      } else {
        logAuthEvent('warn', 'Account selection page but no accountId from any source', {
          event: 'auth:no-account-id',
          tabId,
          url,
        });
      }
    }
  } catch (error) {
    logAuthEvent('error', 'Auto-login error', { event: 'auth:error', tabId, error: error.message });
  }
}

/**
 * Initialize LLM Badge handler
 * Shows a badge in the tab bar when LLM API calls are made
 */
function initLLMBadge() {
  const badge = document.getElementById('llm-badge');
  const badgeText = document.getElementById('llm-badge-text');
  const badgeCost = document.getElementById('llm-badge-cost');

  if (!badge) {
    console.warn('[LLM Badge] Badge element not found');
    return;
  }

  // Listen for LLM call notifications
  if (window.api && window.api.receive) {
    window.api.receive('llm:call-made', (data) => {
      console.log('[LLM Badge] Call received:', data);
      showLLMBadge(data);
    });
    console.log('[LLM Badge] Listener registered');
  }

  // Click handler to show usage details
  badge.addEventListener('click', () => {
    const cost = badgeCost.textContent;
    const text = badgeText.textContent;
    alert(`LLM Usage This Session:\n${text}\nTotal Cost: ${cost}`);
  });
}

/**
 * Show the LLM badge with animation
 */
function showLLMBadge(data) {
  const badge = document.getElementById('llm-badge');
  const badgeText = document.getElementById('llm-badge-text');
  const badgeCost = document.getElementById('llm-badge-cost');

  if (!badge) return;

  // Clear any existing timeouts
  if (llmBadgeTimeout) clearTimeout(llmBadgeTimeout);
  if (llmBadgeHideTimeout) clearTimeout(llmBadgeHideTimeout);

  // Update badge content
  const providerIcon = data.provider === 'claude' ? '🟣' : '🟢';

  badgeText.textContent = `${providerIcon} ${data.sessionTotal?.calls || 1} calls`;
  badgeCost.textContent = `$${(data.sessionTotal?.cost || data.cost || 0).toFixed(4)}`;

  // Show badge with animation
  badge.classList.add('active');
  badge.classList.add('calling');

  // Remove "calling" class after animation
  llmBadgeTimeout = setTimeout(() => {
    badge.classList.remove('calling');
  }, 2000);

  // Keep badge visible for 30 seconds after last call, then hide
  llmBadgeHideTimeout = setTimeout(() => {
    badge.classList.remove('active');
  }, 30000);
}

// Initialize when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Load preferences
  const savedPreference = localStorage.getItem('openChatLinksInNewTab');
  if (savedPreference !== null) {
    openChatLinksInNewTab = savedPreference === 'true';
    console.log('Loaded chat link preference:', openChatLinksInNewTab);
  }

  // Initialize UI elements
  const newTabButton = document.getElementById('new-tab-button');
  const backButton = document.getElementById('back-button');
  const forwardButton = document.getElementById('forward-button');
  const refreshButton = document.getElementById('refresh-button');
  // Initialize LLM Badge for API call notifications
  initLLMBadge();

  // Set up event listeners
  let menuDebounceTimer = null;
  let currentMenuRequest = null;

  newTabButton.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('Plus button clicked, requesting IDW environments');

    // Prevent rapid clicks
    if (menuDebounceTimer) {
      console.log('Debouncing rapid menu clicks');
      return;
    }

    // Check if a menu already exists and remove it
    const existingMenu = document.querySelector('.idw-menu');
    const existingOverlay = document.querySelector('.idw-menu-overlay');

    if (existingMenu || existingOverlay) {
      console.log('Closing existing menu');
      if (existingMenu) existingMenu.remove();
      if (existingOverlay) existingOverlay.remove();

      // If menu was open, debounce next click
      menuDebounceTimer = setTimeout(() => {
        menuDebounceTimer = null;
      }, 200);
      return;
    }

    // Set debounce timer
    menuDebounceTimer = setTimeout(() => {
      menuDebounceTimer = null;
    }, 100);

    // Create a transparent overlay to capture clicks
    const overlay = document.createElement('div');
    overlay.className = 'idw-menu-overlay';
    overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 999;
            background: transparent;
        `;

    // Create a menu element
    const menu = document.createElement('div');
    menu.className = 'idw-menu';

    // Get the position of the plus button
    const buttonRect = newTabButton.getBoundingClientRect();

    menu.style.cssText = `
            position: absolute;
            top: ${buttonRect.bottom + 5}px;
            left: ${buttonRect.left}px;
            background: #2a2a2a;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
            min-width: 200px;
            max-width: 300px;
            max-height: 400px;
            overflow-y: auto;
        `;

    // Show loading state initially
    menu.innerHTML = `
            <div style="padding: 16px; color: rgba(255,255,255,0.5); text-align: center;">
                <div style="display: inline-block; width: 20px; height: 20px; border: 2px solid #666; border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                <style>
                    @keyframes spin { to { transform: rotate(360deg); } }
                </style>
                <div style="margin-top: 8px;">Loading IDW environments...</div>
            </div>
        `;

    // Add menu to document immediately to show loading state
    document.body.appendChild(overlay);
    document.body.appendChild(menu);

    // Track the current request to handle cancellation
    const requestId = Date.now();
    currentMenuRequest = requestId;

    let environments = [];

    // Get currently open tab URLs and their associated IDW IDs
    const getOpenTabInfo = () => {
      const openInfo = {
        urls: new Set(),
        idwIds: new Set(),
        domains: new Set(),
      };

      tabs.forEach((tab) => {
        if (!tab.webview || !tab.webview.src) return;

        try {
          const tabUrl = new URL(tab.webview.src);
          const currentUrl = tab.currentUrl ? new URL(tab.currentUrl) : tabUrl;

          // Store the domain for this tab
          openInfo.domains.add(tabUrl.hostname);
          openInfo.domains.add(currentUrl.hostname);

          // Store full URLs
          openInfo.urls.add(tab.webview.src);
          if (tab.currentUrl) {
            openInfo.urls.add(tab.currentUrl);
          }

          // Store normalized base URLs (without query/fragment)
          const baseUrl = tabUrl.origin + tabUrl.pathname.replace(/\/$/, '');
          const currentBaseUrl = currentUrl.origin + currentUrl.pathname.replace(/\/$/, '');
          openInfo.urls.add(baseUrl);
          openInfo.urls.add(currentBaseUrl);

          // Try to extract IDW ID from the URL or tab data
          // Store it if the tab has associated IDW metadata
          if (tab.idwId) {
            openInfo.idwIds.add(tab.idwId);
          }
        } catch (e) {
          console.error('Error processing tab:', e);
        }
      });

      console.log('Open tab info:', {
        urlCount: openInfo.urls.size,
        idwCount: openInfo.idwIds.size,
        domainCount: openInfo.domains.size,
      });

      return openInfo;
    };

    const populateMenu = () => {
      // Check if this request is still current
      if (currentMenuRequest !== requestId) {
        console.log('Menu request cancelled - newer request exists');
        return;
      }

      console.log('PopulateMenu called');
      console.log('Environments:', environments);

      // Since we already added the "New Tab" option in the main handler,
      // and it was added before populateMenu is called, we don't clear it.
      // Instead, just add the IDW environments after it.

      // Get open tab info
      const openInfo = getOpenTabInfo();
      console.log('Currently open tab info:', openInfo);

      let itemsAdded = 0;

      // Use IDW Registry to get available environments (not already open)
      const filteredEnvironments = idwRegistry.getAvailableIDWs();

      console.log(`Filtered IDW environments: ${filteredEnvironments.length} out of ${environments.length}`);

      filteredEnvironments.forEach((env) => {
        const menuItem = document.createElement('div');
        menuItem.className = 'idw-menu-item';
        menuItem.style.cssText = `
                    padding: 12px 16px;
                    cursor: pointer;
                    color: #ffffff;
                    transition: background-color 0.2s;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                `;
        menuItem.innerHTML = `
                    <div class="tab-favicon default-favicon"></div>
                    <span>${env.label}</span>
                `;
        menuItem.addEventListener('click', () => {
          console.log('Opening IDW environment in new tab:', env.label);
          // Store the IDW ID in the tab for better tracking
          // Use chatUrl first (the actual chat interface), fall back to homeUrl
          const newTab = createNewTab(env.chatUrl || env.homeUrl);
          if (newTab) {
            newTab.idwId = env.id;
            newTab.idwLabel = env.label;
            // Explicitly register with IDW Registry (in case createNewTab didn't detect it)
            idwRegistry.registerTab(newTab.id, env.id, env);
            console.log(`[Menu Click] Registered tab ${newTab.id} with IDW ${env.id}`);
          }
          closeMenuAndCleanup();
        });
        menuItem.addEventListener('mouseover', () => {
          menuItem.style.backgroundColor = '#3a3a3a';
        });
        menuItem.addEventListener('mouseout', () => {
          menuItem.style.backgroundColor = 'transparent';
        });
        menu.appendChild(menuItem);
        itemsAdded++;
      });

      // If no items at all, show a message
      if (itemsAdded === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.style.cssText = `
                    padding: 16px;
                    color: rgba(255,255,255,0.5);
                    text-align: center;
                `;
        emptyMessage.textContent = 'All IDW environments are already open in tabs';
        menu.appendChild(emptyMessage);
      }

      // Add the menu to the document
      document.body.appendChild(overlay);
      document.body.appendChild(menu);

      // Helper function to close menu and cleanup
      const closeMenuAndCleanup = () => {
        currentMenuRequest = null;
        if (menu && menu.parentNode) menu.remove();
        if (overlay && overlay.parentNode) overlay.remove();
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('mousedown', closeMenuOnWebview);
      };

      // Close menu when clicking on overlay or outside menu
      const closeMenu = (e) => {
        // Don't close if it's a right-click (context menu)
        if (e.button === 2) return;

        // If clicking on overlay or outside menu (but not the menu itself or new tab button)
        if (e.target === overlay || (!menu.contains(e.target) && e.target !== newTabButton)) {
          console.log('Closing menu due to outside click');
          closeMenuAndCleanup();
        }
      };

      // Special handler for webview clicks (since they might not bubble up)
      const closeMenuOnWebview = (e) => {
        // Don't close if it's a right-click (context menu)
        if (e.button === 2) return;

        // Check if the click target is within a webview container
        const isWebviewClick = e.target.closest('.webview-container') || e.target.tagName === 'WEBVIEW';

        if (isWebviewClick) {
          console.log('Closing menu due to webview click');
          closeMenuAndCleanup();
        }
      };

      // Click on overlay should close menu
      overlay.addEventListener('click', (_e) => {
        console.log('Overlay clicked, closing menu');
        closeMenuAndCleanup();
      });

      // Add the event listeners after a brief delay to avoid immediate closure
      setTimeout(() => {
        document.addEventListener('click', closeMenu);
        // Use mousedown for webview areas as it fires before click is captured
        document.addEventListener('mousedown', closeMenuOnWebview);

        // Also listen for focus events on webviews
        const webviews = document.querySelectorAll('webview');
        webviews.forEach((webview) => {
          webview.addEventListener(
            'focus',
            () => {
              console.log('Closing menu due to webview focus');
              closeMenuAndCleanup();
            },
            { once: true }
          );
        });
      }, 0);

      // Prevent clicks inside the menu from bubbling up
      menu.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    };

    // Request IDW environments
    console.log('Requesting IDW environments...');
    window.api.getIDWEnvironments((receivedEnvironments) => {
      // Check if this request is still current
      if (currentMenuRequest !== requestId) {
        console.log('Ignoring IDW response - request was cancelled');
        return;
      }

      console.log('Received IDW environments:', receivedEnvironments);
      environments = receivedEnvironments || [];

      // Initialize IDW Registry with the environments
      if (!idwRegistry.initialized) {
        idwRegistry.initialize(environments);
        idwRegistry.restoreState();
      } else {
        // Update registry with latest environments
        idwRegistry.initialize(environments);
      }

      // Clear menu and show appropriate content
      menu.innerHTML = '';

      // Handle case where no environments are configured
      if (!environments || environments.length === 0) {
        const noEnvItem = document.createElement('div');
        noEnvItem.style.cssText = `
                    padding: 16px;
                    color: rgba(255,255,255,0.5);
                    text-align: center;
                    font-size: 12px;
                `;
        noEnvItem.textContent = 'No IDW environments configured';
        menu.appendChild(noEnvItem);

        // Add link to settings/setup
        const setupLink = document.createElement('div');
        setupLink.className = 'idw-menu-item';
        setupLink.style.cssText = `
                    padding: 12px 16px;
                    cursor: pointer;
                    color: #4CAF50;
                    transition: background-color 0.2s;
                    text-align: center;
                    font-size: 12px;
                    border-top: 1px solid rgba(255,255,255,0.1);
                `;
        setupLink.textContent = 'Configure IDW Environments';
        setupLink.addEventListener('click', () => {
          console.log('Opening IDW setup');
          window.api.send('open-setup-wizard');
          closeMenuAndCleanup();
        });
        setupLink.addEventListener('mouseover', () => {
          setupLink.style.backgroundColor = '#3a3a3a';
        });
        setupLink.addEventListener('mouseout', () => {
          setupLink.style.backgroundColor = 'transparent';
        });
        menu.appendChild(setupLink);
        return;
      }

      // Populate menu with available IDW environments
      populateMenu();
    });
  });

  backButton.addEventListener('click', () => {
    if (activeTabId) {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) {
        try {
          // Use try-catch in case canGoBack() fails
          if (tab.webview.canGoBack()) {
            console.log(`Navigating back in tab ${activeTabId}`);
            tab.webview.goBack();
          } else {
            console.log(`Cannot go back in tab ${activeTabId} - no history`);
          }
          // Force update nav state after navigation
          setTimeout(() => updateNavigationState(activeTabId), 300);
        } catch (error) {
          console.error(`Error navigating back in tab ${activeTabId}:`, error);
        }
      } else {
        console.log(`Cannot go back in tab ${activeTabId} - tab not found`);
      }
    }
  });

  forwardButton.addEventListener('click', () => {
    if (activeTabId) {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) {
        try {
          // Use try-catch in case canGoForward() fails
          if (tab.webview.canGoForward()) {
            console.log(`Navigating forward in tab ${activeTabId}`);
            tab.webview.goForward();
          } else {
            console.log(`Cannot go forward in tab ${activeTabId} - no forward history`);
          }
          // Force update nav state after navigation
          setTimeout(() => updateNavigationState(activeTabId), 300);
        } catch (error) {
          console.error(`Error navigating forward in tab ${activeTabId}:`, error);
        }
      } else {
        console.log(`Cannot go forward in tab ${activeTabId} - tab not found`);
      }
    }
  });

  refreshButton.addEventListener('click', () => {
    if (activeTabId) {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) {
        console.log(`Refreshing tab ${activeTabId}`);
        // Force reload regardless of ready state
        tab.webview.reload();
        // Force update nav state after short delay
        setTimeout(() => updateNavigationState(activeTabId), 300);
      } else {
        console.log(`Cannot refresh tab ${activeTabId} - tab not found`);
      }
    }
  });

  // Add Debug button handler
  const debugButton = document.getElementById('debug-button');
  if (debugButton) {
    debugButton.addEventListener('click', () => {
      console.log('Debug button clicked!');
      debugSessionIsolation();
    });
  } else {
    console.debug('Debug button not in DOM (hidden by design)');
  }

  // Add Black Hole Widget button handler
  const blackHoleButton = document.getElementById('black-hole-button');
  console.log('Black Hole button element:', blackHoleButton); // Debug log

  if (!blackHoleButton) {
    console.error('Black Hole button not found in DOM!');
    return;
  }

  let blackHoleTimeout = null;
  let isBlackHoleOpen = false;
  let isBlackHoleActive = false; // Track if space chooser is open

  // Function to open the Black Hole Widget
  // forPaste: if true, opens in expanded mode with space chooser ready
  const openBlackHole = (forPaste = false) => {
    if (!isBlackHoleOpen) {
      console.log('Opening Black Hole Widget, forPaste:', forPaste);
      isBlackHoleOpen = true;

      // Get button position to show black hole near it
      const buttonRect = blackHoleButton.getBoundingClientRect();
      console.log('Button rect:', buttonRect);
      console.log('Window position:', { screenX: window.screenX, screenY: window.screenY });

      // Get the title bar height (approximate - usually around 22-30px on macOS)
      // We can calculate this by comparing outer and inner height
      const titleBarHeight = window.outerHeight - window.innerHeight;
      console.log('Estimated title bar height:', titleBarHeight);

      // Calculate position to center the black hole over the button
      // The black hole widget is 150px wide/tall
      const blackHoleSize = 150;
      const position = {
        x: Math.round(window.screenX + buttonRect.left + buttonRect.width / 2 - blackHoleSize / 2),
        y: Math.round(window.screenY + titleBarHeight + buttonRect.top + buttonRect.height / 2 - blackHoleSize / 2),
      };

      console.log('Black Hole calculated position (centered on button):', position);

      // Send message to main process to open Black Hole Widget with position
      // If forPaste, open in expanded mode so space chooser shows immediately
      window.api.send('open-black-hole-widget', { ...position, startExpanded: forPaste });

      // Set timeout to close after 5 seconds (only if not active)
      blackHoleTimeout = setTimeout(() => {
        if (!isBlackHoleActive) {
          console.log('Auto-closing Black Hole Widget after 5 seconds');
          window.api.send('close-black-hole-widget');
          isBlackHoleOpen = false;
        } else {
          console.log('Black Hole Widget is active, not auto-closing');
        }
      }, 5000); // 5 seconds
    }
  };

  // NOTE: Removed mouseover handler as it blocks clicks by opening widget over the button
  // The button should only respond to clicks (for clipboard) and drags (for files)

  // Drag events - open when dragging files over the button
  blackHoleButton.addEventListener('dragenter', (e) => {
    console.log('Black Hole dragenter event triggered');
    e.preventDefault();
    openBlackHole();
  });

  blackHoleButton.addEventListener('dragover', (e) => {
    console.log('Black Hole dragover event triggered');
    e.preventDefault(); // Important: prevent default to allow drop
    openBlackHole();
  });

  // Cancel auto-close if user clicks the button or drops files
  const cancelAutoClose = () => {
    if (blackHoleTimeout) {
      console.log('Cancelling Black Hole auto-close');
      clearTimeout(blackHoleTimeout);
      blackHoleTimeout = null;
    }
  };

  blackHoleButton.addEventListener('click', () => {
    console.log('Black Hole click event triggered'); // Debug log
    cancelAutoClose();

    // Always open the clipboard viewer when clicked
    console.log('Sending request to open clipboard viewer');
    window.api.send('open-clipboard-viewer');
  });

  // Right-click on Spaces button = Paste to Black Hole
  blackHoleButton.addEventListener('contextmenu', async (e) => {
    console.log('Black Hole button right-click detected');
    e.preventDefault();
    e.stopPropagation(); // Don't show the general context menu
    cancelAutoClose();

    // If black hole is already open (from hover), close it first
    if (isBlackHoleOpen) {
      console.log('Black hole already open, closing and reopening in expanded mode for paste');
      window.api.send('close-black-hole-widget');
      isBlackHoleOpen = false;

      setTimeout(() => {
        openBlackHole(true); // Open in expanded mode
        // Wait for window to load, then trigger paste
        setTimeout(() => {
          console.log('Sending paste trigger to Black Hole widget');
          window.api.send('black-hole:trigger-paste');
        }, 500);
      }, 200);
    } else {
      console.log('Opening black hole widget for right-click paste');
      openBlackHole(true); // Open in expanded mode
      // Wait for window to load, then trigger paste
      setTimeout(() => {
        console.log('Sending paste trigger to Black Hole widget');
        window.api.send('black-hole:trigger-paste');
      }, 500);
    }
  });

  blackHoleButton.addEventListener('drop', (e) => {
    console.log('Black Hole drop event triggered');
    e.preventDefault();
    cancelAutoClose();
    // The actual drop will be handled by the Black Hole Widget itself
  });

  // Make the button focusable to receive keyboard events
  blackHoleButton.setAttribute('tabindex', '0');

  // Track if mouse is over the button
  let isMouseOverButton = false;
  let hoverTimeout = null;

  blackHoleButton.addEventListener('mouseenter', () => {
    isMouseOverButton = true;
    console.log('Mouse entered Black Hole button');

    // Start timer to open black hole after 3 seconds
    hoverTimeout = setTimeout(() => {
      if (isMouseOverButton && !isBlackHoleOpen) {
        console.log('Opening Black Hole after 3 second hover');
        openBlackHole();
      }
    }, 3000);
  });

  blackHoleButton.addEventListener('mouseleave', () => {
    isMouseOverButton = false;
    console.log('Mouse left Black Hole button');

    // Clear hover timeout
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
  });

  // Listen for paste events at the document level
  document.addEventListener('paste', async (e) => {
    // Check if the black hole widget is open or if paste is over the button
    if (isBlackHoleOpen || isMouseOverButton || document.activeElement === blackHoleButton) {
      console.log('Paste detected - Black hole open:', isBlackHoleOpen, 'Over button:', isMouseOverButton);
      e.preventDefault();
      e.stopPropagation();

      // If black hole is open but not in expanded mode, close and reopen
      if (isBlackHoleOpen) {
        console.log('Black hole already open, closing and reopening in expanded mode for paste');
        window.api.send('close-black-hole-widget');
        isBlackHoleOpen = false;

        setTimeout(() => {
          openBlackHole(true);
          setTimeout(() => {
            console.log('Sending paste trigger to Black Hole widget');
            window.api.send('black-hole:trigger-paste');
          }, 600);
        }, 200);
      } else {
        console.log('Opening black hole widget for paste');
        openBlackHole(true); // true = open expanded for paste
        // Wait a bit longer for widget to initialize
        setTimeout(() => {
          console.log('Sending paste trigger to Black Hole widget');
          window.api.send('black-hole:trigger-paste');
        }, 600);
      }
    }
  });

  // Also handle keyboard shortcut when button is focused or hovered
  document.addEventListener('keydown', (e) => {
    // Check for both Cmd and Ctrl to work on all platforms
    const isCmdOrCtrl = e.metaKey || e.ctrlKey;

    if (isCmdOrCtrl && (e.key === 'v' || e.key === 'V')) {
      // Check if black hole is open or if mouse is over button or button is focused
      if (isBlackHoleOpen || isMouseOverButton || document.activeElement === blackHoleButton) {
        console.log('Cmd/Ctrl+V detected - Black hole open:', isBlackHoleOpen);
        e.preventDefault();
        e.stopPropagation();

        if (isBlackHoleOpen) {
          // Close and reopen in expanded mode for paste
          console.log('Black hole already open, closing and reopening in expanded mode');
          window.api.send('close-black-hole-widget');
          isBlackHoleOpen = false;

          setTimeout(() => {
            openBlackHole(true);
            setTimeout(() => {
              console.log('Sending paste trigger to Black Hole widget');
              window.api.send('black-hole:trigger-paste');
            }, 600);
          }, 200);
        } else {
          // Open the black hole widget in paste mode
          console.log('Opening black hole widget for Cmd/Ctrl+V');
          openBlackHole(true); // true = open expanded for paste

          // After a short delay, trigger paste in the widget
          setTimeout(() => {
            console.log('Sending paste trigger to Black Hole widget');
            window.api.send('black-hole:trigger-paste');
          }, 600);
        }
        return; // Don't process the else block below
      } else {
        // no-op
      }
    }
  });

  // Listen for black hole closed event from main process
  window.api.receive('black-hole-closed', () => {
    console.log('Black Hole Widget closed');
    isBlackHoleOpen = false;
    isBlackHoleActive = false;
    if (blackHoleTimeout) {
      clearTimeout(blackHoleTimeout);
      blackHoleTimeout = null;
    }
  });

  // Listen for black hole active state (space chooser open)
  window.api.receive('black-hole-active', () => {
    console.log('Black Hole Widget is active (space chooser open)');
    isBlackHoleActive = true;
    // Cancel any existing auto-close timer
    cancelAutoClose();
  });

  // Listen for black hole inactive state (space chooser closed)
  window.api.receive('black-hole-inactive', () => {
    console.log('Black Hole Widget is inactive (space chooser closed)');
    isBlackHoleActive = false;
    // If black hole is still open but inactive, start auto-close timer
    if (isBlackHoleOpen) {
      blackHoleTimeout = setTimeout(() => {
        if (!isBlackHoleActive && isBlackHoleOpen) {
          console.log('Auto-closing inactive Black Hole Widget');
          window.api.send('close-black-hole-widget');
          isBlackHoleOpen = false;
        }
      }, 5000); // 5 seconds
    }
  });

  console.log('Black Hole event listeners attached successfully'); // Debug log

  // Listen for message events from webviews
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'new-window') {
      console.log('Received postMessage for new window:', event.data.url);

      // Check if it's a chat URL
      if (
        event.data.url.includes('/chat/') ||
        event.data.url.startsWith('https://flow-desc.chat.edison.onereach.ai/')
      ) {
        // First check if this URL is already open
        if (findAndFocusTab(event.data.url)) {
          console.log('Chat URL already open, focused existing tab');
          return;
        }

        if (openChatLinksInNewTab) {
          console.log('Chat URL in postMessage, creating new tab (preference):', event.data.url);
          createNewTab(event.data.url);
        } else {
          console.log('Chat URL in postMessage, navigating in current tab:', event.data.url);
          // Navigate in the current tab
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (activeTab && activeTab.webview) {
            activeTab.webview.src = event.data.url;
          }
        }
      } else {
        createNewTab(event.data.url);
      }
    } else if (event.data && event.data.type === 'request-new-tab') {
      console.log('Received postMessage for request-new-tab:', event.data.url);
      createNewTab(event.data.url);
    }
  });

  // Load saved tabs or create initial tab if none exist
  loadSavedTabs();

  // Handle messages from main process
  window.api.receive('get-tab-partitions', () => {
    const tabInfo = tabs.map((tab) => ({
      partition: tab.partition || (tab.webview && tab.webview.dataset.partition) || null,
      url: tab.currentUrl || (tab.webview && tab.webview.src) || '',
      title: tab.element ? (tab.element.querySelector('.tab-title')?.textContent || '') : '',
    }));
    window.api.send('tab-partitions-response', tabInfo);
  });

  window.api.receive('open-in-new-tab', (data) => {
    // Extract URL from data
    const url = typeof data === 'string' ? data : data && data.url ? data.url : null;

    // Check if this is a problematic site that should open in default browser
    const problematicSites = ['elevenlabs.io'];
    if (url && problematicSites.some((site) => url.includes(site))) {
      console.log(`Opening ${url} in default browser due to compatibility issues`);
      if (window.flipboardAPI && window.flipboardAPI.openExternal) {
        window.flipboardAPI.openExternal(url);
      } else {
        // Try shell.openExternal via IPC
        window.api.send('open-external', url);
      }
      return;
    }

    // Check if it's a simple URL string or an object with additional data
    if (typeof data === 'string') {
      createNewTab(data);
    } else if (data && data.url) {
      // Handle ChatGPT with enhanced permissions
      if (data.isChatGPT) {
        console.log('Creating enhanced tab for ChatGPT:', data.url);
        createChatGPTTab(data.url, data.label);
      } else if (data.isImageCreator || data.isVideoCreator) {
        // Handle image and video creators
        console.log(`Creating tab for ${data.isVideoCreator ? 'video' : 'image'} creator:`, data.url);
        createNewTab(data.url);
      } else {
        createNewTab(data.url);
      }
    }
  });

  // Handle chat URLs specifically
  window.api.receive('handle-chat-url', (url) => {
    console.log('Renderer received handle-chat-url message for URL:', url);

    // First check if this URL is already open
    if (findAndFocusTab(url)) {
      console.log('Chat URL already open, focused existing tab');
      return;
    }

    if (openChatLinksInNewTab) {
      console.log('Creating new tab for chat URL (preference):', url);
      createNewTab(url);
    } else {
      console.log('Navigating to chat URL in current tab:', url);
      // Navigate in the current tab
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab && activeTab.webview) {
        activeTab.webview.src = url;
      } else {
        console.error('No active tab found to navigate');
      }
    }
  });

  // Listen for app-before-quit event to save tab state
  window.api.receive('save-tabs-state', () => {
    console.log('Saving tab state before app quit');
    saveTabState();
  });

  // Backup: Also save tabs on beforeunload in case IPC message doesn't arrive
  window.addEventListener('beforeunload', () => {
    console.log('Window beforeunload - saving tab state');
    saveTabState();
  });

  // Listen for auth URL handling
  window.api.receive('handle-auth-url', (url) => {
    console.log('Received auth URL to handle:', url);

    // Get the current active tab
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab) {
      console.error('No active tab found to handle auth URL');
      return;
    }

    // Get the webview in the active tab
    const webview = activeTab.querySelector('webview');
    if (!webview) {
      console.error('No webview found in active tab');
      return;
    }

    // Load the auth URL in the current webview
    console.log('Loading auth URL in current webview:', url);
    webview.loadURL(url);
  });

  // Custom context menu implementation
  const customContextMenu = document.getElementById('custom-context-menu');
  const pasteToBlackHoleItem = document.getElementById('paste-to-black-hole');

  // Smart positioning function to prevent menu from being cut off
  function positionContextMenu(menu, x, y) {
    const padding = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Show off-screen to measure
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    menu.style.display = 'block';

    // Get menu dimensions
    const rect = menu.getBoundingClientRect();
    const mw = rect.width;
    const mh = rect.height;

    // Calculate available space
    const spaceRight = vw - x - padding;
    const spaceLeft = x - padding;
    const spaceBelow = vh - y - padding;
    const spaceAbove = y - padding;

    let finalX, finalY;

    // Horizontal: prefer right, flip to left if needed
    if (mw <= spaceRight) {
      finalX = x;
    } else if (mw <= spaceLeft) {
      finalX = x - mw;
    } else {
      // Not enough space either side - fit to widest side
      finalX = spaceRight >= spaceLeft ? vw - mw - padding : padding;
    }

    // Vertical: prefer below, flip above if needed
    if (mh <= spaceBelow) {
      finalY = y;
    } else if (mh <= spaceAbove) {
      finalY = y - mh;
    } else {
      // Menu taller than available space - position at top with padding
      finalY = padding;
    }

    // Clamp to viewport bounds
    finalX = Math.max(padding, Math.min(finalX, vw - mw - padding));
    finalY = Math.max(padding, Math.min(finalY, vh - mh - padding));

    // Apply position
    menu.style.left = `${Math.round(finalX)}px`;
    menu.style.top = `${Math.round(finalY)}px`;
  }

  // Handle right-click to show custom context menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();

    // Don't show on tabs
    if (e.target.closest('.tab')) {
      return;
    }

    console.log('Showing custom context menu at:', e.clientX, e.clientY);

    // Position menu smartly to avoid cut-off
    positionContextMenu(customContextMenu, e.clientX, e.clientY);
  });

  // Hide context menu on click elsewhere
  document.addEventListener('click', (e) => {
    if (!customContextMenu.contains(e.target)) {
      customContextMenu.style.display = 'none';
    }
  });

  // Handle paste to black hole click
  pasteToBlackHoleItem.addEventListener('click', () => {
    console.log('Paste to Black Hole clicked from custom menu');
    customContextMenu.style.display = 'none';

    // If black hole is already open (from hover), close it first and reopen in expanded mode
    if (isBlackHoleOpen) {
      console.log('Black hole already open, closing and reopening in expanded mode');
      window.api.send('close-black-hole-widget');
      isBlackHoleOpen = false;

      // Small delay to let it close
      setTimeout(() => {
        console.log('Opening black hole widget for context menu paste (expanded)');
        openBlackHole(true); // true = open expanded for paste

        // Wait for widget to initialize, then trigger paste
        setTimeout(() => {
          console.log('Sending paste trigger to Black Hole widget');
          window.api.send('black-hole:trigger-paste');
        }, 600);
      }, 200);
    } else {
      console.log('Opening black hole widget for context menu paste');
      openBlackHole(true); // true = open expanded for paste

      // Wait for widget to initialize, then trigger paste
      setTimeout(() => {
        console.log('Sending paste trigger to Black Hole widget');
        window.api.send('black-hole:trigger-paste');
      }, 600);
    }
  });
});

// Load tabs from localStorage
function loadSavedTabs() {
  try {
    const savedTabsJSON = localStorage.getItem('savedTabs');
    if (savedTabsJSON) {
      const savedTabs = JSON.parse(savedTabsJSON);
      console.log('Restoring saved tabs:', savedTabs);

      if (savedTabs.tabs && savedTabs.tabs.length > 0) {
        // Filter out invalid tabs (empty or missing URLs)
        const validTabs = savedTabs.tabs.filter((tabData, index) => {
          const hasValidUrl = tabData.url && tabData.url.trim() !== '' && tabData.url.startsWith('http');
          if (!hasValidUrl) {
            console.warn(`Skipping invalid tab ${index}: URL="${tabData.url}"`);
          }
          return hasValidUrl;
        });

        if (validTabs.length > 0) {
          // Create each valid saved tab
          validTabs.forEach((tabData, index) => {
            console.log(`Restoring tab ${index}: URL=${tabData.url}, Partition=${tabData.partition}`);
            // Create the tab with the saved URL and partition
            createNewTabWithPartition(tabData.url, tabData.partition);
          });

          // Activate the previously active tab (adjusted for filtered tabs)
          const adjustedIndex = Math.min(savedTabs.activeTabIndex, tabs.length - 1);
          if (adjustedIndex >= 0 && adjustedIndex < tabs.length) {
            activateTab(tabs[adjustedIndex].id);
          }

          return;
        }
      }
    }
  } catch (error) {
    console.error('Error loading saved tabs:', error);
  }

  // If no valid tabs were loaded or there was an error, create a default tab
  createNewTab('https://my.onereach.ai/');
}

// Save current tab state to localStorage
function saveTabState() {
  try {
    const tabsToSave = tabs.map((tab) => {
      // Use tab.currentUrl instead of tab.webview.src because webview.src may not
      // be set yet during async token injection for OneReach environments.
      // tab.currentUrl is set at creation time and updated on navigation events.
      const url = tab.currentUrl || tab.webview.src || 'https://my.onereach.ai/';
      return {
        url: url,
        title: tab.element.querySelector('.tab-title').textContent,
        partition: tab.partition || tab.webview.dataset.partition,
      };
    });

    const activeTabIndex = tabs.findIndex((tab) => tab.id === activeTabId);

    const tabState = {
      tabs: tabsToSave,
      activeTabIndex: activeTabIndex,
    };

    localStorage.setItem('savedTabs', JSON.stringify(tabState));
    console.log('Tab state saved:', tabState);
  } catch (error) {
    console.error('Error saving tab state:', error);
  }
}

// Get the favicon URL for a website
function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.origin}/favicon.ico`;
  } catch (error) {
    console.error('Error generating favicon URL:', error);
    return null;
  }
}

// Update a tab's favicon
function updateTabFavicon(tabId, url) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const faviconElement = tab.element.querySelector('.tab-favicon');
  if (!faviconElement) return;

  const faviconUrl = getFaviconUrl(url);
  if (!faviconUrl) {
    // Set default favicon if we couldn't generate a valid URL
    faviconElement.style.backgroundImage = '';
    faviconElement.classList.add('default-favicon');
    return;
  }

  // Create a new image to test if the favicon exists
  const img = new Image();
  img.onload = () => {
    faviconElement.style.backgroundImage = `url(${faviconUrl})`;
    faviconElement.classList.remove('default-favicon');
  };
  img.onerror = () => {
    // If favicon.ico doesn't exist, try the Google favicon service
    const googleFaviconUrl = `https://www.google.com/s2/favicons?domain=${url}`;
    faviconElement.style.backgroundImage = `url(${googleFaviconUrl})`;
    faviconElement.classList.remove('default-favicon');
  };
  img.src = faviconUrl;
}

/**
 * Extract OneReach environment from URL
 * @param {string} url - URL to extract environment from
 * @returns {string|null} Environment name or null if not OneReach
 */
function extractEnvironmentFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname.includes('edison')) return 'edison';
    if (hostname.includes('staging')) return 'staging';
    if (hostname.includes('dev.')) return 'dev';

    // Default to production for onereach.ai domains
    if (hostname.includes('onereach.ai')) return 'production';

    return null; // Not a OneReach URL
  } catch {
    return null;
  }
}

// Create a new tab with the given URL and partition
function createNewTabWithPartition(url = 'https://my.onereach.ai/', partition = null) {
  // Close any open IDW menu as available environments will change
  const existingMenu = document.querySelector('.idw-menu');
  const existingOverlay = document.querySelector('.idw-menu-overlay');
  if (existingMenu) existingMenu.remove();
  if (existingOverlay) existingOverlay.remove();

  // Check if this is a problematic site that should open in default browser
  const problematicSites = ['elevenlabs.io'];
  const shouldOpenExternal = problematicSites.some((site) => url.includes(site));

  if (shouldOpenExternal) {
    console.log(`Opening ${url} in default browser due to compatibility issues`);
    // Use the flipboard API to open in default browser
    if (window.flipboardAPI && window.flipboardAPI.openExternal) {
      window.flipboardAPI.openExternal(url);
    } else {
      // Fallback: send IPC message
      console.log('Falling back to IPC message for external URL');
      window.api.send('open-in-new-tab', { url: url, external: true });
    }
    return null;
  }

  // Create a unique ID for this tab
  const tabId = `tab-${tabCounter++}`;

  // Create the tab UI element
  const tabElement = document.createElement('div');
  tabElement.className = 'tab';
  tabElement.dataset.tabId = tabId;
  tabElement.innerHTML = `
        <div class="tab-favicon default-favicon"></div>
        <div class="tab-title">New Tab</div>
        <div class="tab-close" data-tab-id="${tabId}">×</div>
    `;

  // Create the webview container
  const webviewContainer = document.createElement('div');
  webviewContainer.className = 'webview-container';
  webviewContainer.dataset.tabId = tabId;

  // Use the provided partition or create a new unique one for complete isolation
  const partitionName = partition || `persist:tab-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

  // Detect OneReach environment for multi-tenant token handling
  const environment = extractEnvironmentFromUrl(url);

  console.log(`Creating webview for tab ${tabId} with partition: ${partitionName} for URL: ${url}`);

  // Create the webview element
  const webview = document.createElement('webview');
  webview.dataset.tabId = tabId;
  webview.setAttribute('allowpopups', 'true');
  // Turn off security features to allow all popups and links
  webview.setAttribute(
    'webpreferences',
    'contextIsolation=yes, nativeWindowOpen=true, enableBlinkFeatures=MediaStreamAPI,WebRTC,AudioWorklet,WebAudio,MediaRecorder, allowPopups=true, javascript=true'
  );
  // Security: Default to secure settings
  // webview.setAttribute('disablewebsecurity', 'true');
  // webview.setAttribute('allowrunninginsecurecontent', 'true');
  // Set partition as both attribute and property for proper isolation
  webview.setAttribute('partition', partitionName);
  webview.partition = partitionName; // Also set as property

  // Multi-tenant token injection - MUST complete before navigation starts
  // Use a flag to track when webview should load
  let tokenInjectionComplete = false;
  let pendingUrl = url;

  // Function to actually load the URL after token injection
  const loadUrlWhenReady = () => {
    if (!tokenInjectionComplete) return;
    console.log(`[Tab] Token injection complete, loading URL: ${pendingUrl}`);
    webview.src = pendingUrl;
  };

  if (environment) {
    (async () => {
      let authStatus = { hasToken: false, injected: false, error: null };
      try {
        const hasToken = await window.api.invoke('multi-tenant:has-token', environment);
        authStatus.hasToken = hasToken;
        console.log(`[Tab] Token check for ${environment}: hasToken=${hasToken}`);

        if (hasToken) {
          console.log(`[Tab] Injecting ${environment} multi-tenant token into ${partitionName}`);
          const result = await window.api.invoke('multi-tenant:inject-token', {
            environment,
            partition: partitionName,
          });

          if (result.success) {
            authStatus.injected = true;
            // Pre-register partition for refresh propagation
            await window.api.invoke('multi-tenant:register-partition', {
              environment,
              partition: partitionName,
            });
            console.log(`[Tab] Successfully injected and registered ${environment} token`);
          } else {
            authStatus.error = result.error;
            console.warn(`[Tab] Token injection failed: ${result.error}`);
          }
        } else {
          console.log(`[Tab] No ${environment} token available, user will need to login`);
        }
      } catch (err) {
        authStatus.error = err.message;
        console.error('[Tab] Error during token injection:', err);
        // Continue anyway - user can still login manually
      } finally {
        // Always mark injection as complete and load URL
        tokenInjectionComplete = true;
        loadUrlWhenReady();

        // Show auth status notification in the webview once it loads
        // Only show banner for success or injection failure, not for missing tokens
        // (the login page itself tells the user they need to log in)
        if (authStatus.injected || authStatus.hasToken) {
          webview.addEventListener(
            'did-finish-load',
            () => {
              const statusColor = authStatus.injected ? '#22c55e' : '#f59e0b';
              const statusText = authStatus.injected
                ? `Authenticated (${environment})`
                : `Token exists but injection failed: ${authStatus.error}`;

              webview
                .executeJavaScript(
                  `
                            (function() {
                                const existing = document.getElementById('gsx-auth-status');
                                if (existing) existing.remove();
                                
                                const status = document.createElement('div');
                                status.id = 'gsx-auth-status';
                                status.style.cssText = 'position:fixed;bottom:10px;right:10px;padding:8px 16px;background:${statusColor};color:white;border-radius:6px;font-family:system-ui;font-size:12px;z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,0.2);cursor:pointer;transition:opacity 0.3s;';
                                status.textContent = '${statusText}';
                                status.onclick = function() { this.style.opacity = '0'; setTimeout(() => this.remove(), 300); };
                                document.body.appendChild(status);
                                
                                setTimeout(() => {
                                    if (status.parentNode) {
                                        status.style.opacity = '0';
                                        setTimeout(() => status.remove(), 300);
                                    }
                                }, 8000);
                                
                                console.log('[GSX Auth] ${statusText}');
                            })();
                        `
                )
                .catch((err) => console.warn('[browser-renderer] inject GSX auth status:', err.message));
            },
            { once: true }
          );
        } else {
          console.log(`[Tab] No token for ${environment} - user will see login page`);
        }
      }
    })();
  } else {
    // No environment detected, load URL immediately
    tokenInjectionComplete = true;
    webview.src = url;
  }

  // Add preload script for IDW sites to handle authentication
  if (url && (url.includes('onereach.ai') || url.includes('edison.onereach.ai'))) {
    // The preload script path needs to be a file:// URL in the renderer
    webview.setAttribute(
      'preload',
      'file://' + window.location.pathname.replace('tabbed-browser.html', 'preload-minimal.js')
    );

    // For OneReach sites, don't disable web security as it can break authentication
    // webview.removeAttribute('disablewebsecurity');
    // webview.removeAttribute('allowrunninginsecurecontent');
  }

  // Add permissions for media access (microphone for voice mode)
  webview.setAttribute('nodeintegration', 'false');
  webview.setAttribute('plugins', 'true');
  webview.setAttribute('allowfullscreen', 'true');

  // Enable getUserMedia for microphone access
  webview.setAttribute('webrtc', 'true');
  webview.setAttribute('autoplay', 'true');
  webview.setAttribute('experimentalfeatures', 'true');
  webview.setAttribute('enableremotemodule', 'false');

  // Set a Chrome-like user agent for all tabs
  const chromeVersion = '120.0.0.0';
  webview.setAttribute(
    'useragent',
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  );

  // Store the partition name in the dataset for future reference
  webview.dataset.partition = partitionName;

  // Verify partition is set
  console.log(`Webview ${tabId} partition attribute: ${webview.getAttribute('partition')}`);
  console.log(`Webview ${tabId} dataset.partition: ${webview.dataset.partition}`);

  // Handle permission requests (for microphone access in voice mode)
  webview.addEventListener('permission-request', (e) => {
    console.log(`Permission request in webview ${tabId}:`, e.permission);

    // Allow media and other important permissions
    if (
      e.permission === 'media' ||
      e.permission === 'audioCapture' ||
      e.permission === 'microphone' ||
      e.permission === 'camera' ||
      e.permission === 'notifications' ||
      e.permission === 'clipboard-read' ||
      e.permission === 'clipboard-write'
    ) {
      console.log(`Allowing ${e.permission} permission for webview ${tabId}`);
      e.request.allow();
    } else {
      console.log(`Denying ${e.permission} permission for webview ${tabId}`);
      e.request.deny();
    }
  });

  // ========================================
  // Drag and Drop Forwarding for Webviews
  // Electron webviews don't natively forward drag/drop events to content
  // This implementation forwards files and URLs to the webview content
  // ========================================

  // Prevent default drag behavior and show copy cursor
  webview.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  webview.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  webview.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // Handle file and URL drops - forward to webview content
  webview.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    console.log(`Drop event on webview ${tabId}`, e.dataTransfer);

    // Get drop coordinates relative to the webview
    const rect = webview.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Handle file drops
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      console.log(`Forwarding ${files.length} file(s) to webview content`);

      // Convert files to transferable format (can't send File objects directly)
      const fileData = files.map((file) => ({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        path: file.path, // Electron provides the full file path
        lastModified: file.lastModified,
      }));

      // Forward file data to webview content via postMessage
      try {
        await webview.executeJavaScript(`
                    (function() {
                        const fileData = ${JSON.stringify(fileData)};
                        const dropX = ${clientX};
                        const dropY = ${clientY};
                        
                        // Dispatch custom event for apps that listen for it
                        const customEvent = new CustomEvent('electron-file-drop', {
                            detail: { files: fileData, clientX: dropX, clientY: dropY },
                            bubbles: true,
                            cancelable: true
                        });
                        
                        // Find element at drop point and dispatch event
                        const targetElement = document.elementFromPoint(dropX, dropY) || document.body;
                        targetElement.dispatchEvent(customEvent);
                        
                        // Also post message for apps using message listeners
                        window.postMessage({
                            type: 'electron-file-drop',
                            files: fileData,
                            clientX: dropX,
                            clientY: dropY
                        }, '*');
                        
                        console.log('[Electron] File drop forwarded:', fileData.map(f => f.name));
                    })();
                `);
      } catch (err) {
        console.error(`Error forwarding file drop to webview ${tabId}:`, err);
      }
    }

    // Handle URL drops (links dragged from other apps/browsers)
    const urlData = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';

    if (urlData && (urlData.startsWith('http://') || urlData.startsWith('https://'))) {
      console.log(`Forwarding URL drop to webview content: ${urlData}`);

      try {
        await webview.executeJavaScript(`
                    (function() {
                        const url = ${JSON.stringify(urlData)};
                        const dropX = ${clientX};
                        const dropY = ${clientY};
                        
                        // Dispatch custom event for URL drops
                        const customEvent = new CustomEvent('electron-url-drop', {
                            detail: { url: url, clientX: dropX, clientY: dropY },
                            bubbles: true,
                            cancelable: true
                        });
                        
                        const targetElement = document.elementFromPoint(dropX, dropY) || document.body;
                        targetElement.dispatchEvent(customEvent);
                        
                        // Also post message
                        window.postMessage({
                            type: 'electron-url-drop',
                            url: url,
                            clientX: dropX,
                            clientY: dropY
                        }, '*');
                        
                        console.log('[Electron] URL drop forwarded:', url);
                    })();
                `);
      } catch (err) {
        console.error(`Error forwarding URL drop to webview ${tabId}:`, err);
      }
    }
  });

  // Add the elements to the DOM
  webviewContainer.appendChild(webview);
  document.getElementById('browser-container').appendChild(webviewContainer);

  // Insert the tab before the new tab button
  const tabBar = document.querySelector('.tab-bar');
  tabBar.insertBefore(tabElement, document.getElementById('new-tab-button'));

  // Set up event listeners for the tab
  tabElement.addEventListener('click', (e) => {
    if (!e.target.classList.contains('tab-close')) {
      activateTab(tabId);
    }
  });

  // Add right-click context menu for tabs
  tabElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();

    // Create context menu
    const existingMenu = document.querySelector('.tab-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    menu.style.cssText = `
            position: fixed;
            left: ${e.clientX}px;
            top: ${e.clientY}px;
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 4px;
            padding: 4px 0;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;

    const menuItems = [
      { label: 'Reload Tab', action: () => webview.reload() },
      {
        label: 'Clear Session Data',
        action: () => {
          webview
            .executeJavaScript(
              `
                    localStorage.clear();
                    sessionStorage.clear();
                    document.cookie.split(";").forEach(function(c) { 
                        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
                    });
                    location.reload();
                `
            )
            .then(() => {
              console.log(`Cleared session data for tab ${tabId}`);
            })
            .catch((err) => console.error('Error clearing session data:', err));
        },
      },
      {
        label: 'Check Authentication',
        action: () => {
          // Manually trigger the authentication check
          checkTabAuthentication(tabId, webview);
        },
      },
      {
        label: 'Inspect Session',
        action: () => {
          tab.checkSession();
        },
      },
      { label: '─────────', action: null }, // Separator
      {
        label: (openChatLinksInNewTab ? '✓ ' : '') + 'Chat Links Open in New Tab',
        action: () => {
          openChatLinksInNewTab = !openChatLinksInNewTab;
          console.log('Chat links will now open in', openChatLinksInNewTab ? 'new tabs' : 'current tab');
          // Save preference
          localStorage.setItem('openChatLinksInNewTab', openChatLinksInNewTab);
          menu.remove();
        },
      },
    ];

    menuItems.forEach((item) => {
      const menuItem = document.createElement('div');

      // Check if it's a separator
      if (item.action === null) {
        menuItem.style.cssText = `
                    height: 1px;
                    background: rgba(255,255,255,0.2);
                    margin: 4px 8px;
                `;
      } else {
        menuItem.textContent = item.label;
        menuItem.style.cssText = `
                    padding: 8px 16px;
                    cursor: pointer;
                    color: white;
                    font-size: 14px;
                `;
        menuItem.onmouseover = () => (menuItem.style.background = '#444');
        menuItem.onmouseout = () => (menuItem.style.background = 'transparent');
        menuItem.onclick = () => {
          item.action();
          if (item.label !== (openChatLinksInNewTab ? '✓ ' : '') + 'Chat Links Open in New Tab') {
            menu.remove();
          }
        };
      }

      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // Remove menu when clicking elsewhere
    const removeMenu = (e) => {
      // Don't remove if it's a right-click context menu
      if (e.button === 2) return;

      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', removeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', removeMenu), 0);
  });

  tabElement.querySelector('.tab-close').addEventListener('click', () => {
    closeTab(tabId);
  });

  // Flag to track if webview is ready
  let webviewReady = false;
  let loadingTimeout = null;
  let isInitialLoad = true;

  // Set up webview event listeners
  webview.addEventListener('dom-ready', () => {
    console.log(`Webview ${tabId} dom-ready event fired (initial load: ${isInitialLoad})`);
    console.log(
      `Webview ${tabId} partition in dom-ready: ${webview.partition} (getAttribute: ${webview.getAttribute('partition')})`
    );
    webviewReady = true;
    clearTimeout(loadingTimeout);

    // Attach multi-tenant cookie listener for this partition
    if (environment) {
      window.api
        .invoke('multi-tenant:attach-listener', { partition: partitionName })
        .then(() => console.log(`[Tab] Cookie listener attached for ${tabId}`))
        .catch((err) => console.warn(`[Tab] Failed to attach cookie listener:`, err));

      // NOTE: localStorage injection DISABLED
      // The 'or' cookie/localStorage data is account-specific and doesn't help with SSO.
      // The 'mult' cookie (injected before webview.src is set) is sufficient to enable SSO.
    }

    // Get the webContents ID and use it to access the webContents directly
    const webContentsId = webview.getWebContentsId();
    console.log(`Webview ${tabId} webContentsId:`, webContentsId);

    // Log the actual partition being used
    console.log(`Webview ${tabId} actual partition property:`, webview.partition);

    // Send a message to the main process to set up window open handlers
    window.api.send('setup-webcontents-handlers', {
      webContentsId: webContentsId,
      tabId: tabId,
    });

    // Inject link click handler to debug and control navigation
    webview
      .executeJavaScript(
        `
            (function() {
                console.log('Injecting link click handler for debugging');
                
                // Get the current preference value
                const openChatLinksInNewTab = ${openChatLinksInNewTab};
                console.log('Chat links preference:', openChatLinksInNewTab ? 'new tabs' : 'current tab');
                
                // Debug: Log all links on the page
                setTimeout(() => {
                    const allLinks = document.querySelectorAll('a[href]');
                    console.log('=== All links on page ===');
                    allLinks.forEach((link, index) => {
                        console.log(\`Link \${index}: \${link.href} (text: "\${link.textContent.trim()}")\`);
                    });
                    console.log('=== End links ===');
                    
                    // Also check for any data attributes or onclick handlers
                    const linksWithHandlers = document.querySelectorAll('a[onclick], [data-href], [data-url]');
                    if (linksWithHandlers.length > 0) {
                        console.log('=== Links with handlers or data attributes ===');
                        linksWithHandlers.forEach((link, index) => {
                            console.log(\`Special link \${index}:\`, {
                                href: link.href,
                                onclick: link.onclick ? link.onclick.toString() : null,
                                dataHref: link.dataset.href,
                                dataUrl: link.dataset.url,
                                text: link.textContent.trim()
                            });
                        });
                    }
                }, 2000); // Wait for page to fully load
                
                // Track all clicks on links
            document.addEventListener('click', function(e) {
                let target = e.target;
                while (target && target.tagName !== 'A') {
                    target = target.parentElement;
                }
                
                if (target && target.tagName === 'A' && target.href) {
                        console.log('Link clicked:', {
                            href: target.href,
                            target: target.target,
                            text: target.textContent,
                            isDefaultPrevented: e.defaultPrevented
                        });
                        
                        // If it's a chat link and doesn't have target="_blank", let it navigate in current tab
                        if (!target.target || target.target === '_self') {
                            console.log('Link should navigate in current tab');
                            // Don't prevent default - let normal navigation happen
                        }
                    }
                }, true); // Use capture phase to see all clicks
                
                // Also monitor window.open calls
                const originalOpen = window.open;
                window.open = function(url, target, features) {
                    console.log('window.open called:', {
                        url: url,
                        target: target,
                        features: features,
                        caller: new Error().stack // Show where it was called from
                    });
                    
                    // Log any OneReach-specific variables that might affect URL selection
                    console.log('OneReach context at window.open:', {
                        currentUser: window.currentUser || 'none',
                        userProfile: window.userProfile || 'none',
                        idwConfig: window.idwConfig || 'none',
                        localStorage_idw: localStorage.getItem('selectedIdw') || localStorage.getItem('currentIdw') || 'none'
                    });
                    
                    // Check if it's a chat URL and we should navigate in current tab
                    if (url && (url.includes('/chat/') || 
                               url.startsWith('https://flow-desc.chat.edison.onereach.ai/') ||
                               url.includes('chat.') && url.includes('.onereach.ai'))) {
                        
                        // Check if we should open in current tab (preference is false)
                        if (!openChatLinksInNewTab) {
                            console.log('Chat URL in window.open, navigating in current tab instead');
                            window.location.href = url;
                            return null; // Return null to indicate no window was opened
                        }
                    }
                    
                    // Otherwise, use the original window.open
                    return originalOpen.call(window, url, target, features);
                };
                
                // Monitor location changes
                const originalPushState = history.pushState;
                history.pushState = function() {
                    console.log('history.pushState called:', arguments);
                    return originalPushState.apply(history, arguments);
                };
                
                const originalReplaceState = history.replaceState;
                history.replaceState = function() {
                    console.log('history.replaceState called:', arguments);
                    return originalReplaceState.apply(history, arguments);
                };
                
                console.log('Link click debugging enabled');
            })();
        `
      )
      .catch((err) => {
        console.error(`Error injecting link handler into webview ${tabId}:`, err);
      });

    // Update navigation button states if this is the active tab
    if (tabId === activeTabId) {
      updateNavigationState(tabId);
    }

    // Update favicon
    updateTabFavicon(tabId, webview.src);

    // Save tab state when page is fully loaded
    saveTabState();
  });

  // Add error handling for failed loads
  webview.addEventListener('did-fail-load', (e) => {
    console.error(`Webview ${tabId} failed to load:`, e.errorCode, e.errorDescription);
    webviewReady = false;
    clearTimeout(loadingTimeout);
    isInitialLoad = false;

    // Update the tab title to show error
    const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
    if (tabElement) {
      const titleElement = tabElement.querySelector('.tab-title');
      if (titleElement) {
        titleElement.textContent = 'Failed to load page';
      }
    }
  });

  // Add loading state management
  webview.addEventListener('did-start-loading', () => {
    console.log(`Webview ${tabId} started loading (initial load: ${isInitialLoad})`);
    webviewReady = false;

    // Clear any existing timeout
    clearTimeout(loadingTimeout);

    // Set new timeout for loading
    loadingTimeout = setTimeout(() => {
      if (!webviewReady) {
        console.warn(`Webview ${tabId} loading timeout`);
      }
    }, 30000); // 30 second timeout
  });

  // Handle page load completion
  webview.addEventListener('did-finish-load', () => {
    console.log(`Webview ${tabId} finished loading (initial load: ${isInitialLoad})`);
    webviewReady = true;
    clearTimeout(loadingTimeout);

    // Inject Spaces upload enhancer (if enabled)
    injectSpacesUploadEnhancer(webview);

    // Inject WebMCP bridge to detect tool registrations on the page
    injectWebMCPBridge(webview, tabId);

    // Update tab title with actual page title
    webview
      .executeJavaScript('document.title')
      .then((title) => {
        const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
        if (tabElement) {
          const titleElement = tabElement.querySelector('.tab-title');
          if (titleElement) {
            titleElement.textContent = title || 'New Tab';
          }
        }
      })
      .catch((err) => console.error('Error getting page title:', err));

    // Update navigation state
    if (tabId === activeTabId) {
      updateNavigationState(tabId);
    }

    // Auto-login for OneReach auth pages only (with retry for async-loaded forms)
    const currentUrl = webview.getURL();
    console.log(`[AutoLogin] Webview loaded: ${currentUrl} (tab: ${tabId})`);
    if (currentUrl && isAuthPage(currentUrl)) {
      // Fallback: For server-side redirects (HTTP 302), the did-navigate handler
      // may not have captured the original URL because tab.currentUrl was already
      // the auth URL. Use the tab's creation-time URL (from webview.src attribute
      // or tab object) as a fallback source for the original destination.
      if (!autoLoginState.has(tabId)) {
        autoLoginState.set(tabId, {});
      }
      const loginState = autoLoginState.get(tabId);
      if (!loginState.originalDestinationUrl) {
        const tab = tabs.find((t) => t.id === tabId);
        // tab.currentUrl was set to the creation URL and may have been
        // overwritten by did-navigate; try webview's initial src attribute
        const creationUrl = webview.getAttribute('src');
        if (creationUrl && !isAuthPage(creationUrl)) {
          loginState.originalDestinationUrl = creationUrl;
          console.log(`[AutoLogin] Captured creation URL for ${tabId}: ${creationUrl}`);
        } else if (tab && tab.currentUrl && !isAuthPage(tab.currentUrl)) {
          loginState.originalDestinationUrl = tab.currentUrl;
          console.log(`[AutoLogin] Captured tab.currentUrl for ${tabId}: ${tab.currentUrl}`);
        }
      }

      // Check if we should attempt login (debounce)
      if (!shouldAttemptAutoLogin(tabId, currentUrl)) {
        logAuthEvent('info', 'Auth page load skipped (debounce)', {
          event: 'auth:trigger-skip',
          tabId,
          url: currentUrl,
          trigger: 'dom-ready',
        });
      } else {
        logAuthEvent('info', 'Auth page detected, queueing login', {
          event: 'auth:trigger',
          tabId,
          url: currentUrl,
          trigger: 'dom-ready',
        });
        // Queue login with global rate limiting (one per tab)
        queueGlobalLogin(
          tabId,
          async () => {
            // Re-check state before executing (may have changed while in queue)
            if (!shouldAttemptAutoLogin(tabId, currentUrl)) {
              console.log(`[AutoLogin] Skipping ${tabId} - state changed while in queue`);
              return;
            }
            await new Promise((r) => {
              setTimeout(r, 500);
            }); // Wait for form
            attemptAutoLoginWithRetry(webview, currentUrl, tabId, 0);
          },
          webview
        );
      }
    }

    // Mark initial load as complete
    isInitialLoad = false;
  });

  // Handle page load stop
  webview.addEventListener('did-stop-loading', () => {
    console.log(`Webview ${tabId} stopped loading (initial load: ${isInitialLoad})`);
    clearTimeout(loadingTimeout);

    // Update navigation state whenever loading stops
    if (tabId === activeTabId) {
      updateNavigationState(tabId);
    }
  });

  // Handle page title updates
  webview.addEventListener('page-title-updated', (e) => {
    console.log(`Webview ${tabId} title updated: ${e.title} (initial load: ${isInitialLoad})`);
    const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
    if (tabElement) {
      const titleElement = tabElement.querySelector('.tab-title');
      if (titleElement) {
        titleElement.textContent = e.title;
      }
    }
  });

  webview.addEventListener('did-navigate', (e) => {
    console.log(`Webview ${tabId} did-navigate to: ${e.url}`);

    // WebMCP: clear tools from previous page, re-inject bridge on new page
    if (webmcpTabTools.has(tabId) && webmcpTabTools.get(tabId).size > 0) {
      webmcpTabTools.get(tabId).clear();
      updateWebMCPBadge(tabId);
      if (window.api?.invoke) {
        window.api.invoke('webmcp:tab-navigated', { tabId, origin: e.url });
      }
    }

    // SSO Diagnostic: Log when auth pages are accessed
    if (e.url.includes('auth.') && e.url.includes('onereach.ai')) {
      console.log(`[SSO Diagnostic] Auth page accessed in ${tabId}: ${e.url}`);
      // Check if this partition has the mult cookie
      const partition = webview.partition || webview.getAttribute('partition');
      if (partition && window.api) {
        window.api
          .invoke('multi-tenant:get-cookies', { partition, name: 'mult' })
          .then((cookies) => {
            console.log(
              `[SSO Diagnostic] mult cookies in ${partition}:`,
              cookies?.map((c) => ({
                domain: c.domain,
                path: c.path,
                sameSite: c.sameSite,
              })) || 'none'
            );
          })
          .catch((err) => console.log(`[SSO Diagnostic] Could not check cookies: ${err.message}`));
      }
    }

    // Update the tab's current URL
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      // Capture pre-redirect URL before overwriting tab.currentUrl.
      // When an auth redirect happens, the previous URL (the GSX tool URL)
      // contains the accountId we need for account selection after login.
      if (isAuthPage(e.url) && tab.currentUrl && !isAuthPage(tab.currentUrl)) {
        if (!autoLoginState.has(tabId)) {
          autoLoginState.set(tabId, {});
        }
        autoLoginState.get(tabId).originalDestinationUrl = tab.currentUrl;
        console.log(`[AutoLogin] Captured pre-redirect URL for ${tabId}: ${tab.currentUrl}`);
      }

      tab.currentUrl = e.url;
      console.log(`Updated tab ${tabId} currentUrl to: ${e.url}`);

      // Update IDW Registry with the new URL
      const idwChanged = idwRegistry.updateTabURL(tabId, e.url);
      if (idwChanged) {
        // Update tab metadata if IDW changed
        tab.idwId = idwChanged.id;
        tab.idwLabel = idwChanged.label;
        console.log(`[Navigation] Tab ${tabId} IDW changed to ${idwChanged.id}`);

        // Close any open IDW menu as available environments changed
        const existingMenu = document.querySelector('.idw-menu');
        const existingOverlay = document.querySelector('.idw-menu-overlay');
        if (existingMenu) existingMenu.remove();
        if (existingOverlay) existingOverlay.remove();
      }
    }

    // Keep track of navigation for the tab
    if (tabId === activeTabId) {
      // Update navigation state
      updateNavigationState(tabId);
    }

    // Update favicon when navigation completes
    updateTabFavicon(tabId, e.url);

    // Save tab state when navigation completes
    saveTabState();
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    console.log(`Webview ${tabId} did-navigate-in-page to: ${e.url}`);

    // SSO Diagnostic: Log when auth pages are accessed via in-page navigation
    if (e.url.includes('auth.') && e.url.includes('onereach.ai')) {
      console.log(`[SSO Diagnostic] Auth page accessed (in-page) in ${tabId}: ${e.url}`);
      const partition = webview.partition || webview.getAttribute('partition');
      if (partition && window.api) {
        window.api
          .invoke('multi-tenant:get-cookies', { partition, name: 'mult' })
          .then((cookies) => {
            console.log(
              `[SSO Diagnostic] mult cookies in ${partition}:`,
              cookies?.map((c) => ({
                domain: c.domain,
                path: c.path,
                sameSite: c.sameSite,
              })) || 'none'
            );
          })
          .catch((err) => console.log(`[SSO Diagnostic] Could not check cookies: ${err.message}`));
      }
    }

    // Update the tab's current URL for in-page navigation too
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      // Capture pre-redirect URL before overwriting (SPA auth redirects)
      if (isAuthPage(e.url) && tab.currentUrl && !isAuthPage(tab.currentUrl)) {
        if (!autoLoginState.has(tabId)) {
          autoLoginState.set(tabId, {});
        }
        autoLoginState.get(tabId).originalDestinationUrl = tab.currentUrl;
        console.log(`[AutoLogin] Captured pre-redirect URL (in-page) for ${tabId}: ${tab.currentUrl}`);
      }

      tab.currentUrl = e.url;
      console.log(`Updated tab ${tabId} currentUrl (in-page) to: ${e.url}`);

      // Update IDW Registry with the new URL (even for in-page navigation)
      const idwChanged = idwRegistry.updateTabURL(tabId, e.url);
      if (idwChanged) {
        // Update tab metadata if IDW changed
        tab.idwId = idwChanged.id;
        tab.idwLabel = idwChanged.label;
        console.log(`[In-Page Navigation] Tab ${tabId} IDW changed to ${idwChanged.id}`);

        // Close any open IDW menu as available environments changed
        const existingMenu = document.querySelector('.idw-menu');
        const existingOverlay = document.querySelector('.idw-menu-overlay');
        if (existingMenu) existingMenu.remove();
        if (existingOverlay) existingOverlay.remove();
      }
    }

    // This is critical for chat interfaces that use history API
    if (tabId === activeTabId) {
      updateNavigationState(tabId);
    }

    // Auto-login for auth pages (SPA navigation)
    // The actual login form is at auth.*.onereach.ai/login
    if (isAuthPage(e.url)) {
      // Check if we should attempt login (debounce) - pass URL to detect new auth pages
      if (!shouldAttemptAutoLogin(tabId, e.url)) {
        return;
      }
      logAuthEvent('info', 'Auth page detected via SPA nav, queueing login', {
        event: 'auth:trigger',
        tabId,
        url: e.url,
        trigger: 'will-navigate',
      });
      const authUrl = e.url;
      // Queue login with global rate limiting (one per tab)
      queueGlobalLogin(
        tabId,
        async () => {
          // Re-check state before executing
          if (!shouldAttemptAutoLogin(tabId, authUrl)) {
            console.log(`[AutoLogin] Skipping ${tabId} - state changed while in queue`);
            return;
          }
          await new Promise((r) => {
            setTimeout(r, 500);
          }); // Wait for form
          attemptAutoLoginWithRetry(webview, authUrl, tabId, 0);
        },
        webview
      );
    }
  });

  // Intercept navigation attempts to check for existing tabs
  webview.addEventListener('will-navigate', (e) => {
    console.log(`Webview ${tabId} will-navigate to: ${e.url}`);

    // DISABLED: This was preventing navigation to different chat URLs
    // The findAndFocusTab was being too aggressive in matching URLs
    /*
        // Check if it's a chat URL
        if (e.url.includes('/chat/') || 
            e.url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
            
            // Check if this URL is already open in another tab
            if (findAndFocusTab(e.url)) {
                console.log('Chat URL already open, preventing navigation and focusing existing tab');
                e.preventDefault();
                return;
            }
        }
        */
  });

  webview.addEventListener('new-window', (e) => {
    console.log('Webview new-window event detected:', {
      url: e.url,
      disposition: e.disposition,
      frameName: e.frameName,
      options: e.options,
      referrer: e.referrer,
    });

    // Check if this is actually a request to open in a new window/tab
    const isNewWindowRequest = ['new-window', 'foreground-tab', 'background-tab'].includes(e.disposition);

    // If it's not a new window request (e.g., 'other' for same-window navigation), let it proceed normally
    if (!isNewWindowRequest && e.disposition !== 'save-to-disk') {
      console.log('Navigation in same window detected, allowing default behavior');
      return; // Don't prevent default, allow normal navigation
    }

    // Check if this is an authentication URL that needs special handling
    if (
      e.url.includes('accounts.google.com') ||
      e.url.includes('sso.global.api.onereach.ai') ||
      e.url.includes('auth.edison.onereach.ai') ||
      e.url.includes('login.onereach.ai') ||
      e.url.includes('login.edison.onereach.ai') ||
      e.url.includes('oauth') ||
      e.url.includes('/auth/') ||
      e.url.includes('firebase') ||
      e.url.includes('elevenlabs.io/auth')
    ) {
      console.log('Auth URL detected, allowing popup for OAuth flow:', e.url);
      // Don't prevent default - let the auth popup open normally
      // The main process will handle the popup window with same session
      return;
    }

    // For other URLs that are actual new window requests, prevent default and handle as before
    e.preventDefault();

    // Check if this is a chat URL
    if (e.url.includes('/chat/') || e.url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
      // REMOVED: Don't check for existing tabs - each chat URL should be able to open
      // The previous check was preventing different chat URLs from opening
      /*
            // First check if this URL is already open
            if (findAndFocusTab(e.url)) {
                console.log('Chat URL already open, focused existing tab');
                return;
            }
            */

      if (openChatLinksInNewTab) {
        console.log('Chat URL detected in new-window event, creating new tab (preference)');
        createNewTab(e.url);
      } else {
        console.log('Chat URL detected in new-window event, navigating in current tab');
        // Navigate in the current tab instead of creating a new one
        webview.src = e.url;
      }
      return;
    }

    // For all other URLs, create a new tab
    console.log('Non-chat/auth URL in new-window event, creating new tab');
    createNewTab(e.url);
  });

  // Set up console message listener for debugging + WebMCP bridge
  webview.addEventListener('console-message', (e) => {
    // Intercept WebMCP bridge messages before general logging
    if (handleWebMCPConsoleMessage(tabId, webview, e.message)) return;
    console.log(`[Webview ${tabId}]: ${e.message}`);
  });

  // Update favicon initially
  updateTabFavicon(tabId, url);

  // Add tab object to tabs array
  const tab = {
    id: tabId,
    element: tabElement,
    container: webviewContainer,
    webview: webview,
    currentUrl: url || 'https://my.onereach.ai/',
    partition: partitionName, // Track partition for multi-tenant cleanup
    environment: environment, // Track OneReach environment (edison, staging, etc.)
    isReady: () => webviewReady,
    checkSession: () => {
      // Test session isolation by checking local storage and session info
      webview
        .executeJavaScript(
          `
            (function() {
                    try {
                        // Check various authentication indicators
                        const localStorageKeys = Object.keys(localStorage);
                        const sessionStorageKeys = Object.keys(sessionStorage);
                        
                        // Look for OneReach-specific auth tokens
                        const authToken = localStorage.getItem('authToken') || 
                                        localStorage.getItem('access_token') ||
                                        localStorage.getItem('idToken');
                        
                        // Check if user is logged in based on page content
                        const isLoginPage = window.location.href.includes('login') || 
                                          window.location.href.includes('auth');
                        
                        // Check for user info in localStorage
                        const userInfo = localStorage.getItem('user') || 
                                       localStorage.getItem('userInfo') ||
                                       localStorage.getItem('currentUser');
                        
                        return {
                            url: window.location.href,
                            partition: '${partitionName}',
                            cookies: document.cookie || 'No cookies',
                            hasAuthToken: !!authToken,
                            isLoginPage: isLoginPage,
                            hasUserInfo: !!userInfo,
                            localStorageItemCount: localStorageKeys.length,
                            sessionStorageItemCount: sessionStorageKeys.length,
                            // Sample some localStorage keys (first 5)
                            sampleLocalStorageKeys: localStorageKeys.slice(0, 5).join(', ') || 'None'
                        };
                    } catch (error) {
                        return {
                            error: error.message,
                            url: window.location.href,
                            partition: '${partitionName}'
                        };
                    }
                })();
            `
        )
        .then((result) => {
          console.log(`\nTab ${tabId} Session Info:`);
          console.log(`- Partition: ${result.partition}`);
          console.log(`- URL: ${result.url}`);
          console.log(`- Has Auth Token: ${result.hasAuthToken || false}`);
          console.log(`- Is Login Page: ${result.isLoginPage || false}`);
          console.log(`- Has User Info: ${result.hasUserInfo || false}`);
          console.log(`- LocalStorage Items: ${result.localStorageItemCount || 0}`);
          console.log(`- SessionStorage Items: ${result.sessionStorageItemCount || 0}`);
          console.log(`- Sample Keys: ${result.sampleLocalStorageKeys || 'None'}`);
          console.log(`- Cookies: ${result.cookies}`);
          if (result.error) {
            console.log(`- Error: ${result.error}`);
          }
        })
        .catch((err) => {
          console.error(`Error checking session for tab ${tabId}:`, err);
        });
    },
  };
  tabs.push(tab);

  // Check if this tab is an IDW and register it with the registry
  const detectedIDW = idwRegistry.detectIDWFromURL(url);
  if (detectedIDW) {
    console.log(`[Tab Creation] Detected IDW ${detectedIDW.id} for tab ${tabId}`);
    idwRegistry.registerTab(tabId, detectedIDW.id, detectedIDW);
    // Store IDW info in the tab object for reference
    tab.idwId = detectedIDW.id;
    tab.idwLabel = detectedIDW.label;
  }

  // Activate the newly created tab
  activateTab(tabId);

  // If URL was provided, make sure it's the one being loaded
  if (url && url !== 'https://my.onereach.ai/') {
    // Make sure the tab has initialized before navigating
    if (webviewReady) {
      webview.src = url;
    }
  }

  return tab;
}

// Activate a tab by ID
function activateTab(tabId) {
  // Deactivate current active tab
  tabs.forEach((tab) => {
    tab.element.classList.remove('active');
    tab.container.classList.remove('active');
  });

  // Activate the requested tab
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.element.classList.add('active');
    tab.container.classList.add('active');
    activeTabId = tabId;

    // Update navigation button states if webview is ready
    if (tab.isReady()) {
      updateNavigationState(tabId);
    }

    // Save tab state when active tab changes
    saveTabState();
  }
}

// Function to update navigation state (back/forward buttons)
function updateNavigationState(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) {
    console.log(`Cannot update navigation state - tab ${tabId} not found`);
    return;
  }

  const backButton = document.getElementById('back-button');
  const forwardButton = document.getElementById('forward-button');

  try {
    console.log(`Updating navigation state for tab ${tabId}`);

    // Safely check navigation state
    let canGoBack = false;
    let canGoForward = false;

    try {
      // Try to get navigation state even if webview isn't fully ready
      canGoBack = tab.webview.canGoBack();
      canGoForward = tab.webview.canGoForward();
    } catch (error) {
      console.warn(`Could not determine navigation state for ${tabId}, assuming false:`, error);
      // Keep default false values
    }

    console.log(`Navigation state: canGoBack=${canGoBack}, canGoForward=${canGoForward}`);

    // Update UI based on navigation state
    if (canGoBack) {
      backButton.classList.add('active');
    } else {
      backButton.classList.remove('active');
    }

    if (canGoForward) {
      forwardButton.classList.add('active');
    } else {
      forwardButton.classList.remove('active');
    }
  } catch (error) {
    console.error('Error updating navigation state:', error);
    // Ensure buttons are in a valid state even if there's an error
    backButton.classList.remove('active');
    forwardButton.classList.remove('active');
  }
}

// Close a tab by ID
function closeTab(tabId) {
  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  if (tabIndex !== -1) {
    const tab = tabs[tabIndex];

    // Unregister from IDW Registry
    idwRegistry.unregisterTab(tabId);
    console.log(`[Tab Close] Unregistered tab ${tabId} from IDW Registry`);

    // Clean up WebMCP proxy agents for this tab
    cleanupWebMCPForTab(tabId);

    // Cleanup multi-tenant token tracking
    if (tab.partition && tab.environment) {
      // Unregister partition from refresh propagation
      window.api
        .invoke('multi-tenant:unregister-partition', {
          environment: tab.environment,
          partition: tab.partition,
        })
        .catch((err) => console.warn('[Tab Close] Failed to unregister partition:', err));

      // Remove cookie listener (memory cleanup)
      window.api
        .invoke('multi-tenant:remove-listener', {
          partition: tab.partition,
        })
        .catch((err) => console.warn('[Tab Close] Failed to remove listener:', err));

      console.log(`[Tab Close] Cleaned up multi-tenant resources for ${tab.partition}`);
    }

    // Close any open IDW menu as available environments have changed
    const existingMenu = document.querySelector('.idw-menu');
    const existingOverlay = document.querySelector('.idw-menu-overlay');
    if (existingMenu) existingMenu.remove();
    if (existingOverlay) existingOverlay.remove();

    // Remove DOM elements
    tab.element.remove();
    tab.container.remove();

    // Remove from tabs array
    tabs.splice(tabIndex, 1);

    // If this was the active tab, activate another one
    if (activeTabId === tabId) {
      if (tabs.length > 0) {
        // Prefer the tab to the right, otherwise the one to the left
        const newActiveTab = tabs[tabIndex] || tabs[tabIndex - 1];
        activateTab(newActiveTab.id);
      } else {
        // No tabs left, create a new one
        createNewTab();
      }
    }

    // Save tab state after closing a tab
    saveTabState();
  }
}

// Debug function to check session isolation
function debugSessionIsolation() {
  console.log('=== Debugging Session Isolation ===');
  tabs.forEach((tab, index) => {
    console.log(`\nTab ${index} (${tab.id}):`);
    console.log(`- URL: ${tab.webview.src}`);
    console.log(`- Partition attribute: ${tab.webview.getAttribute('partition')}`);
    console.log(`- Partition property: ${tab.webview.partition}`);
    console.log(`- WebContentsId: ${tab.webview.getWebContentsId ? tab.webview.getWebContentsId() : 'N/A'}`);

    // Check session details
    if (tab.checkSession) {
      tab.checkSession();
    }

    // Additional check: look for OneReach-specific data
    tab.webview
      .executeJavaScript(
        `
            (function() {
                const oneReachData = {};
                
                // Check for OneReach-specific localStorage items
                for (let key in localStorage) {
                    if (key.includes('onereach') || key.includes('idToken') || key.includes('auth')) {
                        oneReachData[key] = localStorage[key];
                    }
                }
                
                // Check cookies
                const cookies = document.cookie.split(';').map(c => c.trim());
                const authCookies = cookies.filter(c => 
                    c.includes('auth') || c.includes('token') || c.includes('session')
                );
                
                // Check current user context
                const userContext = {
                    windowLocation: window.location.href,
                    documentTitle: document.title,
                    hasChat: !!document.querySelector('[class*="chat"]'),
                    hasMessages: !!document.querySelector('[class*="message"]')
                };
                
                return {
                    oneReachData: oneReachData,
                    authCookies: authCookies,
                    userContext: userContext
                };
            })();
        `
      )
      .then((result) => {
        console.log(`  OneReach Data:`, result.oneReachData);
        console.log(`  Auth Cookies:`, result.authCookies);
        console.log(`  User Context:`, result.userContext);
      })
      .catch((err) => {
        console.error(`  Error checking OneReach data:`, err);
      });
  });
  console.log('=== End Debug ===');
}

// Add keyboard shortcut for debugging - add to both window and document
const debugShortcutHandler = (e) => {
  // Ctrl/Cmd + Shift + D for debug
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    console.log('Debug shortcut triggered!');
    debugSessionIsolation();
  }
};

// Add to window to capture even when webview has focus
window.addEventListener('keydown', debugShortcutHandler, true);
document.addEventListener('keydown', debugShortcutHandler, true);

// Remove Cmd+T shortcut as plus button is only for IDW environments

// Add "Close Tab" hotkey - Ctrl/Cmd + W
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
    e.preventDefault();
    console.log('Close Tab hotkey triggered!');
    // Close the active tab
    if (activeTabId && tabs.length > 1) {
      closeTab(activeTabId);
    }
  }
});

// Add "Start Fresh" hotkey - Ctrl/Cmd + Shift + R
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      console.log('Start Fresh hotkey triggered!');

      // Confirm with user
      const confirmed = confirm('This will clear ALL data and cookies. Continue?');
      if (confirmed) {
        // Clear all localStorage
        localStorage.clear();

        // Ask main process to wipe all partitions
        window.api.send('wipe-all-partitions');

        // Show feedback
        console.log('✅ All data cleared. Reloading...');

        // Reload after a short delay
        setTimeout(() => {
          window.location.reload();
        }, 100);
      }
    }
  },
  true
);

// Check tab authentication status
function checkTabAuthentication(tabId, webview) {
  console.log(`Manually checking authentication for tab ${tabId}`);

  webview
    .executeJavaScript(
      `
        (function() {
            // Check if we're on a login page or need authentication
            const isLoginPage = window.location.href.includes('/login') || 
                              window.location.href.includes('/auth') ||
                              document.querySelector('input[type="password"]') !== null;
            
            // Check for common login/auth UI elements
            const hasLoginForm = document.querySelector('form[action*="login"]') !== null ||
                               document.querySelector('button[type="submit"]') !== null;
            
            // Check page content for login keywords
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            const hasLoginKeywords = bodyText.includes('sign in') || 
                                   bodyText.includes('log in') ||
                                   bodyText.includes('login') ||
                                   bodyText.includes('password');
            
            // Check if we have any content that suggests we're authenticated
            const hasAuthenticatedContent = document.querySelector('.chat-interface') !== null ||
                                          document.querySelector('[class*="message"]') !== null ||
                                          document.querySelector('[class*="chat"]') !== null ||
                                          document.querySelector('iframe[src*="chat"]') !== null;
            
            // Check for empty or minimal content (common when not authenticated)
            const isEmptyPage = !document.body || 
                              document.body.innerText.trim().length < 50 ||
                              document.body.children.length < 3;
            
            // Check for OneReach-specific elements that indicate authentication
            const hasOneReachChat = document.querySelector('[id*="onereach"]') !== null ||
                                  document.querySelector('[class*="onereach"]') !== null ||
                                  window.OneReach !== undefined;
            
            // For OneReach chat URLs, if the page is empty or minimal, it likely needs auth
            const isOneReachChatUrl = window.location.href.includes('chat.') && 
                                    window.location.href.includes('.onereach.ai');
            
            const needsAuth = (isLoginPage || hasLoginForm || hasLoginKeywords || 
                             (isOneReachChatUrl && isEmptyPage && !hasAuthenticatedContent)) && 
                             !hasAuthenticatedContent;
            
            return {
                needsAuth: needsAuth,
                currentUrl: window.location.href,
                title: document.title,
                bodyLength: document.body ? document.body.innerText.length : 0,
                hasAuthenticatedContent: hasAuthenticatedContent,
                isEmptyPage: isEmptyPage,
                isOneReachChatUrl: isOneReachChatUrl
            };
        })();
    `
    )
    .then((authCheck) => {
      console.log(`Tab ${tabId} auth check:`, authCheck);
      console.log(`- needsAuth: ${authCheck.needsAuth}`);
      console.log(`- currentUrl: ${authCheck.currentUrl}`);
      console.log(`- title: ${authCheck.title}`);
      console.log(`- bodyLength: ${authCheck.bodyLength}`);
      console.log(`- hasAuthenticatedContent: ${authCheck.hasAuthenticatedContent}`);
      console.log(`- isEmptyPage: ${authCheck.isEmptyPage}`);
      console.log(`- isOneReachChatUrl: ${authCheck.isOneReachChatUrl}`);

      if (authCheck.needsAuth) {
        console.log(`Tab ${tabId} needs authentication`);

        // REMOVED: Authentication overlay popup
        // The overlay was showing an annoying popup, so it's been disabled
        /*
            // Inject a helpful message
            webview.executeJavaScript(`
                (function() {
                    // Remove any existing overlay
                    const existingOverlay = document.getElementById('auth-required-overlay');
                    if (existingOverlay) existingOverlay.remove();
                    
                    // Create a helpful overlay
                    const overlay = document.createElement('div');
                    overlay.id = 'auth-required-overlay';
                    overlay.style.cssText = \`
                        position: fixed;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        background: #2a2a2a;
                        color: white;
                        padding: 30px;
                        border-radius: 10px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                        z-index: 99999;
                        text-align: center;
                        max-width: 400px;
                    \`;
                    
                    overlay.innerHTML = \`
                        <h2 style="margin: 0 0 15px 0; color: #4CAF50;">Authentication Required</h2>
                        <p style="margin: 0 0 20px 0; line-height: 1.5;">
                            To access this chat, please first navigate to your IDW environment 
                            using the <strong>+</strong> menu in the tab bar.
                        </p>
                        <p style="margin: 0 0 20px 0; font-size: 14px; opacity: 0.8;">
                            Each tab has its own login session for security.
                        </p>
                        <button onclick="this.parentElement.remove()" style="
                            background: #4CAF50;
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 5px;
                            cursor: pointer;
                            font-size: 16px;
                        ">Got it</button>
                    \`;
                    
                    document.body.appendChild(overlay);
                    
                    // Auto-remove after 10 seconds
                    setTimeout(() => {
                        if (overlay.parentElement) {
                            overlay.remove();
                        }
                    }, 10000);
                })();
            `).catch(err => console.error('Error showing auth message:', err));
            */
      } else {
        console.log(`Tab ${tabId} appears to be authenticated`);
      }
    })
    .catch((err) => {
      console.error(`Error checking auth state for tab ${tabId}:`, err);
    });
}

// Create a new tab with the given URL (or default to new tab page)
function createNewTab(url = 'https://my.onereach.ai/') {
  // DISABLED: Don't prevent creating new tabs for chat URLs
  // Each chat URL should be allowed to open in its own tab
  /*
    // First check if this URL is already open
    if (url !== 'https://my.onereach.ai/' && findAndFocusTab(url)) {
        console.log('URL already open in a tab, focusing it instead of creating new tab');
        return null;
    }
    */

  return createNewTabWithPartition(url, null);
}

// Create a new tab specifically for ChatGPT with enhanced permissions
function createChatGPTTab(url, _label = 'ChatGPT') {
  // For now, just create a regular tab - we can enhance this later if needed
  return createNewTabWithPartition(url, null);
}

// Find and focus a tab with the given URL, returns true if found
function findAndFocusTab(url) {
  // Disable duplicate prevention for OneReach chat URLs
  if (url.includes('/chat/') || (url.includes('chat.') && url.includes('.onereach.ai'))) {
    return false; // Always allow new chat tabs
  }
  console.log('Looking for existing tab with URL:', url);

  // Normalize the URL for comparison
  let normalizedSearchUrl;
  try {
    const searchUrl = new URL(url);
    normalizedSearchUrl = searchUrl.origin + searchUrl.pathname + searchUrl.search;
  } catch (_e) {
    normalizedSearchUrl = url;
  }

  // Check each tab
  for (const tab of tabs) {
    if (tab.webview && tab.webview.src) {
      try {
        const tabUrl = new URL(tab.webview.src);
        const normalizedTabUrl = tabUrl.origin + tabUrl.pathname + tabUrl.search;

        // Compare normalized URLs (ignoring hash/fragment)
        if (normalizedTabUrl === normalizedSearchUrl) {
          console.log(`Found existing tab ${tab.id} with matching URL`);
          activateTab(tab.id);

          // Add a brief highlight effect to show which tab was focused
          tab.element.style.transition = 'background-color 0.3s ease';
          tab.element.style.backgroundColor = '#4CAF50';
          setTimeout(() => {
            tab.element.style.backgroundColor = '';
          }, 300);

          return true;
        }
      } catch (_e) {
        // If URL parsing fails, do simple comparison
        if (tab.webview.src === url) {
          console.log(`Found existing tab ${tab.id} with exact URL match`);
          activateTab(tab.id);

          // Add a brief highlight effect
          tab.element.style.transition = 'background-color 0.3s ease';
          tab.element.style.backgroundColor = '#4CAF50';
          setTimeout(() => {
            tab.element.style.backgroundColor = '';
          }, 300);

          return true;
        }
      }
    }
  }

  console.log('No existing tab found with URL:', url);
  return false;
}
