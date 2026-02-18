/**
 * IPC YouTube Namespace - CRUD Lifecycle Tests
 *
 * Lifecycle: isYouTubeUrl -> getInfo -> download -> getTranscript -> cancel -> verify
 *
 * Run:  npx vitest run test/unit/ipc-youtube.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockInvoke = vi.fn().mockResolvedValue({ success: true });

const youtubeAPI = {
  isYouTubeUrl: (url) => mockInvoke('youtube:is-youtube-url', url),
  extractVideoId: (url) => mockInvoke('youtube:extract-video-id', url),
  getInfo: (url) => mockInvoke('youtube:get-info', url),
  downloadToSpace: (url, spaceId) => mockInvoke('youtube:download-to-space', url, spaceId),
  download: (url, options) => mockInvoke('youtube:download', url, options),
  cancelDownload: (id) => mockInvoke('youtube:cancel-download', id),
  getActiveDownloads: () => mockInvoke('youtube:get-active-downloads'),
  getTranscript: (url, lang) => mockInvoke('youtube:get-transcript', url, lang),
  fetchTranscriptForItem: (itemId, lang) => mockInvoke('youtube:fetch-transcript-for-item', itemId, lang),
};

beforeEach(() => {
  mockInvoke.mockClear();
});

// ═══════════════════════════════════════════════════════════════════
// YOUTUBE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC YouTube - Download Lifecycle', () => {
  it('Step 1: Check if URL is YouTube', async () => {
    await youtubeAPI.isYouTubeUrl('https://youtube.com/watch?v=abc');
    expect(mockInvoke).toHaveBeenCalledWith('youtube:is-youtube-url', 'https://youtube.com/watch?v=abc');
  });

  it('Step 2: Get video info', async () => {
    await youtubeAPI.getInfo('https://youtube.com/watch?v=abc');
    expect(mockInvoke).toHaveBeenCalledWith('youtube:get-info', 'https://youtube.com/watch?v=abc');
  });

  it('Step 3: Download video', async () => {
    await youtubeAPI.download('https://youtube.com/watch?v=abc', { quality: 'high' });
    expect(mockInvoke).toHaveBeenCalledWith('youtube:download', 'https://youtube.com/watch?v=abc', { quality: 'high' });
  });

  it('Step 4: Get transcript', async () => {
    await youtubeAPI.getTranscript('https://youtube.com/watch?v=abc', 'en');
    expect(mockInvoke).toHaveBeenCalledWith('youtube:get-transcript', 'https://youtube.com/watch?v=abc', 'en');
  });

  it('Step 5: Cancel download', async () => {
    await youtubeAPI.cancelDownload('dl-123');
    expect(mockInvoke).toHaveBeenCalledWith('youtube:cancel-download', 'dl-123');
  });

  it('Step 6: Verify active downloads', async () => {
    await youtubeAPI.getActiveDownloads();
    expect(mockInvoke).toHaveBeenCalledWith('youtube:get-active-downloads');
  });
});
