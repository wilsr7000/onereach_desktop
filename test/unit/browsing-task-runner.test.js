import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.fn();

const mockBrowsingAPI = {
  createSession: vi.fn().mockResolvedValue({ sessionId: 'runner-session', mode: 'auto-promote', status: 'created' }),
  destroySession: vi.fn().mockResolvedValue({ destroyed: true }),
  navigate: vi.fn().mockResolvedValue({ url: 'https://example.com', title: 'Example', status: 'loaded' }),
  extract: vi.fn().mockResolvedValue({ text: 'Page content', metadata: {} }),
  snapshot: vi.fn().mockResolvedValue({
    refs: [
      { ref: 1, role: 'textbox', name: 'Search', tag: 'input', type: 'text' },
      { ref: 2, role: 'button', name: 'Submit', tag: 'button' },
    ],
    totalElements: 2,
  }),
  act: vi.fn().mockResolvedValue({ success: true, urlChanged: false }),
  getSession: vi.fn().mockReturnValue({ url: 'https://example.com', title: 'Example' }),
  getConsoleLogs: vi.fn().mockReturnValue([]),
  getNetworkLog: vi.fn().mockReturnValue([]),
  checkAuthState: vi.fn().mockResolvedValue({ blocked: false, detectionType: 'clear', authWall: false, mfa: false, oauth: false, captcha: false }),
  autoFillCredentials: vi.fn().mockResolvedValue({ filled: false, reason: 'no-password-field' }),
  waitForUser: vi.fn().mockResolvedValue({ resumed: true, reason: 'navigation', url: 'https://example.com/dashboard' }),
};

const mockErrorDetector = {
  detect: vi.fn().mockResolvedValue({ blocked: false, type: 'clear' }),
  dismissConsent: vi.fn().mockResolvedValue({ dismissed: true }),
};

const deps = { browsingAPI: mockBrowsingAPI, errorDetector: mockErrorDetector, ai: { chat: mockChat } };

