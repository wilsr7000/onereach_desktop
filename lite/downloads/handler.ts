/**
 * Downloads module — `will-download` orchestrator.
 *
 * Hooks an Electron session's `will-download` event and runs the
 * three-button decision flow (mirrors the full app's
 * `handleDownloadWithSpaceOption` in `browserWindow.js`):
 *
 *     "Save to Downloads"  → set savePath to the OS Downloads folder
 *                            and resume; same behavior as the default
 *                            Electron download dialog.
 *
 *     "Save to Space"      → set savePath to a temp file, resume the
 *                            download, open the picker so the user
 *                            picks a destination Space, then on `done`:
 *                              1. Read the temp file bytes
 *                              2. Upload via `getFilesApi().upload(...)`
 *                              3. Create the :Asset with
 *                                 `getSpacesApi().items.create({...})`
 *                              4. Delete the temp file
 *                            Surfaces a native notification on success
 *                            or failure so the user has feedback even
 *                            when the picker window is already closed.
 *
 *     "Cancel"             → `item.cancel()`.
 *
 * Single-flight at the picker level (the picker BrowserWindow is
 * itself single-instance, see `picker-window.ts`): if a second
 * download fires while a picker is already open, the second download
 * is silently dropped to the OS Downloads folder rather than being
 * rejected outright — the user still gets their file.
 *
 * @internal -- main-process orchestrator only.
 */

import {
  app,
  dialog,
  Notification,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type Event as ElectronEvent,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  deriveKindFromMime,
  sanitizeFileName,
  composeStorageKey,
  composeStoragePrefix,
} from './mime.js';
import {
  openSpacePicker,
  _hasActivePickerForTesting,
} from './picker-window.js';
import type { CapturedDownload, PickerBootstrap, PickerSpace } from './types.js';
import { getFilesApi } from '../files/api.js';
import { getSpacesApi, type CreateAssetInput } from '../spaces/api.js';
import { getAuthApi } from '../auth/api.js';
import { getLoggingApi } from '../logging/api.js';
import { DOWNLOADS_EVENTS } from './events.js';

/** Logger contract — slim, matches the existing per-module shape. */
export interface DownloadsLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface DownloadsHandlerOptions {
  /** Absolute file path of the picker HTML in `dist-lite/build/`. */
  pickerHtmlPath: string;
  /** Absolute file path of the preload bundle (already on disk). */
  preloadPath: string;
  /** Returns the main window to anchor / center the picker on, or null. */
  getParentWindow?: () => BrowserWindow | null;
  /** Optional structured logger; falls back to console when omitted. */
  logger?: DownloadsLogger;
  /**
   * Source label resolver -- given the webContents that triggered the
   * download, returns a human-friendly label like `tab:t-xyz` or
   * `Main`. Optional; defaults to `'webContents:<id>'`.
   */
  describeSource?: (wc: WebContents | null) => string;
}

/**
 * Attach a `will-download` listener to a session and return an
 * `unhook` function. Wired once per session: chrome session,
 * per-tab partitions, ai-window sessions, etc. all share the same
 * handler implementation.
 */
export function attachWillDownloadHandler(
  session: Electron.Session,
  opts: DownloadsHandlerOptions
): () => void {
  const log = opts.logger ?? defaultLogger();
  const listener = (
    _event: ElectronEvent,
    item: DownloadItem,
    wc: WebContents
  ): void => {
    try {
      void handleWillDownload(item, wc, opts, log);
    } catch (err) {
      log.error('handleWillDownload threw synchronously', {
        error: (err as Error).message,
      });
      // Last-ditch: route to the OS Downloads folder rather than
      // leaving the item paused forever.
      safeRouteToDownloads(item, log);
    }
  };
  session.on('will-download', listener);
  return () => {
    session.removeListener('will-download', listener);
  };
}

// ─── core flow ─────────────────────────────────────────────────────────────

