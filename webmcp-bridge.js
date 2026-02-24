/**
 * WebMCP Bridge -- injected into webviews to intercept tool registrations.
 *
 * This IIFE runs inside the guest page context. It:
 *  1. Detects navigator.modelContext support
 *  2. Wraps registerTool / provideContext so every tool definition is
 *     captured and forwarded to the host via console.log JSON messages
 *  3. Keeps a local map of execute functions so the host can invoke them
 *     later through executeJavaScript calls
 *  4. Listens for unregisterTool / clearContext to keep the host in sync
 */
(function webmcpBridge() {
  'use strict';

  if (typeof navigator === 'undefined' || !('modelContext' in navigator)) {
    return;
  }

  const mc = navigator.modelContext;
  if (!mc || typeof mc.registerTool !== 'function') {
    return;
  }

  const PREFIX = '__webmcp__';
  const tools = {};        // name -> { execute, definition }
  let bridgeReady = false;

  // ── Helpers ──────────────────────────────────────────────

  function emit(type, payload) {
    // The host reads these via the webview 'console-message' event,
    // filtering for the PREFIX marker.
    console.log(JSON.stringify({ _webmcp: true, type, ...payload }));
  }

  function serializeTool(tool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || null,
      annotations: tool.annotations || null,
    };
  }

  // ── Intercept registerTool ───────────────────────────────

  const origRegister = mc.registerTool.bind(mc);

  mc.registerTool = function interceptedRegisterTool(tool) {
    if (!tool || !tool.name) return origRegister(tool);

    tools[tool.name] = {
      execute: tool.execute,
      definition: serializeTool(tool),
    };

    emit('tool-registered', { tool: serializeTool(tool) });
    return origRegister(tool);
  };

  // ── Intercept unregisterTool ─────────────────────────────

  if (typeof mc.unregisterTool === 'function') {
    const origUnregister = mc.unregisterTool.bind(mc);

    mc.unregisterTool = function interceptedUnregisterTool(name) {
      delete tools[name];
      emit('tool-unregistered', { name });
      return origUnregister(name);
    };
  }

  // ── Intercept provideContext (replaces all tools) ────────

  if (typeof mc.provideContext === 'function') {
    const origProvide = mc.provideContext.bind(mc);

    mc.provideContext = function interceptedProvideContext(options) {
      // Clear tracked tools -- provideContext replaces everything
      for (const key of Object.keys(tools)) delete tools[key];
      emit('context-cleared', {});

      if (options && Array.isArray(options.tools)) {
        for (const tool of options.tools) {
          if (tool && tool.name) {
            tools[tool.name] = {
              execute: tool.execute,
              definition: serializeTool(tool),
            };
            emit('tool-registered', { tool: serializeTool(tool) });
          }
        }
      }

      return origProvide(options);
    };
  }

  // ── Intercept clearContext ───────────────────────────────

  if (typeof mc.clearContext === 'function') {
    const origClear = mc.clearContext.bind(mc);

    mc.clearContext = function interceptedClearContext() {
      for (const key of Object.keys(tools)) delete tools[key];
      emit('context-cleared', {});
      return origClear();
    };
  }

  // ── Tool invocation (called from host via executeJavaScript) ──

  window[PREFIX + 'callTool'] = async function (name, input) {
    const entry = tools[name];
    if (!entry || typeof entry.execute !== 'function') {
      return { error: `Tool "${name}" not found or has no execute handler` };
    }
    try {
      const result = await entry.execute(input || {}, null);
      return { result };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  };

  // ── Tool enumeration (called from host via executeJavaScript) ──

  window[PREFIX + 'listTools'] = function () {
    return Object.values(tools).map((t) => t.definition);
  };

  bridgeReady = true;
  emit('bridge-ready', { toolCount: Object.keys(tools).length });
})();