describe('BrowsingTaskRunner', () => {
  let taskRunner;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockChat.mockReset();
    Object.values(mockBrowsingAPI).forEach(fn => { if (typeof fn.mockReset === 'function') fn.mockReset(); });
    // Restore default implementations
    mockBrowsingAPI.createSession.mockResolvedValue({ sessionId: 'runner-session', mode: 'auto-promote', status: 'created' });
    mockBrowsingAPI.navigate.mockResolvedValue({ url: 'https://example.com', title: 'Example', status: 'loaded' });
    mockBrowsingAPI.extract.mockResolvedValue({ text: 'Page content', metadata: {} });
    mockBrowsingAPI.snapshot.mockResolvedValue({
      refs: [
        { ref: 1, role: 'textbox', name: 'Search', tag: 'input', type: 'text' },
        { ref: 2, role: 'button', name: 'Submit', tag: 'button' },
      ],
      totalElements: 2,
    });
    mockBrowsingAPI.act.mockResolvedValue({ success: true, urlChanged: false });
    mockBrowsingAPI.getSession.mockReturnValue({ url: 'https://example.com', title: 'Example' });
    mockBrowsingAPI.getConsoleLogs.mockReturnValue([]);
    mockBrowsingAPI.getNetworkLog.mockReturnValue([]);
    mockBrowsingAPI.checkAuthState.mockResolvedValue({ blocked: false, detectionType: 'clear', authWall: false, mfa: false, oauth: false, captcha: false });
    mockBrowsingAPI.autoFillCredentials.mockResolvedValue({ filled: false, reason: 'no-password-field' });
    mockBrowsingAPI.waitForUser.mockResolvedValue({ resumed: true, reason: 'navigation', url: 'https://example.com/dashboard' });
    if (!taskRunner) {
      taskRunner = await import('../../lib/browsing-task-runner.js');
    }
  });

  describe('parseActionResponse()', () => {
    it('should parse a clean JSON action', () => {
      const result = taskRunner.parseActionResponse('{"action":"click","ref":5}');
      expect(result).toEqual({ action: 'click', ref: 5 });
    });

    it('should handle JSON wrapped in markdown code block', () => {
      const result = taskRunner.parseActionResponse('```json\n{"action":"fill","ref":3,"value":"hello"}\n```');
      expect(result).toEqual({ action: 'fill', ref: 3, value: 'hello' });
    });

    it('should extract JSON from text with surrounding content', () => {
      const result = taskRunner.parseActionResponse(
        'I will click the submit button.\n{"action":"click","ref":2}\nThis should work.'
      );
      expect(result).toEqual({ action: 'click', ref: 2 });
    });

    it('should return null for invalid JSON', () => {
      expect(taskRunner.parseActionResponse('not json at all')).toBeNull();
      expect(taskRunner.parseActionResponse('')).toBeNull();
      expect(taskRunner.parseActionResponse('{broken')).toBeNull();
    });

    it('should handle the done action with result data', () => {
      const result = taskRunner.parseActionResponse(
        '{"action":"done","result":{"temperature":"72F","condition":"Sunny"}}'
      );
      expect(result.action).toBe('done');
      expect(result.result.temperature).toBe('72F');
    });
  });

  describe('buildSystemPrompt()', () => {
    it('should include the task description', () => {
      const prompt = taskRunner.buildSystemPrompt('Find the weather in Austin');
      expect(prompt).toContain('Find the weather in Austin');
    });

    it('should list available actions', () => {
      const prompt = taskRunner.buildSystemPrompt('test');
      expect(prompt).toContain('click');
      expect(prompt).toContain('fill');
      expect(prompt).toContain('scroll');
      expect(prompt).toContain('navigate');
      expect(prompt).toContain('done');
      expect(prompt).toContain('error');
    });

    it('should include rules about JSON-only responses', () => {
      const prompt = taskRunner.buildSystemPrompt('test');
      expect(prompt).toContain('JSON');
      expect(prompt).toContain('ref');
    });

    it('should document strategy options', () => {
      const prompt = taskRunner.buildSystemPrompt('test');
      expect(prompt).toContain('strategy');
      expect(prompt).toContain('fast');
      expect(prompt).toContain('stealth');
      expect(prompt).toContain('auto');
    });

    it('should document the submit action', () => {
      const prompt = taskRunner.buildSystemPrompt('test');
      expect(prompt).toContain('submit');
    });

    it('should include auth handling instructions', () => {
      const prompt = taskRunner.buildSystemPrompt('test');
      expect(prompt).toContain('AUTH HANDLING');
      expect(prompt).toContain('login-required');
      expect(prompt).toContain('mfa-required');
      expect(prompt).toContain('NEVER type passwords');
    });
  });

  describe('buildActionPrompt()', () => {
    it('should include page URL and title', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com', 'Example Page'
      );
      expect(prompt).toContain('https://example.com');
      expect(prompt).toContain('Example Page');
    });

    it('should include element refs from snapshot', () => {
      const prompt = taskRunner.buildActionPrompt(
        {
          refs: [
            { ref: 1, role: 'button', name: 'Submit', tag: 'button' },
            { ref: 2, role: 'textbox', name: 'Email', tag: 'input', type: 'email', value: '' },
          ],
        },
        [], 'https://example.com', 'Page'
      );
      expect(prompt).toContain('[1] button "Submit"');
      expect(prompt).toContain('[2] textbox "Email"');
      expect(prompt).toContain('type=email');
    });

    it('should include recent action history', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] },
        [
          { action: 'click', ref: 1, success: true },
          { action: 'fill', ref: 2, value: 'hello', success: false, error: 'Element not found' },
        ],
        'https://example.com', 'Page'
      );
      expect(prompt).toContain('click ref=1');
      expect(prompt).toContain('OK');
      expect(prompt).toContain('FAILED');
      expect(prompt).toContain('Element not found');
    });

    it('should truncate refs beyond 80 elements', () => {
      const refs = Array.from({ length: 100 }, (_, i) => ({
        ref: i + 1, role: 'button', name: `Button ${i}`, tag: 'button',
      }));
      const prompt = taskRunner.buildActionPrompt({ refs }, [], 'https://example.com', 'Page');
      expect(prompt).toContain('and 20 more elements');
    });

    it('should include console logs when provided', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com', 'Page',
        {
          consoleLogs: [
            { level: 3, message: 'Uncaught TypeError: x is not a function', source: 'app.js', line: 42, timestamp: Date.now() },
            { level: 2, message: 'Form validation failed: title is required', source: 'form.js', line: 10, timestamp: Date.now() },
          ],
        }
      );
      expect(prompt).toContain('CONSOLE OUTPUT');
      expect(prompt).toContain('TypeError');
      expect(prompt).toContain('validation failed');
      expect(prompt).toContain('app.js');
    });

    it('should exclude verbose/info console logs (level < 2)', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com', 'Page',
        {
          consoleLogs: [
            { level: 0, message: 'Debug info', timestamp: Date.now() },
            { level: 1, message: 'Info message', timestamp: Date.now() },
          ],
        }
      );
      expect(prompt).not.toContain('CONSOLE OUTPUT');
      expect(prompt).not.toContain('Debug info');
    });

    it('should include network errors when provided', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com', 'Page',
        {
          networkLog: [
            { url: 'https://api.example.com/tickets', status: 422, method: 'POST', timestamp: Date.now() },
            { url: 'https://cdn.example.com/js/app.js', error: 'net::ERR_CONNECTION_REFUSED', method: 'GET', timestamp: Date.now() },
          ],
        }
      );
      expect(prompt).toContain('NETWORK ERRORS');
      expect(prompt).toContain('POST');
      expect(prompt).toContain('422');
      expect(prompt).toContain('ERR_CONNECTION_REFUSED');
    });

    it('should not include network section when no errors', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com', 'Page',
        { networkLog: [] }
      );
      expect(prompt).not.toContain('NETWORK ERRORS');
    });

    it('should include both console and network in correct order', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [{ ref: 1, role: 'button', name: 'Submit' }] },
        [{ action: 'click', ref: 1, success: false, error: 'timeout' }],
        'https://example.com', 'Page',
        {
          consoleLogs: [{ level: 3, message: 'Server error', timestamp: Date.now() }],
          networkLog: [{ url: '/api', status: 500, method: 'POST', timestamp: Date.now() }],
        }
      );

      const consoleIdx = prompt.indexOf('CONSOLE OUTPUT');
      const networkIdx = prompt.indexOf('NETWORK ERRORS');
      const elementsIdx = prompt.indexOf('PAGE ELEMENTS');
      const actionsIdx = prompt.indexOf('RECENT ACTIONS');

      expect(actionsIdx).toBeLessThan(consoleIdx);
      expect(consoleIdx).toBeLessThan(networkIdx);
      expect(networkIdx).toBeLessThan(elementsIdx);
    });

    it('should show strategy in history when not default', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] },
        [
          { action: 'click', ref: 1, strategy: 'stealth', success: true },
          { action: 'fill', ref: 2, value: 'hi', strategy: 'fast', success: true },
          { action: 'click', ref: 3, success: true },
        ],
        'https://example.com', 'Page'
      );
      expect(prompt).toContain('[stealth]');
      expect(prompt).toContain('[fast]');
      expect(prompt).not.toContain('[default]');
    });

    it('should show fallback info in history', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] },
        [{ action: 'click', ref: 1, success: true, fallback: 'stealth' }],
        'https://example.com', 'Page'
      );
      expect(prompt).toContain('fell back to stealth');
    });

    it('should include auth wall context when provided', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [{ ref: 1, role: 'textbox', name: 'Email' }] }, [],
        'https://example.com/login', 'Login',
        {
          authContext: {
            detectionType: 'auth-wall',
            autoFillAttempted: true,
            autoFillResult: { filled: true, username: true, password: true },
          },
        }
      );
      expect(prompt).toContain('AUTH WALL DETECTED');
      expect(prompt).toContain('auth-wall');
      expect(prompt).toContain('succeeded');
      expect(prompt).toContain('sign-in');
    });

    it('should indicate failed auto-fill when no credentials', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com/login', 'Login',
        {
          authContext: {
            detectionType: 'auth-wall',
            autoFillAttempted: true,
            autoFillResult: { filled: false, reason: 'no-credentials-found' },
          },
        }
      );
      expect(prompt).toContain('AUTH WALL DETECTED');
      expect(prompt).toContain('failed');
      expect(prompt).toContain('login-required');
    });

    it('should show MFA context', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com/verify', 'Verify',
        { authContext: { detectionType: 'mfa', autoFillAttempted: false } }
      );
      expect(prompt).toContain('AUTH WALL DETECTED');
      expect(prompt).toContain('mfa-required');
    });

    it('should show OAuth context', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://accounts.google.com/consent', 'Consent',
        { authContext: { detectionType: 'oauth', autoFillAttempted: false } }
      );
      expect(prompt).toContain('AUTH WALL DETECTED');
      expect(prompt).toContain('OAuth consent');
      expect(prompt).toContain('Allow');
    });
  });

  describe('run()', () => {
    it('should complete a task when LLM returns done', async () => {
      mockChat.mockResolvedValueOnce({
        content: '{"action":"done","result":{"answer":"42"}}',
      });

      const result = await taskRunner.run({
        task: 'Find the answer',
        startUrl: 'https://example.com',
        _deps: deps,
      });

      expect(result.success).toBe(true);
      expect(result.data.answer).toBe('42');
      expect(result.steps).toBe(1);
    });

    it('should execute a multi-step workflow', async () => {
      mockChat
        .mockResolvedValueOnce({ content: '{"action":"fill","ref":1,"value":"Austin TX"}' })
        .mockResolvedValueOnce({ content: '{"action":"click","ref":2}' })
        .mockResolvedValueOnce({ content: '{"action":"done","result":{"weather":"Sunny 72F"}}' });

      const result = await taskRunner.run({
        task: 'Get weather for Austin',
        startUrl: 'https://weather.com',
        _deps: deps,
      });

      expect(result.success).toBe(true);
      expect(result.data.weather).toBe('Sunny 72F');
      expect(result.steps).toBe(3);
    });

    it('should stop on agent error', async () => {
      mockChat.mockResolvedValueOnce({
        content: '{"action":"error","message":"Cannot find the search box"}',
      });

      const result = await taskRunner.run({
        task: 'Search for something',
        startUrl: 'https://example.com',
        _deps: deps,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot find the search box');
    });

    it('should respect maxActions limit', async () => {
      mockChat.mockResolvedValue({ content: '{"action":"scroll","value":"down"}' });
      mockBrowsingAPI.act.mockResolvedValue({ success: true, urlChanged: false });

      const result = await taskRunner.run({
        task: 'Infinite scroll',
        maxActions: 3,
        _deps: deps,
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('max-actions');
    });

    it('should handle LLM errors and retry', async () => {
      mockChat
        .mockRejectedValueOnce(new Error('API rate limit'))
        .mockResolvedValueOnce({ content: '{"action":"done","result":"ok"}' });

      const result = await taskRunner.run({ task: 'Test', _deps: deps });

      expect(result.history.some(h => h.action === 'llm-error')).toBe(true);
      expect(result.success).toBe(true);
    });

    it('should fail after MAX_CONSECUTIVE_FAILURES parse errors', async () => {
      mockChat
        .mockResolvedValueOnce({ content: 'not json' })
        .mockResolvedValueOnce({ content: 'still not json' })
        .mockResolvedValueOnce({ content: 'nope' });

      const result = await taskRunner.run({ task: 'Test', _deps: deps });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('parse-failed');
    });

    it('should call onAction callback for each step', async () => {
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":"ok"}' });

      const onAction = vi.fn();
      await taskRunner.run({ task: 'Test', onAction, _deps: deps });

      expect(onAction).toHaveBeenCalledWith(
        expect.objectContaining({ step: 0, action: expect.objectContaining({ action: 'done' }) })
      );
    });

    it('should include checkpoints for resume capability', async () => {
      mockChat
        .mockResolvedValueOnce({ content: '{"action":"click","ref":1}' })
        .mockResolvedValueOnce({ content: '{"action":"done","result":"ok"}' });

      const result = await taskRunner.run({ task: 'Test', _deps: deps });

      expect(result.checkpoints.length).toBeGreaterThan(0);
      expect(result.checkpoints[0]).toHaveProperty('step');
      expect(result.checkpoints[0]).toHaveProperty('url');
      expect(result.checkpoints[0]).toHaveProperty('timestamp');
    });

    it('should extract partial data on max consecutive failures', async () => {
      mockBrowsingAPI.act.mockResolvedValue({ success: false, error: 'Element not found' });
      mockChat.mockResolvedValue({ content: '{"action":"click","ref":99}' });

      const result = await taskRunner.run({ task: 'Test', maxActions: 10, _deps: deps });

      expect(result.success).toBe(false);
      expect(mockBrowsingAPI.extract).toHaveBeenCalled();
    });

    it('should attempt auto-fill when auth wall detected', async () => {
      mockBrowsingAPI.checkAuthState.mockResolvedValue({
        blocked: true, detectionType: 'auth-wall', authWall: true, mfa: false, oauth: false,
      });
      mockBrowsingAPI.autoFillCredentials.mockResolvedValue({
        filled: true, username: true, password: true, credentialUsed: 'user@example.com',
      });
      mockChat.mockResolvedValueOnce({ content: '{"action":"click","ref":2}' })
        .mockResolvedValueOnce({ content: '{"action":"done","result":"logged in"}' });

      const result = await taskRunner.run({ task: 'Login and do stuff', startUrl: 'https://app.com', _deps: deps });

      expect(mockBrowsingAPI.autoFillCredentials).toHaveBeenCalled();
      expect(result.checkpoints[0]).toHaveProperty('authDetected', 'auth-wall');
    });

    it('should not auto-fill for MFA detection', async () => {
      mockBrowsingAPI.checkAuthState.mockResolvedValue({
        blocked: true, detectionType: 'mfa', authWall: false, mfa: true, oauth: false,
      });
      mockChat.mockResolvedValueOnce({ content: '{"action":"error","message":"mfa-required: app.com"}' });

      const result = await taskRunner.run({ task: 'Do something', startUrl: 'https://app.com', _deps: deps });

      expect(mockBrowsingAPI.autoFillCredentials).not.toHaveBeenCalled();
      expect(result.checkpoints[0]).toHaveProperty('authDetected', 'mfa');
    });

    it('should gracefully handle checkAuthState failure', async () => {
      mockBrowsingAPI.checkAuthState.mockRejectedValue(new Error('not available'));
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":"ok"}' });

      const result = await taskRunner.run({ task: 'Test', _deps: deps });
      expect(result.success).toBe(true);
    });

    it('should wait for user on CAPTCHA and resume after login', async () => {
      mockBrowsingAPI.checkAuthState
        .mockResolvedValueOnce({ blocked: true, detectionType: 'captcha', authWall: false, mfa: false, oauth: false, captcha: true })
        .mockResolvedValueOnce({ blocked: false, detectionType: 'clear', authWall: false, mfa: false, oauth: false, captcha: false });
      mockBrowsingAPI.waitForUser.mockResolvedValueOnce({ resumed: true, reason: 'navigation', url: 'https://app.com/dashboard' });
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":"logged in"}' });

      const result = await taskRunner.run({ task: 'Login', startUrl: 'https://app.com', _deps: deps });

      expect(mockBrowsingAPI.waitForUser).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ waitFor: 'navigation' })
      );
      expect(result.history.some(h => h.action === 'hitl-wait')).toBe(true);
      expect(result.history.some(h => h.action === 'hitl-resumed')).toBe(true);
      expect(result.success).toBe(true);
    });

    it('should wait for user on MFA and resume', async () => {
      mockBrowsingAPI.checkAuthState
        .mockResolvedValueOnce({ blocked: true, detectionType: 'mfa', authWall: false, mfa: true, oauth: false, captcha: false })
        .mockResolvedValueOnce({ blocked: false, detectionType: 'clear', authWall: false, mfa: false, oauth: false, captcha: false });
      mockBrowsingAPI.waitForUser.mockResolvedValueOnce({ resumed: true, reason: 'navigation', url: 'https://app.com' });
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":"ok"}' });

      const result = await taskRunner.run({ task: 'Test', _deps: deps });

      expect(mockBrowsingAPI.waitForUser).toHaveBeenCalled();
      expect(result.history.some(h => h.action === 'hitl-wait' && h.reason === 'mfa')).toBe(true);
    });

    it('should fail with hitl-timeout if user does not complete login', async () => {
      mockBrowsingAPI.checkAuthState.mockResolvedValue({
        blocked: true, detectionType: 'captcha', authWall: false, mfa: false, oauth: false, captcha: true,
      });
      mockBrowsingAPI.waitForUser.mockResolvedValueOnce({ resumed: false, reason: 'timeout' });

      const result = await taskRunner.run({ task: 'Test', _deps: deps });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('hitl-timeout');
    });
  });

  describe('Vision Fallback', () => {
    const mockVision = vi.fn();

    beforeEach(() => {
      mockVision.mockReset();
      mockBrowsingAPI.screenshot = vi.fn().mockResolvedValue({ base64: 'fakeScreenshot', width: 1280, height: 900 });
    });

    it('should use vision when snapshot has fewer than threshold elements', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({ refs: [{ ref: 1, role: 'button', name: 'OK' }], totalElements: 1 });
      mockVision.mockResolvedValue('{"action":"click","ref":1}');
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":{"ok":true}}' });

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Click button', useVision: 'auto', visionThreshold: 3, _deps: visionDeps });

      expect(mockVision).toHaveBeenCalled();
      expect(mockBrowsingAPI.screenshot).toHaveBeenCalled();
    });

    it('should NOT use vision when snapshot has enough elements', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({
        refs: [
          { ref: 1, role: 'textbox', name: 'Search' },
          { ref: 2, role: 'button', name: 'Go' },
          { ref: 3, role: 'link', name: 'Home' },
          { ref: 4, role: 'link', name: 'About' },
        ],
        totalElements: 4,
      });
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":{"ok":true}}' });

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Click button', useVision: 'auto', visionThreshold: 3, _deps: visionDeps });

      expect(mockVision).not.toHaveBeenCalled();
      expect(mockBrowsingAPI.screenshot).not.toHaveBeenCalled();
    });

    it('should always use vision when useVision is "always"', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({
        refs: Array.from({ length: 10 }, (_, i) => ({ ref: i + 1, role: 'button', name: `Btn${i}` })),
        totalElements: 10,
      });
      mockVision.mockResolvedValue('{"action":"done","result":{"ok":true}}');

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Click button', useVision: 'always', _deps: visionDeps });

      expect(mockVision).toHaveBeenCalled();
    });

    it('should never use vision when useVision is "never"', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({ refs: [], totalElements: 0 });
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":{}}' });

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Click button', useVision: 'never', _deps: visionDeps });

      expect(mockVision).not.toHaveBeenCalled();
      expect(mockBrowsingAPI.screenshot).not.toHaveBeenCalled();
    });

    it('should cap vision calls at maxVisionSteps', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({ refs: [{ ref: 1, role: 'button', name: 'OK' }], totalElements: 1 });

      let callCount = 0;
      mockVision.mockImplementation(() => {
        callCount++;
        return Promise.resolve('{"action":"scroll","value":"down"}');
      });
      mockChat.mockImplementation(() => Promise.resolve({ content: '{"action":"scroll","value":"down"}' }));

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      await taskRunner.run({ task: 'Scroll', useVision: 'auto', maxVisionSteps: 2, maxActions: 6, _deps: visionDeps });

      expect(mockVision).toHaveBeenCalledTimes(2);
      expect(mockChat.mock.calls.length).toBeGreaterThan(0);
    });

    it('should track visionCalls in successful result', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({ refs: [{ ref: 1, role: 'button', name: 'OK' }], totalElements: 1 });
      mockVision.mockResolvedValue('{"action":"done","result":{"ok":true}}');

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Click', useVision: 'auto', _deps: visionDeps });

      expect(result.success).toBe(true);
      expect(result.visionCalls).toBe(1);
    });

    it('should include visionUsed in history entries', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({ refs: [{ ref: 1, role: 'button', name: 'OK' }], totalElements: 1 });
      mockVision
        .mockResolvedValueOnce('{"action":"click","ref":1}')
        .mockResolvedValueOnce('{"action":"done","result":{}}');
      mockBrowsingAPI.act.mockResolvedValue({ success: true, urlChanged: false });

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Click', useVision: 'auto', _deps: visionDeps });

      const visionEntries = result.history.filter(h => h.visionUsed);
      expect(visionEntries.length).toBeGreaterThan(0);
    });

    it('should handle screenshot failure gracefully (fall back to text-only)', async () => {
      mockBrowsingAPI.snapshot.mockResolvedValue({ refs: [], totalElements: 0 });
      mockBrowsingAPI.screenshot.mockRejectedValue(new Error('Screenshot failed'));
      mockChat.mockResolvedValueOnce({ content: '{"action":"done","result":{}}' });

      const visionDeps = { ...deps, ai: { chat: mockChat, vision: mockVision } };
      const result = await taskRunner.run({ task: 'Test', useVision: 'auto', _deps: visionDeps });

      expect(result.success).toBe(true);
      expect(mockVision).not.toHaveBeenCalled();
      expect(mockChat).toHaveBeenCalled();
    });

    it('should include SCREENSHOT notice in prompt when vision is active', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [] }, [], 'https://example.com', 'Test', { visionActive: true }
      );
      expect(prompt).toContain('SCREENSHOT ATTACHED');
      expect(prompt).toContain('No interactive elements found');
    });

    it('should NOT include SCREENSHOT notice when vision is inactive', () => {
      const prompt = taskRunner.buildActionPrompt(
        { refs: [{ ref: 1, role: 'button', name: 'OK' }] }, [], 'https://example.com', 'Test', { visionActive: false }
      );
      expect(prompt).not.toContain('SCREENSHOT ATTACHED');
    });
  });

  describe('buildSystemPrompt() with vision', () => {
    it('should mention screenshot when visionActive is true', () => {
      const prompt = taskRunner.buildSystemPrompt('Test', true);
      expect(prompt).toContain('SCREENSHOT');
      expect(prompt).toContain('visual layout');
    });

    it('should NOT mention screenshot when visionActive is false', () => {
      const prompt = taskRunner.buildSystemPrompt('Test', false);
      expect(prompt).not.toContain('SCREENSHOT');
    });
  });

  describe('Exported constants', () => {
    it('should export DEFAULT_VISION_THRESHOLD', () => {
      expect(taskRunner.DEFAULT_VISION_THRESHOLD).toBe(3);
    });

    it('should export DEFAULT_MAX_VISION_STEPS', () => {
      expect(taskRunner.DEFAULT_MAX_VISION_STEPS).toBe(5);
    });
  });
});
