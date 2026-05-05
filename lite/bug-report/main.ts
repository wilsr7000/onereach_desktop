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
import { capture, type BugReportAttachment, type BugReportPayload } from './capture.js';
import { getBugReportApi, _resetBugReportApiForTesting } from './api.js';
import { getLoggingApi } from '../logging/api.js';
import { getHealthApi, type AppHealthSnapshot } from '../health/api.js';
import { getFilesApi, FilesError } from '../files/api.js';

const IPC_CAPTURE = 'lite:bug-report:capture';
const IPC_SAVE = 'lite:bug-report:save';
const IPC_CLOSE = 'lite:bug-report:close';
const IPC_LIST = 'lite:bug-report:list';
const IPC_READ = 'lite:bug-report:read';
const IPC_UPDATE = 'lite:bug-report:update';
const IPC_DELETE = 'lite:bug-report:delete';
const IPC_ATTACH = 'lite:bug-report:attach';
const IPC_DOWNLOAD_ATTACHMENT = 'lite:bug-report:download-attachment';

/** Files prefix where bug-report attachments live in the user's bucket. */
const ATTACHMENT_PREFIX = 'lite-bugs/attachments';
/** Hard ceiling on a single attachment (10 MB). Renderer can pre-warn. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Per-report attachment count cap (defensive, mostly UX). */
const MAX_ATTACHMENTS_PER_REPORT = 10;

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

  ipcMain.handle(IPC_SAVE, async (_event, userDescription: string, attachments?: unknown) => {
    getLoggingApi().event('bug-report.ipc.save');
    if (typeof userDescription !== 'string') {
      throw new Error('userDescription must be a string');
    }
    const sanitizedAttachments = sanitizeAttachments(attachments);
    if (sanitizedAttachments.length > MAX_ATTACHMENTS_PER_REPORT) {
      throw new Error(
        `attachments exceeds the per-report cap (${MAX_ATTACHMENTS_PER_REPORT})`
      );
    }
    const payload = await buildPayload(userDescription, sanitizedAttachments);
    return getBugReportApi().save(payload);
  });

  ipcMain.handle(
    IPC_ATTACH,
    async (
      _event,
      input: { name: unknown; contentType: unknown; base64: unknown }
    ): Promise<BugReportAttachment> => {
      getLoggingApi().event('bug-report.ipc.attach');
      const name = typeof input?.name === 'string' ? input.name : '';
      const contentType =
        typeof input?.contentType === 'string' && input.contentType.length > 0
          ? input.contentType
          : 'application/octet-stream';
      const base64 = typeof input?.base64 === 'string' ? input.base64 : '';
      if (name.length === 0) throw new Error('attach: name must be a non-empty string');
      if (base64.length === 0) throw new Error('attach: base64 must be a non-empty string');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        throw new Error('attach: decoded payload is empty');
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `attach: file exceeds ${MAX_ATTACHMENT_BYTES} bytes (got ${bytes.length})`
        );
      }
      const safeName = sanitizeFileName(name);
      // One folder per report-staging session so the modal can clean
      // up if the user cancels (cleanup on cancel is a future
      // hardening; today the orphan files just live in the user's
      // bucket until they prune them).
      const stagingPrefix = `${ATTACHMENT_PREFIX}/staging-${Date.now()}`;
      try {
        const url = await getFilesApi().upload(stagingPrefix, safeName, bytes, {
          contentType,
          isPublic: false,
          rewriteMode: 'rewrite',
          maxFileSize: MAX_ATTACHMENT_BYTES,
        });
        const key = `${stagingPrefix}/${safeName}`;
        getLoggingApi().info('bug-report', 'attachment uploaded', {
          key,
          bytes: bytes.length,
          contentType,
        });
        // The download URL the SDK returns is informational; the
        // renderer should always re-resolve via downloadAttachment()
        // since signed URLs expire.
        void url;
        return {
          key,
          name: safeName,
          contentType,
          size: bytes.length,
          uploadedAt: new Date().toISOString(),
        };
      } catch (err) {
        if (err instanceof FilesError) {
          // Bubble a clean message to the renderer.
          throw new Error(`attach failed: ${err.formatForUser()}`);
        }
        throw err;
      }
    }
  );

  ipcMain.handle(IPC_DOWNLOAD_ATTACHMENT, async (_event, key: unknown) => {
    getLoggingApi().event('bug-report.ipc.download-attachment', {
      key: typeof key === 'string' ? key : null,
    });
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('download-attachment: key must be a non-empty string');
    }
    // Restrict to the bug-attachments prefix so a buggy renderer
    // can't request arbitrary keys from the user's bucket.
    if (!key.startsWith(ATTACHMENT_PREFIX)) {
      throw new Error(
        `download-attachment: key must start with ${ATTACHMENT_PREFIX}`
      );
    }
    try {
      return await getFilesApi().getDownloadUrl(key);
    } catch (err) {
      if (err instanceof FilesError) {
        throw new Error(`download-attachment failed: ${err.formatForUser()}`);
      }
      throw err;
    }
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
async function buildPayload(
  userDescription: string,
  attachments: BugReportAttachment[] = []
): Promise<BugReportPayload> {
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
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

/**
 * Tighten the renderer-supplied attachments list. Drops any entry
 * that doesn't have the required shape (key + name + size) so a
 * buggy renderer can't sneak garbage onto the payload. Keeps key
 * paths inside the ATTACHMENT_PREFIX so we can't be tricked into
 * referencing files outside the bug-attachments folder.
 */
function sanitizeAttachments(input: unknown): BugReportAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: BugReportAttachment[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const key = typeof v['key'] === 'string' ? v['key'] : '';
    const name = typeof v['name'] === 'string' ? v['name'] : '';
    const contentType =
      typeof v['contentType'] === 'string' && v['contentType'].length > 0
        ? v['contentType']
        : 'application/octet-stream';
    const size = typeof v['size'] === 'number' && Number.isFinite(v['size']) ? v['size'] : 0;
    const uploadedAt =
      typeof v['uploadedAt'] === 'string' ? v['uploadedAt'] : new Date().toISOString();
    if (key.length === 0 || name.length === 0) continue;
    if (!key.startsWith(ATTACHMENT_PREFIX)) continue;
    out.push({ key, name, contentType, size, uploadedAt });
  }
  return out;
}

/**
 * Replace path separators + control chars in a user-supplied filename
 * so we can't write to arbitrary subfolders. Keeps the original name
 * recognizable (a screenshot called "Screen Shot 2026.png" still
 * looks reasonable after sanitizing).
 */
function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\\u0000-\u001f]/g, '_').trim();
  if (cleaned.length === 0) return `attachment-${Date.now()}`;
  return cleaned.slice(0, 200);
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
  ipcMain.removeHandler(IPC_ATTACH);
  ipcMain.removeHandler(IPC_DOWNLOAD_ATTACHMENT);
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
  attach: IPC_ATTACH,
  downloadAttachment: IPC_DOWNLOAD_ATTACHMENT,
};

/** @internal -- exposed for the event-name conformance test. */
export const BUG_REPORT_ATTACHMENT_PREFIX = ATTACHMENT_PREFIX;
