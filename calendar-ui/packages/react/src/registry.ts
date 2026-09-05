/**
 * The renderer registry: the only place `item.type` is looked at.
 * The grid asks the registry for a renderer and an accessible label; it
 * never branches on the type itself.
 */
import type { CalendarItem } from '@calendar/core';
import type { FC } from 'react';

export type Density = 'month' | 'week' | 'day';

export interface Box {
  width: number;
  height: number;
}

export interface CompactProps<TPayload = unknown> {
  item: CalendarItem<TPayload>;
  /** The ONLY space the renderer gets; the core clips to it. */
  box: Box;
  density: Density;
  isSelected: boolean;
  onActivate: () => void;
}

export interface ExpandedProps<TPayload = unknown> {
  item: CalendarItem<TPayload>;
  onClose: () => void;
}

export interface ItemRenderer<TPayload = unknown> {
  type: string;
  Compact: FC<CompactProps<TPayload>>;
  Expanded?: FC<ExpandedProps<TPayload>>;
  /** Below this box height (px) the core draws a fallback chip instead. Default 20. */
  minCompactHeight?: number;
  /** Accessible name for the item. Default: "<type> <id>". */
  getLabel?: (item: CalendarItem<TPayload>) => string;
  /** Chip colour for the fallback chip and skeleton, CSS colour string. */
  color?: (item: CalendarItem<TPayload>) => string;
}

export const DEFAULT_MIN_COMPACT_HEIGHT = 20;

/** Immutable: `register` returns a new registry, so identity tracks contents and memoization is reliable. */
export class Registry {
  private readonly renderers: ReadonlyMap<string, ItemRenderer<unknown>>;

  constructor(renderers: ReadonlyMap<string, ItemRenderer<unknown>> = new Map()) {
    this.renderers = renderers;
  }

  register<TPayload>(renderer: ItemRenderer<TPayload>): Registry {
    if (renderer.type.length === 0) throw new Error('Registry.register: a renderer needs a non-empty type');
    const next = new Map(this.renderers);
    next.set(renderer.type, renderer as ItemRenderer<unknown>);
    return new Registry(next);
  }

  get(type: string): ItemRenderer<unknown> | undefined {
    return this.renderers.get(type);
  }

  has(type: string): boolean {
    return this.renderers.has(type);
  }

  get types(): string[] {
    return [...this.renderers.keys()];
  }

  getLabel(item: CalendarItem): string {
    const r = this.renderers.get(item.type);
    const custom = r?.getLabel?.(item);
    return custom !== undefined && custom.length > 0 ? custom : `${item.type} ${item.id}`;
  }

  colorOf(item: CalendarItem): string | undefined {
    return this.renderers.get(item.type)?.color?.(item);
  }

  minCompactHeight(type: string): number {
    return this.renderers.get(type)?.minCompactHeight ?? DEFAULT_MIN_COMPACT_HEIGHT;
  }
}

export function createRegistry(): Registry {
  return new Registry();
}

/**
 * Bundlers replace `process.env.NODE_ENV` in production builds. Anything
 * else — including an environment where `process` does not exist, such
 * as a dev server's browser client — counts as development, so an
 * unregistered type is loud where it can be fixed and quiet in a build.
 */
export function isDevelopment(): boolean {
  try {
    const env = typeof process !== 'undefined' ? process.env?.['NODE_ENV'] : undefined;
    return env !== 'production';
  } catch {
    return true;
  }
}
