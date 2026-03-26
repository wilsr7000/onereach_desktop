/**
 * GSX Flow Context Tracker
 *
 * Maintains the state of which Edison flow/step the user is currently
 * editing in any GSX BrowserWindow. Updated by the fetch hook injected
 * into GSX windows, consumed by the Dev Tools menu and bottom toolbar.
 */

const { ipcMain, BrowserWindow } = require('electron');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

let currentContext = null;
let contextListeners = [];
let stepListeners = [];
let capturedAuthToken = null;
let stepMap = {}; // { stepId: { label, type } } -- populated from flow data
let lastSelectedStep = null; // persists across flow context thrashing
const knownBotIds = new Set(); // UUIDs confirmed as bot IDs, never accept as flow IDs

function get() {
  return currentContext;
}

function getLastStep() {
  return lastSelectedStep;
}

function update(ctx) {
  // Track any confirmed botIds so we never confuse them for flowIds
  if (ctx.botId) knownBotIds.add(ctx.botId);

  // Reject updates where the "flowId" is actually a known botId
  if (ctx.flowId && knownBotIds.has(ctx.flowId)) {
    log.info('gsx-flow-context', 'Rejected botId masquerading as flowId', { rejectedId: ctx.flowId });
    return currentContext;
  }

  // Bot-only update (no flowId) -- just register the botId, don't touch flow context
  if (!ctx.flowId && ctx.botId) {
    return currentContext;
  }

  const prev = currentContext;
  currentContext = {
    flowId: ctx.flowId || null,
    botId: ctx.botId || null,
    label: ctx.label || (prev?.flowId === ctx.flowId ? prev?.label : null),
    stepCount: ctx.stepCount || (prev?.flowId === ctx.flowId ? prev?.stepCount : 0),
    templateCount: ctx.templateCount || 0,
    lastSeen: new Date().toISOString(),
    windowId: ctx.windowId || null,
    stepId: currentContext?.stepId || null,
    stepLabel: currentContext?.stepLabel || null,
    stepType: currentContext?.stepType || null,
  };

  const flowChanged = !prev || prev.flowId !== currentContext.flowId;
  if (flowChanged) {
    currentContext.stepId = null;
    currentContext.stepLabel = null;
    currentContext.stepType = null;
    stepMap = {};
    fetchAndCacheStepMap(currentContext.flowId);
    log.info('gsx-flow-context', 'Flow context updated', {
      flowId: currentContext.flowId,
      label: currentContext.label,
      stepCount: currentContext.stepCount,
    });
    notifyListeners(currentContext);
  } else if (prev.label !== currentContext.label || prev.stepCount !== currentContext.stepCount) {
    log.info('gsx-flow-context', 'Flow context updated', {
      flowId: currentContext.flowId,
      label: currentContext.label,
      stepCount: currentContext.stepCount,
    });
    notifyListeners(currentContext);
  }

  return currentContext;
}

function setStepMap(map) {
  stepMap = map || {};
  const count = Object.keys(stepMap).length;
  if (count > 0) {
    log.info('gsx-flow-context', 'Step map cached', { stepCount: count });
  }
}

