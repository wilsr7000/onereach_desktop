/**
 * closeOnEscape — the shared Escape path for Spaces' in-page dialogs
 * (2026-09-02 modal-closability pass). Behavioral, in jsdom.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { closeOnEscape } from '../../spaces/spaces.js';

const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
};
const mount = (): HTMLElement => {
  const b = document.createElement('div');
  b.className = 'spaces-test-backdrop';
  document.body.appendChild(b);
  return b;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('closeOnEscape', () => {
  it('Escape dismisses once, and the listener is gone afterwards', () => {
    const b = mount();
    let n = 0;
    closeOnEscape(b, () => {
      n += 1;
      b.remove();
    });
    escape();
    expect(n).toBe(1);
    escape();
    expect(n).toBe(1);
  });

  it('only the topmost backdrop answers (a confirm stacked on an editor closes alone)', () => {
    const under = mount();
    const over = mount();
    const hits: string[] = [];
    closeOnEscape(under, () => {
      hits.push('under');
      under.remove();
    });
    closeOnEscape(over, () => {
      hits.push('over');
      over.remove();
    });
    escape();
    expect(hits).toEqual(['over']);
    escape();
    expect(hits).toEqual(['over', 'under']);
  });

  it('a backdrop removed by other means never fires a stale dismiss', () => {
    const b = mount();
    let n = 0;
    closeOnEscape(b, () => {
      n += 1;
    });
    b.remove();
    escape();
    expect(n).toBe(0);
  });

  it('ignores other keys and Escapes something else already handled', () => {
    const b = mount();
    let n = 0;
    closeOnEscape(b, () => {
      n += 1;
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(n).toBe(0);
  });
});
