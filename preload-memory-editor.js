/**
 * Preload script for Memory Editor window
 * Exposes window.memoryEditor for IPC communication with the main process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memoryEditor', {
  // Window control
  close: () => ipcRenderer.send('memory-editor:close'),

  // Agent list
  listAgentMemories: () => ipcRenderer.invoke('memory-editor:list'),

  // Load/save
  loadMemory: (agentId) => ipcRenderer.invoke('memory-editor:load', agentId),
  saveMemory: (agentId, content) => ipcRenderer.invoke('memory-editor:save', agentId, content),
  deleteMemory: (agentId) => ipcRenderer.invoke('memory-editor:delete', agentId),

  // Proposed edits (from memory-agent)
  getPendingEdits: () => ipcRenderer.invoke('memory-editor:get-pending'),
  applyPendingEdit: (editId, modifiedContent) =>
    ipcRenderer.invoke('memory-editor:apply-pending', editId, modifiedContent),
  rejectPendingEdit: (editId) => ipcRenderer.invoke('memory-editor:reject-pending', editId),

  // AI chat editing
  chatEdit: (agentId, currentContent, instruction) =>
    ipcRenderer.invoke('memory-editor:chat-edit', agentId, currentContent, instruction),

  // Events from main process
  onPendingEdit: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('memory-editor:pending-edit', handler);
    return () => ipcRenderer.removeListener('memory-editor:pending-edit', handler);
  },
  onMemoryUpdated: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('memory-editor:updated', handler);
    return () => ipcRenderer.removeListener('memory-editor:updated', handler);
  },
  onOpenAgent: (cb) => {
    const handler = (_e, agentId) => cb(agentId);
    ipcRenderer.on('memory-editor:open-agent', handler);
    return () => ipcRenderer.removeListener('memory-editor:open-agent', handler);
  },
});
