/**
 * Unit tests for lib/sync-v5/conflict.js
 *
 * Covers detectConflict (the core algebra), ConflictStore (the stateful
 * device-side registry that the UI consumes), and applyRemoteOp (the
 * Phase 4 pull-engine entry point).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const conflict = require('../../../lib/sync-v5/conflict');
const vc = require('../../../lib/sync-v5/vector-clock');

const A = '01HABCDEFGHJKMNPQRSTVWXYZ0';
const B = '01HBBBBBBBBBBBBBBBBBBBBBBB';
const C = '01HCCCCCCCCCCCCCCCCCCCCCCC';

describe('sync-v5 / conflict', () => {
  describe('detectConflict (core algebra)', () => {
    it('EQUAL when vcs match', () => {
      expect(conflict.detectConflict({ [A]: 1 }, { [A]: 1 })).toBe(conflict.VERDICT.EQUAL);
    });

    it('APPLY when incoming dominates local', () => {
      expect(conflict.detectConflict({ [A]: 1 }, { [A]: 2 })).toBe(conflict.VERDICT.APPLY);
    });

    it('IGNORE when local dominates incoming', () => {
      expect(conflict.detectConflict({ [A]: 2 }, { [A]: 1 })).toBe(conflict.VERDICT.IGNORE);
    });

    it('CONFLICT when neither dominates', () => {
      expect(conflict.detectConflict({ [A]: 1 }, { [B]: 1 })).toBe(conflict.VERDICT.CONFLICT);
    });
  });

  describe('makeVersion / makeGroup', () => {
    it('makeVersion produces a version with a unique versionId', () => {
      const v = conflict.makeVersion({
        vc: { [A]: 1 },
        authorDeviceId: A,
        authoredAt: '2026-01-01T00:00:00Z',
        payload: { title: 'test' },
      });
      expect(v.versionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(v.vc).toEqual({ [A]: 1 });
    });

    it('makeVersion rejects invalid vc', () => {
      expect(() =>
        conflict.makeVersion({ vc: null, authorDeviceId: A })
      ).toThrow(/invalid vc/);
    });

    it('makeGroup requires at least 2 versions', () => {
      const v = conflict.makeVersion({ vc: { [A]: 1 }, authorDeviceId: A });
      expect(() => conflict.makeGroup({ entityId: 'x', versions: [v] })).toThrow(/at least 2/);
    });
  });

  describe('ConflictStore', () => {
    function fakeVersion(deviceId, slot, payload) {
      return conflict.makeVersion({
        vc: { [deviceId]: slot },
        authorDeviceId: deviceId,
        authoredAt: '2026-01-01T00:00:00Z',
        payload: payload || {},
      });
    }

    it('register stores a new group and exposes count', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1);
      const v2 = fakeVersion(B, 1);
      const g = conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] });
      store.register(g);
      expect(store.count()).toBe(1);
      expect(store.get('e1')).toBeTruthy();
    });

    it('register merges new versions into an existing group (deduped by vc)', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1);
      const v2 = fakeVersion(B, 1);
      const g1 = conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] });
      store.register(g1);

      // Register again with v1 + v3 -- v1 is dedup'd, v3 is new.
      const v3 = fakeVersion(C, 1);
      const g2 = conflict.makeGroup({ entityId: 'e1', versions: [v1, v3] });
      const result = store.register(g2);
      expect(result.versions).toHaveLength(3);
    });

    it('subscribe gets initial state + change notifications', () => {
      const store = new conflict.ConflictStore();
      const calls = [];
      const unsub = store.subscribe((snap) => calls.push(snap.count));
      // Initial: 0
      expect(calls).toEqual([0]);

      const v1 = fakeVersion(A, 1);
      const v2 = fakeVersion(B, 1);
      store.register(conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] }));
      expect(calls).toEqual([0, 1]);

      unsub();
      store.register(conflict.makeGroup({ entityId: 'e2', versions: [v1, v2] }));
      // No further calls after unsubscribe.
      expect(calls).toEqual([0, 1]);
    });

    it('resolveByPick produces a merge op whose vc dominates all participants', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1, { v: 'mine' });
      const v2 = fakeVersion(B, 1, { v: 'theirs' });
      const g = conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] });
      store.register(g);

      const { resolved, mergeOp } = store.resolveByPick('e1', v1.versionId, A);
      expect(resolved.versionId).toBe(v1.versionId);
      expect(mergeOp.opType).toBe('asset.merge');
      expect(mergeOp.entityId).toBe('e1');
      expect(mergeOp.payload.payload).toEqual({ v: 'mine' });
      // vc must dominate both v1 and v2
      expect(vc.dominates(mergeOp.vcAfter, v1.vc)).toBe(true);
      expect(vc.dominates(mergeOp.vcAfter, v2.vc)).toBe(true);
      expect(store.count()).toBe(0);
    });

    it('resolveByMerge accepts a manually-merged payload', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1, { v: 'mine' });
      const v2 = fakeVersion(B, 1, { v: 'theirs' });
      const g = conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] });
      store.register(g);

      const { mergeOp } = store.resolveByMerge('e1', { v: 'merged' }, A);
      expect(mergeOp.payload.payload).toEqual({ v: 'merged' });
      expect(mergeOp.payload.chosenVersionId).toBe(null);
      expect(store.count()).toBe(0);
    });

    it('handles N=3 conflict (the v5 4.7 multi-device case)', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1);
      const v2 = fakeVersion(B, 1);
      const v3 = fakeVersion(C, 1);
      const g = conflict.makeGroup({ entityId: 'e1', versions: [v1, v2, v3] });
      store.register(g);
      const { mergeOp } = store.resolveByPick('e1', v2.versionId, A);
      // vc must dominate ALL three
      expect(vc.dominates(mergeOp.vcAfter, v1.vc)).toBe(true);
      expect(vc.dominates(mergeOp.vcAfter, v2.vc)).toBe(true);
      expect(vc.dominates(mergeOp.vcAfter, v3.vc)).toBe(true);
    });

    it('resolveByPick throws on unknown versionId', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1);
      const v2 = fakeVersion(B, 1);
      store.register(conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] }));
      expect(() => store.resolveByPick('e1', 'nonexistent', A)).toThrow(/not found/);
    });

    it('inspect returns a UI-friendly snapshot', () => {
      const store = new conflict.ConflictStore();
      const v1 = fakeVersion(A, 1);
      const v2 = fakeVersion(B, 1);
      store.register(conflict.makeGroup({ entityId: 'e1', versions: [v1, v2] }));
      const r = store.inspect();
      expect(r.count).toBe(1);
      expect(r.groups[0].versionCount).toBe(2);
    });
  });

  describe('applyRemoteOp', () => {
    it('returns APPLY when remote dominates local', () => {
      const r = conflict.applyRemoteOp({
        entityId: 'e1',
        entityType: 'asset',
        localVersion: { vc: { [A]: 1 }, payload: {}, authorDeviceId: A, authoredAt: 'x' },
        remoteVersion: { vc: { [A]: 2 }, payload: {}, authorDeviceId: A, authoredAt: 'y' },
      });
      expect(r.verdict).toBe(conflict.VERDICT.APPLY);
      expect(r.applied).toBe(true);
      expect(r.conflict).toBe(null);
    });

    it('returns IGNORE when local dominates remote', () => {
      const r = conflict.applyRemoteOp({
        entityId: 'e1',
        entityType: 'asset',
        localVersion: { vc: { [A]: 2 }, payload: {}, authorDeviceId: A, authoredAt: 'x' },
        remoteVersion: { vc: { [A]: 1 }, payload: {}, authorDeviceId: A, authoredAt: 'y' },
      });
      expect(r.verdict).toBe(conflict.VERDICT.IGNORE);
      expect(r.applied).toBe(false);
    });

    it('returns CONFLICT and registers in store when concurrent', () => {
      const store = new conflict.ConflictStore();
      const r = conflict.applyRemoteOp({
        entityId: 'e1',
        entityType: 'asset',
        localVersion: { vc: { [A]: 1 }, payload: { v: 'mine' }, authorDeviceId: A, authoredAt: 'x' },
        remoteVersion: { vc: { [B]: 1 }, payload: { v: 'theirs' }, authorDeviceId: B, authoredAt: 'y' },
        conflictStore: store,
      });
      expect(r.verdict).toBe(conflict.VERDICT.CONFLICT);
      expect(r.applied).toBe(false);
      expect(r.conflict.versions).toHaveLength(2);
      expect(store.count()).toBe(1);
    });

    it('rejects remoteVersion with malformed vc', () => {
      expect(() =>
        conflict.applyRemoteOp({
          entityId: 'e1',
          entityType: 'asset',
          localVersion: null,
          remoteVersion: { vc: 'not a vc', payload: {}, authorDeviceId: A, authoredAt: 'x' },
        })
      ).toThrow(/valid vc/);
    });
  });
});
