import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  app: { getVersion: vi.fn(() => '4.2.0') },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workAreaSize: { width: 1920, height: 1080 },
    })),
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadFile: vi.fn(),
    webContents: { send: vi.fn(), on: vi.fn() },
    on: vi.fn(),
  })),
  ipcMain: mocks.ipcMain,
  clipboard: mocks.clipboard,
  shell: mocks.shell,
  app: mocks.app,
  screen: mocks.screen,
}));

let actionExecutor;

beforeEach(() => {
  vi.clearAllMocks();
  global.mainWindow = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } };
  global.clipboardManager = { createClipboardWindow: vi.fn(), showBlackHole: vi.fn() };
  global.settingsManager = { get: vi.fn(() => null), set: vi.fn(), getAll: vi.fn(() => ({})), update: vi.fn() };
  global.moduleManager = {
    getInstalledModules: vi.fn(() => []),
    getWebTools: vi.fn(() => []),
    openModule: vi.fn(),
    openWebTool: vi.fn(),
  };
});

beforeAll(() => {
  actionExecutor = require('../../action-executor');
});

describe('ACTION_REGISTRY', () => {
  it('contains at least 100 actions', () => {
    const count = Object.keys(actionExecutor.ACTION_REGISTRY).length;
    expect(count).toBeGreaterThanOrEqual(100);
  });

  it('every action has category, description, and execute', () => {
    for (const [id, action] of Object.entries(actionExecutor.ACTION_REGISTRY)) {
      expect(action.category, `${id} missing category`).toBeTruthy();
      expect(action.description, `${id} missing description`).toBeTruthy();
      expect(typeof action.execute, `${id} missing execute`).toBe('function');
    }
  });

  it('params and optionalParams are arrays when present', () => {
    for (const [id, action] of Object.entries(actionExecutor.ACTION_REGISTRY)) {
      if (action.params) {
        expect(Array.isArray(action.params), `${id} params not array`).toBe(true);
      }
      if (action.optionalParams) {
        expect(Array.isArray(action.optionalParams), `${id} optionalParams not array`).toBe(true);
      }
    }
  });
});

describe('listActions', () => {
  it('returns actions grouped by category', () => {
    const grouped = actionExecutor.listActions();
    expect(typeof grouped).toBe('object');
    const categories = Object.keys(grouped);
    expect(categories.length).toBeGreaterThanOrEqual(10);
  });

  it('covers all expected categories', () => {
    const grouped = actionExecutor.listActions();
    const expected = [
      'windows', 'idw', 'gsx', 'agents', 'settings', 'modules',
      'tabs', 'credentials', 'budget', 'ai', 'voice', 'video',
      'backup', 'dev-tools', 'learning', 'system', 'tools', 'share',
    ];
    for (const cat of expected) {
      expect(grouped[cat], `Missing category: ${cat}`).toBeDefined();
      expect(grouped[cat].length, `Category ${cat} is empty`).toBeGreaterThan(0);
    }
  });

  it('includes params and optionalParams in listing', () => {
    const grouped = actionExecutor.listActions();
    const allActions = Object.values(grouped).flat();
    const withParams = allActions.filter(a => a.params.length > 0);
    expect(withParams.length).toBeGreaterThan(0);
    for (const action of withParams) {
      expect(Array.isArray(action.params)).toBe(true);
      expect(Array.isArray(action.optionalParams)).toBe(true);
    }
  });
});

describe('hasAction', () => {
  it('returns true for registered actions', () => {
    expect(actionExecutor.hasAction('open-settings')).toBe(true);
    expect(actionExecutor.hasAction('agents-list')).toBe(true);
    expect(actionExecutor.hasAction('ai-chat')).toBe(true);
    expect(actionExecutor.hasAction('idw-list')).toBe(true);
  });

  it('returns false for unknown actions', () => {
    expect(actionExecutor.hasAction('nonexistent-action')).toBe(false);
    expect(actionExecutor.hasAction('')).toBe(false);
  });
});

describe('getActionInfo', () => {
  it('returns full info for known action', () => {
    const info = actionExecutor.getActionInfo('open-settings');
    expect(info).toMatchObject({
      type: 'open-settings',
      category: 'windows',
      description: expect.any(String),
    });
    expect(Array.isArray(info.params)).toBe(true);
    expect(Array.isArray(info.optionalParams)).toBe(true);
  });

  it('returns null for unknown action', () => {
    expect(actionExecutor.getActionInfo('fake')).toBeNull();
  });

  it('includes param metadata for parameterized action', () => {
    const info = actionExecutor.getActionInfo('agents-create');
    expect(info.params).toContain('agentData');
  });
});

