/**
 * Bug-report main-process orchestration.
 *
 * Owns:
 *   - The bug-report modal BrowserWindow lifecycle
 *   - IPC handlers for bug-report:capture and bug-report:save
 *   - Fetching recent log lines from lite's log server
 *
 * Renderer side lives in modal.html / modal.ts. Preload bridge in
 * preload-lite.ts exposes a `window.bugReport` API the renderer calls.
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as os from 'node:os';
import * as http from 'node:http';
import { capture, type BugReportPayload } from './capture.js';
import { getBugReportApi, _resetBugReportApiForTesting } from './api.js';
import { getLoggingApi } from '../logging/api.js';
import { getHealthApi, type AppHealthSnapshot } from '../health/api.js';

const IPC_CAPTURE = 'lite:bug-report:capture';
const IPC_SAVE = 'lite:bug-report:save';
const IPC_CLOSE = 'lite:bug-report:close';
const IPC_LIST = 'lite:bug-report:list';
const IPC_READ = 'lite:bug-report:read';
const IPC_UPDATE = 'lite:bug-report:update';
const IPC_DELETE = 'lite:bug-report:delete';

let modalWindow: BrowserWindow | null = null;
let handlersRegistered = false;

interface InitOptions {
  /** Port lite's log server is listening on (default 47392) */
  logServerPort: number;
  /** Path to the bundled preload-lite.js */
  preloadPath: string;
  /** Path to the modal.html file */
  modalHtmlPath: string;
  /** Lite app version to forward to the modal renderer */
  liteVersion: string;
  /** Optional parent window (the main placeholder window) */
  getParentWindow: () => BrowserWindow | null;
}

let options: InitOptions | null = null;

/**
 * Register IPC handlers and remember options. Call once at app boot.
 */
export function initBugReport(opts: InitOptions): void {
  if (handlersRegistered) return;
  options = opts;

  // ADR-026: every IPC handler emits an instant `bug-report.ipc.<verb>`
  // event on entry so renderer-driven activity is observable in /logs.
  // The downstream operation emits its own bug-report.<op> span.

  ipcMain.handle(IPC_CAPTURE, async (_event, userDescription: string) => {
    getLoggingApi().event('bug-report.ipc.capture');
    if (typeof userDescription !== 'string') {
      throw new Error('userDescription must be a string');
    }
    return capturePreview(userDescription);
  });

  ipcMain.handle(IPC_SAVE, async (_event, userDescription: string) => {
    getLoggingApi().event('bug-report.ipc.save');
    if (typeof userDescription !== 'string') {
      throw new Error('userDescription must be a string');
    }
    const payload = await buildPayload(userDescription);
    return getBugReportApi().save(payload);
  });

  ipcMain.on(IPC_CLOSE, () => {
    getLoggingApi().event('bug-report.ipc.close');
    if (modalWindow !== null && !modalWindow.isDestroyed()) {
      modalWindow.close();
    }
  });

  ipcMain.handle(IPC_LIST, async () => {
    getLoggingApi().event('bug-report.ipc.list');
    return getBugReportApi().list();
  });

  ipcMain.handle(IPC_READ, async (_event, idOrPath: string) => {
    getLoggingApi().event('bug-report.ipc.read', { idOrPath });
    if (typeof idOrPath !== 'string') {
      throw new Error('idOrPath must be a string');
    }
    return getBugReportApi().read(idOrPath);
  });

  ipcMain.handle(
    IPC_UPDATE,
    async (
      _event,
      timestamp: string,
      updates: { status?: 'open' | 'resolved'; notes?: string }
    ) => {
      getLoggingApi().event('bug-report.ipc.update', { timestamp });
      if (typeof timestamp !== 'string' || timestamp.length === 0) {
        throw new Error('timestamp must be a non-empty string');
      }
      if (typeof updates !== 'object' || updates === null) {
        throw new Error('updates must be an object');
      }
      const sanitized: { status?: 'open' | 'resolved'; notes?: string } = {};
      if (updates.status === 'open' || updates.status === 'resolved') {
        sanitized.status = updates.status;
      }
      if (typeof updates.notes === 'string') {
        sanitized.notes = updates.notes;
      }
      return getBugReportApi().update(timestamp, sanitized);
    }
  );

  ipcMain.handle(IPC_DELETE, async (_event, timestamp: string) => {
    getLoggingApi().event('bug-report.ipc.delete', { timestamp });
    if (typeof timestamp !== 'string' || timestamp.length === 0) {
      throw new Error('timestamp must be a non-empty string');
    }
    return getBugReportApi().delete(timestamp);
  });

  handlersRegistered = true;
}

/**
 * Open (or focus) the bug-report modal window.
 * Triggered by the help:report-bug menu entry / Cmd+Shift+/.
 */
