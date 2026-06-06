/**
 * MenuDataManager -- custom IDW CRUD lifecycle.
 *
 * Pins the Agent Marketplace manual-IDW backing store: add, edit, and
 * remove must all go through the canonical MenuDataManager path so the
 * in-memory menu cache and idw-entries.json stay in sync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp/menu-data-idw-crud-test' },
  BrowserWindow: { getAllWindows: () => [] },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../menu', () => ({
  invalidateMenuCache: vi.fn(),
  setApplicationMenu: vi.fn(),
}));

const { MenuDataManager } = require('../../menu-data-manager');

function makeInitializedManager(tmpDir) {
  const mgr = new MenuDataManager();
  mgr._userDataPath = tmpDir;
  mgr._paths = null;
  mgr._initialized = true;
  return mgr;
}

function readSavedIdws(tmpDir) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'idw-entries.json'), 'utf8'));
}

describe('MenuDataManager custom IDW CRUD lifecycle', () => {
  let tmpDir;
  let mgr;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onereach-idw-crud-'));
    mgr = makeInitializedManager(tmpDir);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete global.settingsManager;
  });

  it('adds a custom IDW to cache and idw-entries.json', async () => {
    const result = await mgr.addIDWEnvironment({
      id: 'idw-custom-1',
      label: 'Custom Support IDW',
      chatUrl: 'https://idw.example.com/chat/support',
      homeUrl: 'https://idw.example.com',
      type: 'idw',
      environment: 'custom',
      description: 'Handles support questions',
    });

    expect(result.success).toBe(true);
    expect(mgr.getIDWEnvironments()).toMatchObject([
      {
        id: 'idw-custom-1',
        label: 'Custom Support IDW',
        chatUrl: 'https://idw.example.com/chat/support',
        environment: 'custom',
        description: 'Handles support questions',
      },
    ]);
    expect(readSavedIdws(tmpDir)).toMatchObject([
      {
        id: 'idw-custom-1',
        label: 'Custom Support IDW',
        chatUrl: 'https://idw.example.com/chat/support',
      },
    ]);
  });

  it('edits an existing custom IDW without changing its id', async () => {
    await mgr.addIDWEnvironment({
      id: 'idw-custom-1',
      label: 'Custom Support IDW',
      chatUrl: 'https://idw.example.com/chat/support',
      environment: 'custom',
    });

    const result = await mgr.updateIDWEnvironment('idw-custom-1', {
      label: 'Edited Support IDW',
      chatUrl: 'https://idw.example.com/chat/support-v2',
      homeUrl: 'https://idw.example.com/home',
      environment: 'custom',
      description: 'Edited description',
    });

    expect(result.success).toBe(true);
    const [edited] = mgr.getIDWEnvironments();
    expect(edited).toMatchObject({
      id: 'idw-custom-1',
      label: 'Edited Support IDW',
      chatUrl: 'https://idw.example.com/chat/support-v2',
      homeUrl: 'https://idw.example.com/home',
      environment: 'custom',
      description: 'Edited description',
    });
    expect(readSavedIdws(tmpDir)[0]).toMatchObject({
      id: 'idw-custom-1',
      label: 'Edited Support IDW',
      chatUrl: 'https://idw.example.com/chat/support-v2',
    });
  });

  it('removes a custom IDW from cache and idw-entries.json', async () => {
    await mgr.addIDWEnvironment({
      id: 'idw-custom-1',
      label: 'Custom Support IDW',
      chatUrl: 'https://idw.example.com/chat/support',
      environment: 'custom',
    });

    const result = await mgr.removeIDWEnvironment('idw-custom-1');

    expect(result.success).toBe(true);
    expect(mgr.getIDWEnvironments()).toEqual([]);
    expect(readSavedIdws(tmpDir)).toEqual([]);
  });
});
