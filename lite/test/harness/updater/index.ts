/**
 * Onereach Lite Test Harness -- updater barrel.
 *
 * Layered on top of lite/test/harness/ (general harness). Provides:
 *   - Local update server
 *   - YAML + zip fixture builders
 *   - dev-app-update.yml injection
 *   - Composed scenarios
 *
 * See lite/test/harness/updater/README.md for usage.
 */

export {
  startUpdateServer,
  type UpdateServerOptions,
  type UpdateServerHandle,
} from './server.js';

export {
  buildYamlFixture,
  buildAppFixture,
  sha512OfFile,
  type YamlFixtureOptions,
  type YamlFixtureResult,
} from './fixtures.js';

export {
  writeDevAppUpdateYml,
  injectDevAppUpdateYml,
  type DevConfigOptions,
} from './dev-config.js';

export {
  runUpdateAvailableScenario,
  runFailedInstallScenario,
  runBackupCreatedScenario,
  type ScenarioOptions,
  type UpdateAvailableResult,
  type FailedInstallScenarioResult,
  type BackupCreatedScenarioResult,
} from './scenarios.js';
