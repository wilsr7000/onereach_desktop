/**
 * Batch intake — folders, multi-file drops, and zips become individual
 * assets through a guided one-by-one review (2026-08-20: "It should run
 * a process of going through one by one and letting the user add meta
 * data etc. Same for zip").
 *
 * This module is the PURE half: enumerate what was dropped, expand
 * zips, drop junk, and plan the queue. The wizard UI lives in
 * spaces.ts and drives the ONE upload pipeline
 * (createAssetFromUploadFile) per item — same inline/GSX decision,
 * transcript conversion, metadata extraction, and per-space duplicate
 * gate as a single-file upload.
 */

import JSZip from 'jszip';

export interface IntakeItem {
  file: File;
  /** Path inside the drop (folder/zip) — shown so the user keeps context. */
  relativePath: string;
  /** Filename minus extension, cleaned — the title the wizard prefills. */
  suggestedTitle: string;
}

/** OS droppings and archive noise that must never become assets. */
export function isJunkFile(pathname: string): boolean {
  const base = pathname.split('/').pop() ?? pathname;
  if (base.startsWith('.')) return true; // .DS_Store, .gitignore, dotfiles
  if (base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (pathname.split('/').some((seg) => seg === '__MACOSX')) return true;
  return false;
}

export function suggestTitle(pathname: string): string {
  const base = pathname.split('/').pop() ?? pathname;
  const noExt = base.replace(/\.[^.]+$/, '');
  const cleaned = noExt.replace(/[-_]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : base;
}

/**
 * Everything dropped, folders traversed. Uses webkitGetAsEntry when the
 * DataTransfer carries directory entries (Electron supports it); falls
 * back to the flat file list.
 */
export async function collectDroppedFiles(dt: DataTransfer): Promise<Array<{ file: File; path: string }>> {
  const out: Array<{ file: File; path: string }> = [];
  const entries: unknown[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const entry = (item as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry?.();
    if (entry !== null && entry !== undefined) entries.push(entry);
  }
  if (entries.length === 0) {
    for (const file of Array.from(dt.files ?? [])) out.push({ file, path: file.name });
    return out;
  }
  const walk = async (entry: unknown, prefix: string): Promise<void> => {
    const e = entry as {
      isFile: boolean;
      isDirectory: boolean;
      name: string;
      file: (ok: (f: File) => void, err: (e: unknown) => void) => void;
      createReader: () => { readEntries: (ok: (es: unknown[]) => void, err: (e: unknown) => void) => void };
    };
    if (e.isFile) {
      const file = await new Promise<File>((resolve, reject) => e.file(resolve, reject));
      out.push({ file, path: prefix + e.name });
      return;
    }
    if (e.isDirectory) {
      const reader = e.createReader();
      // readEntries returns batches of ≤100 — drain until empty.
      for (;;) {
        const batch = await new Promise<unknown[]>((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, prefix + e.name + '/');
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}

/**
 * Blob bytes with a FileReader fallback — Chromium has Blob.arrayBuffer,
 * jsdom (the unit-test DOM) does not, and the zip path must be testable
 * where the tests run.
 */
async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof (blob as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Expand every .zip into its member files; pass everything else through. */
export async function expandZips(
  files: ReadonlyArray<{ file: File; path: string }>
): Promise<Array<{ file: File; path: string }>> {
  const out: Array<{ file: File; path: string }> = [];
  for (const { file, path } of files) {
    if (!/\.zip$/i.test(file.name)) {
      out.push({ file, path });
      continue;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await blobBytes(file));
    } catch {
      // Unreadable archive — keep the zip itself as a single asset
      // rather than silently losing the drop.
      out.push({ file, path });
      continue;
    }
    const base = file.name.replace(/\.zip$/i, '');
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const blob = await entry.async('blob');
      const name = entry.name.split('/').pop() ?? entry.name;
      out.push({
        file: new File([blob], name, { type: blob.type }),
        path: `${base}/${entry.name}`,
      });
    }
  }
  return out;
}

/** Junk out, stable order, titles suggested — the wizard's queue. */
export function planIntake(
  files: ReadonlyArray<{ file: File; path: string }>
): IntakeItem[] {
  return files
    .filter(({ path }) => !isJunkFile(path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ file, path }) => ({
      file,
      relativePath: path,
      suggestedTitle: suggestTitle(path),
    }));
}
