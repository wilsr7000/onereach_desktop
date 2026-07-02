/**
 * Relay Participants — the registry of first-class I/O relay agents.
 *
 * See docs/internal/ORB-EXCHANGE-AGENTS.md. The intended architecture treats
 * every I/O surface as "just another agent that listens to the exchange." Today
 * those surfaces are behaviours scattered across orb.html / exchange-bridge with
 * no shared identity. This module gives them ONE enumerable contract:
 *
 *   - a canonical descriptor per relay agent (voice-relay, chat, modal,
 *     exchange-manager), each `bidExcluded` (relays never bid on user work);
 *   - the single source of truth for which surfaces self-handle user input
 *     (so the voice relay defers to them instead of double-prompting);
 *   - introspection (listParticipants) for health/diagnostics.
 *
 * It is the seam a future transport swap (privileged IPC -> WebSocket peer)
 * hides behind: consumers ask the registry, not the transport. No Electron, no
 * side effects — pure data + lookups, so it is trivially testable and can load
 * in the renderer (window.RelayParticipants) or main/tests (require).
 */

'use strict';

(function () {
  // Legacy interactive surface that prompts the user on its own. The voice
  // relay defers a needsInput owned by a self-handling tool (no double-prompt).
  // NOTE the pop-out modal is intentionally NOT self-handling: it collects one
  // interaction then closes (see agent-ui-modal.html), so the orb must remain
  // the fallback prompter for any subsequent turn.
  const CANONICAL = [
    {
      id: 'voice-relay',
      role: 'relay',
      description: 'Speech in (transcript -> task) and TTS out; enters listen on needsInput.',
      channels: { in: ['voice'], out: ['voice'] },
      bidExcluded: true,
      selfHandling: false, // the orb's own channel — it does not defer to itself
    },
    {
      id: 'chat',
      role: 'relay',
      description: 'Typed text in and visible chat history out (persisted).',
      channels: { in: ['text'], out: ['chat'] },
      bidExcluded: true,
      selfHandling: false,
    },
    {
      id: 'modal',
      role: 'relay',
      description: 'Renders agent ui/html; captures a UI interaction back to the agent (one-shot).',
      channels: { in: ['modal'], out: ['modal'] },
      bidExcluded: true,
      selfHandling: false, // one-shot: closes on submit, so the orb stays fallback
    },
    {
      id: 'exchange-manager',
      role: 'moderator',
      description: 'Prunes terminal tasks and watches exchange health. No user channel.',
      channels: { in: [], out: [] },
      bidExcluded: true,
      selfHandling: false,
    },
  ];

  // Legacy surfaces that still self-prompt (retired HUD). Kept as the default
  // self-handling set so the voice relay defers to them exactly as before.
  const LEGACY_SELF_HANDLING = ['command-hud'];

  // agentId -> descriptor. Seeded with the canonical relays; a runtime may mark
  // status via registerParticipant (e.g. exchange-manager 'active' on start).
  const _registry = new Map();
  for (const p of CANONICAL) {
    _registry.set(p.id, { ...p, status: 'declared' });
  }

  function registerParticipant(descriptor) {
    if (!descriptor || !descriptor.id) return null;
    const prev = _registry.get(descriptor.id) || {};
    const merged = {
      role: 'relay',
      bidExcluded: true,
      selfHandling: false,
      channels: { in: [], out: [] },
      status: 'active',
      ...prev,
      ...descriptor,
    };
    _registry.set(merged.id, merged);
    return merged;
  }

  function getParticipant(id) {
    return _registry.get(id) || null;
  }

  function listParticipants() {
    return Array.from(_registry.values()).map((p) => ({ ...p }));
  }

  function isRelayParticipant(id) {
    return _registry.has(id);
  }

  // Ids that must never be treated as bidding agents.
  function getBidExcludedIds() {
    return listParticipants()
      .filter((p) => p.bidExcluded)
      .map((p) => p.id);
  }

  // The self-handling tool set the voice relay defers to. Registry-flagged
  // participants plus the legacy surfaces — single source of truth for
  // relay-core.shouldSurfaceNeedsInput.
  function getSelfHandlingToolIds() {
    const flagged = listParticipants()
      .filter((p) => p.selfHandling)
      .map((p) => p.id);
    return Array.from(new Set([...LEGACY_SELF_HANDLING, ...flagged]));
  }

  const api = {
    registerParticipant,
    getParticipant,
    listParticipants,
    isRelayParticipant,
    getBidExcludedIds,
    getSelfHandlingToolIds,
    LEGACY_SELF_HANDLING,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.RelayParticipants = api;
  }
})();
