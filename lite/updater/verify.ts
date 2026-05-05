/**
 * Onereach Lite Auto-Updater -- cross-restart install verification.
 *
 * On startup, check whether a previous install was attempted but failed
 * (the install path writes lastAttemptVersion to disk; if we boot back
 * into the OLD version, the install didn't take). This is critical
 * because Squirrel.Mac/ShipIt errors are silent on macOS.
 *
 * Borrowed pattern: main.js verifyUpdateOnStartup (lines 16725-16783),
 * with the dialog text preserved verbatim so users see the same copy.
 *
 * Pure logic + a thin "show dialog" hook so tests can drive verification
 * without a real Electron dialog.
 */

import { clearUpdateState, readUpdateState, writeUpdateState } from './state.js';
import {
  BROKEN_VERSION_HISTORY,
  BROKEN_VERSION_THRESHOLD,
  EMPTY_UPDATE_STATE,
  type UpdateState,
} from './types.js';

export type DialogResponse = 0 | 1 | 2;

/** Surface for showing the dialog -- abstracted so tests can spy. */
export interface VerifyDialogs {
  showFailureDialog: (params: {
    title: string;
    message: string;
    detail: string;
    buttons: ['Download Manually', 'Try Auto-Update Again', 'Skip'];
    defaultId: 0;
  }) => Promise<DialogResponse>;
}

export interface VerifyDeps {
  /** Lite's userData path. */
  userDataPath: string;
  /** Currently-running app version (typically app.getVersion() at boot). */
  currentVersion: string;
  /** Open the public release page (Download Manually button). */
  openReleasesPage: () => void | Promise<void>;
  /** Trigger another auto-update check (Try Again button). */
  triggerCheck: () => void | Promise<void>;
  /** Dialog surface. */
  dialogs: VerifyDialogs;
  /** Optional logger -- defaults to silent. */
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
  };
}

export interface VerifyResult {
  /** Outcome of verification. */
  outcome: 'no-prior-attempt' | 'install-succeeded' | 'install-failed';
  /** What state was on disk before this run. */
  before: UpdateState;
  /** What state is on disk now (after possible mutation). */
  after: UpdateState;
  /** Dialog response, if a dialog was shown. */
  dialogResponse?: DialogResponse;
}

/**
 * Run the boot-time check. Returns synchronously after disk I/O if no
 * dialog is shown; awaits the dialog if there was a failed install.
 */
export async function verifyUpdateOnStartup(deps: VerifyDeps): Promise<VerifyResult> {
  const { userDataPath, currentVersion } = deps;
  const log = deps.logger ?? { info: () => {}, warn: () => {} };

  const before = readUpdateState(userDataPath);

  if (before.lastAttemptVersion === null) {
    return { outcome: 'no-prior-attempt', before, after: before };
  }

  if (before.lastAttemptVersion === currentVersion) {
    log.info('updater: startup running expected version -- install succeeded', {
      version: currentVersion,
    });
    clearUpdateState(userDataPath);
    return {
      outcome: 'install-succeeded',
      before,
      after: { ...EMPTY_UPDATE_STATE },
    };
  }

  // Install failed -- still on the old version.
  const failedAttempts = (before.failedAttempts ?? 0) + 1;

  // After BROKEN_VERSION_THRESHOLD consecutive failures on the same
  // target, mark the version as broken so subsequent auto-update
  // checks suppress that version and the user is steered to the
  // manual-download path instead. This is the auto-recovery exit:
  // bounded retry, then stop hammering a known-bad target.
  const failedVersion = before.lastAttemptVersion;
  const shouldMarkBroken =
    failedAttempts >= BROKEN_VERSION_THRESHOLD &&
    failedVersion !== null &&
    !before.lastFailedVersions.includes(failedVersion);
  const lastFailedVersions: string[] = shouldMarkBroken
    ? [...before.lastFailedVersions, failedVersion].slice(-BROKEN_VERSION_HISTORY)
    : before.lastFailedVersions;

  const after: UpdateState = { ...before, failedAttempts, lastFailedVersions };
  writeUpdateState(userDataPath, after);
  log.warn('updater: startup mismatch -- install failed', {
    expected: before.lastAttemptVersion,
    actual: currentVersion,
    failedAttempts,
    markedBroken: shouldMarkBroken,
  });

  const isBroken = shouldMarkBroken || before.lastFailedVersions.includes(failedVersion ?? '');
  const isRepeat = failedAttempts >= 2;
  const title = isBroken
    ? 'Auto-Update Disabled for This Version'
    : isRepeat
      ? 'Update Could Not Be Applied'
      : "Update Didn't Install";
  const message = isBroken
    ? `Auto-update to v${before.lastAttemptVersion} keeps failing on this Mac.`
    : isRepeat
      ? `Automatic update to v${before.lastAttemptVersion} has failed ${failedAttempts} times`
      : `The update to v${before.lastAttemptVersion} didn't apply`;
  const detail = isBroken
    ? `Lite has tried ${failedAttempts} times and stopped trying for this version. Download v${before.lastAttemptVersion} manually from the releases page; the next different version released will retry auto-update automatically. Your settings and data are preserved.`
    : isRepeat
      ? 'This can happen due to macOS security settings, file permissions, or unsigned builds.\n\nYou can download the latest version manually from our releases page. Your settings and data will be preserved.'
      : "The auto-updater ran but the new version didn't take effect. You can try again automatically, or download it manually.\n\nYour settings and data are safe.";

  // Dialog isolation: a dialog crash in this very-early-boot path
  // (before any windows are created) would otherwise propagate uncaught
  // and abort the boot chain. Default to "Skip" on dialog failure --
  // worst case the user sees the prompt again on next restart.
  let dialogResponse: DialogResponse;
  try {
    dialogResponse = await deps.dialogs.showFailureDialog({
      title,
      message,
      detail,
      buttons: ['Download Manually', 'Try Auto-Update Again', 'Skip'],
      defaultId: 0,
    });
  } catch (err) {
    log.warn('updater: failure dialog threw -- defaulting to Skip', {
      error: (err as Error).message,
    });
    dialogResponse = 2;
  }

  if (dialogResponse === 0) {
    await deps.openReleasesPage();
    // Don't clear the state if the version is now marked broken --
    // the next boot needs to remember NOT to auto-attempt this version.
    if (!shouldMarkBroken && !isBroken) {
      clearUpdateState(userDataPath);
    }
  } else if (dialogResponse === 1) {
    // "Try again" -- only meaningful if we haven't given up on this
    // version. If marked broken, treat the same as Skip.
    if (!isBroken) {
      clearUpdateState(userDataPath);
      await deps.triggerCheck();
    }
  }
  // dialogResponse === 2 (Skip): leave state -- prompt again next restart.

  const finalState = readUpdateState(userDataPath);
  return {
    outcome: 'install-failed',
    before,
    after: finalState,
    dialogResponse,
  };
}
