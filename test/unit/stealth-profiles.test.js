import { describe, it, expect } from 'vitest';
import {
  getProfileForDomain,
  detectProfile,
  getProfile,
  listProfiles,
  shouldPreferChrome,
  PROFILES,
} from '../../lib/stealth-profiles.js';

describe('stealth-profiles', () => {
  describe('getProfileForDomain()', () => {
    it('should match google.com domains', () => {
      const p = getProfileForDomain('www.google.com');
      expect(p.id).toBe('google');
      expect(p.patches.chromeExtensions).toBe(true);
    });

    it('should match youtube.com', () => {
      const p = getProfileForDomain('www.youtube.com');
      expect(p.id).toBe('google');
    });

    it('should match gmail.com', () => {
      const p = getProfileForDomain('mail.gmail.com');
      expect(p.id).toBe('google');
    });

    it('should match microsoft domains', () => {
      const p = getProfileForDomain('login.microsoftonline.com');
      expect(p.id).toBe('microsoft');
    });

    it('should match office.com', () => {
      const p = getProfileForDomain('www.office.com');
      expect(p.id).toBe('microsoft');
    });

    it('should return default for unknown domains', () => {
      const p = getProfileForDomain('randomsite.example.org');
      expect(p.id).toBe('default');
      expect(p.patches.standard).toBe(true);
    });

    it('should include default timing for all profiles', () => {
      const p = getProfileForDomain('www.google.com');
      expect(p.timing).toBeDefined();
      expect(typeof p.timing.minActionDelay).toBe('number');
    });
  });

  describe('detectProfile()', () => {
    it('should detect Cloudflare from headers', () => {
      const p = detectProfile({ 'cf-ray': '1234', 'server': 'cloudflare' });
      expect(p.id).toBe('cloudflare');
      expect(p.patches.canvasNoise).toBe(true);
      expect(p.preferBackend).toBe('chrome');
    });

    it('should detect DataDome from headers', () => {
      const p = detectProfile({ 'x-datadome': 'true' });
      expect(p.id).toBe('datadome');
      expect(p.preferBackend).toBe('chrome');
    });

    it('should detect PerimeterX from headers', () => {
      const p = detectProfile({ 'x-px': 'something' });
      expect(p.id).toBe('perimeterx');
    });

    it('should detect reCAPTCHA from HTML', () => {
      const p = detectProfile({}, '<div class="g-recaptcha"></div>');
      expect(p.id).toBe('recaptcha');
      expect(p.preferBackend).toBe('chrome');
    });

    it('should detect hCaptcha from HTML', () => {
      const p = detectProfile({}, '<div class="h-captcha" data-sitekey="..."></div>');
      expect(p.id).toBe('recaptcha');
    });

    it('should detect Cloudflare Turnstile from HTML', () => {
      const p = detectProfile({}, '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>');
      expect(p.id).toBe('recaptcha');
    });

    it('should detect PerimeterX from HTML', () => {
      const p = detectProfile({}, '<script>window._pxAppId = "abc123";</script>');
      expect(p.id).toBe('perimeterx');
    });

    it('should return null when nothing detected', () => {
      const p = detectProfile({}, '<html><body>Hello</body></html>');
      expect(p).toBeNull();
    });

    it('should return null for empty inputs', () => {
      const p = detectProfile({}, '');
      expect(p).toBeNull();
    });
  });

  describe('shouldPreferChrome()', () => {
    it('should prefer Chrome for Cloudflare domains', () => {
      expect(shouldPreferChrome('cdn.cloudflare.com', {}, '')).toBe(true);
    });

    it('should prefer Chrome when reCAPTCHA detected in HTML', () => {
      expect(shouldPreferChrome('example.com', {}, '<div class="g-recaptcha"></div>')).toBe(true);
    });

    it('should prefer Chrome when DataDome detected in headers', () => {
      expect(shouldPreferChrome('shop.example.com', { 'x-datadome': '1' }, '')).toBe(true);
    });

    it('should not prefer Chrome for normal sites', () => {
      expect(shouldPreferChrome('example.com', {}, '<html>Hello</html>')).toBe(false);
    });

    it('should not prefer Chrome for Google (no aggressive bot detection)', () => {
      expect(shouldPreferChrome('www.google.com', {}, '')).toBe(false);
    });
  });

  describe('getProfile() and listProfiles()', () => {
    it('should get profile by id', () => {
      expect(getProfile('cloudflare')).toBeDefined();
      expect(getProfile('cloudflare').id).toBe('cloudflare');
    });

    it('should return null for unknown profile', () => {
      expect(getProfile('nonexistent')).toBeNull();
    });

    it('should list all profile keys', () => {
      const keys = listProfiles();
      expect(keys).toContain('cloudflare');
      expect(keys).toContain('google');
      expect(keys).toContain('microsoft');
      expect(keys).toContain('recaptcha');
      expect(keys).toContain('datadome');
      expect(keys).toContain('perimeterx');
      expect(keys).toContain('default');
    });
  });
});