async function handleWillDownload(
  item: DownloadItem,
  wc: WebContents,
  opts: DownloadsHandlerOptions,
  log: DownloadsLogger
): Promise<void> {
  const captured = captureDownloadContext(item, wc, opts);
  log.info('download captured', {
    id: captured.id,
    fileName: captured.fileName,
    mimeType: captured.mimeType,
    totalBytes: captured.totalBytes,
    source: captured.source,
  });
  getLoggingApi().event(DOWNLOADS_EVENTS.CAPTURED, {
    id: captured.id,
    fileName: captured.fileName,
    mimeType: captured.mimeType,
    kind: captured.kind,
    totalBytes: captured.totalBytes,
    source: captured.source,
  });

  // Show the same 3-button dialog the full app uses. Application-modal
  // (no parent passed) so the prompt comes forward even when focus is
  // in a different app -- mirrors lite/updater's modal-focus fix.
  let response: number;
  try {
    app.focus({ steal: true });
  } catch {
    /* best-effort */
  }
  try {
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Save to Downloads', 'Save to Space', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      title: 'Save Download',
      message: `How would you like to save "${captured.fileName}"?`,
      detail:
        'Save it to your Downloads folder, or upload it into a OneReach Space ' +
        'where it becomes an asset alongside your other items.',
    });
    response = result.response;
  } catch (err) {
    log.error('download dialog threw', {
      id: captured.id,
      error: (err as Error).message,
    });
    safeRouteToDownloads(item, log);
    return;
  }

  if (response === 0) {
    getLoggingApi().event(DOWNLOADS_EVENTS.ROUTED_TO_DOWNLOADS, { id: captured.id });
    routeToDownloads(item, captured, log);
    return;
  }
  if (response === 2) {
    log.info('download cancelled by user', { id: captured.id });
    getLoggingApi().event(DOWNLOADS_EVENTS.CANCELLED, {
      id: captured.id,
      stage: 'dialog',
    });
    try {
      item.cancel();
    } catch (err) {
      log.warn('item.cancel threw', { id: captured.id, error: (err as Error).message });
    }
    return;
  }

  // "Save to Space" path. The picker is single-instance; if one is
  // already open we fall back to the OS Downloads folder rather than
  // queue (matches the orchestrator's "one decision at a time" intent
  // without forcing the user to wait).
  if (_hasActivePickerForTesting()) {
    log.warn('picker busy -- falling back to Downloads folder', {
      id: captured.id,
    });
    getLoggingApi().event(DOWNLOADS_EVENTS.PICKER_BUSY_FALLBACK, { id: captured.id });
    routeToDownloads(item, captured, log);
    return;
  }

  await runSaveToSpace(item, captured, opts, log);
}

