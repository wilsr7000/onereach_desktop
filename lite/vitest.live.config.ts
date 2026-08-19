import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

/**
 * The LIVE tier — tests that call a real model with the key the app is
 * configured with (Settings → AI, then env, then ai-config.json; see
 * `test/harness/ai-key.ts`).
 *
 * Kept out of `vitest.config.ts` on purpose: `lite:test` is the PR gate
 * and must stay hermetic, fast and free. This tier costs money, needs
 * the network, and asserts against a non-deterministic system, so it is
 * run deliberately (`npm run lite:test:live`) — before a release, and
 * after any change to a prompt.
 *
 * Every spec here skips itself, with an explanation, when no key is
 * configured. Nothing in this tier writes to the graph.
 */
export default defineConfig({
  test: {
    name: 'lite-live',
    root: path.resolve(__dirname),
    include: ['test/live/**/*.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    globals: false,
    // A model call is bounded by the app's own 90s deadline; leave room
    // for it plus the SDK's one retry rather than failing a slow reply.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // One live conversation at a time: parallel files would multiply
    // spend and invite rate-limit flakes that look like prompt rot.
    fileParallelism: false,
    retry: 0,
  },
});
