/**
 * @vitest-environment jsdom
 *
 * .xlsx preview (2026-08-20, "we need a preview on .xlsx").
 *
 * The parser tests run against REAL workbooks built with exceljs in
 * memory — the same library that parses them in production — so cell
 * zoo handling (formulas, dates, richText, hyperlinks) is exercised on
 * genuine xlsx bytes, not hand-mocked shapes. The viewer tests render
 * the DOM the pane shows. A router pin keeps the branch ahead of the
 * text fallback, where an xlsx would decode as mojibake.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import {
  parseSpreadsheetBuffer,
  cellDisplayText,
  isSpreadsheetKey,
  MAX_PREVIEW_ROWS,
  MAX_PREVIEW_COLS,
  MAX_PREVIEW_SHEETS,
} from '../../spaces/spreadsheet-preview.js';

async function workbookBytes(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseSpreadsheetBuffer', () => {
  it('reads a plain sheet: names, values, shape', async () => {
    const buf = await workbookBytes((wb) => {
      const ws = wb.addWorksheet('Q3 Pipeline');
      ws.addRow(['Deal', 'Owner', 'Value']);
      ws.addRow(['InfoBip', 'Rich', 125000]);
      ws.addRow(['Data Bricks', 'Robb', 90000]);
    });
    const model = await parseSpreadsheetBuffer(buf);
    expect(model.totalSheets).toBe(1);
    expect(model.truncatedSheets).toBe(false);
    const sheet = model.sheets[0]!;
    expect(sheet.name).toBe('Q3 Pipeline');
    expect(sheet.rows[0]).toEqual(['Deal', 'Owner', 'Value']);
    expect(sheet.rows[1]).toEqual(['InfoBip', 'Rich', '125000']);
    expect(sheet.truncatedRows).toBe(false);
  });

  it('shows what Excel shows: formula results, dates, rich text', async () => {
    const buf = await workbookBytes((wb) => {
      const ws = wb.addWorksheet('Calc');
      ws.addRow(['label', 42]);
      ws.getCell('C1').value = { formula: 'B1*2', result: 84 } as never;
      ws.getCell('D1').value = new Date(Date.UTC(2026, 7, 20));
      ws.getCell('E1').value = {
        richText: [{ text: 'bold ' }, { text: 'plain' }],
      } as never;
    });
    const model = await parseSpreadsheetBuffer(buf);
    const row = model.sheets[0]!.rows[0]!;
    expect(row[2]).toBe('84'); // cached result, not "=B1*2", never [object Object]
    expect(row[3]).toBe('2026-08-20'); // date-only for midnight UTC
    expect(row[4]).toBe('bold plain');
  });

  it('caps rows and says so', async () => {
    const buf = await workbookBytes((wb) => {
      const ws = wb.addWorksheet('Big');
      for (let i = 0; i < MAX_PREVIEW_ROWS + 60; i++) ws.addRow([`row ${i}`]);
    });
    const model = await parseSpreadsheetBuffer(buf);
    const sheet = model.sheets[0]!;
    expect(sheet.rows.length).toBe(MAX_PREVIEW_ROWS);
    expect(sheet.truncatedRows).toBe(true);
    expect(sheet.totalRows).toBe(MAX_PREVIEW_ROWS + 60);
  });

  it('caps columns and sheets, with honest counts', async () => {
    const buf = await workbookBytes((wb) => {
      for (let s = 0; s < MAX_PREVIEW_SHEETS + 2; s++) {
        const ws = wb.addWorksheet(`S${s}`);
        ws.addRow(Array.from({ length: MAX_PREVIEW_COLS + 5 }, (_, i) => `c${i}`));
      }
    });
    const model = await parseSpreadsheetBuffer(buf);
    expect(model.sheets.length).toBe(MAX_PREVIEW_SHEETS);
    expect(model.truncatedSheets).toBe(true);
    expect(model.totalSheets).toBe(MAX_PREVIEW_SHEETS + 2);
    expect(model.sheets[0]!.rows[0]!.length).toBe(MAX_PREVIEW_COLS);
    expect(model.sheets[0]!.truncatedCols).toBe(true);
  });

  it('rejects bytes that are not a workbook (the soft API maps this to null)', async () => {
    await expect(parseSpreadsheetBuffer(Buffer.from('not a zip'))).rejects.toThrow();
  });
});

describe('cellDisplayText', () => {
  it('never leaks object dumps into the grid', () => {
    expect(cellDisplayText({ formula: 'A1+B1' })).toBe('=A1+B1'); // no cached result
    expect(cellDisplayText({ text: 'OneReach', hyperlink: 'https://onereach.ai' })).toBe('OneReach');
    expect(cellDisplayText({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(cellDisplayText(null)).toBe('');
    expect(cellDisplayText(undefined)).toBe('');
  });

  it('caps pathological cells', () => {
    const out = cellDisplayText('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('isSpreadsheetKey', () => {
  it('matches .xlsx only — old .xls is not parseable here', () => {
    expect(isSpreadsheetKey('report.xlsx')).toBe(true);
    expect(isSpreadsheetKey('REPORT.XLSX')).toBe(true);
    expect(isSpreadsheetKey('report.xls')).toBe(false);
    expect(isSpreadsheetKey('report.csv')).toBe(false);
  });
});

// ── The viewer ───────────────────────────────────────────────────────
describe('buildSpreadsheetViewer', () => {
  const model = (over: Partial<LiteSpreadsheetPreview> = {}): LiteSpreadsheetPreview => ({
    sheets: [
      {
        name: 'Pipeline',
        rows: [
          ['Deal', 'Value'],
          ['InfoBip', '125000'],
        ],
        totalRows: 2,
        totalCols: 2,
        truncatedRows: false,
        truncatedCols: false,
      },
    ],
    totalSheets: 1,
    truncatedSheets: false,
    ...over,
  });
  const item = { id: 'a1', title: 'pipeline.xlsx', kind: 'document' } as never;

  it('renders the grid with the first row as the header', async () => {
    const mod = await import('../../spaces/spaces.js');
    const el = mod.buildSpreadsheetViewer(item, model(), 'https://signed.example/x');
    expect(el.querySelectorAll('th').length).toBe(2);
    expect(el.querySelectorAll('td').length).toBe(2);
    expect(el.textContent).toContain('InfoBip');
    // The pane's standing affordances survive.
    expect(el.textContent).toContain('Open in browser');
    expect(el.textContent).toContain('Download');
  });

  it('multi-sheet workbooks get tabs, and clicking swaps the grid', async () => {
    const mod = await import('../../spaces/spaces.js');
    const two = model({
      sheets: [
        { name: 'One', rows: [['a']], totalRows: 1, totalCols: 1, truncatedRows: false, truncatedCols: false },
        { name: 'Two', rows: [['b']], totalRows: 1, totalCols: 1, truncatedRows: false, truncatedCols: false },
      ],
      totalSheets: 2,
    });
    const el = mod.buildSpreadsheetViewer(item, two, null);
    const tabs = el.querySelectorAll<HTMLButtonElement>('.spaces-detail-sheet-tab');
    expect(tabs.length).toBe(2);
    expect(el.querySelector('.spaces-detail-sheet-table')?.textContent).toContain('a');
    tabs[1]!.click();
    expect(el.querySelector('.spaces-detail-sheet-table')?.textContent).toContain('b');
    expect(tabs[1]!.classList.contains('is-active')).toBe(true);
  });

  it('states truncation instead of pretending the file is small', async () => {
    const mod = await import('../../spaces/spaces.js');
    const truncated = model();
    truncated.sheets[0]!.truncatedRows = true;
    truncated.sheets[0]!.totalRows = 12041;
    const el = mod.buildSpreadsheetViewer(item, truncated, null);
    expect(el.textContent).toContain('showing 2 of 12041 rows');
  });
});

// ── The router ───────────────────────────────────────────────────────
describe('the detail router', () => {
  it('routes .xlsx BEFORE the text fallback (mojibake prevention)', () => {
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((p) => resolve(p))
      .find((p) => existsSync(p));
    if (found === undefined) throw new Error('spaces.ts not found');
    const s = readFileSync(found, 'utf8');
    const xlsxAt = s.indexOf('const looksLikeXlsx');
    const textAt = s.indexOf('const textLang = detectTextPreviewLanguage');
    expect(xlsxAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(xlsxAt);
    const branch = s.slice(xlsxAt, xlsxAt + 1600);
    expect(branch).toContain('readSpreadsheet(item.fileKey)');
    expect(branch).toContain('injectSpreadsheetViewer(item, model, remoteUrl)');
  });
});
