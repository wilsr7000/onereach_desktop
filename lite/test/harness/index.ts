/**
 * Onereach Lite -- test harness barrel.
 *
 * This is the import point for any test-side utility. Test files should
 * import only from here; never from the per-file paths under harness/.
 *
 * The barrel covers two complementary surfaces:
 *
 * 1. Conformance contracts + module-level mocks (rules-driven testing per
 *    LITE-RULES.md Rule 12). Used by every module's `*-api.test.ts` to
 *    assert the public API surface and error class match the contract.
 *
 * 2. App-level harness (`launch`, `menu`, `windows`, `log-server`,
 *    `userdata`) -- boot the BUILT lite app, drive menus/IPCs, query the
 *    log server, snapshot userData. Used by E2E specs and integration
 *    tests that need a running lite process.
 *
 * Layered harnesses (e.g. `updater/`) build on top of the app-level
 * primitives -- import them through the per-folder barrel
 * (`./updater/index.js`).
 */

// ---------------------------------------------------------------------------
// Conformance contracts (Rule 12 in LITE-RULES.md)
//
// These live in a SEPARATE barrel (`./conformance.js`) because they
// import `vitest`, which can't be loaded via Playwright's CommonJS
// `require()`. Importing them here would crash every E2E spec that
// touches the harness barrel.
//
// Vitest unit tests import via:
//   import { runApiConformanceContract } from '../harness/conformance.js';
// ---------------------------------------------------------------------------

// (intentionally not re-exported here -- see './conformance.js')

// ---------------------------------------------------------------------------
// Module mocks + fixtures
// ---------------------------------------------------------------------------

export { FakeKV } from './mocks/fake-kv.js';
export { FakeLogging } from './mocks/fake-logging.js';
export { FakeQueue, type FakeQueueEntry } from './mocks/fake-queue.js';

export {
  startInMemoryKVServer,
  type InMemoryKVServer,
} from './mocks/in-memory-kv-server.js';

export {
  startInMemoryLogServer,
  type InMemoryLogServer,
} from './mocks/in-memory-log-server.js';

export { makeBugReportPayload } from './fixtures/bug-report.js';

// ---------------------------------------------------------------------------
// App-level harness (boot the built lite app, drive menus/IPCs, query
// log server, snapshot userData). See lite/test/harness/README.md.
// ---------------------------------------------------------------------------

export {
  launchLite,
  closeLite,
  defaultExecutablePath,
  waitForLogServer,
  sleep,
  LITE_LOG_PORT,
  LITE_LOG_SERVER,
  type LaunchOptions,
  type LiteHandle,
} from './launch.js';

export {
  getMenuStructure,
  clickMenuItem,
  clickMenuItemById,
  getSubmenuItems,
  registerEntryFromTest,
  unregisterEntryFromTest,
  type MenuItemInfo,
  type TopLevelInfo,
} from './menu.js';

export {
  waitForWindow,
  waitForWindowByUrl,
  findWindowByUrl,
  waitForBugReportModal,
  waitForAboutWindow,
  getWindowSnapshot,
  type WaitForWindowOptions,
} from './windows.js';

export {
  LiteLogServerClient,
  filterBenignLiteErrors,
  BENIGN_LITE_ERROR_PATTERNS,
  expectEvent,
  expectSpan,
  expectSpanFail,
  type LogEntry,
  type LogStats,
  type LogSnapshot,
  type LogLevel,
  type QueryLogsParams,
  type EventLogEntry,
  type GetEventsOptions,
  type WaitForEventOptions,
} from './log-server.js';

export {
  readBugReports,
  readUpdateState,
  writeUpdateState,
  listAppBackups,
  snapshotUserData,
  clearUserData,
  type BugReportFile,
  type UpdateState,
  type AppBackup,
  type UserDataSnapshot,
} from './userdata.js';
