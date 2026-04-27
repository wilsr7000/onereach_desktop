/**
 * Regression tests for spaces-sync-manager._isGraphAvailable()
 *
 * Background: prior to 2026-04-27, _isGraphAvailable() only checked
 * `graph?.endpoint` -- it returned true even when the Neo4j password was
 * missing, which let push fire and predictably explode with "Neo4j password
 * not configured". Result: 2+ weeks of silent push failures in production.
 *
 * The fix delegates to OmniGraphClient.isReady(), which checks BOTH endpoint
 * AND password. These tests pin that contract so the regression can't return.
 *
 * The full-life-cycle tests live in spaces-sync-manager.test.js; here we
 * isolate the readiness check by directly poking the method on the prototype.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../../lib/spaces-git', () => ({
  SpacesGit: class { isInitialized() { return false; } },
  getSpacesGit: () => ({ isInitialized: () => false }),
}));

const { SpacesSyncManager } = require('../../lib/spaces-sync-manager');

/**
 * Build a sync manager without running its constructor side-effects (the
 * constructor wires event subscribers we don't need for these unit tests).
 */
function makeManager() {
  const m = Object.create(SpacesSyncManager.prototype);
  m._lastUnconfiguredNotifyAt = 0; // pre-set so the popup helper short-circuits
  return m;
}

/**
 * Patch the OmniGraph singleton's `isReady()` method via the require cache.
 * Returns a restore function.
 */
function withOmniClient({ endpoint, neo4jPassword }) {
  const mod = require('../../omnigraph-client');
  const originalGetClient = mod.getOmniGraphClient;
  const stub = {
    endpoint,
    neo4jPassword,
    isReady: () => !!(endpoint && neo4jPassword),
  };
  mod.getOmniGraphClient = () => stub;
  return () => {
    mod.getOmniGraphClient = originalGetClient;
  };
}

describe('spaces-sync-manager._isGraphAvailable', () => {
  it('returns false when the OmniGraph endpoint is missing', () => {
    const restore = withOmniClient({ endpoint: null, neo4jPassword: null });
    try {
      const m = makeManager();
      expect(m._isGraphAvailable()).toBe(false);
    } finally {
      restore();
    }
  });

  it('returns false when endpoint is set but Neo4j password is missing (regression for the 2-week silent-failure bug)', () => {
    const restore = withOmniClient({
      endpoint: 'https://em.edison.api.onereach.ai/http/x/omnidata/neon',
      neo4jPassword: null,
    });
    try {
      const m = makeManager();
      expect(m._isGraphAvailable()).toBe(false);
    } finally {
      restore();
    }
  });

  it('returns true only when BOTH endpoint AND password are configured', () => {
    const restore = withOmniClient({
      endpoint: 'https://em.edison.api.onereach.ai/http/x/omnidata/neon',
      neo4jPassword: 'aura-instance-secret',
    });
    try {
      const m = makeManager();
      expect(m._isGraphAvailable()).toBe(true);
    } finally {
      restore();
    }
  });

  it('falls back to false when the omnigraph-client module throws', () => {
    const mod = require('../../omnigraph-client');
    const originalGetClient = mod.getOmniGraphClient;
    mod.getOmniGraphClient = () => {
      throw new Error('boom');
    };
    try {
      const m = makeManager();
      expect(m._isGraphAvailable()).toBe(false);
    } finally {
      mod.getOmniGraphClient = originalGetClient;
    }
  });
});