export function openBugReportModal(): void {
  if (options === null) {
    throw new Error('initBugReport must be called before openBugReportModal');
  }
  if (modalWindow !== null && !modalWindow.isDestroyed()) {
    modalWindow.focus();
    return;
  }

  const parent = options.getParentWindow();
  const baseOptions: Electron.BrowserWindowConstructorOptions = {
    width: 760,
    height: 680,
    minWidth: 680,
    minHeight: 600,
    title: 'Report a Bug',
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`--lite-app-version=${options.liteVersion}`],
    },
  };
  // Only set modal+parent when we actually have a parent window. Setting
  // parent: undefined trips exactOptionalPropertyTypes: true.
  modalWindow = parent !== null
    ? new BrowserWindow({ ...baseOptions, modal: true, parent })
    : new BrowserWindow(baseOptions);

  void modalWindow.loadFile(options.modalHtmlPath);
  modalWindow.once('ready-to-show', () => {
    modalWindow?.show();
  });

  modalWindow.on('closed', () => {
    modalWindow = null;
  });
}

/**
 * Build a redacted payload preview without writing to disk.
 * Returns both the payload object and a JSON-stringified preview.
 */
async function capturePreview(userDescription: string): Promise<{
  payload: BugReportPayload;
  payloadJson: string;
  redactionStatus: BugReportPayload['redactionTelemetry']['bucket'];
  redactionTotalCount: number;
}> {
  const payload = await buildPayload(userDescription);
  const counts = payload.redactionTelemetry.countsByKind;
  const redactionTotalCount = Object.values(counts).reduce((acc, c) => acc + c, 0);
  return {
    payload,
    payloadJson: JSON.stringify(payload, null, 2),
    redactionStatus: payload.redactionTelemetry.bucket,
    redactionTotalCount,
  };
}

/**
 * Build the structured payload from current app state + log server.
 */
async function buildPayload(userDescription: string): Promise<BugReportPayload> {
  if (options === null) {
    throw new Error('initBugReport must be called before buildPayload');
  }
  const recentLogLines = await fetchRecentLogs(options.logServerPort);
  // Best-effort health snapshot (ADR-036). If the health module is
  // unavailable or the snapshot throws unexpectedly, file the bug
  // anyway -- the snapshot is supplementary diagnostic context, not
  // load-bearing evidence.
  let healthSnapshot: AppHealthSnapshot | undefined;
  try {
    healthSnapshot = await getHealthApi().snapshot();
  } catch (err) {
    getLoggingApi().warn('bug-report', 'health snapshot fetch failed; filing without it', {
      error: (err as Error).message,
    });
  }
  return capture({
    // Use the version main-lite.ts forwarded via initBugReport(). In dev
    // mode (`electron <script>`) app.getVersion() returns Electron's own
    // version (41.2.1) rather than ours, so we can't rely on it.
    version: options.liteVersion,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    recentLogLines,
    userDescription,
    ...(healthSnapshot !== undefined ? { healthSnapshot } : {}),
  });
}

/**
 * Fetch the most recent log lines from lite's log server. Returns an
 * empty array if the server is unreachable (so bug reports still work
 * even if the log server failed to start).
 */
function fetchRecentLogs(port: number): Promise<string[]> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/logs?limit=200',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            // Lite's log server returns logs under `data` (the new shape).
            // Accept `logs` as a fallback for forward compatibility with
            // any older log-server build.
            const parsed = JSON.parse(body) as {
              logs?: Array<{ timestamp?: string; level?: string; category?: string; message?: string }>;
              data?: Array<{ timestamp?: string; level?: string; category?: string; message?: string }>;
            };
            const logs = parsed.logs ?? parsed.data ?? [];
            const lines = logs.map((entry) => {
              const ts = entry.timestamp ?? '';
              const lvl = (entry.level ?? 'info').toUpperCase();
              const cat = entry.category ?? 'app';
              const msg = entry.message ?? '';
              return `${ts} [${lvl}] ${cat}: ${msg}`;
            });
            resolve(lines);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

/**
 * Tear down for tests.
 */
export function _teardownForTesting(): void {
  if (modalWindow !== null && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
  modalWindow = null;
  ipcMain.removeHandler(IPC_CAPTURE);
  ipcMain.removeHandler(IPC_SAVE);
  ipcMain.removeHandler(IPC_LIST);
  ipcMain.removeHandler(IPC_READ);
  ipcMain.removeHandler(IPC_UPDATE);
  ipcMain.removeHandler(IPC_DELETE);
  ipcMain.removeAllListeners(IPC_CLOSE);
  handlersRegistered = false;
  options = null;
  // Reset the API singleton so a subsequent init() picks up a fresh
  // instance (e.g. with a test-injected store).
  _resetBugReportApiForTesting();
}

export const BUG_REPORT_IPC = {
  capture: IPC_CAPTURE,
  save: IPC_SAVE,
  close: IPC_CLOSE,
  list: IPC_LIST,
  read: IPC_READ,
  update: IPC_UPDATE,
  delete: IPC_DELETE,
};