async function runSaveToSpace(
  item: DownloadItem,
  captured: CapturedDownload,
  opts: DownloadsHandlerOptions,
  log: DownloadsLogger
): Promise<void> {
  // Start the download to a temp file IMMEDIATELY while we open the
  // picker. The picker promise + the download `done` event run in
  // parallel; we synchronize on Promise.all below.
  const tempPath = path.join(
    app.getPath('temp'),
    `lite-download-${captured.id}-${captured.fileName}`
  );
  try {
    item.setSavePath(tempPath);
    item.resume();
  } catch (err) {
    log.error('failed to start download to temp', {
      id: captured.id,
      error: (err as Error).message,
    });
    safeRouteToDownloads(item, log);
    return;
  }

  // Bootstrap payload for the picker. We surface a load failure to the
  // user via the picker's own error block rather than crashing the
  // window — the bootstrap channel just throws and the renderer renders
  // the message inline.
  let bootstrap: PickerBootstrap;
  try {
    bootstrap = await buildBootstrap(captured);
  } catch (err) {
    log.error('failed to build picker bootstrap', {
      id: captured.id,
      error: (err as Error).message,
    });
    // No picker → cancel + notify. Don't dump to OS Downloads because
    // the user explicitly chose Space and we should respect that.
    safeCancel(item);
    void cleanupTemp(tempPath);
    notifyFail(captured.fileName, (err as Error).message);
    return;
  }

  // Spin up the picker. The picker's `closed` event resolves to null
  // if the user dismisses without choosing.
  const parent =
    typeof opts.getParentWindow === 'function' ? opts.getParentWindow() : null;
  const pickerPromise = openSpacePicker(
    {
      parent,
      htmlPath: opts.pickerHtmlPath,
      preloadPath: opts.preloadPath,
      downloadId: captured.id,
    },
    bootstrap
  );

  // Wait for both: (a) the picker to settle, (b) the download to
  // finish. We don't await sequentially because we want to surface
  // network errors as soon as they happen, not after the user picks.
  const donePromise = waitForDoneState(item);

  const [pickerResult, doneState] = await Promise.all([
    pickerPromise,
    donePromise,
  ]);

  if (pickerResult === null) {
    log.info('picker cancelled', { id: captured.id });
    // Download might have completed already; either way, scrub the
    // temp file. If the download is still in flight (rare race), the
    // OS will clean up the partial file when fsp.rm runs.
    void cleanupTemp(tempPath);
    return;
  }

  if (doneState !== 'completed') {
    log.warn('download did not complete', {
      id: captured.id,
      state: doneState,
    });
    void cleanupTemp(tempPath);
    notifyFail(
      captured.fileName,
      `Download ${doneState} before upload could start.`
    );
    return;
  }

  // Upload + asset-create. Surface failures inline through a
  // notification (the picker window has already closed). The span
  // makes the most failure-prone path (temp read -> Files.upload ->
  // Spaces.items.create -> cleanup) traceable with a duration in
  // `/logs?category=downloads`.
  // Span base name -- the logging API auto-appends `.start` / `.finish`
  // / `.fail` (declared in DOWNLOADS_EVENTS as SAVE_TO_SPACE_*).
  const span = getLoggingApi().start('downloads.save-to-space', {
    id: captured.id,
    spaceId: pickerResult.spaceId,
  });
  try {
    await uploadAndCreateAsset({
      captured,
      tempPath,
      pickerResult,
      log,
    });
    span.finish({ id: captured.id, spaceId: pickerResult.spaceId });
    notifySuccess(captured.fileName, pickerResult.spaceName);
  } catch (err) {
    span.fail(err);
    log.error('upload + asset-create failed', {
      id: captured.id,
      error: (err as Error).message,
    });
    notifyFail(captured.fileName, (err as Error).message);
  } finally {
    void cleanupTemp(tempPath);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function captureDownloadContext(
  item: DownloadItem,
  wc: WebContents,
  opts: DownloadsHandlerOptions
): CapturedDownload {
  const rawName = item.getFilename();
  const fileName = sanitizeFileName(rawName);
  const mimeType = item.getMimeType();
  const totalBytes = Math.max(0, Math.round(item.getTotalBytes() || 0));
  const url = item.getURL();
  const source =
    typeof opts.describeSource === 'function'
      ? opts.describeSource(wc)
      : `webContents:${wc.id}`;
  return {
    id: randomUUID().replace(/-/g, '').slice(0, 10),
    fileName,
    mimeType,
    kind: deriveKindFromMime(mimeType, fileName),
    totalBytes,
    source,
    url,
  };
}

function routeToDownloads(
  item: DownloadItem,
  captured: CapturedDownload,
  log: DownloadsLogger
): void {
  const downloadsPath = app.getPath('downloads');
  const filePath = path.join(downloadsPath, captured.fileName);
  try {
    item.setSavePath(filePath);
    item.resume();
    log.info('download routed to Downloads folder', {
      id: captured.id,
      filePath,
    });
    item.once('done', (_evt: ElectronEvent, state: string) => {
      if (state === 'completed') {
        notifyDownloadsComplete(captured.fileName, filePath);
      } else {
        log.warn('download to Downloads folder did not complete', {
          id: captured.id,
          state,
        });
      }
    });
  } catch (err) {
    log.error('failed to route download to Downloads folder', {
      id: captured.id,
      error: (err as Error).message,
    });
    safeCancel(item);
  }
}

function safeRouteToDownloads(item: DownloadItem, log: DownloadsLogger): void {
  try {
    const fileName = sanitizeFileName(item.getFilename());
    const filePath = path.join(app.getPath('downloads'), fileName);
    item.setSavePath(filePath);
    item.resume();
  } catch (err) {
    log.error('safeRouteToDownloads failed', {
      error: (err as Error).message,
    });
    safeCancel(item);
  }
}

function safeCancel(item: DownloadItem): void {
  try {
    item.cancel();
  } catch {
    /* item may already be in a terminal state */
  }
}

/**
 * Build the picker bootstrap payload by listing spaces from the SDK
 * + projecting the captured-download summary. List failures bubble up
 * so the orchestrator can surface them on a notification.
 *
 * The `defaultSpaceId` is left blank for now — the picker auto-selects
 * the first space when none is suggested. A future iteration could
 * persist "last-used space" in KV and feed it here.
 */
async function buildBootstrap(
  captured: CapturedDownload
): Promise<PickerBootstrap> {
  const spaces = await getSpacesApi().listSpaces();
  const projected: PickerSpace[] = spaces.map((s) => {
    const space: PickerSpace = {
      id: s.id,
      name: s.name,
    };
    if (typeof s.color === 'string' && s.color.length > 0) {
      space.color = s.color;
    }
    if (typeof s.itemCount === 'number' && s.itemCount >= 0) {
      space.itemCount = s.itemCount;
    }
    return space;
  });
  return {
    download: {
      fileName: captured.fileName,
      mimeType: captured.mimeType,
      kind: captured.kind,
      totalBytes: captured.totalBytes,
      source: captured.source,
    },
    spaces: projected,
  };
}

/**
 * Wait for the item's `done` event and resolve with the final state
 * string. If the download was already done before this listener was
 * added (very unlikely given the surrounding flow), we resolve with
 * the live state read off the item.
 */
function waitForDoneState(item: DownloadItem): Promise<string> {
  return new Promise<string>((resolve) => {
    // Fast path: terminal states.
    const live = item.getState();
    if (live === 'completed' || live === 'cancelled' || live === 'interrupted') {
      resolve(live);
      return;
    }
    item.once('done', (_evt: ElectronEvent, state: string) => {
      resolve(state);
    });
  });
}

async function uploadAndCreateAsset(args: {
  captured: CapturedDownload;
  tempPath: string;
  pickerResult: { spaceId: string; spaceName: string };
  log: DownloadsLogger;
}): Promise<void> {
  const { captured, tempPath, pickerResult, log } = args;

  const buffer = await fsp.readFile(tempPath);
  // The Files SDK accepts `Buffer | Blob | string`; Node's Buffer is
  // an ArrayBufferView so it's a perfectly fine `FilesContent`. We pass
  // the original file name so the storage layer can preserve the
  // extension for download-url Content-Disposition.
  const prefix = composeStoragePrefix(pickerResult.spaceId, captured.id);
  const filesApi = getFilesApi();
  // upload() returns a short-lived signed URL; the canonical storage
  // key is what we want to persist on the asset. Compose it deterministically.
  const fileKey = composeStorageKey(
    pickerResult.spaceId,
    captured.id,
    captured.fileName
  );

  log.info('uploading captured download', {
    id: captured.id,
    spaceId: pickerResult.spaceId,
    fileKey,
    bytes: buffer.byteLength,
  });

  // Treat upload + asset-create as a logical pair. If upload succeeds
  // but asset-create fails, we let the user know via notification so
  // they can re-trigger; we DO NOT try to roll the upload back (the
  // signed-URL window is short and a stranded upload eventually ages
  // out — a future janitor could sweep `lite-downloads/<spaceId>/<id>/`
  // prefixes that don't have a matching :Asset).
  await filesApi.upload(prefix, captured.fileName, buffer, {
    contentType:
      captured.mimeType.length > 0
        ? captured.mimeType
        : 'application/octet-stream',
  });

  const creatorId = resolveCreatorId();
  const title = captured.fileName;

  const createInput: CreateAssetInput = {
    spaceId: pickerResult.spaceId,
    title,
    kind: mapKindForAsset(captured.kind),
    fileKey,
    mimeType:
      captured.mimeType.length > 0
        ? captured.mimeType
        : 'application/octet-stream',
    size: captured.totalBytes > 0 ? captured.totalBytes : buffer.byteLength,
  };
  if (captured.url.length > 0) {
    createInput.sourceUrl = captured.url;
  }
  if (creatorId !== null) {
    createInput.creatorId = creatorId;
  }

  await getSpacesApi().items.create(createInput);
  log.info('captured download saved as asset', {
    id: captured.id,
    spaceId: pickerResult.spaceId,
    spaceName: pickerResult.spaceName,
    fileKey,
  });
}

/**
 * Map a captured `DerivedItemKind` to a Spaces `ItemKind`. The two
 * enums overlap entirely on the kinds the downloads module produces
 * — neither `'playbook'` nor `'ticket'` are ever derived from a
 * MIME type, so a direct cast is safe.
 */
function mapKindForAsset(kind: CapturedDownload['kind']): 'document' | 'image' | 'url' | 'text' | 'audio' | 'video' | 'other' {
  switch (kind) {
    case 'document':
    case 'image':
    case 'url':
    case 'text':
    case 'audio':
    case 'video':
    case 'other':
      return kind;
    default:
      return 'other';
  }
}

/**
 * Best-effort lookup of the active account id for the `[:CREATED]`
 * edge. The Spaces SDK MERGES a `:Person` row keyed on the id we hand
 * over, so any stable per-account identifier works — we use the GSX
 * `accountId` from the auth module. Returns null when signed-out;
 * the asset is created without provenance in that case.
 */
function resolveCreatorId(): string | null {
  try {
    const session = getAuthApi().getSession('edison');
    if (session === null) return null;
    return session.accountId;
  } catch {
    return null;
  }
}

async function cleanupTemp(tempPath: string): Promise<void> {
  try {
    await fsp.rm(tempPath, { force: true });
  } catch {
    // best-effort -- the OS will GC the temp file eventually if it
    // survived the delete attempt.
  }
}

// ─── notifications ─────────────────────────────────────────────────────────

function notifySuccess(fileName: string, spaceName: string): void {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: 'Saved to Space',
      body: `${fileName} → ${spaceName}`,
    });
    n.show();
  } catch {
    /* notifications are nice-to-have, not load-bearing */
  }
}

function notifyFail(fileName: string, reason: string): void {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: 'Save to Space failed',
      body: `${fileName}: ${reason}`,
    });
    n.show();
  } catch {
    /* see above */
  }
}

function notifyDownloadsComplete(fileName: string, filePath: string): void {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: 'Download Complete',
      body: `${fileName} downloaded`,
    });
    n.on('click', () => {
      try {
        shell.showItemInFolder(filePath);
      } catch {
        /* best-effort */
      }
    });
    n.show();
  } catch {
    /* see above */
  }
}

// ─── default logger ───────────────────────────────────────────────────────

function defaultLogger(): DownloadsLogger {
  return {
    info: (message: string, data?: unknown) => {
      // eslint-disable-next-line no-console
      console.info('[downloads]', message, data ?? '');
    },
    warn: (message: string, data?: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[downloads]', message, data ?? '');
    },
    error: (message: string, data?: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[downloads]', message, data ?? '');
    },
  };
}
