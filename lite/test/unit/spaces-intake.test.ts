/**
 * Batch intake (2026-08-20): "I uploaded a folder into spaces and it did
 * not upload each asset as individual assets… It should run a process of
 * going through one by one… Same for zip" + "spaces should also not
 * allow exact duplicate files in the same space."
 *
 * The pure half is tested directly (junk filter, titles, zip expansion,
 * planning); the wiring is pinned at source so the drop paths cannot
 * silently regress to files[0].
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { isJunkFile, suggestTitle, expandZips, planIntake } from '../../spaces/intake.js';

const F = (name: string, content = 'x', type = 'text/plain'): { file: File; path: string } => ({
  file: new File([content], name, { type }),
  path: name,
});

describe('junk filter — OS droppings never become assets', () => {
  it('drops dotfiles, Thumbs.db, and __MACOSX noise', () => {
    for (const junk of ['.DS_Store', 'docs/.DS_Store', '__MACOSX/x.txt', 'a/__MACOSX/b.md', 'Thumbs.db', '.hidden']) {
      expect(isJunkFile(junk), junk).toBe(true);
    }
    for (const ok of ['notes.md', 'docs/plan.pdf', 'deep/path/file.txt']) {
      expect(isJunkFile(ok), ok).toBe(false);
    }
  });
});

describe('title suggestion — the filename, made humane', () => {
  it('strips extension and separators', () => {
    expect(suggestTitle('q3-launch_plan.md')).toBe('q3 launch plan');
    expect(suggestTitle('docs/road-map.pdf')).toBe('road map');
    expect(suggestTitle('.env')).toBe('.env'); // degenerate stays whole
  });
});

describe('zip expansion — an archive becomes its members', () => {
  it('unpacks entries, keeps non-zips, skips directories', async () => {
    const zip = new JSZip();
    zip.file('readme.md', '# hello');
    zip.file('sub/notes.txt', 'notes');
    zip.folder('empty');
    const blob = await zip.generateAsync({ type: 'blob' });
    const dropped = [
      { file: new File([blob], 'bundle.zip', { type: 'application/zip' }), path: 'bundle.zip' },
      F('loose.md'),
    ];
    const out = await expandZips(dropped);
    const paths = out.map((o) => o.path).sort();
    expect(paths).toEqual(['bundle/readme.md', 'bundle/sub/notes.txt', 'loose.md']);
  });

  it('an unreadable zip stays as itself rather than vanishing', async () => {
    const out = await expandZips([
      { file: new File(['not a zip'], 'broken.zip', { type: 'application/zip' }), path: 'broken.zip' },
    ]);
    expect(out.map((o) => o.path)).toEqual(['broken.zip']);
  });
});

describe('planIntake — the wizard queue', () => {
  it('filters junk, sorts stably, suggests titles', () => {
    const plan = planIntake([F('b-two.md'), F('.DS_Store'), F('a-one.txt')]);
    expect(plan.map((p) => p.relativePath)).toEqual(['a-one.txt', 'b-two.md']);
    expect(plan[0]!.suggestedTitle).toBe('a one');
  });
});

describe('wiring pins — the drop paths cannot regress to files[0]', () => {
  const source = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    return fs.readFileSync(found as string, 'utf8');
  };

  it('the grid drop routes through the intake planner', () => {
    const src = source();
    const wire = src.slice(
      src.indexOf('function wireDragDropAssetUpload'),
      src.indexOf('function wireDragDropAssetUpload') + 1600
    );
    expect(wire).toContain('routeDroppedFiles(ev.dataTransfer)');
    expect(wire).not.toMatch(/files\?\.\[0\]/);
  });

  it('the modal accepts drops on the WHOLE dialog and hands batches to the wizard', () => {
    const src = source();
    const i = src.indexOf('const dialogRoot = document.getElementById');
    expect(i).toBeGreaterThan(-1);
    const seg = src.slice(i, i + 2200);
    expect(seg).toContain('openBatchIntakeWizard(plan, spaceId)');
    expect(seg).toContain('handleNewAssetFileSelection(plan[0]!.file)');
  });

  it('Electron cannot navigate away on a missed drop — the window guard exists', () => {
    const src = source();
    const g = src.slice(
      src.indexOf('function wireGlobalDropGuard'),
      src.indexOf('function wireGlobalDropGuard') + 700
    );
    expect(g).toContain("window.addEventListener('dragover'");
    expect(g).toContain("window.addEventListener('drop'");
    expect(src).toMatch(/wireGlobalDropGuard\(\);/);
  });

  it('duplicates are refused by BYTES in the shared pipeline, per space', () => {
    const src = source();
    const fn = src.slice(
      src.indexOf('async function createAssetFromUploadFile'),
      src.indexOf('async function createAssetFromUploadFile') + 3000
    );
    expect(fn).toContain('fileSha256(file)');
    expect(fn).toContain('exact duplicate files are not allowed');
    // …and every new upload stamps the identity for future checks.
    const whole = src.slice(src.indexOf('async function createAssetFromUploadFile'), src.indexOf('async function submitNewAsset'));
    expect(whole.match(/contentSha256,/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
