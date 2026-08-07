/**
 * Learning Center progress store — main process.
 *
 * One JSON file under userData (`learn-progress.json`). Local-first on
 * purpose: progress must survive offline and never block on the graph.
 * Writes are atomic (tmp + rename) so a crash mid-save can't corrupt
 * the file, and every read passes through `normalizeLearnProgress` so
 * a corrupt/stale file degrades to a fresh start instead of throwing.
 *
 * Cross-machine sync (mirroring a summary onto the viewer's Person
 * node) is a deliberate later step — see the punch list.
 *
 * @internal — consumers go through `getSpacesApi().learn*`.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeLearnProgress,
  type LearnProgress,
} from './learn-content.js';

/** Overridable for tests (temp dir instead of the real userData). */
let baseDirOverride: string | null = null;

export function setLearnStoreDirForTesting(dir: string | null): void {
  baseDirOverride = dir;
}

function progressPath(): string {
  const base = baseDirOverride ?? app.getPath('userData');
  return path.join(base, 'learn-progress.json');
}

export async function readLearnProgress(): Promise<LearnProgress> {
  const now = new Date().toISOString();
  try {
    const raw = await fs.readFile(progressPath(), 'utf8');
    return normalizeLearnProgress(JSON.parse(raw), now);
  } catch {
    // Missing file (first run) or corrupt JSON — both mean "start fresh".
    return normalizeLearnProgress(null, now);
  }
}

export async function writeLearnProgress(raw: unknown): Promise<LearnProgress> {
  const now = new Date().toISOString();
  // Normalize whatever crossed the IPC boundary: unknown lesson ids
  // are dropped, roles are validated, shape is guaranteed.
  const next = normalizeLearnProgress(raw, now);
  const target = progressPath();
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, target);
  return next;
}
