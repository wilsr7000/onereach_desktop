/**
 * IPC Flipboard/RSS Namespace - Lifecycle Tests
 *
 * Lifecycle: fetchRSS -> loadReadingLog -> saveReadingLog -> verify
 *
 * Run:  npx vitest run test/unit/ipc-flipboard.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let readingLog = {};
const mockInvoke = vi.fn(async (channel, ...args) => {
  switch (channel) {
    case 'flipboard:fetch-rss':
      return { items: [{ title: 'Test Article', url: 'https://example.com/1' }] };
    case 'flipboard:load-reading-log':
      return readingLog;
    case 'flipboard:save-reading-log':
      readingLog = args[0];
      return { success: true };
    default:
      return null;
  }
});
const mockSend = vi.fn();
const mockOn = vi.fn();

const flipboardAPI = {
  fetchRSS: (url) => mockInvoke('flipboard:fetch-rss', url),
  openExternal: (url) => mockSend('flipboard:open-external', url),
  onRSSData: (cb) => mockOn('flipboard:rss-data', cb),
  loadReadingLog: () => mockInvoke('flipboard:load-reading-log'),
  saveReadingLog: (log) => mockInvoke('flipboard:save-reading-log', log),
};

beforeEach(() => {
  readingLog = {};
  mockInvoke.mockClear();
});

describe('IPC Flipboard - RSS Lifecycle', () => {
  it('Step 1: Fetch RSS feed', async () => {
    const result = await flipboardAPI.fetchRSS('https://example.com/rss');
    expect(result.items).toBeDefined();
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('Step 2: Load reading log (empty)', async () => {
    const log = await flipboardAPI.loadReadingLog();
    expect(log).toEqual({});
  });

  it('Step 3: Save reading log', async () => {
    await flipboardAPI.saveReadingLog({ 'https://example.com/1': { read: true, savedAt: Date.now() } });
    const log = await flipboardAPI.loadReadingLog();
    expect(log['https://example.com/1']).toBeDefined();
    expect(log['https://example.com/1'].read).toBe(true);
  });

  it('Step 4: Update reading log', async () => {
    await flipboardAPI.saveReadingLog({
      'https://example.com/1': { read: true },
      'https://example.com/2': { read: false },
    });
    const log = await flipboardAPI.loadReadingLog();
    expect(Object.keys(log).length).toBe(2);
  });

  it('Step 5: Clear reading log (overwrite)', async () => {
    await flipboardAPI.saveReadingLog({});
    const log = await flipboardAPI.loadReadingLog();
    expect(Object.keys(log).length).toBe(0);
  });
});
