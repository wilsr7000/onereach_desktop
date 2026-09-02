/**
 * Bug-report sheet geometry — pure, unit-pinned (2026-09-02).
 *
 * The modal is a macOS sheet (BrowserWindow modal:true + parent): it has
 * no traffic lights, cannot be dragged, and is NOT clipped to its
 * parent. With a fixed 680-px height, a short parent window (a laptop
 * with the app at 600 px) left the sheet hanging below the parent's
 * bottom edge with the Cancel/Send row out of reach — "no way to close
 * the report-a-bug modal". The sheet now fits inside the parent's
 * content area, with floors low enough that the pinned footer (see
 * modal.css) still shows on any realistic window.
 */

export const BUG_REPORT_SHEET = {
  width: 760,
  height: 680,
  minWidth: 560,
  minHeight: 420,
  /** Breathing room kept between the sheet and the parent's edges. */
  margin: 24,
} as const;

export interface SheetSize {
  width: number;
  height: number;
}

/**
 * The sheet size for a parent of the given CONTENT bounds (null when the
 * modal opens with no parent — then the defaults apply unchanged).
 */
export function bugReportSheetSize(
  parentContent: { width: number; height: number } | null
): SheetSize {
  if (parentContent === null) {
    return { width: BUG_REPORT_SHEET.width, height: BUG_REPORT_SHEET.height };
  }
  const fit = (want: number, avail: number, floor: number): number =>
    Math.max(floor, Math.min(want, Math.floor(avail) - BUG_REPORT_SHEET.margin));
  return {
    width: fit(BUG_REPORT_SHEET.width, parentContent.width, BUG_REPORT_SHEET.minWidth),
    height: fit(BUG_REPORT_SHEET.height, parentContent.height, BUG_REPORT_SHEET.minHeight),
  };
}
