/**
 * Arrow keys walk the asset grid (2026-09-06 live pass: with the real
 * renderer in headless Chromium, ArrowRight on a focused tile went
 * nowhere — Tab was the only way between tiles). Left/Right step by
 * order; Up/Down step by one row of the live layout; the edges are
 * quiet, never a wrap, never a throw.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildItemCard } from '../../spaces/spaces.js';

const item = (id: string) =>
  ({
    id,
    title: `Tile ${id}`,
    kind: 'document',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    otherSpaces: [],
    producedBy: null,
  }) as never;

let cards: HTMLElement[];

beforeEach(() => {
  document.body.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'spaces-card-grid';
  cards = ['a', 'b', 'c'].map((id) => buildItemCard(item(id), false));
  for (const c of cards) grid.appendChild(c);
  document.body.appendChild(grid);
});

const press = (el: HTMLElement, key: string): boolean =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('asset grid keyboard', () => {
  it('ArrowRight / ArrowLeft move focus between tiles', () => {
    cards[0]!.focus();
    expect(press(cards[0]!, 'ArrowRight')).toBe(false); // handled → default prevented
    expect(document.activeElement).toBe(cards[1]);
    press(cards[1]!, 'ArrowRight');
    expect(document.activeElement).toBe(cards[2]);
    press(cards[2]!, 'ArrowLeft');
    expect(document.activeElement).toBe(cards[1]);
  });

  it('the edges are quiet — no wrap, nothing thrown', () => {
    cards[0]!.focus();
    expect(press(cards[0]!, 'ArrowLeft')).toBe(true); // not handled
    expect(document.activeElement).toBe(cards[0]);
    cards[2]!.focus();
    press(cards[2]!, 'ArrowRight');
    expect(document.activeElement).toBe(cards[2]);
  });

  it('a tile outside a grid ignores the arrows', () => {
    const loose = buildItemCard(item('loose'), false);
    document.body.appendChild(loose);
    loose.focus();
    expect(press(loose, 'ArrowRight')).toBe(true);
    expect(document.activeElement).toBe(loose);
  });

  it('Enter still opens the tile (default prevented)', () => {
    cards[0]!.focus();
    expect(press(cards[0]!, 'Enter')).toBe(false);
  });
});
