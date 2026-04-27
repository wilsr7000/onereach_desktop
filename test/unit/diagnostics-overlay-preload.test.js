/**
 * Unit tests for lib/diagnostics-overlay-preload.js
 *
 * Since the overlay does real DOM work that Electron's preload exposes to the
 * renderer, these tests exercise the pure logic (benign filter, signature,
 * factory composition) plus a minimal happy-path popup() smoke test using a
 * lightweight DOM shim. The full visual card is verified by hand in-app.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  makeDiagnosticsOverlayAPI,
  makeOverlayFactory,
  isBenignMessage,
  BENIGN_PATTERNS,
  _signature,
} from '../../lib/diagnostics-overlay-preload.js';

// ────────────────────────────────────────────────────────────────────────────
// Benign filter
// ────────────────────────────────────────────────────────────────────────────

describe('isBenignMessage', () => {
  it('flags known benign patterns from the testing guide', () => {
    const benign = [
      'Agent reconnect failed',
      'Built-in agent WebSocket error: connection closed',
      'Failed to inject Chrome-like behavior',
      'Failed to check for Material Symbols',
      'Database IO error',
      'console-message arguments are deprecated',
      'The ScriptProcessorNode is deprecated. Use AudioWorkletNode instead.',
      'DevTools failed to load source map: Could not load content for ...',
      'ResizeObserver loop limit exceeded',
    ];
    for (const m of benign) expect(isBenignMessage(m)).toBe(true);
  });

  it('does not flag real, user-actionable errors', () => {
    const actionable = [
      'Cross account requests allowed to SUPER_ADMIN only',
      'SignalRequestError: does not have permission to update own metadata',
      '[Recorder Preload] HUD API not available: module not found: ./preload-hud-api',
      'connect ECONNREFUSED 127.0.0.1:47292',
      'Unterminated string in JSON at position 2039',
      '401 Unauthorized',
    ];
    for (const m of actionable) expect(isBenignMessage(m)).toBe(false);
  });

  it('treats empty input as benign (nothing to show)', () => {
    expect(isBenignMessage('')).toBe(true);
    expect(isBenignMessage(null)).toBe(true);
    expect(isBenignMessage(undefined)).toBe(true);
  });

  it('has a minimum of 8 benign patterns (coverage check)', () => {
    expect(BENIGN_PATTERNS.length).toBeGreaterThanOrEqual(8);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Signature normalization (drives dedup)
// ────────────────────────────────────────────────────────────────────────────

describe('_signature', () => {
  it('collapses UUIDs and long digit runs so repeats of the same fundamental error share a signature', () => {
    const a = _signature({
      message: 'Task 550e8400-e29b-41d4-a716-446655440000 timed out at 1713811200000',
      category: 'agent',
    });
    const b = _signature({
      message: 'Task 0ef30afe-1234-5678-9abc-def012345678 timed out at 1713900000000',
      category: 'agent',
    });
    expect(a).toBe(b);
  });

  it('includes category/source in the key so cross-subsystem errors stay distinct', () => {
    const a = _signature({ message: 'x', category: 'voice' });
    const b = _signature({ message: 'x', category: 'recorder' });
    expect(a).not.toBe(b);
  });

  it('is case-insensitive', () => {
    const a = _signature({ message: 'ECONNREFUSED 127.0.0.1:47292', category: 'app' });
    const b = _signature({ message: 'econnrefused 127.0.0.1:47292', category: 'app' });
    expect(a).toBe(b);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// makeDiagnosticsOverlayAPI factory
// ────────────────────────────────────────────────────────────────────────────

describe('makeDiagnosticsOverlayAPI', () => {
  it('requires an ipcRenderer and returns the public API shape', () => {
    expect(() => makeDiagnosticsOverlayAPI({})).toThrow(/ipcRenderer/);
    const api = makeDiagnosticsOverlayAPI({ ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} } });
    expect(typeof api.popup).toBe('function');
    expect(typeof api.onAutoPopup).toBe('function');
    expect(typeof api.isBenignMessage).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// popup() happy path -- uses a minimal DOM shim
// ────────────────────────────────────────────────────────────────────────────

function makeDomShim() {
  const listeners = [];
  function makeElement() {
    const el = {
      tagName: 'DIV',
      children: [],
      attributes: {},
      className: '',
      innerHTML: '',
      textContent: '',
      style: {},
      parentNode: null,
      _listeners: [],
      addEventListener(ev, fn) {
        this._listeners.push({ ev, fn });
      },
      removeEventListener() {},
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      getAttribute(k) {
        return this.attributes[k] ?? null;
      },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((c) => c !== child);
        child.parentNode = null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
    };
    return el;
  }
  const body = makeElement();
  const head = makeElement();
  const document = {
    createElement() {
      return makeElement();
    },
    body,
    head,
    readyState: 'complete',
    addEventListener(ev, fn) {
      listeners.push({ ev, fn });
    },
  };
  body.contains = function (_node) {
    return true;
  };
  return { document, listeners };
}

describe('popup()', () => {
  let ipcRenderer;
  let api;
  let originalDocument;

  beforeEach(() => {
    ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    // makeOverlayFactory closes over a module-scoped _recentSignatures map, so
    // we must work around it via varying category/message across tests. For
    // tests in this block we use unique messages to avoid cross-test dedup.
    api = makeOverlayFactory({ ipcRenderer });
    const shim = makeDomShim();
    originalDocument = globalThis.document;
    globalThis.document = shim.document;
  });

  it('returns null and skips DOM work for benign messages', () => {
    const id = api.popup({ message: 'Agent reconnect failed', category: 'app' });
    expect(id).toBeNull();
    expect(globalThis.document.body.children.length).toBe(0);
  });

  it('renders a card for an actionable error and exposes its id', () => {
    const id = api.popup({
      message: 'Cross account requests allowed to SUPER_ADMIN only (unique-' + Date.now() + ')',
      category: 'recorder',
    });
    expect(typeof id).toBe('string');
    expect(id.startsWith('diag-overlay-')).toBe(true);
    expect(globalThis.document.body.children.length).toBe(1);
    const stack = globalThis.document.body.children[0];
    expect(stack.children.length).toBe(1);
    const card = stack.children[0];
    expect(card.innerHTML).toContain('Cross account requests allowed to SUPER_ADMIN only');
    expect(card.innerHTML).toContain('What');
  });

  it('dedups identical errors within the suppression window', () => {
    const msg = 'Unique dedup probe: ECONNREFUSED 127.0.0.1:47292 XYZ-' + Date.now();
    const id1 = api.popup({ message: msg, category: 'app' });
    const id2 = api.popup({ message: msg, category: 'app' });
    expect(id1).toBeTruthy();
    expect(id2).toBeNull();
  });

  it('honors { force: true } to bypass both the benign filter and dedup', () => {
    const id1 = api.popup({ message: 'Agent reconnect failed' });
    expect(id1).toBeNull();
    const id2 = api.popup({ message: 'Agent reconnect failed' }, { force: true });
    expect(id2).not.toBeNull();
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Missing-DOM safety (preload loaded before the renderer is ready)
// ────────────────────────────────────────────────────────────────────────────

describe('popup() without a DOM', () => {
  it('returns null and does not throw', () => {
    const prev = globalThis.document;
    try {
      globalThis.document = undefined;
      const api = makeOverlayFactory({ ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} } });
      expect(api.popup({ message: 'Some error ' + Date.now() })).toBeNull();
    } finally {
      globalThis.document = prev;
    }
  });
});

// Vitest hoists the import for afterEach
import { afterEach } from 'vitest';
