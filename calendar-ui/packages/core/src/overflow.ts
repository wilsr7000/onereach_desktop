import { segmentsInColumn } from './allday.js';
import type { AllDaySegment, CellOverflow } from './types.js';

/**
 * Visible items for a month cell plus the "+N more" count. When any
 * item in the cell sits at or beyond row `maxVisible`, one line is
 * reserved for the affordance: rows below `maxVisible - 1` show and the
 * rest are counted.
 * Visibility goes by row index, so a bar hidden here keeps its row in
 * the neighbouring cells where it may still show.
 */
export function monthCellOverflow(items: readonly AllDaySegment[], maxVisible: number): CellOverflow {
  const sorted = [...items].sort((a, b) => a.row - b.row);
  const limit = Math.max(0, Math.floor(maxVisible));
  // Rows are shared across the week, so the cap is on the row index: a
  // cell whose items sit in rows 0, 2 and 3 needs four lines even though
  // it holds three items.
  if (!sorted.some((s) => s.row >= limit)) return { visible: sorted, hidden: [], overflow: 0 };
  const rowLimit = Math.max(0, limit - 1);
  const visible = sorted.filter((s) => s.row < rowLimit);
  const hidden = sorted.filter((s) => s.row >= rowLimit);
  return { visible, hidden, overflow: hidden.length };
}

/** Overflow per column of a week, from that week's segments. */
export function weekOverflow(segments: readonly AllDaySegment[], maxVisible: number, columnCount: number): CellOverflow[] {
  const out: CellOverflow[] = [];
  for (let col = 0; col < columnCount; col += 1) out.push(monthCellOverflow(segmentsInColumn(segments, col), maxVisible));
  return out;
}
