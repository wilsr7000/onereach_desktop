/**
 * Dependency-cruiser config -- enforces the lite/full/lib/packages isolation boundaries.
 * See lite/LITE-RULES.md for the policy.
 *
 * The single rule: Lite imports only from lite/ and lib/. Full does not import from lite/.
 * lib/ has no upward dependencies. packages/ is not imported by lite.
 */
module.exports = {
  forbidden: [
    {
      name: 'lite-imports-only-from-lite-or-lib',
      severity: 'error',
      comment:
        'Lite must only import from lite/ or lib/ (or node_modules). Importing from full or packages/ violates the isolation policy. See lite/LITE-RULES.md.',
      from: { path: '^lite/' },
      to: {
        pathNot: '^(lite/|lib/|node_modules/)',
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
      name: 'lib-must-not-depend-on-app-code',
      severity: 'error',
      comment:
        'lib/ has no upward dependencies. Code that needs to import app-level files must live in the app, not in lib/.',
      from: { path: '^lib/' },
      to: {
        path: '^(lite/|main\\.js|action-executor\\.js|app-manager-agent\\.js|preload\\.js|menu\\.js|module-manager\\.js|spaces-api\\.js|tabbed-browser\\.html|agent-manager\\.html|orb\\.html|settings\\.html|packages/)',
      },
    },
    {
      name: 'lite-must-not-import-packages',
      severity: 'error',
      comment:
        'Lite never imports from packages/. If something in packages/ deserves to be shared with lite, promote it to lib/ first as a deliberate act, full-app-verified, both CODEOWNERS sign off (the promote-to-lib policy).',
      from: { path: '^lite/' },
      to: { path: '^packages/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies indicate a design problem. Refactor to break the cycle.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (not imported by anything) may be dead code. Remove or document why they exist.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(?:cjs|mjs|js)$', // dotfiles like .eslintrc.js
          '\\.d\\.ts$', // type definitions
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|vite|esbuild|electron-builder)\\.config\\.(js|cjs|mjs)$',
          '^lite/main-lite\\.ts$', // entry point
          '^lite/preload-lite\\.ts$', // entry point
          '^main\\.js$', // full's entry point
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'lite/tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['main', 'types'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      archi: {
        collapsePattern: '^(packages|lite|lib|test)/[^/]+',
      },
    },
  },
};
