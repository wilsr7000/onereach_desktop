import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Anchored to the compact element, portaled to the body so it can size
 * itself freely, flipped above the anchor when there is no room below,
 * focus trapped, and focus restored to the anchor on close.
 */
export function Popover({ anchor, onClose, children, reduced, label }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; reduced: boolean; label: string }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; flipped: boolean } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const el = ref.current;
    const h = el?.offsetHeight ?? 200;
    const w = el?.offsetWidth ?? 280;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const below = a.bottom + 8 + h <= vh || a.top - 8 - h < 0;
    const top = below ? a.bottom + 8 : a.top - 8 - h;
    const left = Math.max(8, Math.min(a.left, vw - w - 8));
    setPos({ top: top + window.scrollY, left: left + window.scrollX, flipped: !below });
  }, [anchor]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (firstEl === undefined || lastEl === undefined) return;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !el.contains(e.target) && !anchor.contains(e.target)) onClose();
    };
    el.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
      anchor.focus();
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} className={`cal-popover ${reduced ? 'cal-popover--still' : ''} ${pos?.flipped === true ? 'cal-popover--above' : ''}`} style={pos === null ? { visibility: 'hidden' } : { top: pos.top, left: pos.left }} data-testid="cal-popover">
      {children}
    </div>,
    document.body
  );
}
