import { describe, it, expect, vi } from 'vitest';
import { ElectronBackend, PlaywrightBackend, createBackend } from '../../lib/browser-backend.js';

describe('browser-backend', () => {
  describe('createBackend()', () => {
    it('should create ElectronBackend by default', () => {
      const backend = createBackend('electron');
      expect(backend).toBeInstanceOf(ElectronBackend);
      expect(backend.type).toBe('electron');
    });

    it('should create PlaywrightBackend for chrome', () => {
      const backend = createBackend('chrome');
      expect(backend).toBeInstanceOf(PlaywrightBackend);
      expect(backend.type).toBe('playwright');
    });

    it('should create PlaywrightBackend for playwright', () => {
      const backend = createBackend('playwright');
      expect(backend).toBeInstanceOf(PlaywrightBackend);
    });

    it('should default to ElectronBackend for unknown types', () => {
      const backend = createBackend('unknown');
      expect(backend).toBeInstanceOf(ElectronBackend);
    });
  });

  describe('ElectronBackend', () => {
    it('should have all required interface methods', () => {
      const b = new ElectronBackend();
      expect(typeof b.launch).toBe('function');
      expect(typeof b.navigate).toBe('function');
      expect(typeof b.evaluate).toBe('function');
      expect(typeof b.screenshot).toBe('function');
      expect(typeof b.sendInput).toBe('function');
      expect(typeof b.getCookies).toBe('function');
      expect(typeof b.setCookies).toBe('function');
      expect(typeof b.show).toBe('function');
      expect(typeof b.close).toBe('function');
      expect(typeof b.supportsHITL).toBe('function');
    });

    it('should support HITL', () => {
      const b = new ElectronBackend();
      expect(b.supportsHITL()).toBe(true);
    });

    it('should start with null window and session', () => {
      const b = new ElectronBackend();
      expect(b.webContents).toBeUndefined();
      expect(b.window).toBeNull();
    });

    it('should handle close gracefully when not launched', async () => {
      const b = new ElectronBackend();
      await expect(b.close()).resolves.not.toThrow();
    });
  });

  describe('PlaywrightBackend', () => {
    it('should have all required interface methods', () => {
      const b = new PlaywrightBackend();
      expect(typeof b.launch).toBe('function');
      expect(typeof b.navigate).toBe('function');
      expect(typeof b.evaluate).toBe('function');
      expect(typeof b.screenshot).toBe('function');
      expect(typeof b.sendInput).toBe('function');
      expect(typeof b.getCookies).toBe('function');
      expect(typeof b.setCookies).toBe('function');
      expect(typeof b.show).toBe('function');
      expect(typeof b.close).toBe('function');
      expect(typeof b.supportsHITL).toBe('function');
    });

    it('should NOT support HITL', () => {
      const b = new PlaywrightBackend();
      expect(b.supportsHITL()).toBe(false);
    });

    it('should start with null page and context', () => {
      const b = new PlaywrightBackend();
      expect(b.page).toBeNull();
      expect(b.context).toBeNull();
    });

    it('should handle close gracefully when not launched', async () => {
      const b = new PlaywrightBackend();
      await expect(b.close()).resolves.not.toThrow();
    });

    it('should handle show gracefully (no-op for Playwright)', async () => {
      const b = new PlaywrightBackend();
      await expect(b.show()).resolves.not.toThrow();
    });

    describe('getCookies() filtering', () => {
      it('should filter by domain', async () => {
        const b = new PlaywrightBackend();
        b._context = {
          cookies: vi.fn().mockResolvedValue([
            { name: 'a', domain: '.example.com', value: '1' },
            { name: 'b', domain: '.other.com', value: '2' },
          ]),
        };

        const cookies = await b.getCookies({ domain: 'example.com' });
        expect(cookies).toHaveLength(1);
        expect(cookies[0].name).toBe('a');
      });

      it('should filter by url', async () => {
        const b = new PlaywrightBackend();
        b._context = {
          cookies: vi.fn().mockResolvedValue([
            { name: 'a', domain: '.example.com', value: '1' },
            { name: 'b', domain: '.other.com', value: '2' },
          ]),
        };

        const cookies = await b.getCookies({ url: 'https://www.example.com/page' });
        expect(cookies).toHaveLength(1);
        expect(cookies[0].name).toBe('a');
      });

      it('should return all cookies when no filter', async () => {
        const b = new PlaywrightBackend();
        b._context = {
          cookies: vi.fn().mockResolvedValue([
            { name: 'a', domain: '.example.com' },
            { name: 'b', domain: '.other.com' },
          ]),
        };

        const cookies = await b.getCookies({});
        expect(cookies).toHaveLength(2);
      });
    });

    describe('setCookies() mapping', () => {
      it('should map cookies to Playwright format', async () => {
        const b = new PlaywrightBackend();
        const addCookies = vi.fn().mockResolvedValue(undefined);
        b._context = { addCookies };

        await b.setCookies([
          { name: 'session', value: 'abc', domain: '.example.com', httpOnly: true, secure: true },
        ]);

        expect(addCookies).toHaveBeenCalledOnce();
        const mapped = addCookies.mock.calls[0][0];
        expect(mapped[0].name).toBe('session');
        expect(mapped[0].value).toBe('abc');
        expect(mapped[0].httpOnly).toBe(true);
        expect(mapped[0].secure).toBe(true);
      });
    });
  });

  describe('Interface parity', () => {
    it('both backends should have the same method names', () => {
      const e = new ElectronBackend();
      const p = new PlaywrightBackend();

      const requiredMethods = [
        'launch', 'navigate', 'evaluate', 'screenshot',
        'sendInput', 'getCookies', 'setCookies', 'show', 'close', 'supportsHITL',
      ];

      for (const method of requiredMethods) {
        expect(typeof e[method]).toBe('function');
        expect(typeof p[method]).toBe('function');
      }
    });
  });
});
