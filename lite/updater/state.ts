/**
 * Onereach Lite Auto-Updater -- update-state.json read/write/clear.
 *
 * Survives restarts so verify.ts can detect failed installs. Lives in the
 * lite app's own userData (Onereach.ai Lite/), distinct from full's path.
 *
 * Borrowed pattern: main.js getUpdateStateFile / readUpdateState /
 * writeUpdateState / clearUpdateState (lines 16695-16723). Sync I/O is
 * intentional -- this is called inline during boot and during shutdown,
 * and the file is tiny (~150 bytes).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EMPTY_UPDATE_STATE, type UpdateState } from './types.js';
import { getLoggingApi } from '../logging/api.js';

export const UPDATE_STATE_FILENAME = 'update-state.json';

/** Path to the state file inside the given userData directory. */
export function updateStateFile(userDataPath: string): string {
  return path.join(userDataPath, UPDATE_STATE_FILENAME);
}

/**
 * Read state.json. Returns EMPTY_UPDATE_STATE if missing or corrupt.
 * Never throws -- corrupt-state recovery is a normal path.
 *
 * Parses defensively: every field is type-checked, missing fields fall
 * through to their EMPTY_UPDATE_STATE defaults so a state file written
 * by an older version still loads cleanly.
 */
export function readUpdateState(userDataPath: string): UpdateState {
  try {
    const filePath = updateStateFile(userDataPath);
    if (!fs.existsSync(filePath)) return { ...EMPTY_UPDATE_STATE };
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UpdateState>;
    const lastFailedVersions = Array.isArray(parsed.lastFailedVersions)
      ? parsed.lastFailedVersions.filter((v): v is string => typeof v === 'string')
      : [];
    return {
      failedAttempts: typeof parsed.failedAttempts === 'number' ? parsed.failedAttempts : 0,
      lastAttemptVersion:
        typeof parsed.lastAttemptVersion === 'string' ? parsed.lastAttemptVersion : null,
      lastAttemptTime:
        typeof parsed.lastAttemptTime === 'string' ? parsed.lastAttemptTime : null,
      lastFailedVersions,
    };
  } catch {
    return { ...EMPTY_UPDATE_STATE };
  }
}

/**
 * Write state.json atomically. Creates the userData dir if necessary.
 * Never throws -- the updater's failure-detection is a nice-to-have,
 * not a critical path.
 *
 * Atomicity: writes to `<file>.tmp` first, then renames over the live
 * file. `fs.renameSync` is atomic on the same volume on POSIX + NTFS,
 * so a process kill between writeFileSync and rename leaves the live
 * file untouched. Without this, a partial write would corrupt the
 * file -- and since the catch in `readUpdateState` returns
 * EMPTY_UPDATE_STATE, a corrupt write would silently erase the
 * lastAttemptVersion record, breaking failure detection.
 */
export function writeUpdateState(userDataPath: string, state: UpdateState): void {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const target = updateStateFile(userDataPath);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    // Best-effort logging -- if the central logger isn't ready (e.g.
    // during a very-early boot crash) the silent fallback is acceptable
    // because update-state failure-detection is itself a nice-to-have.
    try {
      getLoggingApi().warn('updater', 'writeUpdateState failed', {
        error: (err as Error).message,
      });
    } catch {
      // intentionally silent -- logging the logging failure would loop
    }
  }
}

/** Reset to EMPTY_UPDATE_STATE. Used on successful install verification. */
export function clearUpdateState(userDataPath: string): void {
  writeUpdateState(userDataPath, { ...EMPTY_UPDATE_STATE });
}
