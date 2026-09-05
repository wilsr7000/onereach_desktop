import { describe, expect, it } from 'vitest';
import { monthCellOverflow, weekOverflow } from './overflow.js';
import type { AllDaySegment } from './types.js';

const seg = (itemId: string, row: number, startCol = 0, endCol = startCol): AllDaySegment => ({ itemId, row, startCol, endCol, continuesBefore: false, continuesAfter: false });

describe('monthCellOverflow', () => {
  it('shows everything when it fits', () => {
    const r = monthCellOverflow([seg('a', 0), seg('b', 1), seg('c', 2)], 3);
    expect(r.visible.map((s) => s.itemId)).toEqual(['a', 'b', 'c']);
    expect(r.overflow).toBe(0);
  });
  it('reserves a line for "+N more" and counts what it hides', () => {
    const r = monthCellOverflow([seg('a', 0), seg('b', 1), seg('c', 2), seg('d', 3), seg('e', 4)], 3);
    expect(r.visible.map((s) => s.itemId)).toEqual(['a', 'b']);
    expect(r.hidden.map((s) => s.itemId)).toEqual(['c', 'd', 'e']);
    expect(r.overflow).toBe(3);
  });
  it('goes by row index, so a gap left by a bar in another cell stays a gap', () => {
    const r = monthCellOverflow([seg('a', 0), seg('c', 2), seg('d', 3)], 3);
    expect(r.visible.map((s) => s.itemId)).toEqual(['a']);
    expect(r.overflow).toBe(2);
    expect(monthCellOverflow([seg('a', 0), seg('b', 1)], 0)).toEqual({ visible: [], hidden: [seg('a', 0), seg('b', 1)], overflow: 2 });
  });
  it('weekOverflow answers per column, spanning bars counted in every cell they cover', () => {
    const segments = [seg('bar', 0, 0, 6), seg('x', 1, 2), seg('y', 2, 2), seg('z', 3, 2)];
    const cols = weekOverflow(segments, 3, 7);
    expect(cols[0]).toMatchObject({ overflow: 0 });
    expect(cols[2]?.visible.map((s) => s.itemId)).toEqual(['bar', 'x']);
    expect(cols[2]?.overflow).toBe(2);
    expect(cols).toHaveLength(7);
  });
});
