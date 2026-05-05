/**
 * Onereach Lite Auto-Updater -- shared types.
 *
 * Borrowed shapes (not imports) from main.js auto-updater handlers and
 * rollback-manager.js. Re-stated here so lite/updater/ has zero
 * dependencies on full's runtime code per LITE-RULES.md rule 1.
 */

/** Persisted across restarts at userData/update-state.json. */
export interface UpdateState {
  /** Number of consecutive failed install attempts. Reset on success. */
  failedAttempts: number;
  /** Version we last tried to install (set before quitAndInstall). */
  lastAttemptVersion: string | null;
  /** ISO timestamp of the last attempt. */
  lastAttemptTime: string | null;
  /**
   * Versions that hit `BROKEN_VERSION_THRESHOLD` consecutive failures.
   * Auto-update suppresses these going forward -- the user has to
   * download manually. Resets when a different version installs
   * successfully. Bounded to the most recent 8 entries to prevent the
   * list from growing without limit on a chronically-broken host.
   */
  lastFailedVersions: string[];
}

/**
 * Number of consecutive failed restarts on the same target version that
 * marks the version as broken (auto-update will suppress subsequent
 * attempts at that version, surfacing a manual-download path instead).
 */
export const BROKEN_VERSION_THRESHOLD = 3;

/** Cap on `lastFailedVersions` length so the list can't grow indefinitely. */
export const BROKEN_VERSION_HISTORY = 8;

export const EMPTY_UPDATE_STATE: UpdateState = {
  failedAttempts: 0,
  lastAttemptVersion: null,
  lastAttemptTime: null,
  lastFailedVersions: [],
};

/** Status events the lifecycle emits to the renderer via IPC. */
export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'progress'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdaterStatusEvent {
  status: UpdaterStatus;
  /** Arbitrary detail per status. Mirrors main.js sendUpdateStatus. */
  info?: unknown;
}

/** Subset of electron-updater's UpdateInfo we actually use. */
export interface UpdaterInfo {
  version: string;
  releaseDate?: string;
  files?: Array<{ url: string; sha512?: string; size?: number }>;
  path?: string;
  sha512?: string;
}

/** What rollback-manager.js writes per backup. */
export interface BackupMetadata {
  version: string;
  date: string;
}

export interface BackupRecord {
  version: string;
  /** Absolute path to the backup directory. */
  path: string;
}
