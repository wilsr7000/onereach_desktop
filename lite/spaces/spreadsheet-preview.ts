/**
 * Spreadsheet preview (2026-08-20, "we need a preview on .xlsx").
 *
 * An uploaded .xlsx landed in the generic no-preview branch: a
 * download card where every other document kind shows its content.
 * This module is the main-process half of the fix — it turns workbook
 * BYTES into a compact, renderer-safe table model. Parsing stays in
 * main on purpose: exceljs is a heavyweight zip+XML parser that has no
 * business in the sandboxed renderer, and the renderer receives plain
 * strings it can drop into DOM nodes with zero interpretation.
 *
 * The model is CAPPED, and honestly so: a preview is for recognizing a
 * file, not auditing it. Truncation is reported per axis (sheets, rows,
 * columns) so the viewer can say "showing 200 of 12,041 rows" instead
 * of silently pretending the file is small. The full file remains one
 * click away (Open in browser / Download).
 *
 * exceljs is lazy-required so its module init cost is paid on the
 * first spreadsheet preview, not at boot.
 *
 * @internal
 */

import type { Workbook } from 'exceljs';

/** Preview caps. A recognition aid, not a data grid. */
export const MAX_PREVIEW_SHEETS = 10;
export const MAX_PREVIEW_ROWS = 200;
export const MAX_PREVIEW_COLS = 40;
/** Cell text cap — one pathological cell must not bloat the IPC payload. */
const MAX_CELL_CHARS = 200;

export interface SpreadsheetSheetPreview {
  name: string;
  /** Row-major cell text. Ragged rows are padded renderer-side. */
  rows: string[][];
  /** True row/col extent of the sheet, pre-cap. */
  totalRows: number;
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

export interface SpreadsheetPreviewModel {
  sheets: SpreadsheetSheetPreview[];
  totalSheets: number;
  truncatedSheets: boolean;
}

let exceljsModule: typeof import('exceljs') | null = null;
function loadExceljs(): typeof import('exceljs') {
  if (exceljsModule === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    exceljsModule = require('exceljs') as typeof import('exceljs');
  }
  return exceljsModule;
}

/**
 * One cell's display text. exceljs cell values are a zoo — strings,
 * numbers, dates, {formula, result}, {richText}, {text, hyperlink},
 * errors — and the preview wants the closest thing to what Excel
 * SHOWS, never a JSON dump of the zoo.
 */
export function cellDisplayText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return cap(value);
  if (typeof value === 'number' || typeof value === 'boolean') return cap(String(value));
  if (value instanceof Date) {
    // Date-only when midnight UTC (the common spreadsheet date), else
    // date + time. Locale-free so tests and users see the same thing.
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Formula cell: show the cached result; fall back to the formula
    // itself so the cell is never blank when Excel showed something.
    if ('formula' in record || 'sharedFormula' in record) {
      const result = record['result'];
      if (result !== undefined && result !== null && !(typeof result === 'object' && 'error' in (result as object))) {
        return cellDisplayText(result);
      }
      const formula = record['formula'] ?? record['sharedFormula'];
      return typeof formula === 'string' ? cap(`=${formula}`) : '';
    }
    if (Array.isArray(record['richText'])) {
      const text = (record['richText'] as Array<{ text?: unknown }>)
        .map((r) => (typeof r.text === 'string' ? r.text : ''))
        .join('');
      return cap(text);
    }
    if (typeof record['text'] === 'string') return cap(record['text']); // hyperlink cells
    if ('error' in record) return cap(String(record['error']));
  }
  return cap(String(value));
}

function cap(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_CELL_CHARS ? `${clean.slice(0, MAX_CELL_CHARS - 1)}…` : clean;
}

/**
 * Parse workbook bytes into the preview model. Throws on bytes that
 * are not a readable workbook — the caller (soft API) maps that to
 * null so the pane falls back to the generic document card.
 */
export async function parseSpreadsheetBuffer(buffer: Buffer): Promise<SpreadsheetPreviewModel> {
  const ExcelJS = loadExceljs();
  const workbook: Workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheets: SpreadsheetSheetPreview[] = [];
  let totalSheets = 0;
  workbook.eachSheet((worksheet) => {
    totalSheets += 1;
    if (sheets.length >= MAX_PREVIEW_SHEETS) return;
    const totalRows = worksheet.actualRowCount;
    const totalCols = worksheet.actualColumnCount;
    const rows: string[][] = [];
    // eachRow skips fully-empty rows, which is what a preview wants —
    // includeEmpty would render thousand-row voids some tools leave.
    worksheet.eachRow((row) => {
      if (rows.length >= MAX_PREVIEW_ROWS) return;
      const cells: string[] = [];
      const colCount = Math.min(row.cellCount, MAX_PREVIEW_COLS);
      for (let c = 1; c <= colCount; c++) {
        cells.push(cellDisplayText(row.getCell(c).value));
      }
      // Drop trailing empties so ragged data doesn't render as a wall
      // of blank cells; the viewer pads to the widest row it shows.
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells);
    });
    sheets.push({
      name: worksheet.name,
      rows,
      totalRows,
      totalCols,
      truncatedRows: totalRows > rows.length,
      truncatedCols: totalCols > MAX_PREVIEW_COLS,
    });
  });

  return {
    sheets,
    totalSheets,
    truncatedSheets: totalSheets > sheets.length,
  };
}

/** Keys/names this preview understands. Old .xls is NOT parseable by exceljs. */
export function isSpreadsheetKey(keyOrName: string): boolean {
  return /\.xlsx$/i.test(keyOrName.trim());
}
