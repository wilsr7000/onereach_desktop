/**
 * GSX Branch Manager
 *
 * Per-branch coding sessions powered by Claude Code.
 * Drop-in replacement for the retired `BranchAiderManager` in main.js:
 *  - same constructor (no args)
 *  - same async methods (initialize, initBranch, runBranchPrompt,
 *    cleanupBranch, cleanupAll, getBranchLog, getOrchestrationLog,
 *    getActiveBranches)
 *  - same log-file layout under `<spacePath>/logs/orchestration.log`
 *    and `<spacePath>/logs/branches/<branchId>.log`
 *
 * Each branch gets its own `GSXCreateEngine` instance, so Claude Code
 * sessions are fully isolated per branch. A branch's Claude Code
 * session id is kept in the engine, enabling natural --resume behavior
 * across successive prompts.
 */

const fs = require('fs');
const path = require('path');
const { GSXCreateEngine } = require('./gsx-create-engine');

class GSXBranchManager {
  constructor() {
    /** @type {Map<string, { engine: GSXCreateEngine, branchPath: string, logFile: string, startTime: Date, model: string }>} */
    this.branches = new Map();
    /** @type {string|null} */
    this.logsDir = null;
    /** @type {string|null} */
    this.orchestrationLogFile = null;
  }

  async initialize(spacePath) {
    if (!spacePath || typeof spacePath !== 'string') {
      throw new Error(
        `[GSXBranchManager] Invalid spacePath: ${JSON.stringify(spacePath)} (type: ${typeof spacePath})`
      );
    }

    this.logsDir = path.join(spacePath, 'logs');
    const branchLogsDir = path.join(this.logsDir, 'branches');

    if (!fs.existsSync(branchLogsDir)) {
      fs.mkdirSync(branchLogsDir, { recursive: true });
    }

    this.orchestrationLogFile = path.join(this.logsDir, 'orchestration.log');
    this.logOrchestration('SESSION', 'GSX Branch Manager initialized');
  }

  logOrchestration(level, message, data = {}) {
    if (!this.orchestrationLogFile) return;

    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${level}: ${message}${
      Object.keys(data).length ? ' ' + JSON.stringify(data) : ''
    }\n`;

    try {
      fs.appendFileSync(this.orchestrationLogFile, logLine);
    } catch (e) {
      console.error('[GSXBranchManager] Failed to write orchestration log:', e);
    }
    console.log(`[GSXBranchManager] ${level}: ${message}`);
  }

  logBranch(branchId, level, message, data = {}) {
    if (!this.logsDir) return;

    const logFile = path.join(this.logsDir, 'branches', `${branchId}.log`);
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${level}: ${message}${
      Object.keys(data).length ? ' ' + JSON.stringify(data) : ''
    }\n`;

    try {
      fs.appendFileSync(logFile, logLine);
    } catch (e) {
      console.error(`[GSXBranchManager] Failed to write branch log ${branchId}:`, e);
    }
  }