let fetchPending = null;
async function fetchAndCacheStepMap(flowId) {
  if (!flowId || !capturedAuthToken) return;
  if (fetchPending === flowId) return;
  fetchPending = flowId;
  try {
    const { net } = require('electron');
    const url = `https://datahub.edison.api.onereach.ai/flows/${flowId}`;
    const resp = await net.fetch(url, {
      method: 'GET',
      headers: { 'Authorization': capturedAuthToken, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) { fetchPending = null; return; }
    const flowData = await resp.json();
    const trees = flowData?.data?.trees || flowData?.trees || {};
    const sm = {};
    for (const treeName of Object.keys(trees)) {
      const stepsArr = trees[treeName]?.steps || [];
      const arr = Array.isArray(stepsArr) ? stepsArr : Object.values(stepsArr);
      for (const s of arr) {
        if (s?.id) {
          sm[s.id] = { label: s.label || s.data?.label || null, type: s.type || s.stepTemplateId || null };
        }
      }
    }
    if (currentContext?.flowId === flowId && Object.keys(sm).length > 0) {
      setStepMap(sm);
      currentContext.stepCount = Object.keys(sm).length;
    }
  } catch (err) {
    log.warn('gsx-flow-context', 'Failed to fetch step map', { error: err.message });
  }
  fetchPending = null;
}

function updateStep(ctx) {
  if (!currentContext) return;
  if (ctx.stepId && (ctx.stepId === currentContext.flowId || ctx.stepId === currentContext.botId)) return;

  // If stepMap is populated, only accept known step instance IDs.
  // The DOM observer picks up template UUIDs from canvas elements -- reject those.
  const mapSize = Object.keys(stepMap).length;
  if (mapSize > 0 && ctx.stepId && !stepMap[ctx.stepId]) {
    const matchingSteps = Object.entries(stepMap).filter(([, s]) => s.type === ctx.stepId);
    if (matchingSteps.length === 1) {
      // Template ID uniquely identifies one step -- resolve to its instance ID
      const [instanceId, instanceData] = matchingSteps[0];
      log.info('gsx-flow-context', 'Resolved template ID to instance', {
        templateId: ctx.stepId, instanceId, label: instanceData.label, source: ctx.source,
      });
      ctx.stepId = instanceId;
      ctx.stepLabel = ctx.stepLabel || instanceData.label;
      ctx.stepType = instanceData.type;
    } else if (matchingSteps.length > 1) {
      // Ambiguous -- multiple steps share this template, can't resolve
      log.info('gsx-flow-context', 'Ignoring ambiguous template ID', {
        templateId: ctx.stepId, matchCount: matchingSteps.length, source: ctx.source,
      });
      return;
    }
    // If matchingSteps.length === 0, the ID isn't a known template --
    // allow it through (could be a newly added step not yet in the map)
  }

  let label = ctx.stepLabel || null;
  let type = ctx.stepType || null;
  if ((!label || !type) && ctx.stepId && stepMap[ctx.stepId]) {
    const cached = stepMap[ctx.stepId];
    if (!label) label = cached.label || null;
    if (!type) type = cached.type || null;
  }

  const prev = { stepId: currentContext.stepId, stepLabel: currentContext.stepLabel };
  currentContext.stepId = ctx.stepId || null;
  currentContext.stepLabel = label;
  currentContext.stepType = type;
  currentContext.lastSeen = new Date().toISOString();
  if (ctx.windowId) currentContext.windowId = ctx.windowId;

  const changed = prev.stepId !== currentContext.stepId || prev.stepLabel !== currentContext.stepLabel;
  if (changed) {
    if (currentContext.stepId) {
      lastSelectedStep = {
        stepId: currentContext.stepId,
        stepLabel: currentContext.stepLabel,
        stepType: currentContext.stepType,
        flowId: currentContext.flowId,
        ts: Date.now(),
      };
    }
    log.info('gsx-flow-context', 'Step context updated', {
      stepId: currentContext.stepId,
      stepLabel: currentContext.stepLabel,
      stepType: currentContext.stepType,
    });
    notifyStepListeners(currentContext);
  }
  // Always push to renderer -- DOM elements may have been recreated by Studio
  if (currentContext.stepId) {
    pushStepToRenderer(currentContext);
  }
  return currentContext;
}

function onStepChange(fn) {
  stepListeners.push(fn);
  return () => { stepListeners = stepListeners.filter(l => l !== fn); };
}

function notifyStepListeners(ctx) {
  for (const fn of stepListeners) {
    try { fn(ctx); } catch (e) {
      log.error('gsx-flow-context', 'Step listener error', { error: e.message });
    }
  }
}

function pushStepToRenderer(ctx) {
  if (!ctx?.windowId) {
    log.warn('gsx-flow-context', 'pushStepToRenderer: no windowId');
    return;
  }
  try {
    const win = BrowserWindow.fromId(ctx.windowId);
    if (!win || win.isDestroyed()) {
      log.warn('gsx-flow-context', 'pushStepToRenderer: window gone', { windowId: ctx.windowId });
      return;
    }
    const stepId = ctx.stepId || '';
    const stepLabel = ctx.stepLabel || '';
    const stepType = ctx.stepType || '';
    const flowLabel = ctx.label || '';
    const hasStepId = !!stepId;
    const displayName = stepLabel || (stepId ? stepId.substring(0, 8) + '...' : '');
    const text = stepLabel
      ? (stepType ? stepLabel + ' (' + stepType + ')' : stepLabel)
      : displayName;
    const display = hasStepId ? 'inline' : 'none';
    log.info('gsx-flow-context', 'pushStepToRenderer', {
      windowId: ctx.windowId, stepId: stepId.substring(0, 12), hasStepId, displayName: displayName.substring(0, 30),
    });
    win.webContents.executeJavaScript(`
      (function() {
        window.__gsxCurrentStep = { stepId: ${JSON.stringify(stepId)}, displayName: ${JSON.stringify(displayName)}, hasStepId: ${JSON.stringify(hasStepId)} };
        var el = document.getElementById('gsx-dt-step');
        var sep = document.getElementById('gsx-dt-sep');
        var bar = document.getElementById('gsx-devtools-bar');
        if (el) { el.textContent = ${JSON.stringify(text)}; el.style.display = ${JSON.stringify(display)}; }
        if (sep) { sep.style.display = ${JSON.stringify(display)}; }
        if (bar) { bar.dataset.stepId = ${JSON.stringify(stepId)}; }
        var ctxEl = document.getElementById('gsx-ctx-label');
        if (ctxEl) {
          var html = '<span class="ctx-flow">' + ${JSON.stringify(flowLabel)}.replace(/</g,'&lt;') + '</span>';
          if (${JSON.stringify(displayName)}) {
            html += '<span class="ctx-sep">/</span><span class="ctx-step">' + ${JSON.stringify(displayName)}.replace(/</g,'&lt;') + '</span>';
          }
          ctxEl.innerHTML = html;
          ctxEl.classList.add('has-context');
        }
        var hasStep = ${JSON.stringify(hasStepId)};
        var stepName = ${JSON.stringify(displayName)};
        var cfgItem = document.getElementById('gsx-dt-configure-step');
        if (cfgItem) {
          var lbl = cfgItem.querySelector('.dt-label');
          var badge = cfgItem.querySelector('.dt-badge');
          if (hasStep) {
            cfgItem.classList.add('enabled');
            if (lbl) lbl.textContent = 'Configure: ' + stepName;
            if (badge) badge.style.display = 'none';
          } else {
            cfgItem.classList.remove('enabled');
            if (lbl) lbl.textContent = 'Configure Step';
            if (badge) { badge.textContent = 'Select a step'; badge.style.display = ''; }
          }
        }
        var valItem = document.getElementById('gsx-dt-validate-step');
        if (valItem) {
          var vLbl = valItem.querySelector('.dt-label');
          var vBadge = valItem.querySelector('.dt-badge');
          if (hasStep) {
            valItem.classList.add('enabled');
            if (vLbl) vLbl.textContent = 'Validate: ' + stepName;
            if (vBadge) vBadge.style.display = 'none';
          } else {
            valItem.classList.remove('enabled');
            if (vLbl) vLbl.textContent = 'Validate Step';
            if (vBadge) { vBadge.textContent = 'Select a step'; vBadge.style.display = ''; }
          }
        }
        return { bar: !!bar, el: !!el, cfgItem: !!cfgItem, valItem: !!valItem, barStepId: bar ? bar.dataset.stepId : null, cfgEnabled: cfgItem ? cfgItem.classList.contains('enabled') : null };
      })();
    `).then(r => {
      log.info('gsx-flow-context', 'pushStepToRenderer result', r);
    }).catch(err => {
      log.warn('gsx-flow-context', 'pushStepToRenderer exec failed', { error: err.message });
    });
  } catch (e) {
    log.warn('gsx-flow-context', 'pushStepToRenderer error', { error: e.message });
  }
}

function setAuthToken(token) {
  if (token && token !== capturedAuthToken) {
    capturedAuthToken = token;
    log.info('gsx-flow-context', 'Auth token captured/updated');
  }
}

function getAuthToken() {
  return capturedAuthToken;
}

function clear() {
  currentContext = null;
  notifyListeners(null);
}

function onChange(fn) {
  contextListeners.push(fn);
  return () => {
    contextListeners = contextListeners.filter(l => l !== fn);
  };
}

function notifyListeners(ctx) {
  for (const fn of contextListeners) {
    try { fn(ctx); } catch (e) {
      log.error('gsx-flow-context', 'Listener error', { error: e.message });
    }
  }

  // Push update to the GSX BrowserWindow renderer so the info bar updates
  if (ctx && ctx.windowId) {
    try {
      const win = BrowserWindow.fromId(ctx.windowId);
      if (win && !win.isDestroyed()) {
        const label = ctx.label || (ctx.flowId ? ctx.flowId.substring(0, 8) + '...' : '');
        const steps = ctx.stepCount > 0 ? `${ctx.stepCount} steps` : '';
        log.info('gsx-flow-context', 'Pushing context to renderer', { windowId: ctx.windowId, label });
        win.webContents.executeJavaScript(`
          (function() {
            var bar = document.getElementById('gsx-devtools-bar');
            if (bar) {
              bar.classList.add('active');
              bar.dataset.flowId = ${JSON.stringify(ctx.flowId || '')};
              var f = document.getElementById('gsx-dt-flow');
              var s = document.getElementById('gsx-dt-steps');
              if (f) f.textContent = ${JSON.stringify(label)};
              if (s) s.textContent = ${JSON.stringify(steps)};
            }
            var ctx = document.getElementById('gsx-ctx-label');
            if (ctx) {
              ctx.innerHTML = '<span class="ctx-flow">' + ${JSON.stringify(label)}.replace(/</g,'&lt;') + '</span>';
              ctx.classList.toggle('has-context', !!${JSON.stringify(label)});
            }
          })();
        `).catch((err) => {
          log.warn('gsx-flow-context', 'executeJavaScript push failed', { error: err.message });
        });
      } else {
        log.warn('gsx-flow-context', 'Target window not available for push', { windowId: ctx.windowId });
      }
    } catch (e) {
      log.warn('gsx-flow-context', 'Push to renderer failed', { error: e.message });
    }
  }
}

/**
 * Returns the JavaScript string to inject into GSX windows.
 * This wraps fetch() to intercept Edison API calls and extract flow context.
 */
function getFetchHookScript() {
  return `
(function() {
  if (window.__gsxFetchHookInstalled) return;
  window.__gsxFetchHookInstalled = true;

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      const flowMatch = url.match(/\\/flows\\/([a-f0-9-]{36})/i);
      const botInUrl = url.match(/\\/bots\\/([a-f0-9-]{36})/i);
      if (flowMatch && (url.includes('/api/') || url.includes('.api.') || url.includes('sdkapi.') || url.includes('datahub'))) {
        const method = args[1]?.method?.toUpperCase() || 'GET';
        if (method === 'GET' || method === 'PUT') {
          const clone = response.clone();
          clone.json().then(data => {
            const flowData = data?.data || data;
            const flowId = flowMatch[1];
            // Skip if the "flowId" is actually a botId from the URL
            if (botInUrl && flowId === botInUrl[1]) return;
            // Validate the response looks like flow data (has trees or steps)
            const hasTrees = !!(flowData?.trees || flowData?.data?.trees);
            if (!hasTrees) return;
            const label = flowData?.label || flowData?.data?.label || null;
            const trees = flowData?.trees || flowData?.data?.trees || {};
            const mainTree = trees?.main || {};
            const stepsArr = mainTree?.steps || [];
            const stepCount = Array.isArray(stepsArr) ? stepsArr.length : Object.keys(stepsArr).length;

            var stepsMap = {};
            var stepsList = Array.isArray(stepsArr) ? stepsArr : Object.values(stepsArr);
            for (var si = 0; si < stepsList.length; si++) {
              var s = stepsList[si];
              if (s && s.id) {
                stepsMap[s.id] = {
                  label: s.label || s.data?.label || s.name || null,
                  type: s.type || s.stepTemplateId || s.data?.type || null,
                };
              }
            }

            if (flowId && window.electronAPI?.send) {
              window.electronAPI.send('edison-flow-detected', {
                flowId,
                label,
                stepCount,
                stepsMap: stepsMap,
                method,
              });

              const bar = document.getElementById('gsx-devtools-bar');
              if (bar) {
                bar.classList.add('active');
                bar.dataset.flowId = flowId;
                const flowEl = document.getElementById('gsx-dt-flow');
                const stepsEl = document.getElementById('gsx-dt-steps');
                if (flowEl) flowEl.textContent = label || flowId.substring(0, 8) + '...';
                if (stepsEl) stepsEl.textContent = stepCount > 0 ? stepCount + ' steps' : '';
              }
            }
          }).catch(() => {});
        }
      }
    } catch (_) {}

    return response;
  };
})();
`;
}

/**
 * Returns the JavaScript string to inject into GSX windows for step detection.
 * Uses DOM observation + click interception to detect which step is selected.
 */
function getStepObserverScript() {
  return `
(function() {
  if (window.__gsxStepObserverInstalled) return;
  window.__gsxStepObserverInstalled = true;

  const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
  let lastStepId = null;
  let debounceTimer = null;

  function sendStep(stepId, stepLabel, stepType, source) {
    if (stepId === lastStepId) return;
    var bar = document.getElementById('gsx-devtools-bar');
    var currentFlowId = bar ? bar.dataset.flowId : null;
    if (currentFlowId && stepId === currentFlowId) return;
    lastStepId = stepId;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      if (window.electronAPI && window.electronAPI.send) {
        window.electronAPI.send('edison-step-detected', {
          stepId: stepId,
          stepLabel: stepLabel || null,
          stepType: stepType || null,
          source: source,
        });
      }
    }, 150);
  }

  var PRIORITY_ATTRS = ['id','stepId','stepid','step-id','nodeId','nodeid','node-id','itemId','itemid'];

  function findStepIdFromElement(el, maxDepth) {
    var depth = 0;
    var fallback = null;
    while (el && depth < (maxDepth || 12)) {
      if (el.dataset) {
        // Check high-priority attributes first (more likely to be instance IDs)
        for (var p = 0; p < PRIORITY_ATTRS.length; p++) {
          var pval = el.dataset[PRIORITY_ATTRS[p]];
          if (typeof pval === 'string' && UUID_RE.test(pval)) {
            return { id: pval.match(UUID_RE)[0], el: el, attr: PRIORITY_ATTRS[p] };
          }
        }
        // Fall back to any data attribute with a UUID, but save as lower priority
        if (!fallback) {
          for (var key in el.dataset) {
            var val = el.dataset[key];
            if (typeof val === 'string' && UUID_RE.test(val)) {
              fallback = { id: val.match(UUID_RE)[0], el: el, attr: key };
              break;
            }
          }
        }
      }
      if (el.id && UUID_RE.test(el.id)) {
        return { id: el.id.match(UUID_RE)[0], el: el, attr: 'element-id' };
      }
      el = el.parentElement;
      depth++;
    }
    return fallback;
  }

  function extractStepMeta(containerEl) {
    var label = null;
    var type = null;
    var headings = containerEl.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="label"],[class*="name"],[class*="header"]');
    for (var i = 0; i < headings.length; i++) {
      var text = (headings[i].textContent || '').trim();
      if (text && text.length > 0 && text.length < 80 && !UUID_RE.test(text)) {
        label = text;
        break;
      }
    }
    if (!label) {
      var raw = (containerEl.innerText || containerEl.textContent || '').trim();
      var lines = raw.split(/\\n/).map(function(l){ return l.trim(); }).filter(function(l){
        return l.length > 0 && l.length < 80 && !UUID_RE.test(l);
      });
      if (lines.length > 0) label = lines[0];
    }
    if (!label && containerEl.title) label = containerEl.title;
    if (!label && containerEl.getAttribute && containerEl.getAttribute('aria-label')) {
      label = containerEl.getAttribute('aria-label');
    }
    var typeEls = containerEl.querySelectorAll('[class*="type"],[class*="kind"],[class*="template"]');
    for (var j = 0; j < typeEls.length; j++) {
      var t = (typeEls[j].textContent || '').trim();
      if (t && t.length < 60 && !UUID_RE.test(t)) {
        type = t;
        break;
      }
    }
    return { label: label, type: type };
  }

  // Strategy 1: Click interception on step elements
  document.addEventListener('click', function(e) {
    var target = e.target;
    var found = findStepIdFromElement(target, 15);
    if (found) {
      var meta = extractStepMeta(found.el);
      sendStep(found.id, meta.label, meta.type, 'click:' + (found.attr || '?'));
    }
  }, true);

  // Strategy 2: MutationObserver watching for panels/drawers with step data
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var mut = mutations[i];
      if (mut.type === 'childList' && mut.addedNodes.length > 0) {
        for (var j = 0; j < mut.addedNodes.length; j++) {
          var node = mut.addedNodes[j];
          if (node.nodeType !== 1) continue;
          var cls = (node.className || '').toString().toLowerCase();
          if (cls.indexOf('panel') !== -1 || cls.indexOf('drawer') !== -1 ||
              cls.indexOf('sidebar') !== -1 || cls.indexOf('detail') !== -1 ||
              cls.indexOf('config') !== -1 || cls.indexOf('editor') !== -1 ||
              cls.indexOf('step') !== -1) {
            var found = findStepIdFromElement(node, 5);
            if (!found) {
              var inner = node.querySelector('[data-id],[data-step-id],[data-stepid],[data-node-id]');
              if (inner) found = findStepIdFromElement(inner, 3);
            }
            if (found) {
              var meta = extractStepMeta(node);
              sendStep(found.id, meta.label, meta.type, 'mutation:' + (found.attr || '?'));
            }
          }
        }
      }
      if (mut.type === 'attributes' && mut.target && mut.target.nodeType === 1) {
        var attrEl = mut.target;
        var attrCls = (attrEl.className || '').toString().toLowerCase();
        if (attrCls.indexOf('selected') !== -1 || attrCls.indexOf('active') !== -1 || attrCls.indexOf('focused') !== -1) {
          var found2 = findStepIdFromElement(attrEl, 8);
          if (found2) {
            var meta2 = extractStepMeta(found2.el);
            sendStep(found2.id, meta2.label, meta2.type, 'attribute:' + (found2.attr || '?'));
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  // Strategy 3: Periodic scan for selected step indicators
  setInterval(function() {
    var selected = document.querySelector('[class*="selected"][data-id], [class*="active"][data-id], .selected[data-node-id], .active[data-node-id]');
    if (selected) {
      var found = findStepIdFromElement(selected, 5);
      if (found) {
        var meta = extractStepMeta(found.el);
        sendStep(found.id, meta.label, meta.type, 'scan:' + (found.attr || '?'));
      }
    }
  }, 2000);
})();
`;
}

function registerIPC() {
  ipcMain.on('edison-flow-detected', (event, data) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (data.stepsMap && typeof data.stepsMap === 'object') {
      setStepMap(data.stepsMap);
    }
    update({
      ...data,
      windowId: win?.id || null,
    });
  });

  ipcMain.on('edison-step-detected', (event, data) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    log.info('gsx-flow-context', 'Step detected via renderer', {
      stepId: data.stepId,
      stepLabel: data.stepLabel,
      stepType: data.stepType,
      source: data.source,
    });
    updateStep({
      ...data,
      windowId: win?.id || null,
    });
  });

  ipcMain.handle('get-flow-context', () => get());
}

module.exports = {
  get,
  getLastStep,
  update,
  updateStep,
  setStepMap,
  getStepMap: () => stepMap,
  clear,
  onChange,
  onStepChange,
  setAuthToken,
  getAuthToken,
  getFetchHookScript,
  getStepObserverScript,
  registerIPC,
};
