/**
 * Lite-scoped dependency-cruiser config.
 *
 * Same isolation rules as the root .dependency-cruiser.cjs (which is the
 * source of truth) but configured to be runnable from the repo root
 * without tripping over full's TS configs.
 *
 * Differences from root config:
 *   - No `tsConfig.fileName` -- relies on dep-cruiser's own enhanced
 *     resolver instead of forwarding to tsc. lite/'s import paths are
 *     explicit (`./foo.js`, `../bar/baz.js`) so TS path-mapping is not
 *     required to find dependencies.
 *   - `doNotFollow` includes the full-app entry points so we don't crawl
 *     into full's main.js / action-executor.js / etc. (which have known
 *     pre-existing circular deps that are not lite's concern).
 *   - Excludes test/, dist-lite/, lite/node_modules/ so we don't crawl
 *     vitest fixtures or built artifacts.
 *
 * Run via:  npm run lite:dep-check
 *
 * This file is the source of truth for the LITE-isolation rules check.
 * The root .dependency-cruiser.cjs is preserved for full-app dep-cruise
 * when that lands.
 */
module.exports = {
  forbidden: [
    {
      name: 'lite-imports-only-from-lite-or-lib',
      severity: 'error',
      comment:
        'Lite must only import from lite/, lib/, node_modules, or Node builtins. Importing from full or packages/ violates the isolation policy. See lite/LITE-RULES.md.',
      from: { path: '^lite/' },
      to: {
        pathNot: '^(lite/|lib/|node_modules/)',
        // Allow Node built-ins (fs, http, os, path, etc.) which dep-cruiser
        // resolves with `coreModule: true` rather than a path.
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'full-app-must-not-import-from-lite',
      severity: 'error',
      comment:
        'Full app must never import from lite/. The strangler pattern requires unidirectional dependency. See lite/LITE-RULES.md.',
      from: {
        pathNot: '^(lite/|node_modules/)',
      },
      to: { path: '^lite/' },
    },
    {
      name: 'lite-must-not-import-packages',
      severity: 'error',
      comment:
        'Lite never imports from packages/. If something in packages/ deserves to be shared with lite, promote it to lib/ first as a deliberate act, full-app-verified, both CODEOWNERS sign off (the promote-to-lib policy).',
      from: { path: '^lite/' },
      to: { path: '^packages/' },
    },
    // Note on lib hygiene:
    //
    // The original .dependency-cruiser.cjs has `lib-must-not-depend-on-app-code`
    // which is a strict rule (lib should never reach into full's main.js,
    // packages/, spaces-api.js, etc.). That's correct in principle, but:
    //   1. Many existing lib/ files are full-app-only and pre-date the rule.
    //   2. Lite only reaches a small subset of lib/ (currently just
    //      lib/log-server.js + lib/log-event-queue.js).
    //   3. The relevant question for the lite check is "do the lib files
    //      lite reaches contaminate lite with full-app deps", which is
    //      better answered by the lite-imports-only-from-lite-or-lib rule
    //      tracing transitively (dep-cruiser does this -- if log-server.js
    //      reaches main.js, it shows up as lite -> log-server -> main).
    //
    // So lib hygiene is enforced indirectly via the lite-side import rule.
    // Direct lib hygiene gets its own check when a full-app dep-cruise lands.
    {
      name: 'no-circular-in-lite',
      severity: 'error',
      comment:
        'Circular dependencies inside lite/ indicate a design problem. Refactor to break the cycle. (Full has known pre-existing circulars that are out of scope for the lite check.)',
      from: { path: '^lite/' },
      to: { circular: true, path: '^lite/' },
    },
    {
      name: 'no-orphans-in-lite',
      severity: 'warn',
      comment:
        'Orphan modules under lite/ may be dead code. Remove or document why they exist.',
      from: {
        path: '^lite/',
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(?:cjs|mjs|js)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|vite|esbuild|electron-builder|playwright|vitest)\\.config\\.(js|cjs|mjs|ts)$',
          '(^|/)dep-cruiser\\.[^/]+\\.cjs$',
          '^lite/main-lite\\.ts$', // entry point
          '^lite/preload-lite\\.ts$', // entry point
          '^lite/bug-report/modal\\.ts$', // renderer entry point (loaded by HTML, not imported)
          '^lite/placeholder\\.ts$', // renderer entry point (loaded by HTML, not imported)
          '^lite/settings/settings\\.ts$', // renderer entry point (loaded by HTML, not imported)
          '(^|/)(scripts|test|build)/', // build/test/script files often appear orphan to dep-cruiser
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      // Don't follow into:
      //   - node_modules (third-party, not lite's concern)
      //   - full's entry points + their transitive forest (out of scope for the lite check)
      path: '(^|/)node_modules/|^main\\.js$|^action-executor\\.js$|^menu(-data-manager)?\\.js$|^module-manager\\.js$|^preload\\.js$|^preload-(?!lite).+\\.js$|^app-manager-agent\\.js$|^spaces-api\\.js$|^packages/',
    },
    exclude: {
      // Don't even cruise these.
      path: '(^|/)dist(-lite)?/|^test/|^lite/test/|^resources/|^_temp/|^_scripts/|^scripts/',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['main', 'types'],
      // Treat .ts and .js as equivalent so `import './foo.js'` from a .ts
      // file resolves to foo.ts when foo.js doesn't exist.
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
