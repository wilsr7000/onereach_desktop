/**
 * Memory Editor API
 *
 * Core backend API for the Memory Editor component.
 * Provides CRUD for agent memories, a pending-edit queue for review-before-apply,
 * and AI-powered chat editing.
 *
 * Used by:
 * - memory-editor.html (via preload IPC bridge)
 * - memory-agent.js (proposeEdit for review flow)
 * - main.js (IPC handler registration)
 */

const { ipcMain, BrowserWindow } = require('electron');
const { getAgentMemory, listAgentMemories, deleteAgentMemory } = require('./agent-memory-store');
const ai = require('./ai-service');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const pendingEdits = new Map();
let _editorWindowRef = null;
let _editIdCounter = 0;

function setEditorWindow(win) {
  _editorWindowRef = win;
}

function getEditorWindow() {
  if (_editorWindowRef && !_editorWindowRef.isDestroyed()) return _editorWindowRef;
  return null;
}

/**
 * List all agent memories with metadata.
 * @returns {Promise<Array<{ agentId, displayName, lastUpdated, sizeChars }>>}
 */
async function listMemories() {
  const agentIds = listAgentMemories();
  const results = [];

  for (const agentId of agentIds) {
    try {
      const mem = getAgentMemory(agentId);
      if (!mem.isLoaded()) await mem.load();
      const raw = mem.getRaw();
      const titleMatch = raw.match(/^#\s+(.+)/m);
      results.push({
        agentId,
        displayName: titleMatch ? titleMatch[1].replace(' Memory', '') : agentId,
        lastUpdated: raw.match(/Last updated:\s*(.+)/)?.[1] || null,
        sizeChars: raw.length,
      });
    } catch (_err) {
      results.push({ agentId, displayName: agentId, lastUpdated: null, sizeChars: 0 });
    }
  }

  results.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return results;
}

/**
 * Load full memory content for an agent.
 * @param {string} agentId
 * @returns {Promise<{ agentId, displayName, content, lastUpdated }>}
 */
async function loadMemory(agentId) {
  const mem = getAgentMemory(agentId);
  if (!mem.isLoaded()) await mem.load();
  const raw = mem.getRaw();
  const titleMatch = raw.match(/^#\s+(.+)/m);
  return {
    agentId,
    displayName: titleMatch ? titleMatch[1].replace(' Memory', '') : agentId,
    content: raw,
    lastUpdated: raw.match(/Last updated:\s*(.+)/)?.[1] || null,
  };
}

/**
 * Save full memory content for an agent (from user edits).
 * @param {string} agentId
 * @param {string} content - Full markdown content
 * @returns {Promise<boolean>}
 */
async function saveMemory(agentId, content) {
  const mem = getAgentMemory(agentId);
  if (!mem.isLoaded()) await mem.load();
  mem.setRaw(content);
  await mem.save();
  log.info('agent', '[MemoryEditor] Saved memory', { agentId, chars: content.length });

  const win = getEditorWindow();
  if (win) {
    win.webContents.send('memory-editor:updated', { agentId });
  }
  return true;
}

/**
 * Delete an agent's memory.
 * @param {string} agentId
 * @returns {boolean}
 */
function deleteMemoryForAgent(agentId) {
  const result = deleteAgentMemory(agentId);
  log.info('agent', '[MemoryEditor] Deleted memory', { agentId, success: result });
  return result;
}

/**
 * Propose an edit for user review (called by memory-agent before applying).
 * Opens the editor window and shows the diff.
 *
 * @param {{ agentId, section, oldContent, newContent, reason }} edit
 * @returns {string} editId
 */
function proposeEdit(edit) {
  const editId = `edit-${++_editIdCounter}-${Date.now()}`;
  pendingEdits.set(editId, {
    ...edit,
    editId,
    timestamp: new Date().toISOString(),
  });

  log.info('agent', '[MemoryEditor] Proposed edit', {
    editId,
    agentId: edit.agentId,
    section: edit.section,
    reason: edit.reason,
  });

  const win = getEditorWindow();
  if (win) {
    win.webContents.send('memory-editor:pending-edit', { editId, ...edit });
    win.focus();
  }

  return editId;
}

/**
 * Get all pending edits.
 * @returns {Array}
 */
function getPendingEdits() {
  return Array.from(pendingEdits.values());
}

/**
 * Apply a pending edit (user approved it, possibly modified).
 * @param {string} editId
 * @param {string} [modifiedContent] - If user edited the proposed content
 * @returns {Promise<boolean>}
 */
async function applyPendingEdit(editId, modifiedContent) {
  const edit = pendingEdits.get(editId);
  if (!edit) return false;

  try {
    const mem = getAgentMemory(edit.agentId);
    if (!mem.isLoaded()) await mem.load();

    const contentToApply = modifiedContent || edit.newContent;

    if (edit.section) {
      mem.updateSection(edit.section, contentToApply);
    } else {
      mem.setRaw(contentToApply);
    }
    await mem.save();

    log.info('agent', '[MemoryEditor] Applied pending edit', { editId, agentId: edit.agentId });
    pendingEdits.delete(editId);
    return true;
  } catch (err) {
    log.error('agent', '[MemoryEditor] Failed to apply edit', { editId, error: err.message });
    return false;
  }
}

/**
 * Reject a pending edit (user declined it).
 * @param {string} editId
 * @returns {boolean}
 */
function rejectPendingEdit(editId) {
  const had = pendingEdits.has(editId);
  pendingEdits.delete(editId);
  if (had) log.info('agent', '[MemoryEditor] Rejected pending edit', { editId });
  return had;
}

/**
 * AI-powered chat editing: apply a natural-language instruction to memory markdown.
 * @param {string} agentId
 * @param {string} currentContent - Current markdown
 * @param {string} instruction - User's edit instruction
 * @returns {Promise<{ newContent: string, summary: string }>}
 */
async function chatEdit(agentId, currentContent, instruction) {
  const result = await ai.json(
    `You are editing an agent's memory file (Markdown format).

CURRENT CONTENT:
\`\`\`markdown
${currentContent}
\`\`\`

USER INSTRUCTION: "${instruction}"

Apply the user's instruction to the markdown content. Return JSON:
{
  "newContent": "The COMPLETE updated markdown (not a diff -- the full document)",
  "summary": "One-sentence summary of what you changed"
}

Rules:
- Preserve the overall structure (# title, ## sections, > metadata)
- Only change what the instruction asks for
- Keep the "Last updated" timestamp as-is (the system updates it on save)
- Return the FULL document, not just the changed parts`,
    { profile: 'fast', temperature: 0, maxTokens: 2000, feature: 'memory-editor' }
  );

  return {
    newContent: result.newContent || currentContent,
    summary: result.summary || 'Applied edit',
  };
}

/**
 * Register all IPC handlers. Called once from main.js.
 */
function registerIPC() {
  ipcMain.handle('memory-editor:list', async () => {
    return listMemories();
  });

  ipcMain.handle('memory-editor:load', async (_event, agentId) => {
    return loadMemory(agentId);
  });

  ipcMain.handle('memory-editor:save', async (_event, agentId, content) => {
    return saveMemory(agentId, content);
  });

  ipcMain.handle('memory-editor:delete', async (_event, agentId) => {
    return deleteMemoryForAgent(agentId);
  });

  ipcMain.handle('memory-editor:get-pending', async () => {
    return getPendingEdits();
  });

  ipcMain.handle('memory-editor:apply-pending', async (_event, editId, modifiedContent) => {
    return applyPendingEdit(editId, modifiedContent);
  });

  ipcMain.handle('memory-editor:reject-pending', async (_event, editId) => {
    return rejectPendingEdit(editId);
  });

  ipcMain.handle('memory-editor:chat-edit', async (_event, agentId, currentContent, instruction) => {
    return chatEdit(agentId, currentContent, instruction);
  });

  ipcMain.on('memory-editor:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  log.info('app', '[MemoryEditor] IPC handlers registered');
}

module.exports = {
  registerIPC,
  setEditorWindow,
  getEditorWindow,
  listMemories,
  loadMemory,
  saveMemory,
  deleteMemoryForAgent,
  proposeEdit,
  getPendingEdits,
  applyPendingEdit,
  rejectPendingEdit,
  chatEdit,
};
