/**
 * Onereach Lite Test Harness -- updater E2E scenarios.
 *
 * Composed flows that use the general lite harness (launch, menu, log,
 * userdata) plus the updater-specific server + fixture builders.
 *
 * Each scenario returns a structured result so tests can assert on it
 * without scraping logs. Scenarios are deliberately verbose -- their
 * read order should match the test reader's mental model.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launchLite,
  closeLite,
  clickMenuItem,
  readUpdateState,
  writeUpdateState,
  listAppBackups,
  type LiteHandle,
} from '../index.js';
import { startUpdateServer, type UpdateServerHandle } from './server.js';
import { buildYamlFixture } from './fixtures.js';
import { writeDevAppUpdateYml } from './dev-config.js';

export interface ScenarioOptions {
  /** Logger -- defaults to console.log. */
  logger?: (msg: string, data?: unknown) => void;
  /** Override the placeholder bytes used in the YAML fixture. */
  fixtureBytes?: Buffer;
  /** Override the lite executable path. */
  executablePath?: string;
}

export interface UpdateAvailableResult {
  serverPort: number;
  servedRequests: string[];
  /** True if the update-state.json was untouched (no install attempted). */
  stateUnchangedAfterCheck: boolean;
}

/**
 * Boot lite pointed at a local update server serving a higher version.
 * Asserts that lite reaches out to the server. Does NOT click through
 * the install dialog -- the placeholder zip would fail electron-updater's
 * integrity check at install time. Use this for asserting check + dialog
 * surfaces.
 */
export async function runUpdateAvailableScenario(opts: {
  fromVersion: string;
  toVersion: string;
} & ScenarioOptions): Promise<UpdateAvailableResult> {
  const log = opts.logger ?? ((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(`[scenario:available] ${msg}`);
  });

  const sandbox = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-scenario-'));
  const servingDir = path.join(sandbox, 'serving');
  const userDataDir = path.join(sandbox, 'userdata');
  const devCfg = path.join(sandbox, 'dev-app-update.yml');
  await fs.mkdir(userDataDir, { recursive: true });

  await buildYamlFixture({
    version: opts.toVersion,
    outputDir: servingDir,
    ...(opts.fixtureBytes !== undefined ? { zipBytes: opts.fixtureBytes } : {}),
  });

  const server: UpdateServerHandle = await startUpdateServer({
    servingDir,
    logger: (msg) => log(`server: ${msg}`),
  });
  log(`server up at ${server.baseUrl}`);

  await writeDevAppUpdateYml(devCfg, { serverUrl: server.baseUrl });

  let handle: LiteHandle | null = null;
  try {
    handle = await launchLite({
      ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      userDataDir,
      env: {
        // Pre-empt the readiness wait if the host system is slow.
        LITE_DEV_UPDATE_CONFIG: devCfg,
      },
    });

    const stateBefore = await readUpdateState(handle.userDataPath);

    // Trigger Check for Updates from the menu.
    await clickMenuItem(handle.app, 'Check for Updates...');

    // Give the updater up to 5s to make a request to the server.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && server.requestCount() === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const stateAfter = await readUpdateState(handle.userDataPath);

    return {
      serverPort: server.port,
      servedRequests: server.requestLog(),
      stateUnchangedAfterCheck:
        stateBefore.lastAttemptVersion === stateAfter.lastAttemptVersion &&
        stateBefore.failedAttempts === stateAfter.failedAttempts,
    };
  } finally {
    await closeLite(handle);
    await server.stop();
    try {
      await fs.rm(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export interface FailedInstallScenarioResult {
  /** What state was on disk before second launch. */
  stateBefore: Awaited<ReturnType<typeof readUpdateState>>;
  /** What state is on disk after verifyUpdateOnStartup ran. */
  stateAfter: Awaited<ReturnType<typeof readUpdateState>>;
  /** Logged events captured from the lite log server containing 'updater'. */
  updaterLogLines: string[];
}

/**
 * Simulate a failed install across restart: pre-seed update-state.json
 * with a version != the running one, launch lite, and assert that
 * verifyUpdateOnStartup detects the mismatch and increments
 * failedAttempts.
 *
 * No real update server needed -- this exercises only the verify path.
 */
export async function runFailedInstallScenario(opts: {
  failedVersion: string;
} & ScenarioOptions): Promise<FailedInstallScenarioResult> {
  const sandbox = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-failscenario-'));

  // Pre-seed the userData with a fake "we tried to install vX" record.
  await writeUpdateState(sandbox, {
    failedAttempts: 0,
    lastAttemptVersion: opts.failedVersion,
    lastAttemptTime: new Date().toISOString(),
  });

  const stateBefore = await readUpdateState(sandbox);

  let handle: LiteHandle | null = null;
  try {
    handle = await launchLite({
      ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      userDataDir: sandbox,
      // verifyUpdateOnStartup's failure dialog is modal -- skip it by
      // setting an env hook the kernel reads.
      env: { LITE_TEST_SKIP_UPDATE_DIALOG: 'true' },
    });

    // Give verifyUpdateOnStartup time to run + write state.
    await new Promise((r) => setTimeout(r, 500));

    const stateAfter = await readUpdateState(handle.userDataPath);

    // Pull updater-related log entries from lite's log server.
    // Lite's log server returns logs under `data` (not `logs`) -- keep
    // both keys checked for forward compatibility.
    const logsRes = await fetch(`http://127.0.0.1:${handle.logPort}/logs?category=updater&limit=50`);
    const logsJson = (await logsRes.json()) as {
      logs?: Array<{ message: string }>;
      data?: Array<{ message: string }>;
    };
    const updaterLogLines = (logsJson.logs ?? logsJson.data ?? []).map((l) => l.message);

    return { stateBefore, stateAfter, updaterLogLines };
  } finally {
    await closeLite(handle);
    try {
      await fs.rm(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export interface BackupCreatedScenarioResult {
  backups: Awaited<ReturnType<typeof listAppBackups>>;
}

/**
 * Asserts that triggering a backup (via BackupManager directly through
 * the renderer-exposed updater bridge OR via simulated download-completed
 * event) creates a marker dir under userData/app-backups/.
 *
 * Implementation note: lite's lifecycle creates a backup on the
 * 'update-downloaded' event from electron-updater. Without a real signed
 * fixture the event won't fire, so we exercise the BackupManager via its
 * IPC instead. (When a real signed fixture is available, prefer
 * exercising the full path.)
 */
export async function runBackupCreatedScenario(opts: {
  version: string;
} & ScenarioOptions): Promise<BackupCreatedScenarioResult> {
  const sandbox = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-backupscenario-'));
  let handle: LiteHandle | null = null;
  try {
    handle = await launchLite({
      ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      userDataDir: sandbox,
    });

    // Trigger a backup via app.evaluate -- we don't have a renderer hook
    // for this in the kernel and don't want to bring up a real fixture
    // for this scenario.
    await handle.app.evaluate(
      async ({ app }: { app: Electron.App }, version: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        const { BackupManager } = require('./backups.js') as {
          BackupManager: new (o: unknown) => { createBackup: (v: string) => Promise<boolean> };
        };
        const mgr = new BackupManager({ userDataPath: app.getPath('userData') });
        await mgr.createBackup(version);
      },
      opts.version
    );

    const backups = await listAppBackups(handle.userDataPath);
    return { backups };
  } finally {
    await closeLite(handle);
    try {
      await fs.rm(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
