import type { CalendarItem } from '@calendar/core';
import { useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useElementSize } from '../hooks/useElementSize.js';
import type { Box, Density, Registry } from '../registry.js';
import { FallbackChip } from './FallbackChip.js';
import { UnknownType } from './UnknownType.js';

export interface ItemSlotProps {
  item: CalendarItem;
  registry: Registry;
  density: Density;
  /** Expected size, used until the element has been measured. */
  boxHint: Box;
  style?: CSSProperties | undefined;
  className?: string | undefined;
  isSelected: boolean;
  onActivate: (item: CalendarItem, anchor: HTMLElement) => void;
  /** Drag start for move (pointer events); absent when the calendar is read-only. */
  onDragStart?: ((item: CalendarItem, e: PointerEvent<HTMLElement>, mode: 'move' | 'resize-start' | 'resize-end') => void) | undefined;
  resizable?: boolean | undefined;
  registerFlip?: ((el: HTMLElement | null, key: string) => void) | undefined;
  entering?: boolean | undefined;
  leaving?: boolean | undefined;
  tabIndex?: number | undefined;
  continuesBefore?: boolean | undefined;
  continuesAfter?: boolean | undefined;
}

/**
 * The container the core wraps every renderer in: a fixed box with
 * `overflow: hidden`. Activation ignores clicks a renderer has already
 * handled (`defaultPrevented`), which is how a button inside stays a
 * button. Never branches on item.type: it asks the registry.
 */
export function ItemSlot(props: ItemSlotProps): JSX.Element {
  const { item, registry, density, boxHint, isSelected, onActivate, onDragStart, resizable, registerFlip, entering, leaving, continuesBefore, continuesAfter } = props;
  const ref = useRef<HTMLDivElement>(null);
  // Where the pointer went down; a click released more than a few pixels away is a drag, not an activation.
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const box = useElementSize(ref, boxHint);
  const renderer = registry.get(item.type);
  const label = registry.getLabel(item);
  const color = registry.colorOf(item);
  const tooShort = box.height < registry.minCompactHeight(item.type);
  const activate = (): void => {
    if (ref.current !== null) onActivate(item, ref.current);
  };
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented) return;
    const d = downAt.current;
    downAt.current = null;
    if (d !== null && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) return;
    activate();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (onDragStart === undefined || (e.button ?? 0) !== 0 || e.defaultPrevented) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.closest('button, a, input, select, textarea') !== null && target?.closest('.cal-slot') === ref.current && target !== ref.current && target.closest('.cal-slot__handle') === null) return;
    const handle = target?.closest<HTMLElement>('.cal-slot__handle');
    const mode = handle?.dataset['edge'] === 'start' ? 'resize-start' : handle?.dataset['edge'] === 'end' ? 'resize-end' : 'move';
    downAt.current = { x: e.clientX, y: e.clientY };
    onDragStart(item, e, mode);
  };
  const setRef = (el: HTMLDivElement | null): void => {
    (ref as { current: HTMLDivElement | null }).current = el;
    registerFlip?.(el, item.id);
  };
  const classes = ['cal-slot', isSelected ? 'is-selected' : '', entering === true ? 'is-entering' : '', leaving === true ? 'is-leaving' : '', continuesBefore === true ? 'continues-before' : '', continuesAfter === true ? 'continues-after' : '', onDragStart !== undefined ? 'is-draggable' : '', props.className ?? ''].filter((c) => c.length > 0).join(' ');
  const style: CSSProperties = { ...props.style, ...(color !== undefined ? { ['--cal-item-accent' as string]: color } : {}) };
  let content: JSX.Element;
  if (renderer === undefined) content = <UnknownType type={item.type} label={label} />;
  else if (tooShort) content = <FallbackChip label={label} color={color} />;
  else {
    const Compact = renderer.Compact;
    content = <Compact item={item} box={box} density={density} isSelected={isSelected} onActivate={activate} />;
  }
  return (
    <div ref={setRef} className={classes} style={style} role="button" tabIndex={props.tabIndex ?? 0} aria-label={label} aria-pressed={isSelected} data-item-id={item.id} data-item-type={item.type} onClick={onClick} onKeyDown={onKeyDown} onPointerDown={onPointerDown}>
      {resizable === true ? <div className="cal-slot__handle cal-slot__handle--start" data-edge="start" aria-hidden="true" /> : null}
      <div className="cal-slot__inner">{content}</div>
      {resizable === true ? <div className="cal-slot__handle cal-slot__handle--end" data-edge="end" aria-hidden="true" /> : null}
    </div>
  );
}
