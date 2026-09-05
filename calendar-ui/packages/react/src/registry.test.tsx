import { CalendarDate, CalendarDateTime, toZoned } from '@internationalized/date';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarItem } from '@calendar/core';
import { createRegistry } from './registry.js';
import { textRenderer } from './renderers/text.js';
import { buttonRenderer } from './renderers/button.js';
import { svgRenderer } from './renderers/svg.js';
import { ItemSlot } from './primitives/ItemSlot.js';
import { sanitizeSvg, svgAspectRatio } from './renderers/svg-sanitize.js';

const z = (h: number) => toZoned(new CalendarDateTime(2026, 9, 4, h, 0, 0, 0), 'UTC');
const item = (type: string, payload: unknown, id = 'i1'): CalendarItem => ({ id, start: z(9), end: z(10), allDay: false, type, payload });
const registry = createRegistry().register(textRenderer).register(buttonRenderer).register(svgRenderer);

describe('registry', () => {
  it('is immutable: register returns a new registry and leaves the old one alone', () => {
    const a = createRegistry();
    const b = a.register(textRenderer);
    expect(a.has('text')).toBe(false);
    expect(b.has('text')).toBe(true);
    expect(b.types).toEqual(['text']);
    expect(() => a.register({ type: '', Compact: () => null })).toThrow();
  });
  it('labels come from the renderer, with a safe default for unknown types', () => {
    expect(registry.getLabel(item('text', { title: 'Standup' }))).toBe('Standup');
    expect(registry.getLabel(item('button', { label: 'Join', onClick: () => undefined }))).toBe('Join');
    expect(registry.getLabel(item('mystery', {}))).toBe('mystery i1');
    expect(registry.minCompactHeight('text')).toBe(18);
    expect(registry.minCompactHeight('nope')).toBe(20);
  });
});

describe('ItemSlot — the box', () => {
  it('wraps every renderer in a fixed, overflow-hidden box and never branches on type', () => {
    const onActivate = vi.fn();
    render(<ItemSlot item={item('text', { title: 'Hello' })} registry={registry} density="week" boxHint={{ width: 120, height: 40 }} style={{ width: 120, height: 40 }} isSelected={false} onActivate={onActivate} />);
    const slot = screen.getByRole('button', { name: 'Hello' });
    expect(slot).toHaveClass('cal-slot');
    expect(slot.style.width).toBe('120px');
    expect(slot.style.height).toBe('40px');
    expect(slot.querySelector('.cal-slot__inner')).not.toBeNull();
    expect(new CalendarDate(2026, 9, 4).day).toBe(4);
  });
  it('an unregistered type renders a visible placeholder and never crashes', () => {
    render(<ItemSlot item={item('hologram', { x: 1 })} registry={registry} density="month" boxHint={{ width: 100, height: 22 }} isSelected={false} onActivate={() => undefined} />);
    expect(screen.getByRole('note')).toHaveTextContent('unregistered type');
    expect(screen.getByRole('note')).toHaveTextContent('hologram');
  });
  it('below the renderer minimum height the core draws the fallback chip', () => {
    render(<ItemSlot item={item('text', { title: 'Tiny' })} registry={registry} density="week" boxHint={{ width: 100, height: 8 }} isSelected={false} onActivate={() => undefined} />);
    const slot = screen.getByRole('button', { name: 'Tiny' });
    expect(slot.querySelector('.cal-chip')).not.toBeNull();
    expect(slot.querySelector('.cal-text')).toBeNull();
    expect(slot.querySelector('.cal-chip')?.getAttribute('title')).toBe('Tiny');
  });
  it('a button item keeps its click: the payload handler runs and the calendar does not activate', () => {
    const onActivate = vi.fn();
    const onClick = vi.fn();
    render(<ItemSlot item={item('button', { label: 'Join call', onClick })} registry={registry} density="week" boxHint={{ width: 120, height: 40 }} isSelected={false} onActivate={onActivate} />);
    const inner = screen.getAllByRole('button', { name: 'Join call' }).find((b) => b.tagName === 'BUTTON');
    inner?.click();
    expect(onClick).toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    // a text item activates on click
    render(<ItemSlot item={item('text', { title: 'Plain' }, 'i2')} registry={registry} density="week" boxHint={{ width: 120, height: 40 }} isSelected={false} onActivate={onActivate} />);
    screen.getByRole('button', { name: 'Plain' }).click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
  it('a click that follows a drag does not activate; a plain click still does', () => {
    const onActivate = vi.fn();
    const onDragStart = vi.fn();
    render(<ItemSlot item={item('text', { title: 'Movable' })} registry={registry} density="week" boxHint={{ width: 120, height: 40 }} isSelected={false} onActivate={onActivate} onDragStart={onDragStart} />);
    const slot = screen.getByRole('button', { name: 'Movable' });
    fireEvent.pointerDown(slot, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(onDragStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), expect.anything(), 'move');
    fireEvent.click(slot, { clientX: 10, clientY: 60 }); // released 50px away: a drag
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.pointerDown(slot, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.click(slot, { clientX: 11, clientY: 10 }); // released where it started: a click
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
  it('svg: fixed aspect ratio, scaled to fit, sanitised', () => {
    const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><script>alert(1)</script><rect onclick="x()" width="200" height="100"/></svg>';
    expect(svgAspectRatio(wide)).toBe(2);
    expect(sanitizeSvg(wide)).not.toContain('<script');
    expect(sanitizeSvg(wide)).not.toContain('onclick');
    render(<ItemSlot item={item('svg', { svg: wide, title: 'Chart' })} registry={registry} density="day" boxHint={{ width: 100, height: 100 }} isSelected={false} onActivate={() => undefined} />);
    const img = screen.getByRole('img', { name: 'Chart' });
    expect(img.style.width).toBe('100px');
    expect(img.style.height).toBe('50px'); // 2:1 inside a square box
  });
});