describe('executeAction', () => {
  it('returns success for simple window action', async () => {
    const result = await actionExecutor.executeAction('open-spaces');
    expect(result.success).toBe(true);
  });

  it('returns error for unknown action', async () => {
    const result = await actionExecutor.executeAction('does-not-exist');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });

  it('validates required params', async () => {
    const result = await actionExecutor.executeAction('agents-create', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter');
  });

  it('validates all required params', async () => {
    const result = await actionExecutor.executeAction('agents-update', { id: '123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter: updates');
  });

  it('executes focus-main-window successfully', async () => {
    const result = await actionExecutor.executeAction('focus-main-window');
    expect(result.success).toBe(true);
    expect(global.mainWindow.show).toHaveBeenCalled();
    expect(global.mainWindow.focus).toHaveBeenCalled();
  });

  it('app-version action is registered', async () => {
    const info = actionExecutor.getActionInfo('app-version');
    expect(info).toMatchObject({ type: 'app-version', category: 'system' });
  });

  it('app-health action is registered', async () => {
    const info = actionExecutor.getActionInfo('app-health');
    expect(info).toMatchObject({ type: 'app-health', category: 'system' });
  });

  it('lists modules via modules-list', async () => {
    const result = await actionExecutor.executeAction('modules-list');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('copy-download-link action is registered with correct shape', async () => {
    const info = actionExecutor.getActionInfo('copy-download-link');
    expect(info).toMatchObject({ type: 'copy-download-link', category: 'share' });
  });

  it('redacts API keys in settings-get-all', async () => {
    global.settingsManager.getAll.mockReturnValue({
      theme: 'dark',
      llmApiKey: 'sk-secret-123',
      openaiToken: 'tok-abc',
    });
    const result = await actionExecutor.executeAction('settings-get-all');
    expect(result.success).toBe(true);
    expect(result.data.theme).toBe('dark');
    expect(result.data.llmApiKey).toBe('***REDACTED***');
    expect(result.data.openaiToken).toBe('***REDACTED***');
  });

  it('redacts API keys in settings-get for sensitive keys', async () => {
    global.settingsManager.get.mockReturnValue('sk-secret-123');
    const result = await actionExecutor.executeAction('settings-get', { key: 'llmApiKey' });
    expect(result.success).toBe(true);
    expect(result.data).toBe('***REDACTED***');
  });

  it('sets builtin agent enabled state', async () => {
    global.settingsManager.get.mockReturnValue({});
    const result = await actionExecutor.executeAction('agents-set-builtin-enabled', {
      agentId: 'calendar-agent',
      enabled: false,
    });
    expect(result.success).toBe(true);
    expect(global.settingsManager.set).toHaveBeenCalledWith(
      'builtinAgentStates',
      expect.objectContaining({ 'calendar-agent': false })
    );
  });

  it('handles settings-set', async () => {
    const result = await actionExecutor.executeAction('settings-set', { key: 'theme', value: 'dark' });
    expect(result.success).toBe(true);
    expect(global.settingsManager.set).toHaveBeenCalledWith('theme', 'dark');
  });

  it('opens tab via tab-open', async () => {
    const result = await actionExecutor.executeAction('tab-open', { url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(global.mainWindow.webContents.send).toHaveBeenCalledWith('open-in-new-tab', 'https://example.com');
  });
});

describe('app-situation', () => {
  it('is registered with system category', () => {
    const info = actionExecutor.getActionInfo('app-situation');
    expect(info).toMatchObject({ type: 'app-situation', category: 'system' });
    expect(info.params).toEqual([]);
  });

  it('returns a snapshot with all expected top-level keys', async () => {
    global.windowRegistry = {
      list: vi.fn(() => [
        { name: 'main', alive: true, visible: true, focused: true },
        { name: 'orb', alive: true, visible: false, focused: false },
      ]),
      get: vi.fn((name) => {
        if (name === 'main') return { id: 1, getTitle: () => 'GSX Power User', isDestroyed: () => false };
        if (name === 'orb') return { id: 2, getTitle: () => 'Voice Orb', isDestroyed: () => false, isVisible: () => false };
        return null;
      }),
    };
    const result = await actionExecutor.executeAction('app-situation');
    expect(result.success).toBe(true);
    const d = result.data;
    expect(d).toHaveProperty('timestamp');
    expect(d).toHaveProperty('windows');
    expect(d).toHaveProperty('flowContext');
    expect(d).toHaveProperty('voice');
    expect(d).toHaveProperty('agents');
    expect(d).toHaveProperty('recentActivity');
    expect(d).toHaveProperty('settings');
  });

  it('windows section includes registered entries', async () => {
    global.windowRegistry = {
      list: vi.fn(() => [{ name: 'settings', alive: true, visible: true, focused: true }]),
      get: vi.fn(() => ({ id: 1, getTitle: () => 'Settings', isDestroyed: () => false })),
    };
    const result = await actionExecutor.executeAction('app-situation');
    expect(result.data.windows.open.length).toBeGreaterThanOrEqual(1);
    expect(result.data.windows.focusedName).toBe('settings');
  });

  it('settings section returns safe keys (no secrets)', async () => {
    global.settingsManager.getAll.mockReturnValue({
      theme: 'dark',
      llmProvider: 'anthropic',
      llmModel: 'claude-sonnet',
      diagnosticLogging: 'debug',
      llmApiKey: 'sk-secret',
    });
    const result = await actionExecutor.executeAction('app-situation');
    expect(result.data.settings.theme).toBe('dark');
    expect(result.data.settings.llmProvider).toBe('anthropic');
    expect(result.data.settings).not.toHaveProperty('llmApiKey');
  });
});

describe('setupActionIPC', () => {
  it('is an exported function', () => {
    expect(typeof actionExecutor.setupActionIPC).toBe('function');
  });
});

describe('startSituationLogger', () => {
  it('is an exported function', () => {
    expect(typeof actionExecutor.startSituationLogger).toBe('function');
  });
});
