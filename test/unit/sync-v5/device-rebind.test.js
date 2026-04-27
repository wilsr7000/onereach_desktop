/**
 * Unit tests for lib/sync-v5/device-rebind.js
 *
 * Path A (signed handoff) and Path B (user-attested) are tested with
 * injected dependencies so the auth substrate (Phase 0) doesn't gate
 * Phase 3 testing. Real Ed25519 keys are used so signature verification
 * exercises the actual crypto path.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const rebind = require('../../../lib/sync-v5/device-rebind');
const vc = require('../../../lib/sync-v5/vector-clock');

const A = '01HABCDEFGHJKMNPQRSTVWXYZ0';
const B = '01HBBBBBBBBBBBBBBBBBBBBBBB';

function genKeyPair() {
  // RSA is what Node's createSign('SHA256') / createVerify works with out
  // of the box. Ed25519 in Node requires the special verify with no algo.
  // RSA gives us a portable signature path testable in unit tests.
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function sign(payload, privateKey) {
  const signer = crypto.createSign('SHA256');
  signer.update(payload);
  signer.end();
  return signer.sign(privateKey, 'base64');
}

function makeOmni({ ready = true, queryRows = [{ rewrittenAssets: 3 }], throwOnQuery = null } = {}) {
  return {
    isReady: () => ready,
    executeQuery: vi.fn(async () => {
      if (throwOnQuery) throw throwOnQuery;
      return queryRows;
    }),
  };
}

describe('sync-v5 / device-rebind', () => {
  describe('buildRebindPayload', () => {
    it('produces a deterministic payload for the same inputs', () => {
      const at = '2026-04-27T12:00:00Z';
      const p1 = rebind.buildRebindPayload({ fromDeviceId: A, toDeviceId: B, at });
      const p2 = rebind.buildRebindPayload({ fromDeviceId: A, toDeviceId: B, at });
      // Different traceIds, so payload bytes differ. But for a given traceId,
      // the JSON must be canonical (sorted keys).
      const obj = JSON.parse(p1.payload);
      expect(obj.fromDeviceId).toBe(A);
      expect(obj.toDeviceId).toBe(B);
      expect(obj.transferredAt).toBe(at);
      expect(obj.v).toBe(1);
      expect(p1.payloadHash).toHaveLength(64);
      expect(p1.traceId).not.toBe(p2.traceId);
    });

    it('rejects same fromDeviceId and toDeviceId', () => {
      expect(() =>
        rebind.buildRebindPayload({ fromDeviceId: A, toDeviceId: A })
      ).toThrow(/must differ/);
    });

    it('rejects missing deviceIds', () => {
      expect(() => rebind.buildRebindPayload({})).toThrow();
    });

    it('keys in payload JSON are alphabetically sorted (canonical form)', () => {
      const p = rebind.buildRebindPayload({ fromDeviceId: A, toDeviceId: B });
      const keys = Object.keys(JSON.parse(p.payload));
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });
  });

  describe('verifyHandoffSignature', () => {
    it('returns true for a valid signature', () => {
      const { publicKey, privateKey } = genKeyPair();
      const payload = JSON.stringify({ test: 'data' });
      const signature = sign(payload, privateKey);
      const r = rebind.verifyHandoffSignature({
        payload,
        signature,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      });
      expect(r).toBe(true);
    });

    it('returns false for a tampered payload', () => {
      const { publicKey, privateKey } = genKeyPair();
      const payload = JSON.stringify({ test: 'data' });
      const signature = sign(payload, privateKey);
      const r = rebind.verifyHandoffSignature({
        payload: JSON.stringify({ test: 'tampered' }),
        signature,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      });
      expect(r).toBe(false);
    });

    it('returns false for a wrong key', () => {
      const k1 = genKeyPair();
      const k2 = genKeyPair();
      const payload = JSON.stringify({ test: 'data' });
      const signature = sign(payload, k1.privateKey);
      const r = rebind.verifyHandoffSignature({
        payload,
        signature,
        publicKeyPem: k2.publicKey.export({ type: 'spki', format: 'pem' }),
      });
      expect(r).toBe(false);
    });

    it('returns false for malformed inputs without throwing', () => {
      expect(rebind.verifyHandoffSignature({})).toBe(false);
      expect(rebind.verifyHandoffSignature({ payload: 'p' })).toBe(false);
      expect(
        rebind.verifyHandoffSignature({ payload: 'p', signature: 'x', publicKeyPem: 'not pem' })
      ).toBe(false);
    });
  });

  describe('submitLiveHandoff (Path A)', () => {
    it('submits when signature verifies, returns rewrittenAssets', async () => {
      const { publicKey, privateKey } = genKeyPair();
      const omni = makeOmni({ queryRows: [{ rewrittenAssets: 5, traceId: 'x' }] });
      const built = rebind.buildRebindPayload({ fromDeviceId: A, toDeviceId: B });
      const signature = sign(built.payload, privateKey);
      const r = await rebind.submitLiveHandoff(
        {
          fromDeviceId: A,
          toDeviceId: B,
          payload: built.payload,
          signature,
          publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        },
        { omniClient: omni }
      );
      expect(r.success).toBe(true);
      expect(r.rewrittenAssets).toBe(5);
      expect(omni.executeQuery).toHaveBeenCalledOnce();
    });

    it('refuses when signature does not verify', async () => {
      const { publicKey } = genKeyPair();
      const built = rebind.buildRebindPayload({ fromDeviceId: A, toDeviceId: B });
      const r = await rebind.submitLiveHandoff(
        {
          fromDeviceId: A,
          toDeviceId: B,
          payload: built.payload,
          signature: 'not-a-real-signature',
          publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        },
        { omniClient: makeOmni() }
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/signature/);
    });

    it('refuses when payload deviceIds do not match args (defends against client tampering)', async () => {
      const { publicKey, privateKey } = genKeyPair();
      const tampered = JSON.stringify({
        fromDeviceId: 'OTHER',
        toDeviceId: B,
        transferredAt: new Date().toISOString(),
        traceId: '01HABCDEFGHJKMNPQRSTVWXYZ0',
        v: 1,
      });
      const signature = sign(tampered, privateKey);
      const r = await rebind.submitLiveHandoff(
        {
          fromDeviceId: A, // arg says A but payload says OTHER
          toDeviceId: B,
          payload: tampered,
          signature,
          publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        },
        { omniClient: makeOmni() }
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/deviceIds/);
    });
  });

  describe('submitUserAttested (Path B)', () => {
    it('submits when verifyUserOwnsDevice returns true', async () => {
      const omni = makeOmni({ queryRows: [{ rewrittenAssets: 7, traceId: 'x' }] });
      const r = await rebind.submitUserAttested(
        { fromDeviceId: A, toDeviceId: B, userId: 'user-1' },
        { omniClient: omni, verifyUserOwnsDevice: async () => true }
      );
      expect(r.success).toBe(true);
      expect(r.rewrittenAssets).toBe(7);
    });

    it('refuses when verifyUserOwnsDevice returns false', async () => {
      const r = await rebind.submitUserAttested(
        { fromDeviceId: A, toDeviceId: B, userId: 'attacker' },
        { omniClient: makeOmni(), verifyUserOwnsDevice: async () => false }
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/does not own/);
    });

    it('refuses when verifyUserOwnsDevice is missing (Phase 0 prerequisite)', async () => {
      const r = await rebind.submitUserAttested(
        { fromDeviceId: A, toDeviceId: B, userId: 'user-1' },
        { omniClient: makeOmni() }
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/auth substrate/);
    });

    it('refuses with empty deviceIds or userId', async () => {
      const r = await rebind.submitUserAttested(
        { fromDeviceId: '', toDeviceId: B, userId: 'u' },
        { omniClient: makeOmni(), verifyUserOwnsDevice: async () => true }
      );
      expect(r.success).toBe(false);
    });
  });

  describe('applyRebindToVc (pure function)', () => {
    it('renames a slot from old to new deviceId', () => {
      expect(rebind.applyRebindToVc({ [A]: 5, [B]: 3 }, A, 'NEW')).toEqual({ NEW: 5, [B]: 3 });
    });

    it('is a no-op when fromDeviceId is not in the vc', () => {
      const v = { [A]: 5 };
      expect(rebind.applyRebindToVc(v, 'OTHER', 'NEW')).toBe(v);
    });

    it('handles invalid input gracefully', () => {
      expect(rebind.applyRebindToVc(null, A, B)).toBe(null);
    });

    it('does not lose count value through the rename', () => {
      const v = { [A]: 99 };
      expect(rebind.applyRebindToVc(v, A, B)[B]).toBe(99);
    });
  });

  describe('CYPHER_DEVICE_REBIND', () => {
    it('writes :DeviceRebind audit + rewrites Asset.vc maps', () => {
      expect(rebind.CYPHER_DEVICE_REBIND).toContain('CREATE (rb:DeviceRebind');
      expect(rebind.CYPHER_DEVICE_REBIND).toContain('apoc.map');
      expect(rebind.CYPHER_DEVICE_REBIND).toContain('count(a) AS rewrittenAssets');
    });
  });
});
