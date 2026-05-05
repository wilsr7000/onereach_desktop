/**
 * Conformance contract barrel -- re-exports the Vitest-based contracts
 * every module's `<module>-api.test.ts` runs through.
 *
 * Imported only by Vitest test files. Playwright E2E specs import from
 * `./index.js` instead, which deliberately excludes anything that
 * pulls `vitest` into the bundle.
 *
 * The split exists because `vitest` 4+ refuses to load via CommonJS
 * `require()`, which is how Playwright's runner resolves modules. Any
 * harness file that imports `vitest` at module-eval time has to live
 * outside the main barrel, or every E2E spec that imports the barrel
 * crashes at load time.
 */

export { runApiConformanceContract } from './api-conformance.js';
export type { ApiConformanceSpec } from './api-conformance.js';

export { runErrorConformanceContract } from './error-conformance.js';
export type { ErrorConformanceSpec } from './error-conformance.js';
