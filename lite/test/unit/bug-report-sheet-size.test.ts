/**
 * Bug-report sheet geometry (2026-09-02 modal-closability pass).
 *
 * The modal is a macOS sheet: no traffic lights, not clipped to its
 * parent. A fixed 680-px height hung below short parent windows with the
 * Cancel/Send row unreachable — the user's "no way to close the report a
 * bug modal". The sheet must fit inside the parent's content area, with
 * floors low enough that the pinned footer still shows.
 */

import { describe, it, expect } from 'vitest';
import { BUG_REPORT_SHEET, bugReportSheetSize } from '../../bug-report/sheet-size.js';

describe('bugReportSheetSize', () => {
  it('uses the defaults when there is no parent window', () => {
    expect(bugReportSheetSize(null)).toEqual({ width: 760, height: 680 });
  });

  it('keeps the defaults inside a roomy parent', () => {
    expect(bugReportSheetSize({ width: 1600, height: 1000 })).toEqual({ width: 760, height: 680 });
  });

  it('shrinks to fit a short parent, keeping a margin (the reported case: a 600-px window)', () => {
    // 600-px window ≈ 572-px content area on macOS.
    const size = bugReportSheetSize({ width: 1100, height: 572 });
    expect(size.width).toBe(760);
    expect(size.height).toBe(572 - BUG_REPORT_SHEET.margin);
    expect(size.height).toBeLessThan(572);
  });

  it('shrinks width too when the parent is narrow', () => {
    expect(bugReportSheetSize({ width: 700, height: 900 }).width).toBe(700 - BUG_REPORT_SHEET.margin);
  });

  it('never goes below the floors (the footer must still fit)', () => {
    expect(bugReportSheetSize({ width: 300, height: 200 })).toEqual({
      width: BUG_REPORT_SHEET.minWidth,
      height: BUG_REPORT_SHEET.minHeight,
    });
    expect(BUG_REPORT_SHEET.minHeight).toBeLessThan(600);
  });

  it('returns integers for fractional bounds', () => {
    const size = bugReportSheetSize({ width: 1000.7, height: 500.9 });
    expect(Number.isInteger(size.width)).toBe(true);
    expect(Number.isInteger(size.height)).toBe(true);
  });
});
