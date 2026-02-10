'use strict';

const { ipcMain } = require('electron');
const { TestAuditOrchestrator } = require('./orchestrator');

let orchestrator = null;
let registered = false;

/**
 * Register IPC handlers for the test audit orchestrator.
 * Call this once from main.js during app initialization.
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
function registerAuditIPC() {
  if (registered) {
    console.log('[Audit] IPC handlers already registered, skipping');
    return;
  }
  registered = true;
  // Lazy init: create orchestrator on first IPC call
  async function getOrchestrator() {
    if (!orchestrator) {
      orchestrator = new TestAuditOrchestrator();
      await orchestrator.init();
    }
    return orchestrator;
  }

  ipcMain.handle('audit:init', async () => {
    const orch = await getOrchestrator();
    return orch.status();
  });

  ipcMain.handle('audit:next', async () => {
    const orch = await getOrchestrator();
    return orch.next();
  });

  ipcMain.handle('audit:run', async (_event, itemId) => {
    const orch = await getOrchestrator();
    return orch.run(itemId);
  });

  ipcMain.handle('audit:plan', async (_event, planNumber) => {
    const orch = await getOrchestrator();
    return orch.runPlan(planNumber);
  });

  ipcMain.handle('audit:regression', async () => {
    const orch = await getOrchestrator();
    return orch.regression();
  });

  ipcMain.handle('audit:retry-failed', async () => {
    const orch = await getOrchestrator();
    return orch.retryFailed();
  });

  ipcMain.handle('audit:skip', async (_event, itemId, reason) => {
    const orch = await getOrchestrator();
    return orch.skip(itemId, reason);
  });

  ipcMain.handle('audit:block', async (_event, itemId, reason) => {
    const orch = await getOrchestrator();
    return orch.block(itemId, reason);
  });

  ipcMain.handle('audit:status', async () => {
    const orch = await getOrchestrator();
    return orch.status();
  });

  ipcMain.handle('audit:report', async (_event, format) => {
    const orch = await getOrchestrator();
    return orch.report(format || 'markdown');
  });

  ipcMain.handle('audit:item', async (_event, itemId) => {
    const orch = await getOrchestrator();
    return orch.getItem(itemId);
  });

  ipcMain.handle('audit:record', async (_event, itemId, status, notes) => {
    const orch = await getOrchestrator();
    return orch.recordResult(itemId, status, notes);
  });

  ipcMain.handle('audit:reset', async (_event, confirm) => {
    const orch = await getOrchestrator();
    return orch.reset(confirm);
  });

  console.log('[Audit] IPC handlers registered');
}

/**
 * Gracefully close the orchestrator (call on app quit).
 */
async function closeAuditOrchestrator() {
  if (orchestrator) {
    try {
      await orchestrator.close();
    } catch (e) {
      console.error('[Audit] Error closing orchestrator:', e.message);
    }
    orchestrator = null;
  }
}

module.exports = { registerAuditIPC, closeAuditOrchestrator };
