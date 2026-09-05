import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

if (typeof globalThis.ResizeObserver === 'undefined') {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
}
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({ matches: query.includes('reduce') && (globalThis as { __reducedMotion?: boolean }).__reducedMotion === true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false });
}
if (typeof window !== 'undefined' && typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => window.setTimeout(() => cb(performance.now()), 0);
}

// jsdom has no PointerEvent; a MouseEvent with the pointer fields lets pointer handlers see coordinates and buttons.
if (typeof window !== 'undefined' && typeof (window as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}