  async initBranch(branchPath, branchId, model, readOnlyFiles = []) {
    if (!branchPath || typeof branchPath !== 'string') {
      throw new Error(
        `[GSXBranchManager] Invalid branchPath: ${JSON.stringify(branchPath)} (type: ${typeof branchPath})`
      );
    }
    if (!branchId || typeof branchId !== 'string') {
      throw new Error(
        `[GSXBranchManager] Invalid branchId: ${JSON.stringify(branchId)} (type: ${typeof branchId})`
      );
    }
    if (!this.logsDir) {
      throw new Error(
        '[GSXBranchManager] logsDir is not set. Call initialize() first before initBranch().'
      );
    }

    this.logOrchestration('BRANCH', `Initializing ${branchId}`, { model, branchPath });

    // Clean up any existing engine for this branchId
    if (this.branches.has(branchId)) {
      this.logOrchestration('WARN', `Branch ${branchId} already initialized, cleaning up first`);
      await this.cleanupBranch(branchId);
    }

    // New Claude Code-backed engine for this branch
    const engine = new GSXCreateEngine({
      sessionKey: `gsx-branch-${branchId}`,
      feature: 'gsx-create-branch',
    });
    await engine.start();

    const initResult = await engine.initialize(branchPath, model || 'claude-opus-4-7');
    if (!initResult.success) {
      throw new Error(`Failed to initialize branch engine: ${initResult.error || 'unknown error'}`);
    }

    // Record read-only files so the engine's system prompt warns the model off them
    await engine.sendRequest('set_sandbox', {
      sandbox_root: branchPath,
      read_only_files: readOnlyFiles,
      branch_id: branchId,
    });

    // Seed the engine's file-context list with non-hidden, non-metadata files
    // in the branch directory. Claude Code discovers files on demand, but
    // surfacing this list in the system prompt mirrors Aider's behavior so
    // the user's selected files stay "primary" in the conversation.
    try {
      const branchFiles = fs.readdirSync(branchPath);
      const editableFiles = branchFiles
        .filter((f) => {
          const filePath = path.join(branchPath, f);
          let stat;
          try {
            stat = fs.statSync(filePath);
          } catch {
            return false;
          }
          return stat.isFile() && !f.startsWith('.') && !f.endsWith('.json');
        })
        .map((f) => path.join(branchPath, f));

      if (editableFiles.length > 0) {
        await engine.addFiles(editableFiles);
        this.logBranch(branchId, 'FILES', `Added ${editableFiles.length} files to context`, {
          files: editableFiles.map((f) => path.basename(f)),
        });
      }
    } catch (fileError) {
      console.warn(`[GSXBranchManager] Could not list branch files:`, fileError.message);
    }

    this.branches.set(branchId, {
      engine,
      branchPath,
      logFile: path.join(this.logsDir, 'branches', `${branchId}.log`),
      startTime: new Date(),
      model: model || 'claude-opus-4-7',
    });

    this.logOrchestration('BRANCH', `${branchId} started`, { model });
    this.logBranch(branchId, 'INIT', `Claude Code engine initialized`, {
      branchPath,
      model,
      sandbox: true,
    });

    return { success: true, branchId };
  }

  async runBranchPrompt(branchId, prompt, streamCallback = null) {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not initialized`);
    }

    const preview = (prompt || '').substring(0, 200);
    this.logBranch(branchId, 'PROMPT', preview + (prompt && prompt.length > 200 ? '...' : ''));
    this.logOrchestration('BRANCH', `${branchId} executing prompt`, {
      promptLength: prompt ? prompt.length : 0,
    });

    let result;
    if (streamCallback) {
      result = await branch.engine.runPromptStreaming(prompt, streamCallback);
    } else {
      result = await branch.engine.runPrompt(prompt);
    }

    this.logBranch(branchId, 'RESPONSE', `Success: ${result.success}`, {
      sessionId: result.sessionId,
      usage: result.usage,
    });

    return result;
  }

  async cleanupBranch(branchId) {
    const branch = this.branches.get(branchId);
    if (!branch) {
      return { success: true, message: 'Branch not found (already cleaned up)' };
    }

    this.logOrchestration('BRANCH', `${branchId} cleaning up`);
    this.logBranch(branchId, 'CLEANUP', 'Shutting down engine');

    try {
      await branch.engine.shutdown();
    } catch (e) {
      console.error(`[GSXBranchManager] Error shutting down branch ${branchId}:`, e);
    }

    this.branches.delete(branchId);
    this.logOrchestration('BRANCH', `${branchId} cleaned up`);
    return { success: true };
  }

  async cleanupAll() {
    this.logOrchestration('SESSION', 'Cleaning up all branches');
    for (const branchId of Array.from(this.branches.keys())) {
      // eslint-disable-next-line no-await-in-loop
      await this.cleanupBranch(branchId);
    }
    this.logOrchestration('SESSION', 'All branches cleaned up');
  }

  getBranchLog(branchId) {
    if (!this.logsDir) return null;
    const logFile = path.join(this.logsDir, 'branches', `${branchId}.log`);
    try {
      if (fs.existsSync(logFile)) {
        return fs.readFileSync(logFile, 'utf-8');
      }
    } catch (e) {
      console.error(`[GSXBranchManager] Error reading branch log ${branchId}:`, e);
    }
    return null;
  }

  getOrchestrationLog() {
    if (!this.orchestrationLogFile) return null;
    try {
      if (fs.existsSync(this.orchestrationLogFile)) {
        return fs.readFileSync(this.orchestrationLogFile, 'utf-8');
      }
    } catch (e) {
      console.error('[GSXBranchManager] Error reading orchestration log:', e);
    }
    return null;
  }

  getActiveBranches() {
    return Array.from(this.branches.entries()).map(([id, info]) => ({
      branchId: id,
      branchPath: info.branchPath,
      model: info.model,
      startTime: info.startTime.toISOString(),
    }));
  }
}

module.exports = { GSXBranchManager };
