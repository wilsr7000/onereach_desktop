# Lite Test Harness -- Updater

Layered on top of the general harness (`lite/test/harness/`). Provides the building blocks for E2E updater scenarios: a local HTTP update server, fixture builders, dev-app-update.yml injection, and composed flows.

## Modules

| Module | Purpose |
|---|---|
| `server.ts` | Local HTTP server -- serves `latest-mac.yml` + `.zip` from a fixture dir |
| `fixtures.ts` | YAML fixture builder (fast) + real-app fixture builder (slow, cached) |
| `dev-config.ts` | Write `dev-app-update.yml` so dev-mode lite reads from the local server |
| `scenarios.ts` | Composed flows: `runUpdateAvailableScenario`, `runFailedInstallScenario`, `runBackupCreatedScenario` |
| `index.ts` | Barrel re-exports |

## Two fixture flavours

### YAML-only fixture (fast, ~10ms)

Builds a valid `latest-mac.yml` + a placeholder zip with correct sha512. Suitable for testing the updater's check + dialog + state-write paths -- electron-updater validates the zip's hash against the YAML before download succeeds, but the actual install isn't exercised.

```typescript
import { buildYamlFixture } from './fixtures.js';

const fixture = await buildYamlFixture({
  version: '0.5.0',
  outputDir: '/tmp/serving',
});
// fixture.yamlPath, fixture.zipPath, fixture.sha512
```

### Real-app fixture (slow, ~1-3 minutes per version, cached)

Runs `lite:package:mac` with a version-overridden `package.json` and copies the resulting `.app` + `.zip` into a cache dir keyed by version. Required for testing the full quitAndInstall path.

```bash
# Build the default fixture pair (0.0.1-fixture + 0.0.2-fixture)
npm run lite:fixtures:build

# Build a custom pair
node lite/scripts/build-fixtures.mjs 0.5.0 0.6.0

# Force rebuild
node lite/scripts/build-fixtures.mjs --force 0.5.0
```

Fixtures cache in `$TMPDIR/onereach-lite-fixture-cache/<version>/`. Delete the cache to force a clean rebuild.

## Local update server

```typescript
import { startUpdateServer } from './server.js';

const server = await startUpdateServer({
  servingDir: '/tmp/serving',
  // port: 0  -- OS-assigned, recommended for parallel tests
});
console.log(server.baseUrl);  // http://127.0.0.1:54321
console.log(server.requestLog());  // Paths served, in order
await server.stop();
```

## Composed scenarios

Each scenario boots lite, drives a flow, returns a structured result. Use them as the "happy path" surface; reach for the lower-level pieces (server + fixtures) only when a scenario doesn't quite fit.

```typescript
import { runUpdateAvailableScenario } from './scenarios.js';

const result = await runUpdateAvailableScenario({
  fromVersion: '0.0.1',
  toVersion: '0.0.2',
});

expect(result.serverPort).toBeGreaterThan(0);
expect(result.servedRequests).toContain('/latest-mac.yml');
expect(result.stateUnchangedAfterCheck).toBe(true);
```

## Running

```bash
# Run all updater E2E specs
npm run lite:test:e2e:updater

# Or via the all-E2E runner
npm run lite:test:e2e
```

## Troubleshooting

- **Port collision**: scenarios use OS-assigned ports by default (`port: 0`). If you hard-code a port, watch for collisions when running tests in parallel.
- **Fixture cache stale**: lite/ or lib/ changes may need a cache invalidation. `node lite/scripts/build-fixtures.mjs --force <version>` rebuilds.
- **`autoUpdater` not available in dev**: `app.isPackaged === false` so electron-updater's dev shim takes over. The harness's local-server scenario relies on `LITE_DEV_UPDATE_CONFIG` env-var wiring -- documented as a high-priority TODO in `lite/LITE-PUNCH-LIST.md`.
- **Bundle-not-writable test on signed fixtures**: chmod the cached `.app` to 555 before launch. The harness doesn't do this automatically because it's a destructive setup most tests shouldn't pay for.

## Adding a new updater scenario

1. Add the function to `scenarios.ts` -- prefer composing existing harness primitives.
2. Export it from `index.ts`.
3. Document it in this README.
4. Write the spec under `lite/test/e2e/updater/`.

Updater-specific scenarios live here; cross-port helpers go in the general harness instead.
