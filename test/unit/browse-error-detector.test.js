import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('BrowseErrorDetector', () => {
  let detector;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    detector = await import('../../lib/browse-error-detector.js');
  });

  describe('classify()', () => {
    it('should detect CAPTCHA as blocked with promote-hitl action', () => {
      const result = detector.classify({
        captcha: { detected: true, marker: '.g-recaptcha', method: 'selector' },
        authWall: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 500,
      });

      expect(result.blocked).toBe(true);
      expect(result.type).toBe('captcha');
      expect(result.action).toBe('promote-hitl');
      expect(result.message).toContain('CAPTCHA');
    });

    it('should detect bot blocks', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        botBlock: { detected: true, marker: 'access denied', method: 'text' },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 200,
      });

      expect(result.blocked).toBe(true);
      expect(result.type).toBe('bot-block');
      expect(result.action).toBe('retry-then-hitl');
    });

    it('should detect empty/challenge pages', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: true,
        bodyLength: 10,
      });

      expect(result.blocked).toBe(true);
      expect(result.type).toBe('challenge-page');
      expect(result.action).toBe('wait-then-hitl');
    });

    it('should detect auth walls', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: true, marker: 'input[type="password"]', method: 'selector' },
        mfa: { detected: false },
        oauth: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 1000,
      });

      expect(result.blocked).toBe(true);
      expect(result.type).toBe('auth-wall');
      expect(result.action).toBe('promote-hitl');
      expect(result.message).toContain('Login');
    });

    it('should detect 2FA/MFA prompts', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        mfa: { detected: true, marker: 'authenticator app', method: 'text' },
        oauth: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 800,
      });

      expect(result.blocked).toBe(true);
      expect(result.type).toBe('mfa');
      expect(result.action).toBe('promote-hitl');
      expect(result.message).toContain('verification code');
    });

    it('should detect OAuth authorization screens', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        mfa: { detected: false },
        oauth: { detected: true, marker: 'wants to access your', method: 'text' },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 1200,
      });

      expect(result.blocked).toBe(true);
      expect(result.type).toBe('oauth');
      expect(result.action).toBe('promote-hitl');
      expect(result.message).toContain('OAuth');
    });

    it('should prioritize MFA over auth wall', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: true, marker: 'input[type="password"]', method: 'selector' },
        mfa: { detected: true, marker: 'enter the code', method: 'text' },
        oauth: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 500,
      });

      expect(result.type).toBe('mfa');
    });

    it('should prioritize OAuth over auth wall', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: true },
        mfa: { detected: false },
        oauth: { detected: true, marker: 'authorize application', method: 'text' },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 500,
      });

      expect(result.type).toBe('oauth');
    });

    it('should detect content gates (paywalls) as non-blocking', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: true, marker: 'subscribe to read', method: 'text' },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 2000,
      });

      expect(result.blocked).toBe(false);
      expect(result.type).toBe('content-gate');
      expect(result.action).toBe('extract-partial');
    });

    it('should detect consent banners as non-blocking', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: true, marker: '#onetrust', method: 'selector' },
        emptyPage: false,
        bodyLength: 5000,
      });

      expect(result.blocked).toBe(false);
      expect(result.type).toBe('consent');
      expect(result.action).toBe('dismiss-consent');
    });

    it('should return clear when nothing detected', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 5000,
      });

      expect(result.blocked).toBe(false);
      expect(result.type).toBe('clear');
      expect(result.action).toBe('continue');
    });

    it('should prioritize CAPTCHA over auth wall', () => {
      const result = detector.classify({
        captcha: { detected: true, marker: '.g-recaptcha', method: 'selector' },
        authWall: { detected: true, marker: 'input[type="password"]', method: 'selector' },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: false },
        emptyPage: false,
        bodyLength: 500,
      });

      expect(result.type).toBe('captcha');
    });

    it('should not flag empty page as challenge if consent is detected', () => {
      const result = detector.classify({
        captcha: { detected: false },
        authWall: { detected: false },
        botBlock: { detected: false },
        contentGate: { detected: false },
        consent: { detected: true, marker: 'cookie banner', method: 'text' },
        emptyPage: true,
        bodyLength: 30,
      });

      expect(result.type).toBe('consent');
      expect(result.blocked).toBe(false);
    });
  });

  describe('detect()', () => {
    it('should execute detection script on webContents', async () => {
      const mockWebContents = {
        executeJavaScript: vi.fn().mockResolvedValue({
          captcha: { detected: false },
          authWall: { detected: false },
          botBlock: { detected: false },
          contentGate: { detected: false },
          consent: { detected: false },
          emptyPage: false,
          bodyLength: 1000,
        }),
      };

      const result = await detector.detect(mockWebContents);
      expect(mockWebContents.executeJavaScript).toHaveBeenCalled();
      expect(result.type).toBe('clear');
    });

    it('should handle detection errors gracefully', async () => {
      const mockWebContents = {
        executeJavaScript: vi.fn().mockRejectedValue(new Error('Page destroyed')),
      };

      const result = await detector.detect(mockWebContents);
      expect(result.blocked).toBe(false);
      expect(result.type).toBe('error');
      expect(result.error).toBe('Page destroyed');
    });
  });

  describe('dismissConsent()', () => {
    it('should execute consent dismissal script', async () => {
      const mockWebContents = {
        executeJavaScript: vi.fn().mockResolvedValue({ dismissed: true, selector: '#accept-all' }),
      };

      const result = await detector.dismissConsent(mockWebContents);
      expect(result.dismissed).toBe(true);
    });

    it('should handle dismissal failure gracefully', async () => {
      const mockWebContents = {
        executeJavaScript: vi.fn().mockRejectedValue(new Error('fail')),
      };

      const result = await detector.dismissConsent(mockWebContents);
      expect(result.dismissed).toBe(false);
    });
  });

  describe('Marker Coverage', () => {
    it('should have CAPTCHA markers for major providers', () => {
      const markers = detector.CAPTCHA_MARKERS;
      const selectorValues = markers.filter(m => m.type === 'selector').map(m => m.value);

      expect(selectorValues.some(s => s.includes('recaptcha'))).toBe(true);
      expect(selectorValues.some(s => s.includes('hcaptcha'))).toBe(true);
      expect(selectorValues.some(s => s.includes('cloudflare'))).toBe(true);
    });

    it('should have auth wall markers for common patterns', () => {
      const markers = detector.AUTH_WALL_MARKERS;
      const values = markers.map(m => m.value.toLowerCase());

      expect(values.some(v => v.includes('password'))).toBe(true);
      expect(values.some(v => v.includes('login') || v.includes('sign'))).toBe(true);
    });

    it('should have bot block markers', () => {
      const markers = detector.BOT_BLOCK_MARKERS;
      expect(markers.length).toBeGreaterThan(3);
    });

    it('should have consent markers for major providers', () => {
      const markers = detector.CONSENT_MARKERS;
      const values = markers.map(m => m.value.toLowerCase());

      expect(values.some(v => v.includes('consent') || v.includes('cookie'))).toBe(true);
      expect(values.some(v => v.includes('onetrust'))).toBe(true);
    });

    it('should have MFA markers for common 2FA patterns', () => {
      const markers = detector.MFA_MARKERS;
      expect(markers.length).toBeGreaterThan(5);
      const values = markers.map(m => m.value.toLowerCase());
      expect(values.some(v => v.includes('totp') || v.includes('otp') || v.includes('one-time'))).toBe(true);
      expect(values.some(v => v.includes('authenticator') || v.includes('verification code'))).toBe(true);
    });

    it('should have OAuth markers for common providers', () => {
      const markers = detector.OAUTH_MARKERS;
      expect(markers.length).toBeGreaterThan(5);
      const values = markers.map(m => m.value.toLowerCase());
      expect(values.some(v => v.includes('google'))).toBe(true);
      expect(values.some(v => v.includes('github'))).toBe(true);
      expect(values.some(v => v.includes('authorize') || v.includes('oauth'))).toBe(true);
    });
  });

  describe('buildDetectionScript()', () => {
    it('should return a valid JavaScript string', () => {
      const script = detector.buildDetectionScript();
      expect(typeof script).toBe('string');
      expect(script).toContain('checkMarkers');
      expect(script).toContain('captcha');
      expect(script).toContain('authWall');
    });

    it('should embed marker arrays in the script', () => {
      const script = detector.buildDetectionScript();
      expect(script).toContain('recaptcha');
      expect(script).toContain('hcaptcha');
      expect(script).toContain('access denied');
      expect(script).toContain('authenticator app');
      expect(script).toContain('authorize');
    });
  });
});
