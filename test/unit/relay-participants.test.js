/**
 * Relay Participants registry — the first-class roster of I/O relay agents.
 * See docs/internal/ORB-EXCHANGE-AGENTS.md (Piece 5).
 *
 * Run: npx vitest run test/unit/relay-participants.test.js
 *
 * NOTE: the registry is a module singleton. Tests that mutate it
 * (registerParticipant) use ids that don't collide with the canonical four so
 * ordering never matters.
 */

import { describe, it, expect } from 'vitest';

const rp = require('../../lib/exchange/relay-participants');

describe('relay-participants canonical roster', () => {
  it('declares the four relay agents the architecture names', () => {
    const ids = rp.listParticipants().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['voice-relay', 'chat', 'modal', 'exchange-manager']));
  });

  it('every relay participant is bid-excluded (relays never bid on user work)', () => {
    for (const p of rp.listParticipants()) {
      expect(p.bidExcluded).toBe(true);
    }
    expect(rp.getBidExcludedIds()).toEqual(
      expect.arrayContaining(['voice-relay', 'chat', 'modal', 'exchange-manager'])
    );
  });

  it('each participant has a channels contract', () => {
    const voice = rp.getParticipant('voice-relay');
    expect(voice.channels).toEqual({ in: ['voice'], out: ['voice'] });
    expect(rp.getParticipant('modal').channels.in).toContain('modal');
    expect(rp.getParticipant('exchange-manager').channels).toEqual({ in: [], out: [] });
  });

  it('isRelayParticipant recognises relays and rejects a normal agent', () => {
    expect(rp.isRelayParticipant('voice-relay')).toBe(true);
    expect(rp.isRelayParticipant('daily-brief-agent')).toBe(false);
  });
});

describe('relay-participants self-handling set (single source of truth)', () => {
  it('includes the legacy self-prompting HUD by default', () => {
    expect(rp.getSelfHandlingToolIds()).toContain('command-hud');
  });

  it('does NOT mark the pop-out modal self-handling (it closes on submit, orb stays fallback)', () => {
    expect(rp.getParticipant('modal').selfHandling).toBe(false);
    expect(rp.getSelfHandlingToolIds()).not.toContain('modal');
  });

  it('reflects a newly registered self-handling surface', () => {
    rp.registerParticipant({ id: 'test-panel', selfHandling: true });
    expect(rp.getSelfHandlingToolIds()).toContain('test-panel');
  });
});

describe('relay-participants registration', () => {
  it('marks an existing participant active without losing its descriptor', () => {
    const before = rp.getParticipant('exchange-manager');
    const after = rp.registerParticipant({ id: 'exchange-manager', status: 'active' });
    expect(after.status).toBe('active');
    expect(after.role).toBe(before.role); // merged, not replaced
    expect(after.bidExcluded).toBe(true);
  });

  it('a brand-new participant defaults to bid-excluded relay', () => {
    const p = rp.registerParticipant({ id: 'some-new-relay' });
    expect(p.bidExcluded).toBe(true);
    expect(p.role).toBe('relay');
  });

  it('ignores a registration with no id', () => {
    expect(rp.registerParticipant({})).toBeNull();
    expect(rp.registerParticipant(null)).toBeNull();
  });
});

describe('relay-core consumes the registry for self-handling', () => {
  const { shouldSurfaceNeedsInput } = require('../../lib/exchange/relay-core');

  it('defers a needsInput owned by a registry self-handling tool', () => {
    // command-hud is self-handling via the registry -> orb does not surface.
    expect(shouldSurfaceNeedsInput({ toolId: 'command-hud' })).toBe(false);
  });

  it('surfaces a needsInput from a non-self-handling tool', () => {
    expect(shouldSurfaceNeedsInput({ toolId: 'meeting-monitor-agent' })).toBe(true);
  });
});
