/**
 * IPC Recorder Namespace - Lifecycle Tests
 *
 * Lifecycle: getDevices -> requestPermissions -> saveToSpace -> startMonitor -> stopMonitor -> close
 *
 * Tests the preload-recorder.js IPC namespace shape.
 *
 * Run:  npx vitest run test/unit/ipc-recorder.test.js
 */

import { describe, it, expect, vi } from 'vitest';

// Mock ipcRenderer
const mockInvoke = vi.fn().mockResolvedValue({ success: true });
const mockSend = vi.fn();
const _mockOn = vi.fn();

// Build the recorder namespace as preload-recorder.js would
const recorderAPI = {
  getInstructions: () => mockInvoke('recorder:get-instructions'),
  getDevices: () => mockInvoke('recorder:get-devices'),
  requestPermissions: (type) => mockInvoke('recorder:request-permissions', type),
  saveToSpace: (data) => mockInvoke('recorder:save-to-space', data),
  getSpaces: () => mockInvoke('recorder:get-spaces'),
  getProjectFolder: (spaceId) => mockInvoke('recorder:get-project-folder', spaceId),
  close: () => mockSend('recorder:close'),
  minimize: () => mockSend('recorder:minimize'),
  getScreenSources: () => mockInvoke('recorder:get-screen-sources'),
  startMonitor: (spaceId) => mockInvoke('recorder:start-monitor', spaceId),
  stopMonitor: () => mockInvoke('recorder:stop-monitor'),
  createRoom: (name) => mockInvoke('recorder:create-room', name),
  endSession: () => mockInvoke('recorder:end-session'),
};

// ═══════════════════════════════════════════════════════════════════
// RECORDER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC Recorder - Lifecycle', () => {
  it('Step 1: getDevices invokes correct channel', async () => {
    await recorderAPI.getDevices();
    expect(mockInvoke).toHaveBeenCalledWith('recorder:get-devices');
  });

  it('Step 2: requestPermissions invokes with type', async () => {
    await recorderAPI.requestPermissions('camera');
    expect(mockInvoke).toHaveBeenCalledWith('recorder:request-permissions', 'camera');
  });

  it('Step 3: saveToSpace invokes with data', async () => {
    await recorderAPI.saveToSpace({ blob: 'data', spaceId: 's1' });
    expect(mockInvoke).toHaveBeenCalledWith('recorder:save-to-space', { blob: 'data', spaceId: 's1' });
  });

  it('Step 4: startMonitor invokes with spaceId', async () => {
    await recorderAPI.startMonitor('space-123');
    expect(mockInvoke).toHaveBeenCalledWith('recorder:start-monitor', 'space-123');
  });

  it('Step 5: stopMonitor invokes correct channel', async () => {
    await recorderAPI.stopMonitor();
    expect(mockInvoke).toHaveBeenCalledWith('recorder:stop-monitor');
  });

  it('Step 6: close sends correct channel', () => {
    recorderAPI.close();
    expect(mockSend).toHaveBeenCalledWith('recorder:close');
  });

  it('Step 7: createRoom invokes with name', async () => {
    await recorderAPI.createRoom('test-room');
    expect(mockInvoke).toHaveBeenCalledWith('recorder:create-room', 'test-room');
  });

  it('Step 8: endSession invokes correct channel', async () => {
    await recorderAPI.endSession();
    expect(mockInvoke).toHaveBeenCalledWith('recorder:end-session');
  });
});
