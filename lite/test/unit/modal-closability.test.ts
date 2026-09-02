/**
 * Every modal surface has a guaranteed, discoverable close path
 * (2026-09-02, from the user's "there seems to be no way to close the
 * report a bug modal. can you make sure all modals can be closed").
 *
 * Pinned mechanically because each of these regressed silently before:
 *  - the bug-report sheet (a macOS sheet has NO traffic lights): header ×,
 *    Escape, ⌘W/Ctrl+W, a footer pinned outside the only scroll region,
 *    and a window sized to fit its parent;
 *  - the Spaces batch-intake wizard: Escape (it had only a ×);
 *  - the AI Run Times feed overlays (article, preferences): Escape (only ×).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('bug-report sheet', () => {
  const html = read('bug-report/modal.html');
  const css = read('bug-report/modal.css');
  const ts = read('bug-report/modal.ts');
  const main = read('bug-report/main.ts');

  it('has a header × labelled Close', () => {
    expect(html).toMatch(/<button[^>]*id="close"[^>]*aria-label="Close"/);
  });

  it('keeps the footer (Cancel/Send) OUTSIDE the single scroll region', () => {
    const scrollOpen = html.indexOf('<div class="modal-scroll">');
    const scrollClose = html.indexOf('</div>', html.indexOf('</section>', html.indexOf('report-new')));
    const footer = html.indexOf('<footer>');
    expect(scrollOpen).toBeGreaterThan(-1);
    expect(html.indexOf('class="reports-browse"')).toBeGreaterThan(scrollOpen);
    expect(html.indexOf('class="report-new"')).toBeGreaterThan(scrollOpen);
    expect(scrollClose).toBeGreaterThan(html.indexOf('class="report-new"'));
    expect(footer).toBeGreaterThan(scrollClose);
    expect(html.indexOf('id="cancel"')).toBeGreaterThan(footer);
  });

  it('CSS: the frame never scrolls, the middle does, the footer is pinned', () => {
    const block = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, `${selector} block missing`).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(block('.modal-frame')).toMatch(/overflow:\s*hidden/);
    expect(block('.modal-frame')).not.toMatch(/overflow-y:\s*auto/);
    expect(block('.modal-scroll')).toMatch(/overflow-y:\s*auto/);
    expect(block('.modal-scroll')).toMatch(/min-height:\s*0/);
    expect(css).toMatch(/\.modal-frame > footer \{\s*flex: 0 0 auto/);
  });

  it('renderer: Escape and ⌘W/Ctrl+W close; the × is wired; never mid-send', () => {
    expect(ts).toMatch(/document\.addEventListener\('keydown'/);
    expect(ts).toMatch(/e\.key === 'Escape'/);
    expect(ts).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\)[^\n]*e\.key\.toLowerCase\(\) === 'w'/);
    expect(ts).toMatch(/closeBtn\.addEventListener\('click', requestClose\)/);
    expect(ts).toMatch(/function requestClose\(\): void \{\s*if \(cancelBtn\.disabled\) return;/);
  });

  it('window: sized to fit the parent content area, never a fixed 680', () => {
    expect(main).toMatch(/bugReportSheetSize\(parent !== null \? parent\.getContentBounds\(\) : null\)/);
    expect(main).not.toMatch(/height:\s*680/);
    expect(main).toMatch(/minHeight:\s*BUG_REPORT_SHEET\.minHeight/);
  });
});

describe('Spaces batch-intake wizard', () => {
  const src = read('spaces/spaces.ts');
  const start = src.indexOf('function openBatchIntakeWizard(');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  it('exists', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('Escape finishes (same as the ×) and the listener is torn down with the wizard', () => {
    expect(body).toMatch(/ev\.key !== 'Escape'[\s\S]*?finish\(\);/);
    expect(body).toMatch(/document\.addEventListener\('keydown', onEscape\)/);
    expect(body).toMatch(/document\.removeEventListener\('keydown', onEscape\)/);
    expect(body).toMatch(/for \(const undo of teardown\) undo\(\);/);
  });
});

describe('AI Run Times feed overlays', () => {
  const src = read('ai-run-times/feed-renderer.ts');

  it('Escape closes the article overlay, then the preferences panel', () => {
    const at = src.indexOf("e.key !== 'Escape'");
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 600);
    expect(handler).toMatch(/article-overlay[\s\S]*closeArticle\(\)/);
    expect(handler).toMatch(/prefs-panel[\s\S]*togglePrefsPanel\(false\)/);
  });
});

describe('Spaces in-page dialogs that had only a ×', () => {
  const src = read('spaces/spaces.ts');
  const bodyOf = (name: string): string => {
    const at = src.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'));
    expect(at, `${name} missing`).toBeGreaterThan(-1);
    const next = src.slice(at + 1).search(/^(export )?(async )?function \w+\(/m);
    return src.slice(at, next === -1 ? undefined : at + 1 + next);
  };

  for (const name of [
    'openSetPlaybookPicker',
    'openChecklistEditorPanel',
    'openAttachChecklistPanel',
    'mountModal',
  ]) {
    it(`${name}: Escape closes exactly like the ×`, () => {
      expect(bodyOf(name)).toMatch(/closeOnEscape\(backdrop, /);
    });
  }

  it('the shared helper only answers for the topmost backdrop and unhooks itself', () => {
    const helper = bodyOf('closeOnEscape');
    expect(helper).toMatch(/stacked\[stacked\.length - 1\] !== backdrop\) return/);
    expect(helper).toMatch(/if \(!backdrop\.isConnected\)/);
  });
});
