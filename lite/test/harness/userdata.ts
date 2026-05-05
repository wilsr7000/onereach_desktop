/**
 * Onereach Lite Test Harness -- userData helpers.
 *
 * Snapshots/reads files in the lite app's userData directory:
 *   - lite-bugs/<timestamp>.json (bug-report local cache)
 *   - update-state.json (auto-updater cross-restart state)
 *   - app-backups/v<version>/backup-metadata.json (rollback backups)
 *
 * Tests should prefer launching with an isolated userData directory via
 * `launchLite({ userDataDir })` so they read/write only their own state.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface BugReportFile {
  filePath: string;
  payload: Record<string, unknown>;
}

export interface UpdateState {
  failedAttempts?: number;
  lastAttemptVersion?: string | null;
  lastAttemptTime?: string | null;
}

export interface AppBackup {
  version: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface UserDataSnapshot {
  bugs: BugReportFile[];
  updateState: UpdateState;
  backups: AppBackup[];
}

/**
 * Read every .json file in userData/lite-bugs/. Returns parsed payloads
 * with their absolute file paths. Files that fail to parse are skipped.
 */
export async function readBugReports(userDataPath: string): Promise<BugReportFile[]> {
  const dir = path.join(userDataPath, 'lite-bugs');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: BugReportFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      out.push({ filePath, payload: JSON.parse(raw) as Record<string, unknown> });
    } catch {
      /* skip unreadable / unparseable */
    }
  }
  return out;
}

/**
 * Read userData/update-state.json. Returns the default empty state if the
 * file is missing or corrupt.
 */
export async function readUpdateState(userDataPath: string): Promise<UpdateState> {
  const filePath = path.join(userDataPath, 'update-state.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as UpdateState;
  } catch {
    return { failedAttempts: 0, lastAttemptVersion: null, lastAttemptTime: null };
  }
}

/**
 * Pre-seed update-state.json -- useful for tests that simulate a
 * pending-install verification on next launch.
 */
export async function writeUpdateState(
  userDataPath: string,
  state: UpdateState
): Promise<void> {
  const filePath = path.join(userDataPath, 'update-state.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * List backups under userData/app-backups/. Each entry is a v<version>/
 * directory; if backup-metadata.json exists it's included.
 */
export async function listAppBackups(userDataPath: string): Promise<AppBackup[]> {
  const dir = path.join(userDataPath, 'app-backups');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const backups: AppBackup[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('v')) continue;
    const fullPath = path.join(dir, entry);
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) continue;
    let metadata: Record<string, unknown> | undefined;
    try {
      const metaRaw = await fs.readFile(path.join(fullPath, 'backup-metadata.json'), 'utf-8');
      metadata = JSON.parse(metaRaw) as Record<string, unknown>;
    } catch {
      /* metadata may not exist */
    }
    backups.push({
      version: entry.slice(1),
      path: fullPath,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }
  return backups;
}

/**
 * One-shot snapshot of all relevant userData state. Cheap enough to call
 * before/after every test step.
 */
export async function snapshotUserData(userDataPath: string): Promise<UserDataSnapshot> {
  const [bugs, updateState, backups] = await Promise.all([
    readBugReports(userDataPath),
    readUpdateState(userDataPath),
    listAppBackups(userDataPath),
  ]);
  return { bugs, updateState, backups };
}

/**
 * Wipe the userData directory. Use only with isolated userData dirs --
 * never against the user's real Onereach.ai Lite/ folder.
 */
export async function clearUserData(userDataPath: string): Promise<void> {
  // Defensive: refuse to clear anything that doesn't look like a test dir.
  if (!userDataPath.includes('onereach-lite-test') && !userDataPath.includes('test-userdata')) {
    throw new Error(
      `clearUserData refused: '${userDataPath}' does not look like a test directory`
    );
  }
  await fs.rm(userDataPath, { recursive: true, force: true });
  await fs.mkdir(userDataPath, { recursive: true });
}
